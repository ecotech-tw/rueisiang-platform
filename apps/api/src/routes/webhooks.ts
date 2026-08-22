import { readCyberbizTopic, verifyCyberbizWebhook } from "@rueisiang/cyberbiz";
import {
  createDatabase,
  dispatchCyberbizWebhook,
  ensureAssistantDefaults,
  getAssistantConfig,
  getActiveAssistantPrompt,
  ensureAssistantLineChannel,
  getAssistantLineChannel,
  findAssistantLineGroup,
  markAssistantLinePushDelivery,
  recordAssistantLineReplyBackup,
  reserveAssistantLinePushDelivery,
  resolveLineToolKeys,
  recordAssistantRun,
  recordAssistantLineMessage,
  resetAssistantLineContext,
  shouldSyncLineGroupProfile,
  updateAssistantLineGroupProfile,
  upsertAssistantLineGroup,
} from "@rueisiang/db";
import {
  ASSISTANT_KEY,
  DEFAULT_ASSISTANT_PROMPT,
  assistantErrorDetails,
  assistantLog,
  currentAssistantRuntimeContext,
  runtimeContextInstruction,
  type AssistantRunResult,
} from "@rueisiang/assistant";
import { PLATFORM_TOOL_KEYS, toolsForSurface } from "@rueisiang/tools";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { forgetCatalog } from "../cyberbiz-catalog.js";
import { cyberbizClient, cyberbizInventoryClient } from "../cyberbiz.js";
import type { AppEnv, Env } from "../env.js";
import { decryptLineSecret } from "../line-secrets.js";
import { isLineAssistantQueueMessage, type LineAssistantQueueMessage } from "../line-queue.js";
import { cacheClient } from "../upstash.js";
import type { Context } from "hono";
import {
  DEFAULT_PI_CODEX_MODEL,
  PiAgentStaleSessionError,
  resetPiLineAgent,
  runPiLineAgent,
} from "../pi-agent.js";
import {
  isLineWebhookEvent,
  lineEventGroup,
  lineEventIsMentioned,
  lineEventIsSessionReset,
  lineEventRawText,
  lineEventText,
  fetchLineChatMemberCount,
  fetchLineGroupSummary,
  fetchLinePushUsage,
  fetchLineUserProfile,
  linePushWindowKey,
  lineQuestionText,
  pushLineMessage,
  replyLineMessage,
  verifyLineWebhookSignature,
  type LineWebhookPayload,
} from "../line.js";

/**
 * CYBERBIZ 送進來的 webhook。**一個網址收全部的事件。**
 *
 * 這是整個系統唯一不需要登入的寫入端點，所以驗證要嚴：沒設密鑰就一律不收，
 * 驗不過就 401，兩者都不會透露原因。
 *
 * 為什麼不是每種事件一個網址：CYBERBIZ 後台的訂閱是人手動設的，每多一個網址就
 * 多一個「有沒有設到」的問題，而設漏了不會有任何錯誤訊息——只會安靜地不同步。
 * 分派在程式裡做（見 packages/db 的 dispatchCyberbizWebhook），那段判斷本來就
 * 跑不掉：CYBERBIZ 不一定送 topic 標頭，就算分成好幾條路，每一條也還是得驗證
 * 自己收到的是不是該收的。
 */

/** 2 MB。正常的事件遠小於這個，超過的多半是打錯地方。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LINE_TOOL_KEYS = toolsForSurface("line").map((tool) => tool.key);
const LINE_REPLY_TOKEN_TTL_MS = 60_000;
const LINE_REPLY_SAFETY_MARGIN_MS = 10_000;
const LINE_BUSY_REPLY = "系統繁忙，請稍後再試。";
const LINE_FREE_PUSH_RECIPIENT_LIMIT = 200;

function lineReplyDeadlineAt(timestamp: unknown): number {
  return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
    ? timestamp + LINE_REPLY_TOKEN_TTL_MS
    : Date.now() + LINE_REPLY_TOKEN_TTL_MS;
}

async function stableLineWebhookEventId(input: {
  groupId: string;
  sourceType: string;
  timestamp?: number;
  messageId?: string;
  userId?: string;
  text: string;
}): Promise<string> {
  const source = [
    input.groupId,
    input.sourceType,
    input.timestamp ?? "",
    input.messageId ?? "",
    input.userId ?? "",
    input.text,
  ].join("\u001f");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)));
  return `fallback:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

type LinePushOutcome = "sent" | "quota_exhausted" | "usage_unavailable" | "member_count_unavailable" | "failed";

/** Push 是 Reply token 失效後的最後手段；任何前置資訊取不到都保守停用，不能冒險超過免費額度。 */
async function deliverLinePush(input: {
  db: AppEnv["Variables"]["db"];
  accessToken: string;
  runId: string;
  channelKey: string;
  groupRowId: string;
  lineGroupId: string;
  sourceType: "group" | "room" | "user";
  text: string;
}): Promise<LinePushOutcome> {
  const windowKey = linePushWindowKey();
  let recipientCount = input.sourceType === "user" ? 1 : 0;
  try {
    recipientCount = await fetchLineChatMemberCount(input.accessToken, input.sourceType, input.lineGroupId);
  } catch (error) {
    await reserveAssistantLinePushDelivery(input.db, {
      runId: input.runId,
      channelKey: input.channelKey,
      groupId: input.groupRowId,
      lineGroupId: input.lineGroupId,
      sourceType: input.sourceType,
      windowKey,
      remoteUsage: 0,
      recipients: recipientCount,
      limit: LINE_FREE_PUSH_RECIPIENT_LIMIT,
      denyReason: "member_count_unavailable",
    });
    assistantLog("warn", "line.push.skipped", {
      runId: input.runId,
      groupId: input.lineGroupId,
      reason: "member_count_unavailable",
      error: assistantErrorDetails(error),
    });
    return "member_count_unavailable";
  }

  let remoteUsage: number;
  try {
    remoteUsage = await fetchLinePushUsage(input.accessToken);
  } catch (error) {
    await reserveAssistantLinePushDelivery(input.db, {
      runId: input.runId,
      channelKey: input.channelKey,
      groupId: input.groupRowId,
      lineGroupId: input.lineGroupId,
      sourceType: input.sourceType,
      windowKey,
      remoteUsage: 0,
      recipients: recipientCount,
      limit: LINE_FREE_PUSH_RECIPIENT_LIMIT,
      denyReason: "usage_unavailable",
    });
    assistantLog("warn", "line.push.skipped", {
      runId: input.runId,
      groupId: input.lineGroupId,
      reason: "usage_unavailable",
      error: assistantErrorDetails(error),
    });
    return "usage_unavailable";
  }

  const reservation = await reserveAssistantLinePushDelivery(input.db, {
    runId: input.runId,
    channelKey: input.channelKey,
    groupId: input.groupRowId,
    lineGroupId: input.lineGroupId,
    sourceType: input.sourceType,
    windowKey,
    remoteUsage,
    recipients: recipientCount,
    limit: LINE_FREE_PUSH_RECIPIENT_LIMIT,
  });
  if (!reservation.allowed) {
    assistantLog("warn", "line.push.skipped", {
      runId: input.runId,
      groupId: input.lineGroupId,
      reason: reservation.delivery.reason || "monthly_fixed_window_limit",
      recipientCount,
      remoteUsage,
      localUsage: reservation.localUsage,
      windowKey,
    });
    return "quota_exhausted";
  }

  try {
    // retry key 與 Queue message 的 runId 相同；consumer 在 LINE 已收件、D1 尚未標 sent 時重試也不會重複計費。
    await pushLineMessage(input.accessToken, input.lineGroupId, input.text, input.runId);
    await markAssistantLinePushDelivery(input.db, { runId: input.runId, status: "sent" });
    assistantLog("info", "line.push.completed", {
      runId: input.runId,
      groupId: input.lineGroupId,
      recipientCount,
      windowKey,
    });
    return "sent";
  } catch (error) {
    await markAssistantLinePushDelivery(input.db, {
      runId: input.runId,
      status: "failed",
      reason: error instanceof Error ? error.message : "line_push_failed",
    });
    assistantLog("warn", "line.push.failed", {
      runId: input.runId,
      groupId: input.lineGroupId,
      error: assistantErrorDetails(error),
    });
    return "failed";
  }
}

async function runLineAssistant(input: {
  db: AppEnv["Variables"]["db"];
  env: AppEnv["Bindings"];
  accessToken: string;
  replyToken: string;
  assistantKey: string;
  channelKey: string;
  /** 對話那一列的 id，不是 LINE 的對話 id——對話層的工具授權掛在這個 id 上。 */
  groupRowId: string;
  lineGroupId: string;
  sourceType: "group" | "room" | "user";
  questionText: string;
  webhookEventId: string;
  runId: string;
  contextGeneration: string;
  replyDeadlineAt?: number;
}): Promise<void> {
  const runId = input.runId;
  const started = Date.now();
  let modelId = DEFAULT_PI_CODEX_MODEL;
  let promptRevisionId = "unavailable";
  let promptText = input.questionText;
  let replyKind: "final" | "deadline-fallback" | "error" | undefined;
  let replyFailed = false;
  let replyAttempt: Promise<boolean> | undefined;
  let resultForBackup: AssistantRunResult | undefined;

  const sendReplyOnce = async (text: string, reason: "final" | "deadline-fallback" | "error"): Promise<boolean> => {
    if (replyKind) return false;
    if (replyAttempt) {
      await replyAttempt;
      return false;
    }
    replyAttempt = (async () => {
      try {
        await replyLineMessage(input.accessToken, input.replyToken, text);
        replyKind = reason;
        assistantLog("info", "line.reply.completed", {
          runId,
          groupId: input.lineGroupId,
          reason,
        });
        return true;
      } catch (error) {
        replyFailed = true;
        assistantLog("warn", "line.reply.failed", {
          runId,
          groupId: input.lineGroupId,
          reason,
          error: assistantErrorDetails(error),
        });
        return false;
      } finally {
        replyAttempt = undefined;
      }
    })();
    return await replyAttempt;
  };

  const replyDeadlineAt = input.replyDeadlineAt ?? Date.now() + LINE_REPLY_TOKEN_TTL_MS;
  const fallbackAt = replyDeadlineAt - LINE_REPLY_SAFETY_MARGIN_MS;
  const fallbackTimer = replyDeadlineAt > Date.now()
    ? setTimeout(() => {
        void sendReplyOnce(LINE_BUSY_REPLY, "deadline-fallback");
      }, Math.max(0, fallbackAt - Date.now()))
    : undefined;
  try {
    await ensureAssistantDefaults(input.db, {
      assistantKey: input.assistantKey,
      defaultModel: DEFAULT_PI_CODEX_MODEL,
      defaultPrompt: DEFAULT_ASSISTANT_PROMPT,
      toolKeys: PLATFORM_TOOL_KEYS,
    });
    /*
     * toolMode 在這裡重讀，不採信收 webhook 當下那一份。
     *
     * 這條路是排程執行的，收件與回答之間隔著一段時間；管理員在那之間把對話從 inherit
     * 改成 custom 的話，用舊值等於讓這一輪照舊拿到 channel 的全部工具。授權每次執行都
     * 回 DB 重讀是這個 codebase 的既定原則（CLAUDE.md），LINE 這條也不例外。
     */
    const group = await findAssistantLineGroup(input.db, { channelKey: input.channelKey, id: input.groupRowId });
    if (!group) throw new Error("找不到這個 LINE 對話的設定。");
    if (!group.enabled) throw new Error("這個 LINE 對話已經被取消授權。");
    if ((group.contextResetAt ?? "") !== input.contextGeneration) {
      throw new PiAgentStaleSessionError("這則工作屬於已重設的舊 session，已略過。");
    }

    const [assistantConfig, prompt, allowedToolKeys] = await Promise.all([
      getAssistantConfig(input.db, input.assistantKey),
      getActiveAssistantPrompt(input.db, input.assistantKey),
      resolveLineToolKeys(input.db, {
        channelKey: input.channelKey,
        groupId: input.groupRowId,
        toolMode: group.toolMode,
      }),
    ]);
    const configuredModel = assistantConfig?.activeModel
      || input.env.PI_AGENT_MODEL?.trim()
      || DEFAULT_PI_CODEX_MODEL;
    modelId = configuredModel;
    if (!prompt) throw new Error("小香的 prompt 設定目前無法使用。");
    promptRevisionId = prompt.id;

    // 最近對話不再由 D1 每輪拼成 prompt；chat 專屬 DO 會還原 Pi transcript 與 compact summary。
    promptText = input.questionText;
    const systemPrompt = [
      prompt.systemPrompt,
      runtimeContextInstruction(currentAssistantRuntimeContext()),
      "這是 LINE 內部助理。除非使用者要求詳細說明，請用繁體中文在六句內直接回答；不要輸出思考過程。",
    ].join("\n\n");
    const piResponse = await runPiLineAgent(input.env, {
      assistantKey: input.assistantKey,
      channelKey: input.channelKey,
      groupRowId: input.groupRowId,
      lineGroupId: input.lineGroupId,
      sourceType: input.sourceType,
      contextGeneration: input.contextGeneration,
      runId,
      model: configuredModel,
      systemPrompt,
      userText: promptText,
      toolKeys: allowedToolKeys,
    });
    modelId = piResponse.model;
    const result: AssistantRunResult = piResponse.result;
    resultForBackup = result;
    if (result.thoughts) {
      console.info("LINE 小香 thought summary", {
        runId,
        groupId: input.lineGroupId,
        thoughts: result.thoughts.slice(0, 12_000),
      });
    }
    const toolFailure = result.toolCalls.find((toolCall) => toolCall.status === "failed");
    assistantLog("info", "line.reply.started", {
      runId,
      groupId: input.lineGroupId,
      textChars: result.text.length,
    });
    if (fallbackTimer) clearTimeout(fallbackTimer);
    if (replyAttempt) await replyAttempt;

    let finalReplySent = false;
    if (!replyKind && !replyFailed && Date.now() < fallbackAt) {
      finalReplySent = await sendReplyOnce(result.text, "final");
    } else if (!replyKind && !replyFailed && Date.now() < replyDeadlineAt) {
      // 已進入安全緩衝區就不再拿完整回答冒險；先用 Reply token 明確告知繁忙，完成內容再走受限 Push。
      await sendReplyOnce(LINE_BUSY_REPLY, "deadline-fallback");
    }

    if (!finalReplySent) {
      try {
        await recordAssistantLineReplyBackup(input.db, {
          runId,
          channelKey: input.channelKey,
          groupId: input.groupRowId,
          lineGroupId: input.lineGroupId,
          sourceType: input.sourceType,
          webhookEventId: input.webhookEventId,
          questionText: input.questionText,
          responseText: result.text,
          model: modelId,
          reason: replyFailed ? "reply_failed" : "reply_token_deadline",
        });
      } catch (backupError) {
        console.error("LINE 備用回覆儲存失敗", { runId, groupId: input.lineGroupId, error: backupError });
      }

      await deliverLinePush({
        db: input.db,
        accessToken: input.accessToken,
        runId,
        channelKey: input.channelKey,
        groupRowId: input.groupRowId,
        lineGroupId: input.lineGroupId,
        sourceType: input.sourceType,
        text: result.text,
      });
    }
    await recordAssistantRun(input.db, {
      id: runId,
      channel: "line",
      assistantKey: input.assistantKey,
      channelKey: input.channelKey,
      groupId: input.lineGroupId,
      model: modelId,
      promptRevisionId,
      inputChars: promptText.length,
      outputChars: result.text.length,
      usage: result.usage,
      status: toolFailure ? "failed" : "success",
      durationMs: Date.now() - started,
      ...(toolFailure?.errorMessage ? { errorMessage: toolFailure.errorMessage } : {}),
      toolCalls: result.toolCalls,
    });
  } catch (error) {
    if (error instanceof PiAgentStaleSessionError) {
      assistantLog("info", "line.queue.skipped", {
        runId,
        groupId: input.lineGroupId,
        reason: "stale_session_generation",
      });
      return;
    }
    const message = error instanceof Error ? error.message : "小香目前無法完成回答。";
    console.error("LINE 小香回覆失敗", { runId, groupId: input.lineGroupId, error });
    try {
      await recordAssistantRun(input.db, {
        id: runId,
        channel: "line",
        assistantKey: input.assistantKey,
        channelKey: input.channelKey,
        groupId: input.lineGroupId,
        model: modelId,
        promptRevisionId,
        inputChars: promptText.length,
        outputChars: 0,
        usage: { promptTokens: 0, candidateTokens: 0, totalTokens: 0 },
        status: "failed",
        durationMs: Date.now() - started,
        errorMessage: message,
        toolCalls: [],
      });
    } catch (recordError) {
      console.error("LINE 小香失敗用量記錄失敗", { runId, groupId: input.lineGroupId, error: recordError });
    }
    if (!replyKind && !replyFailed && Date.now() < replyDeadlineAt) {
      await sendReplyOnce("小香目前無法完成回答，請稍後再試。", "error");
    }
    if (resultForBackup && replyKind !== "final") {
      try {
        await recordAssistantLineReplyBackup(input.db, {
          runId,
          channelKey: input.channelKey,
          groupId: input.groupRowId,
          lineGroupId: input.lineGroupId,
          sourceType: input.sourceType,
          webhookEventId: input.webhookEventId,
          questionText: input.questionText,
          responseText: resultForBackup.text,
          model: modelId,
          status: "ready",
          reason: "reply_token_expired_or_failed",
        });
      } catch (backupError) {
        console.error("LINE 備用回覆儲存失敗", { runId, groupId: input.lineGroupId, error: backupError });
      }
    }
  } finally {
    if (fallbackTimer) clearTimeout(fallbackTimer);
  }
}

async function syncLineGroupProfile(input: {
  db: AppEnv["Variables"]["db"];
  accessToken: string;
  channelKey: string;
  group: NonNullable<Awaited<ReturnType<typeof findAssistantLineGroup>>>;
}): Promise<void> {
  const group = input.group;
  if (group.sourceType === "room" || !shouldSyncLineGroupProfile(group)) return;

  try {
    const profile = group.sourceType === "group"
      ? await fetchLineGroupSummary(input.accessToken, group.lineGroupId)
      : await fetchLineUserProfile(input.accessToken, group.lineGroupId);
    if (profile) {
      await updateAssistantLineGroupProfile(input.db, {
        channelKey: input.channelKey,
        id: group.id,
        groupName: "groupName" in profile ? profile.groupName : profile.displayName,
        pictureUrl: profile.pictureUrl,
      });
    }
  } catch (error) {
    console.warn("LINE 對話資料同步失敗", { groupId: group.lineGroupId, error });
  }
}

async function enqueueLineAssistantJob(
  env: AppEnv["Bindings"],
  message: LineAssistantQueueMessage,
): Promise<void> {
  // send() resolve 時才代表訊息已寫入 Queue；Webhook 會等這個短暫寫入完成，不再把 Gemini 放進 waitUntil。
  await env.LINE_ASSISTANT_QUEUE.send(message, { contentType: "json", delaySeconds: 0 });
  assistantLog("info", "line.queue.enqueued", {
    kind: message.kind,
    webhookEventId: message.webhookEventId,
    groupId: message.lineGroupId,
  });
}

/** Queue consumer 與本機測試共用的 LINE 工作入口。 */
export async function processLineAssistantQueueMessage(message: unknown, env: AppEnv["Bindings"]): Promise<void> {
  if (!isLineAssistantQueueMessage(message)) {
    console.error("LINE Queue 收到無效的工作內容", { message });
    return;
  }
  const contextGeneration = message.contextGeneration ?? "";

  const db = createDatabase(env.DB);
  const channel = await getAssistantLineChannel(db, message.assistantKey);
  if (!channel) {
    console.error("LINE Queue 找不到 channel", { assistantKey: message.assistantKey, channelKey: message.channelKey });
    return;
  }

  const storedAccessToken = channel.accessTokenEncrypted
    ? await decryptLineSecret(channel.accessTokenEncrypted, env.AUTH_SESSION_SECRET)
    : null;
  const accessToken = storedAccessToken || env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!accessToken) {
    assistantLog("warn", "line.queue.skipped", {
      kind: message.kind,
      groupId: message.lineGroupId,
      reason: "missing_access_token",
    });
    return;
  }

  const group = await findAssistantLineGroup(db, { channelKey: message.channelKey, id: message.groupRowId });
  if (!group) {
    console.error("LINE Queue 找不到對話設定", { channelKey: message.channelKey, groupRowId: message.groupRowId });
    return;
  }

  await syncLineGroupProfile({ db, accessToken, channelKey: message.channelKey, group });
  if (message.kind === "profile") return;

  if ((group.contextResetAt ?? "") !== contextGeneration) {
    assistantLog("info", "line.queue.skipped", {
      kind: message.kind,
      groupId: message.lineGroupId,
      reason: "stale_session_generation",
    });
    return;
  }

  // Queue 送出後管理員可能已經關閉 channel 或這個對話；此時不要再回覆一則錯誤訊息。
  if (!channel.enabled || !group.enabled) {
    assistantLog("info", "line.queue.skipped", {
      kind: message.kind,
      groupId: message.lineGroupId,
      reason: "disabled_before_consume",
    });
    return;
  }

  if (message.kind === "reset") {
    await resetPiLineAgent(env, {
      assistantKey: channel.assistantKey,
      channelKey: message.channelKey,
      groupRowId: message.groupRowId,
      lineGroupId: message.lineGroupId,
      sourceType: message.sourceType,
      contextGeneration,
    });
    await replyLineMessage(accessToken, message.replyToken, "已重設這段對話的上下文。");
    return;
  }

  await runLineAssistant({
    db,
    env,
    accessToken,
    replyToken: message.replyToken,
    assistantKey: channel.assistantKey,
    channelKey: message.channelKey,
    groupRowId: message.groupRowId,
    lineGroupId: message.lineGroupId,
    sourceType: message.sourceType,
    questionText: message.questionText,
    webhookEventId: message.webhookEventId,
    runId: message.runId,
    contextGeneration,
    replyDeadlineAt: message.replyDeadlineAt,
  });
}

/** parse 不出來時回這個。用 Symbol 才不會跟「payload 本身就是 null」混淆。 */
const MALFORMED = Symbol("malformed-json");

/** topic 可能藏在 body 裡，所以分派前要先 parse 一次。 */
function safeJson(rawBody: string): unknown {
  try {
    return rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return MALFORMED;
  }
}

async function receive(c: Context<AppEnv>) {
  const declared = Number(c.req.header("content-length") || 0);
  if (declared > MAX_BODY_BYTES) {
    throw new HTTPException(413, { message: "Payload too large" });
  }

  const rawBody = await c.req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    throw new HTTPException(413, { message: "Payload too large" });
  }

  const verified = await verifyCyberbizWebhook(
    c.req.raw,
    rawBody,
    c.env.CYBERBIZ_WEBHOOK_SECRET ?? "",
  );
  if (!verified) throw new HTTPException(401, { message: "Invalid webhook signature or token" });

  /*
   * 壞掉的 JSON 在這裡就擋下來，回 400。
   *
   * 讓它進到分派再由處理函式丟錯的話會變成 500——那是在說「我們壞了」，但實際上
   * 是對方送了壞東西。而且 5xx 會讓 CYBERBIZ 重送，重送一份一樣壞的內容沒有意義。
   */
  const payload = safeJson(rawBody);
  if (payload === MALFORMED) {
    throw new HTTPException(400, { message: "Invalid JSON payload" });
  }

  const outcome = await dispatchCyberbizWebhook(c.get("db"), {
    rawBody,
    topic: readCyberbizTopic(c.req.raw, payload),
    customerClient: cyberbizClient(c.env),
    inventoryClient: cyberbizInventoryClient(c.env),
  });

  /*
   * 官網那邊的庫存動了，快取的目錄就過期了——「CYBERBIZ 庫存」那一頁最多會有
   * 一整天顯示舊數量。跟盤點推上去之後同一個道理。
   *
   * **只看 processed 不夠。** 那一頁列的是官網公司倉的**全部**商品，不是只有
   * 連到 WMS 的那些——所以「沒連結所以 ignored」的事件同樣代表畫面上某個數字
   * 過期了。failed 也一樣：我們沒讀到，但官網那邊確實動過。
   *
   * 所以只排除 duplicate（第一次收到時已經清過了）。清錯的代價只是下次多讀一次
   * 官網，漏清的代價是一整天的錯數字。
   */
  if (outcome.kind === "product" && outcome.status !== "duplicate") {
    await forgetCatalog(cacheClient(c.env));
  }

  /*
   * 處理失敗也回 200。
   *
   * 事件已經落地了，補跑歸我們自己的 cron 管——回 5xx 只會讓 CYBERBIZ 用掉
   * 重送次數，用完之後那筆事件就真的消失了，而我們手上其實還留著它。
   */
  return c.json(outcome);
}

async function receiveLine(c: Context<AppEnv>) {
  const declared = Number(c.req.header("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new HTTPException(413, { message: "Payload too large" });

  const rawBody = await c.req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    throw new HTTPException(413, { message: "Payload too large" });
  }

  const lineChannel = await ensureAssistantLineChannel(c.get("db"), {
    assistantKey: ASSISTANT_KEY,
    defaultToolKeys: LINE_TOOL_KEYS,
  });
  const storedSecret = lineChannel.channelSecretEncrypted
    ? await decryptLineSecret(lineChannel.channelSecretEncrypted, c.env.AUTH_SESSION_SECRET)
    : null;
  const webhookSecret = storedSecret || c.env.LINE_CHANNEL_SECRET;
  if (!webhookSecret) throw new HTTPException(503, { message: "LINE channel 尚未設定 webhook secret。" });

  const storedAccessToken = lineChannel.accessTokenEncrypted
    ? await decryptLineSecret(lineChannel.accessTokenEncrypted, c.env.AUTH_SESSION_SECRET)
    : null;
  const accessToken = storedAccessToken || c.env.LINE_CHANNEL_ACCESS_TOKEN;

  const verified = await verifyLineWebhookSignature(
    rawBody,
    c.req.header("x-line-signature"),
    webhookSecret,
  );
  if (!verified) throw new HTTPException(401, { message: "Invalid LINE webhook signature" });

  let payload: LineWebhookPayload;
  try {
    payload = (rawBody ? JSON.parse(rawBody) : {}) as LineWebhookPayload;
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON payload" });
  }
  if (!Array.isArray(payload.events)) throw new HTTPException(400, { message: "LINE webhook events 格式不正確。" });

  let recorded = 0;
  let duplicates = 0;
  let ignored = 0;
  for (const rawEvent of payload.events) {
    if (!isLineWebhookEvent(rawEvent)) {
      ignored += 1;
      continue;
    }
    const event = rawEvent;
    const rawText = lineEventRawText(event);
    const text = lineEventText(event);
    const group = lineEventGroup(event);
    if (!text || !group || (group.sourceType !== "user" && !lineEventIsMentioned(event))) {
      ignored += 1;
      continue;
    }

    const lineGroup = await upsertAssistantLineGroup(c.get("db"), {
      channelKey: lineChannel.channelKey,
      lineGroupId: group.id,
      sourceType: group.sourceType,
    });
    const webhookEventId = event.webhookEventId || await stableLineWebhookEventId({
      groupId: group.id,
      sourceType: group.sourceType,
      timestamp: event.timestamp,
      messageId: event.message?.id,
      userId: event.source?.userId,
      text,
    });
    const result = await recordAssistantLineMessage(c.get("db"), {
      channelKey: lineChannel.channelKey,
      lineGroupId: lineGroup.lineGroupId,
      sourceType: group.sourceType,
      webhookEventId,
      lineMessageId: event.message?.id,
      lineUserId: event.source?.userId,
      text,
    });
    if (result.inserted) recorded += 1;
    else duplicates += 1;

    const replyToken = event.replyToken?.trim();
    const queueBase = {
      assistantKey: lineChannel.assistantKey,
      channelKey: lineChannel.channelKey,
      groupRowId: lineGroup.id,
      lineGroupId: lineGroup.lineGroupId,
      sourceType: group.sourceType,
      webhookEventId,
      contextGeneration: lineGroup.contextResetAt ?? "",
      replyDeadlineAt: lineReplyDeadlineAt(event.timestamp),
    } as const;
    const profileSyncNeeded = Boolean(
      result.inserted &&
      accessToken &&
      group.sourceType !== "room" &&
      shouldSyncLineGroupProfile(lineGroup),
    );

    if (result.inserted && lineEventIsSessionReset(event)) {
      const resetGroup = await resetAssistantLineContext(c.get("db"), {
        channelKey: lineChannel.channelKey,
        id: lineGroup.id,
      });
      const resetGeneration = resetGroup?.contextResetAt ?? queueBase.contextGeneration;
      if (lineChannel.enabled && lineGroup.enabled && accessToken && replyToken) {
        await enqueueLineAssistantJob(c.env, {
          ...queueBase,
          contextGeneration: resetGeneration,
          kind: "reset",
          replyToken,
        });
      } else if (profileSyncNeeded) {
        await enqueueLineAssistantJob(c.env, { ...queueBase, contextGeneration: resetGeneration, kind: "profile" });
      }
      continue;
    }

    if (result.inserted && lineChannel.enabled && lineGroup.enabled && accessToken && replyToken) {
      const selfMention = event.message?.mention?.mentionees?.find((mentionee) => mentionee.isSelf);
      const questionText = lineQuestionText(rawText ?? text, selfMention).slice(0, 5_000);
      await enqueueLineAssistantJob(c.env, {
        ...queueBase,
        kind: "assistant",
        runId: crypto.randomUUID(),
        replyToken,
        questionText,
      });
    } else {
      if (profileSyncNeeded) {
        await enqueueLineAssistantJob(c.env, { ...queueBase, kind: "profile" });
      }
      if (result.inserted && lineChannel.enabled && lineGroup.enabled && accessToken && !replyToken) {
        assistantLog("warn", "line.reply.skipped", {
          webhookEventId,
          groupId: lineGroup.lineGroupId,
          reason: "missing_reply_token",
        });
      }
    }
  }

  return c.json({ status: "accepted", recorded, duplicates, ignored });
}

/** 給人與監控用的探測點：確認這條路由活著、密鑰有沒有設。 */
function probe(c: Context<AppEnv>) {
  return c.json({
    ok: true,
    integration: "CYBERBIZ webhook",
    configured: Boolean((c.env as Env).CYBERBIZ_WEBHOOK_SECRET),
    events: [
      "會員註冊、會員修改、會員 UID 資料新增／更新、更新會員標籤",
      "商品款式更新（variants/update）",
    ],
  });
}

export const webhooks = new Hono<AppEnv>()
  /** 正式網址。CYBERBIZ 後台的所有事件都設到這裡。 */
  .post("/cyberbiz", receive)
  .get("/cyberbiz", probe)
  .post("/line", receiveLine)

  /*
   * 舊網址，**不要移除**。
   *
   * 它是搬進平台時就設在 CYBERBIZ 後台的那一個，改成 /cyberbiz 之後仍然會有
   * 事件從這裡進來——後台改設定與程式部署不可能同一秒發生，而且以後也可能有
   * 沒改到的地方。收到就照樣處理，比讓事件掉在地上好。
   */
  .post("/cyberbiz/customers", receive)
  .get("/cyberbiz/customers", probe);
