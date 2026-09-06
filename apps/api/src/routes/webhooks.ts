import { readCyberbizTopic, verifyCyberbizWebhook } from "@rueisiang/cyberbiz";
import {
  createDatabase,
  dispatchCyberbizWebhook,
  ensureAssistantDefaults,
  getAssistantConfig,
  getActiveAssistantPrompt,
  getAssistantLineReplyBackup,
  getAssistantLineQueueJob,
  ASSISTANT_LINE_QUEUE_MAX_ATTEMPTS,
  ASSISTANT_LINE_QUEUE_WAITING_ERROR,
  ASSISTANT_LINE_QUEUE_WAITING_TIMEOUT_ERROR,
  ensureAssistantLineChannel,
  getAssistantLineChannel,
  findAssistantLineGroup,
  getAssistantLineMessageByLineMessageId,
  markAssistantLinePushDelivery,
  markAssistantLineQueueJobEnqueued,
  claimAssistantLineQueueJob,
  completeAssistantLineQueueJob,
  failAssistantLineQueueJob,
  findEarlierAssistantLineQueueJob,
  markAssistantLineQueueJobAmbiguous,
  releaseAssistantLineQueueJob,
  requeueStaleAssistantLineQueueJobs,
  listPendingAssistantLineQueueJobs,
  listAssistantLineImageContext,
  listAssistantLineImageFollowUpMessages,
  listAssistantLineMessagesByQuotedMessageId,
  requeueExpiredAssistantLineQuoteJobs,
  recordAssistantLineReplyBackup,
  reserveAssistantLinePushDelivery,
  resolveLineToolKeys,
  recordAssistantRun,
  recordAssistantLineMessage,
  upsertAssistantLineQueueJob,
  resetAssistantLineContext,
  shouldSyncLineGroupProfile,
  updateAssistantLineGroupProfile,
  upsertAssistantLineGroup,
  resumeAssistantLineQueueJob,
  updateAssistantLineMessageImageDownloadStatus,
  waitAssistantLineQueueJob,
  type StoredMediaAttachment,
} from "@rueisiang/db";
import {
  ASSISTANT_KEY,
  ASSISTANT_REPORT_TOOL_ROUTING,
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
import { decryptLineSecret, encryptLineSecret } from "../line-secrets.js";
import { isLineAssistantQueueMessage, type LineAssistantQueueMessage } from "../line-queue.js";
import { cacheClient } from "../upstash.js";
import type { Context } from "hono";
import {
  DEFAULT_PI_CODEX_MODEL,
  PiAgentRequestError,
  PiAgentStaleSessionError,
  resetPiLineAgent,
  runPiLineAgent,
} from "../pi-agent.js";
import { isPiAssistantModel, resolvePiAssistantModelId } from "../pi-agent-models.js";
import {
  isExpiredLineImageAttachment,
  isPermanentLineImageError,
  parseStoredLineImageAttachments,
  storeLineImage,
} from "../line-media.js";
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
  LineMessageError,
  pushLineMessage,
  replyLineMessage,
  verifyLineWebhookSignature,
  type LineLogContext,
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
/** LINE usage endpoint 的數字是 approximate，保留少量緩衝優先避免超過免費額度。 */
const LINE_PUSH_QUOTA_SAFETY_BUFFER = 5;
const LINE_SAFE_PUSH_LIMIT = Math.max(0, LINE_FREE_PUSH_RECIPIENT_LIMIT - LINE_PUSH_QUOTA_SAFETY_BUFFER);
const LINE_PUSH_RETRY_KEY_TTL_MS = 24 * 60 * 60_000;
const LINE_IMAGE_MESSAGE_TEXT = "（使用者傳送了一張圖片）";
const LINE_QUOTE_WAIT_TIMEOUT_MS = 30_000;
const LINE_IMAGE_UNAVAILABLE_NOTE = "圖片目前無法讀取，請直接告知使用者。";

class LinePushRetryKeyExpiredError extends Error {
  constructor() {
    super("LINE retry key 已超過 24 小時安全重送期限，等待 reconciliation。");
    this.name = "LinePushRetryKeyExpiredError";
  }
}

class LineQueueRetryExhaustedError extends Error {
  constructor() {
    super("LINE Queue 工作已達到重試上限，交由 dead-letter queue 追蹤。");
    this.name = "LineQueueRetryExhaustedError";
  }
}

class LineQueueConversationOrderError extends Error {
  constructor(sequence: number, previousSequence: number, previousEventId: string) {
    super(`LINE 對話正在等待較早的訊息完成（sequence ${sequence} 等待 ${previousSequence}）。`);
    this.name = "LineQueueConversationOrderError";
    this.cause = { previousEventId };
  }
}

class LineImageContextPendingError extends Error {
  constructor(imageMessageId: string) {
    super(`LINE 圖片尚未完成保存（${imageMessageId}）。`);
    this.name = "LineImageContextPendingError";
  }
}

function lineReplyDeadlineAt(): number {
  // LINE 的 reply token 有效期是從 webhook 收到開始算，不是 event.timestamp。
  // redelivery 也應該用這次收到的時間重新給 consumer 一個 reply window。
  return Date.now() + LINE_REPLY_TOKEN_TTL_MS;
}

async function stableLineRunId(webhookEventId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(webhookEventId)));
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function isPermanentLineAssistantError(error: unknown): boolean {
  const messages: string[] = [];
  const statuses: number[] = [];
  const permanentFlags: boolean[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "string") {
      messages.push(current);
      break;
    }
    if (typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    const record = current as { message?: unknown; cause?: unknown };
    if (typeof record.message === "string") messages.push(record.message);
    if (typeof (record as { status?: unknown }).status === "number") {
      statuses.push((record as { status: number }).status);
    }
    if (typeof (record as { permanent?: unknown }).permanent === "boolean") {
      permanentFlags.push((record as { permanent: boolean }).permanent);
    }
    current = record.cause;
  }
  const hasPermanentCodexCredentialMessage = messages.some((message) =>
    /PI_(?:OPENAI_CODEX_CREDENTIAL|CREDENTIAL_ENCRYPTION_KEY)|(?:尚未設定|不是合法|缺少|至少需要).*(?:credential|PI_)|無法解密.*(?:Codex|credential)|(?:Codex|ChatGPT).*credential.*(?:無法使用|失效|缺少|錯誤)|credential.*(?:Codex|ChatGPT).*(?:無法使用|失效|缺少|錯誤)/i.test(message));
  return permanentFlags.some(Boolean)
    || statuses.some((status) => [400, 401, 403, 404, 422].includes(status))
    || hasPermanentCodexCredentialMessage
    || messages.some((message) => /gemini[\s_-]*api[\s_-]*key|Gemini 請求格式錯誤|模型設定|模型無法使用|prompt.*設定|對話設定|授權|HTTP\s+(400|401|403|404)/i.test(message));
}

type LineImageMessageRow = {
  messageType: string;
  imageDownloadStatus: string;
  attachments: string;
  text: string;
};

function lineImageErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "line_image_processing_failed").slice(0, 1_000);
}

function resolveLineImageRow(row: LineImageMessageRow | null): {
  attachments: StoredMediaAttachment[];
  pending: boolean;
  unavailable: boolean;
} {
  if (!row || (row.messageType !== "image" && row.text !== LINE_IMAGE_MESSAGE_TEXT)) {
    return { attachments: [], pending: false, unavailable: false };
  }
  if (row.imageDownloadStatus === "pending") return { attachments: [], pending: true, unavailable: false };
  const attachments = parseStoredLineImageAttachments(row.attachments)
    .filter((attachment) => !isExpiredLineImageAttachment(attachment));
  if (attachments.length) return { attachments, pending: false, unavailable: false };
  return { attachments: [], pending: false, unavailable: true };
}

async function stableLineWebhookEventId(input: {
  groupId: string;
  sourceType: string;
  timestamp?: number;
  messageId?: string;
  userId?: string;
  text: string;
  messageType?: string;
  quotedMessageId?: string;
}): Promise<string> {
  const source = [
    input.groupId,
    input.sourceType,
    input.timestamp ?? "",
    input.messageId ?? "",
    input.userId ?? "",
    input.messageType ?? "",
    input.quotedMessageId ?? "",
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
  webhookEventId: string;
  channelKey: string;
  groupRowId: string;
  lineGroupId: string;
  messageId?: string;
  sourceType: "group" | "room" | "user";
  text: string;
  /** Queue outbox 建立時間；超過 LINE retry-key 的 24 小時 dedupe 保證後不可自動 Push。 */
  queueCreatedAt?: string;
}): Promise<LinePushOutcome> {
  const lineLogContext: LineLogContext = {
    runId: input.runId,
    webhookEventId: input.webhookEventId,
    channelKey: input.channelKey,
    groupId: input.lineGroupId,
    groupRowId: input.groupRowId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
  };
  const queueCreatedAtMs = input.queueCreatedAt ? Date.parse(input.queueCreatedAt) : Number.NaN;
  if (Number.isFinite(queueCreatedAtMs)) {
    const retryKeyAgeMs = Date.now() - queueCreatedAtMs;
    if (retryKeyAgeMs >= LINE_PUSH_RETRY_KEY_TTL_MS) {
      assistantLog("warn", "line.push.skipped", {
        ...lineLogContext,
        reason: "retry_key_expired_ambiguous",
        retryKeyAgeMs,
      });
      throw new LinePushRetryKeyExpiredError();
    }
  }
  const windowKey = linePushWindowKey();
  let recipientCount = input.sourceType === "user" ? 1 : 0;
  try {
    recipientCount = await fetchLineChatMemberCount(input.accessToken, input.sourceType, input.lineGroupId, lineLogContext);
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
      limit: LINE_SAFE_PUSH_LIMIT,
      denyReason: "member_count_unavailable",
    });
    assistantLog("warn", "line.push.skipped", {
      runId: input.runId,
      webhookEventId: input.webhookEventId,
      channelKey: input.channelKey,
      groupId: input.lineGroupId,
      reason: "member_count_unavailable",
      error: assistantErrorDetails(error),
    });
    return "member_count_unavailable";
  }

  let remoteUsage: number;
  try {
    remoteUsage = await fetchLinePushUsage(input.accessToken, lineLogContext);
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
      limit: LINE_SAFE_PUSH_LIMIT,
      denyReason: "usage_unavailable",
    });
    assistantLog("warn", "line.push.skipped", {
      runId: input.runId,
      webhookEventId: input.webhookEventId,
      channelKey: input.channelKey,
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
    limit: LINE_SAFE_PUSH_LIMIT,
  });
  if (!reservation.allowed) {
    assistantLog("warn", "line.push.skipped", {
      runId: input.runId,
      webhookEventId: input.webhookEventId,
      channelKey: input.channelKey,
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
    await pushLineMessage(input.accessToken, input.lineGroupId, input.text, input.runId, lineLogContext);
    await markAssistantLinePushDelivery(input.db, { runId: input.runId, status: "sent" });
    assistantLog("info", "line.push.completed", {
      runId: input.runId,
      webhookEventId: input.webhookEventId,
      channelKey: input.channelKey,
      groupId: input.lineGroupId,
      recipientCount,
      windowKey,
    });
    return "sent";
  } catch (error) {
    if (error instanceof LineMessageError && error.accepted) {
      await markAssistantLinePushDelivery(input.db, { runId: input.runId, status: "sent", reason: "line_retry_key_already_accepted" });
      assistantLog("info", "line.push.completed", {
        runId: input.runId,
        webhookEventId: input.webhookEventId,
        channelKey: input.channelKey,
        groupId: input.lineGroupId,
        recipientCount,
        windowKey,
        status: 409,
      });
      return "sent";
    }
    if (error instanceof LineMessageError && error.retryable) {
      // 保留 reserved ledger；Queue retry 會以同一個 runId / retry key 重送。
      assistantLog("warn", "line.push.retry", {
        runId: input.runId,
        webhookEventId: input.webhookEventId,
        channelKey: input.channelKey,
        groupId: input.lineGroupId,
        error: assistantErrorDetails(error),
      });
      throw error;
    }
    await markAssistantLinePushDelivery(input.db, {
      runId: input.runId,
      status: "failed",
      reason: error instanceof Error ? error.message : "line_push_failed",
    });
    assistantLog("warn", "line.push.failed", {
      runId: input.runId,
      webhookEventId: input.webhookEventId,
      channelKey: input.channelKey,
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
  messageId?: string;
  quotedMessageId?: string;
  attachments?: StoredMediaAttachment[];
  persistAttachments?: boolean;
  questionText: string;
  webhookEventId: string;
  runId: string;
  contextGeneration: string;
  replyDeadlineAt?: number;
  queueCreatedAt?: string;
}): Promise<void> {
  const runId = input.runId;
  const trace = {
    runId,
    webhookEventId: input.webhookEventId,
    channelKey: input.channelKey,
    groupId: input.lineGroupId,
    groupRowId: input.groupRowId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
  };
  const started = Date.now();
  let modelId = DEFAULT_PI_CODEX_MODEL;
  let promptRevisionId = "unavailable";
  let promptText = input.questionText;
  const defaultModel = resolvePiAssistantModelId(input.env.PI_AGENT_MODEL, DEFAULT_PI_CODEX_MODEL);
  let replyKind: "final" | "deadline-fallback" | "error" | undefined;
  let replyFailed = false;
  let replyFailureKind: "permanent" | "ambiguous" | undefined;
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
        await replyLineMessage(input.accessToken, input.replyToken, text, trace);
        replyKind = reason;
        assistantLog("info", "line.reply.completed", {
          ...trace,
          reason,
        });
        return true;
      } catch (error) {
        replyFailed = true;
        replyFailureKind = error instanceof LineMessageError && !error.ambiguous ? "permanent" : "ambiguous";
        assistantLog("warn", "line.reply.failed", {
          ...trace,
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
    // Push retry 若已有完整 backup，不需要重新執行 agent；這也避免外部服務暫時異常時重複產生答案。
    const savedBackup = await getAssistantLineReplyBackup(input.db, runId);
    await ensureAssistantDefaults(input.db, {
      assistantKey: input.assistantKey,
      defaultModel,
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
    const configuredModel = resolvePiAssistantModelId(assistantConfig?.activeModel, defaultModel);
    const fallbackModel = isPiAssistantModel(assistantConfig?.fallbackModel)
      && assistantConfig?.fallbackModel !== configuredModel
      ? assistantConfig.fallbackModel
      : undefined;
    modelId = configuredModel;
    if (!prompt) throw new Error("小香的 prompt 設定目前無法使用。");
    promptRevisionId = prompt.id;

    // 最近對話不再由 D1 每輪拼成 prompt；chat 專屬 DO 會還原 Pi transcript 與 compact summary。
    promptText = input.questionText;
    const systemPrompt = [
      prompt.systemPrompt,
      ASSISTANT_REPORT_TOOL_ROUTING,
      runtimeContextInstruction(currentAssistantRuntimeContext()),
      "這是 LINE 內部助理。除非使用者要求詳細說明，請用繁體中文在六句內直接回答；不要輸出思考過程。",
    ].join("\n\n");
    let result: AssistantRunResult;
    if (savedBackup?.responseText) {
      result = {
        text: savedBackup.responseText,
        thoughts: "",
        toolCalls: [],
        usage: { promptTokens: 0, candidateTokens: 0, totalTokens: 0 },
      };
      modelId = savedBackup.model || modelId;
      promptRevisionId = "reused-line-reply-backup";
      assistantLog("info", "line.reply.backup_reused", trace);
    } else {
      const piResponse = await runPiLineAgent(input.env, {
        assistantKey: input.assistantKey,
        channelKey: input.channelKey,
        groupRowId: input.groupRowId,
        lineGroupId: input.lineGroupId,
        sourceType: input.sourceType,
        contextGeneration: input.contextGeneration,
        ...(input.quotedMessageId ? { quotedMessageId: input.quotedMessageId } : {}),
        webhookEventId: input.webhookEventId,
        runId,
        model: configuredModel,
        ...(fallbackModel ? { fallbackModel } : {}),
        systemPrompt,
        userText: promptText,
        toolKeys: allowedToolKeys,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.persistAttachments !== undefined ? { persistAttachments: input.persistAttachments } : {}),
      });
      modelId = piResponse.model;
      result = piResponse.result;
    }
    resultForBackup = result;
    if (result.thoughts) {
      assistantLog("info", "line.thoughts.recorded", {
        ...trace,
        thoughts: result.thoughts.slice(0, 12_000),
      });
    }
    const toolFailure = result.toolCalls.find((toolCall) => toolCall.status === "failed");
    assistantLog("info", "line.reply.started", {
      ...trace,
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
        assistantLog("error", "line.reply.backup_failed", { ...trace, error: assistantErrorDetails(backupError) });
      }

      if (replyFailureKind !== "ambiguous") {
        await deliverLinePush({
          db: input.db,
          accessToken: input.accessToken,
          runId,
          webhookEventId: input.webhookEventId,
          channelKey: input.channelKey,
          groupRowId: input.groupRowId,
          lineGroupId: input.lineGroupId,
          messageId: input.messageId,
          sourceType: input.sourceType,
          text: result.text,
          queueCreatedAt: input.queueCreatedAt,
        });
      } else {
        assistantLog("warn", "line.push.skipped", {
          ...trace,
          reason: "reply_delivery_ambiguous",
        });
      }
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
    assistantLog("error", "line.run.failed", { ...trace, error: assistantErrorDetails(error) });
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
        outputChars: resultForBackup?.text.length ?? 0,
        usage: resultForBackup?.usage ?? { promptTokens: 0, candidateTokens: 0, totalTokens: 0 },
        status: "failed",
        durationMs: Date.now() - started,
        errorMessage: message,
        toolCalls: resultForBackup?.toolCalls
          ?? (error instanceof PiAgentRequestError ? error.toolCalls : []),
      });
    } catch (recordError) {
      assistantLog("error", "line.run.record_failed", { ...trace, error: assistantErrorDetails(recordError) });
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
        assistantLog("error", "line.reply.backup_failed", { ...trace, error: assistantErrorDetails(backupError) });
      }
    }
    // Push 有 retry key，可以安全交給 Queue 重試；Reply 沒有 idempotency，
    // timeout / 5xx 則寧可只留下 backup，也不要冒險再 Push 造成重複回答。
    if (error instanceof LineMessageError && error.endpoint === "push" && error.retryable) throw error;
    if (replyKind || replyFailureKind === "ambiguous") return;
    if (isPermanentLineAssistantError(error) && !replyFailed && Date.now() < replyDeadlineAt) {
      const errorReplySent = await sendReplyOnce("小香目前無法完成回答，請稍後再試。", "error");
      if (errorReplySent) return;
    }
    throw error;
  } finally {
    if (fallbackTimer) clearTimeout(fallbackTimer);
  }
}

async function syncLineGroupProfile(input: {
  db: AppEnv["Variables"]["db"];
  accessToken: string;
  channelKey: string;
  group: NonNullable<Awaited<ReturnType<typeof findAssistantLineGroup>>>;
  trace?: LineLogContext;
}): Promise<void> {
  const group = input.group;
  if (group.sourceType === "room" || !shouldSyncLineGroupProfile(group)) return;

  try {
    const profile = group.sourceType === "group"
      ? await fetchLineGroupSummary(input.accessToken, group.lineGroupId, {
          ...input.trace,
          channelKey: input.channelKey,
          groupId: group.lineGroupId,
          groupRowId: group.id,
        })
      : await fetchLineUserProfile(input.accessToken, group.lineGroupId, {
          ...input.trace,
          channelKey: input.channelKey,
          groupId: group.lineGroupId,
          groupRowId: group.id,
        });
    if (profile) {
      await updateAssistantLineGroupProfile(input.db, {
        channelKey: input.channelKey,
        id: group.id,
        groupName: "groupName" in profile ? profile.groupName : profile.displayName,
        pictureUrl: profile.pictureUrl,
      });
    }
  } catch (error) {
    assistantLog("warn", "line.profile_sync.failed", {
      ...input.trace,
      channelKey: input.channelKey,
      groupId: group.lineGroupId,
      groupRowId: group.id,
      error: assistantErrorDetails(error),
    });
  }
}

function lineQueueTrace(message: LineAssistantQueueMessage): LineLogContext {
  return {
    ...(message.kind === "assistant" ? { runId: message.runId } : {}),
    webhookEventId: message.webhookEventId,
    channelKey: message.channelKey,
    groupId: message.lineGroupId,
    groupRowId: message.groupRowId,
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(message.quotedMessageId ? { quotedMessageId: message.quotedMessageId } : {}),
    ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
  };
}

async function enqueueLineAssistantJob(
  db: AppEnv["Variables"]["db"],
  env: AppEnv["Bindings"],
  message: LineAssistantQueueMessage,
): Promise<void> {
  const payloadEncrypted = await encryptLineSecret(JSON.stringify(message), env.AUTH_SESSION_SECRET);
  const { job, shouldEnqueue } = await upsertAssistantLineQueueJob(db, {
    channelKey: message.channelKey,
    webhookEventId: message.webhookEventId,
    payloadEncrypted,
  });
  if (!shouldEnqueue) {
    assistantLog("info", "line.queue.deduplicated", {
      ...lineQueueTrace(message),
      jobId: job.id,
      kind: message.kind,
      webhookEventId: message.webhookEventId,
      channelKey: message.channelKey,
      groupId: message.lineGroupId,
      status: job.status,
    });
    return;
  }

  // D1 outbox 先落地；Queue.send 失敗時保留 pending，LINE redelivery 或 cron 會補送。
  try {
    await env.LINE_ASSISTANT_QUEUE.send(message, { contentType: "json", delaySeconds: 0 });
    await markAssistantLineQueueJobEnqueued(db, job.id);
  } catch (error) {
    assistantLog("error", "line.queue.enqueue_failed", {
      ...lineQueueTrace(message),
      jobId: job.id,
      kind: message.kind,
      webhookEventId: message.webhookEventId,
      channelKey: message.channelKey,
      groupId: message.lineGroupId,
      error: assistantErrorDetails(error),
    });
    throw error;
  }
  assistantLog("info", "line.queue.enqueued", {
    ...lineQueueTrace(message),
    jobId: job.id,
    kind: message.kind,
    webhookEventId: message.webhookEventId,
    channelKey: message.channelKey,
    groupId: message.lineGroupId,
  });
}

/** 圖片落地後喚醒等待它的工作；工作本身仍會再次 claim，避免重複投遞造成重複回答。 */
async function resumeWaitingLineImageJobs(
  db: AppEnv["Variables"]["db"],
  env: AppEnv["Bindings"],
  input: { channelKey: string; lineGroupId: string; messageId: string; contextResetAt?: string | null },
): Promise<void> {
  const quotedMessages = await listAssistantLineMessagesByQuotedMessageId(db, {
    channelKey: input.channelKey,
    lineGroupId: input.lineGroupId,
    quotedMessageId: input.messageId,
  });
  const imageMessage = await getAssistantLineMessageByLineMessageId(db, {
    channelKey: input.channelKey,
    lineGroupId: input.lineGroupId,
    lineMessageId: input.messageId,
  });
  const followUpMessages = imageMessage
    && (!input.contextResetAt || imageMessage.createdAt > input.contextResetAt)
    ? await listAssistantLineImageFollowUpMessages(db, {
      channelKey: input.channelKey,
      lineGroupId: input.lineGroupId,
      imageSequence: imageMessage.sequence,
      contextResetAt: input.contextResetAt,
    })
    : [];
  // 只喚醒圖片後第一個未引用圖片的文字；後續文字會由 sequence gate 排在它後面。
  const messages = [...quotedMessages, ...(followUpMessages[0] ? [followUpMessages[0]] : [])]
    .sort((left, right) => left.sequence - right.sequence);
  for (const quotedMessage of messages) {
    const job = await getAssistantLineQueueJob(db, {
      channelKey: input.channelKey,
      webhookEventId: quotedMessage.webhookEventId,
    });
    if (!job || job.status !== "waiting") continue;
    await resumeAssistantLineQueueJob(db, job.id);
    try {
      const decrypted = await decryptLineSecret(job.payloadEncrypted, env.AUTH_SESSION_SECRET);
      if (!decrypted) throw new Error("LINE 圖片引用工作 payload 解密失敗。");
      const payload = JSON.parse(decrypted) as unknown;
      if (!isLineAssistantQueueMessage(payload) || payload.kind !== "assistant") {
        throw new Error("LINE 圖片引用工作 payload 格式不正確。");
      }
      await env.LINE_ASSISTANT_QUEUE.send(payload, { contentType: "json", delaySeconds: 0 });
      await markAssistantLineQueueJobEnqueued(db, job.id);
      assistantLog("info", "line.queue.image_context_resumed", {
        ...lineQueueTrace(payload),
        jobId: job.id,
        imageMessageId: input.messageId,
      });
    } catch (error) {
      assistantLog("error", "line.queue.quote_resume_failed", {
        channelKey: input.channelKey,
        groupId: input.lineGroupId,
        jobId: job.id,
        imageMessageId: input.messageId,
        error: assistantErrorDetails(error),
      });
    }
  }
}

/** Cron 用來補送「D1 已記錄但 Queue.send 沒完成」的工作。 */
export async function drainLineAssistantQueueOutbox(
  db: AppEnv["Variables"]["db"],
  env: AppEnv["Bindings"],
): Promise<void> {
  const waitingBefore = new Date(Date.now() - LINE_QUOTE_WAIT_TIMEOUT_MS).toISOString();
  const quoteWaitReleased = await requeueExpiredAssistantLineQuoteJobs(db, { olderThan: waitingBefore });
  if (quoteWaitReleased > 0) {
    assistantLog("warn", "line.queue.quote_wait_expired", {
      count: quoteWaitReleased,
      olderThan: waitingBefore,
    });
  }
  const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
  const requeuedCount = await requeueStaleAssistantLineQueueJobs(db, { olderThan: staleBefore });
  if (requeuedCount > 0) {
    assistantLog("warn", "line.queue.outbox_stale_requeued", {
      count: requeuedCount,
      olderThan: staleBefore,
    });
  }
  const jobs = await listPendingAssistantLineQueueJobs(db, 20);
  for (const job of jobs) {
    try {
      const decrypted = await decryptLineSecret(job.payloadEncrypted, env.AUTH_SESSION_SECRET);
      if (!decrypted) throw new Error("LINE Queue outbox payload 解密失敗。");
      const payload = JSON.parse(decrypted) as unknown;
      if (!isLineAssistantQueueMessage(payload)) throw new Error("LINE Queue outbox payload 格式不正確。");
      const trace = lineQueueTrace(payload);
      await env.LINE_ASSISTANT_QUEUE.send(payload, { contentType: "json", delaySeconds: 0 });
      await markAssistantLineQueueJobEnqueued(db, job.id);
      assistantLog("info", "line.queue.outbox_replayed", {
        ...trace,
        jobId: job.id,
        kind: payload.kind,
        webhookEventId: payload.webhookEventId,
        channelKey: payload.channelKey,
        groupId: payload.lineGroupId,
      });
    } catch (error) {
      assistantLog("error", "line.queue.outbox_replay_failed", {
        jobId: job.id,
        channelKey: job.channelKey,
        webhookEventId: job.webhookEventId,
        error: assistantErrorDetails(error),
      });
    }
  }
}

/** Queue consumer 與本機測試共用的 LINE 工作入口。 */
export async function processLineAssistantQueueMessage(message: unknown, env: AppEnv["Bindings"]): Promise<void> {
  if (!isLineAssistantQueueMessage(message)) {
    assistantLog("error", "line.queue.invalid_message", {
      messageType: typeof message,
      hasObject: Boolean(message && typeof message === "object"),
    });
    return;
  }
  const contextGeneration = message.contextGeneration ?? "";

  const db = createDatabase(env.DB);
  const trace = lineQueueTrace(message);
  if (message.sequence !== undefined) {
    const previous = await findEarlierAssistantLineQueueJob(db, {
      channelKey: message.channelKey,
      lineGroupId: message.lineGroupId,
      sequence: message.sequence,
    });
    if (previous) {
      assistantLog("info", "line.queue.waiting_for_previous", {
        ...trace,
        sequence: message.sequence,
        previousSequence: previous.sequence,
        previousWebhookEventId: previous.webhookEventId,
        previousStatus: previous.status,
      });
      throw new LineQueueConversationOrderError(message.sequence, previous.sequence, previous.webhookEventId);
    }
  }
  const claim = await claimAssistantLineQueueJob(db, {
    channelKey: message.channelKey,
    webhookEventId: message.webhookEventId,
  });
  if (claim && "done" in claim) {
    if (claim.terminal === "failed") throw new LineQueueRetryExhaustedError();
    return;
  }
  if (claim && "job" in claim) {
    assistantLog("info", "line.queue.claimed", {
      ...trace,
      jobId: claim.job.id,
      kind: message.kind,
      attempts: claim.job.attempts,
      webhookEventId: message.webhookEventId,
      channelKey: message.channelKey,
      groupId: message.lineGroupId,
    });
  }

  let processed = false;
  try {
    const channel = await getAssistantLineChannel(db, message.assistantKey);
    if (!channel) {
      assistantLog("error", "line.queue.channel_not_found", {
        ...trace,
        assistantKey: message.assistantKey,
        channelKey: message.channelKey,
        webhookEventId: message.webhookEventId,
        groupId: message.lineGroupId,
      });
      processed = true;
      return;
    }

    const storedAccessToken = channel.accessTokenEncrypted
      ? await decryptLineSecret(channel.accessTokenEncrypted, env.AUTH_SESSION_SECRET)
      : null;
    const accessToken = storedAccessToken || env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!accessToken) {
      assistantLog("warn", "line.queue.skipped", {
        ...trace,
        kind: message.kind,
        webhookEventId: message.webhookEventId,
        channelKey: message.channelKey,
        groupId: message.lineGroupId,
        reason: "missing_access_token",
      });
      processed = true;
      return;
    }

    const group = await findAssistantLineGroup(db, { channelKey: message.channelKey, id: message.groupRowId });
    if (!group) {
      assistantLog("error", "line.queue.group_not_found", {
        ...trace,
        channelKey: message.channelKey,
        groupRowId: message.groupRowId,
        webhookEventId: message.webhookEventId,
        groupId: message.lineGroupId,
      });
      processed = true;
      return;
    }

    await syncLineGroupProfile({
      db,
      accessToken,
      channelKey: message.channelKey,
      group,
      trace: {
        ...(message.kind === "assistant" ? { runId: message.runId } : {}),
        webhookEventId: message.webhookEventId,
        channelKey: message.channelKey,
        groupId: message.lineGroupId,
        groupRowId: message.groupRowId,
        ...(message.messageId ? { messageId: message.messageId } : {}),
      },
    });
    if (message.kind === "profile") {
      processed = true;
      return;
    }

    if ((group.contextResetAt ?? "") !== contextGeneration) {
      assistantLog("info", "line.queue.skipped", {
        ...trace,
        kind: message.kind,
        reason: "stale_session_generation",
      });
      processed = true;
      return;
    }

    // Queue 送出後管理員可能已經關閉 channel 或這個對話；此時不要再回覆一則錯誤訊息。
    if (!channel.enabled || !group.enabled) {
      assistantLog("info", "line.queue.skipped", {
        ...trace,
        kind: message.kind,
        webhookEventId: message.webhookEventId,
        channelKey: message.channelKey,
        groupId: message.lineGroupId,
        reason: "disabled_before_consume",
      });
      processed = true;
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
      await replyLineMessage(accessToken, message.replyToken, "已重設這段對話的上下文。", {
        webhookEventId: message.webhookEventId,
        channelKey: message.channelKey,
        groupId: message.lineGroupId,
        groupRowId: message.groupRowId,
        ...(message.messageId ? { messageId: message.messageId } : {}),
      });
      processed = true;
      return;
    }

    if (message.kind === "media") {
      if (!message.messageId) throw new Error("LINE 圖片 Queue 缺少 message id。");
      try {
        await storeLineImage({
          db,
          env,
          accessToken,
          channelKey: message.channelKey,
          lineGroupId: message.lineGroupId,
          webhookEventId: message.webhookEventId,
          messageId: message.messageId,
          trace,
        });
      } catch (error) {
        const permanent = isPermanentLineImageError(error);
        await updateAssistantLineMessageImageDownloadStatus(db, {
          channelKey: message.channelKey,
          webhookEventId: message.webhookEventId,
          status: permanent ? "failed" : "pending",
          error: lineImageErrorMessage(error),
        });
        if (!permanent) throw error;
        assistantLog("error", "line.image.skipped", {
          ...trace,
          reason: "permanent_content_or_storage_error",
          error: assistantErrorDetails(error),
        });
      }
      await resumeWaitingLineImageJobs(db, env, {
        channelKey: message.channelKey,
        lineGroupId: message.lineGroupId,
        messageId: message.messageId,
        contextResetAt: contextGeneration,
      });
      processed = true;
      return;
    }

    // 舊版可能已經把圖片排成 assistant 工作；相容處理仍只落地，不因圖片事件直接回覆。
    if (message.messageType === "image") {
      if (!message.messageId) throw new Error("LINE 圖片 Queue 缺少 message id。");
      try {
        await storeLineImage({
          db,
          env,
          accessToken,
          channelKey: message.channelKey,
          lineGroupId: message.lineGroupId,
          webhookEventId: message.webhookEventId,
          messageId: message.messageId,
          trace,
        });
      } catch (error) {
        const permanent = isPermanentLineImageError(error);
        await updateAssistantLineMessageImageDownloadStatus(db, {
          channelKey: message.channelKey,
          webhookEventId: message.webhookEventId,
          status: permanent ? "failed" : "pending",
          error: lineImageErrorMessage(error),
        });
        if (!permanent) throw error;
        assistantLog("error", "line.image.skipped", {
          ...trace,
          reason: "permanent_content_or_storage_error",
          error: assistantErrorDetails(error),
        });
      }
      await resumeWaitingLineImageJobs(db, env, {
        channelKey: message.channelKey,
        lineGroupId: message.lineGroupId,
        messageId: message.messageId,
        contextResetAt: contextGeneration,
      });
      processed = true;
      return;
    }

    const attachments: StoredMediaAttachment[] = [];
    let questionText = message.questionText;
    let imageUnavailable = false;
    let imagePending = false;
    if (message.quotedMessageId) {
      const quotedMessage = await getAssistantLineMessageByLineMessageId(db, {
        channelKey: message.channelKey,
        lineGroupId: message.lineGroupId,
        lineMessageId: message.quotedMessageId,
      });
      if (!quotedMessage) {
        imagePending = true;
      } else {
        const resolved = resolveLineImageRow(quotedMessage);
        attachments.push(...resolved.attachments);
        imagePending = resolved.pending;
        imageUnavailable = resolved.unavailable;
      }
      if (imageUnavailable) {
        questionText = `${questionText} ${LINE_IMAGE_UNAVAILABLE_NOTE}`;
        assistantLog("warn", "line.image.quote_unavailable", {
          ...trace,
          quotedMessageId: message.quotedMessageId,
          reason: "expired_or_failed",
        });
      }
    } else {
      const recentImages = await listAssistantLineImageContext(db, {
        channelKey: message.channelKey,
        lineGroupId: message.lineGroupId,
        beforeSequence: message.sequence ?? Number.MAX_SAFE_INTEGER,
        contextResetAt: contextGeneration,
        limit: 4,
      });
      for (const image of recentImages) {
        const resolved = resolveLineImageRow(image);
        attachments.push(...resolved.attachments);
        imagePending ||= resolved.pending;
        imageUnavailable ||= resolved.unavailable;
      }
      if (imageUnavailable) questionText = `${questionText} ${LINE_IMAGE_UNAVAILABLE_NOTE}`;
    }
    const quoteWaitTimedOut = claim && "job" in claim
      && claim.job.lastError === ASSISTANT_LINE_QUEUE_WAITING_TIMEOUT_ERROR;
    if (imagePending && !quoteWaitTimedOut) {
      throw new LineImageContextPendingError(message.quotedMessageId ?? "recent-line-image");
    }
    if (imagePending && quoteWaitTimedOut) {
      questionText = `${questionText} ${LINE_IMAGE_UNAVAILABLE_NOTE}`;
      assistantLog("warn", "line.image.wait_timeout", {
        ...trace,
        ...(message.quotedMessageId ? { quotedMessageId: message.quotedMessageId } : {}),
      });
    }
    const inputAttachments = attachments.slice(0, 4);

    await runLineAssistant({
      db,
      env,
      accessToken,
      replyToken: message.replyToken,
      assistantKey: channel.assistantKey,
      channelKey: message.channelKey,
      groupRowId: message.groupRowId,
      lineGroupId: message.lineGroupId,
      messageId: message.messageId,
      ...(message.quotedMessageId ? { quotedMessageId: message.quotedMessageId } : {}),
      ...(inputAttachments.length ? { attachments: inputAttachments } : {}),
      persistAttachments: message.sourceType === "user",
      sourceType: message.sourceType,
      questionText,
      webhookEventId: message.webhookEventId,
      runId: message.runId,
      contextGeneration,
      replyDeadlineAt: message.replyDeadlineAt,
      queueCreatedAt: claim && "job" in claim ? claim.job.createdAt : undefined,
    });
    processed = true;
  } catch (error) {
    if (claim && "job" in claim) {
      const errorMessage = error instanceof Error ? error.message : "line_queue_processing_failed";
      if (error instanceof LineImageContextPendingError) {
        await waitAssistantLineQueueJob(db, {
          id: claim.job.id,
          claimToken: claim.claimToken,
          error: ASSISTANT_LINE_QUEUE_WAITING_ERROR,
        });
        assistantLog("info", "line.queue.waiting_for_image", {
          ...trace,
          jobId: claim.job.id,
          kind: message.kind,
          webhookEventId: message.webhookEventId,
          channelKey: message.channelKey,
          groupId: message.lineGroupId,
          attempts: claim.job.attempts,
          error: assistantErrorDetails(error),
        });
        return;
      }
      if (error instanceof LinePushRetryKeyExpiredError) {
        await markAssistantLineQueueJobAmbiguous(db, {
          id: claim.job.id,
          claimToken: claim.claimToken,
          error: errorMessage,
        });
        assistantLog("warn", "line.queue.ambiguous", {
          ...trace,
          jobId: claim.job.id,
          kind: message.kind,
          webhookEventId: message.webhookEventId,
          channelKey: message.channelKey,
          groupId: message.lineGroupId,
          reason: "retry_key_expired_ambiguous",
          error: assistantErrorDetails(error),
        });
        return;
      }

      const exhausted = claim.job.attempts >= ASSISTANT_LINE_QUEUE_MAX_ATTEMPTS;
      if (exhausted && (message.kind === "media" || message.messageType === "image")) {
        await updateAssistantLineMessageImageDownloadStatus(db, {
          channelKey: message.channelKey,
          webhookEventId: message.webhookEventId,
          status: "failed",
          error: errorMessage,
        }).catch((statusError) => {
          assistantLog("error", "line.image.status_update_failed", {
            ...trace,
            reason: "retry_exhausted",
            error: assistantErrorDetails(statusError),
          });
        });
      }
      if (exhausted) {
        await failAssistantLineQueueJob(db, {
          id: claim.job.id,
          claimToken: claim.claimToken,
          error: errorMessage,
        });
      } else {
        await releaseAssistantLineQueueJob(db, {
          id: claim.job.id,
          claimToken: claim.claimToken,
          error: errorMessage,
        });
      }
      assistantLog(exhausted ? "error" : "warn", exhausted ? "line.queue.retry_exhausted" : "line.queue.retry_scheduled", {
        ...trace,
        jobId: claim.job.id,
        kind: message.kind,
        webhookEventId: message.webhookEventId,
        channelKey: message.channelKey,
        groupId: message.lineGroupId,
        attempts: claim.job.attempts,
        maxAttempts: ASSISTANT_LINE_QUEUE_MAX_ATTEMPTS,
        terminal: exhausted,
        error: assistantErrorDetails(error),
      });
    }
    throw error;
  } finally {
    if (processed && claim && "job" in claim) {
      try {
        await completeAssistantLineQueueJob(db, { id: claim.job.id, claimToken: claim.claimToken });
      } catch (error) {
        assistantLog("error", "line.queue.complete_failed", {
          ...trace,
          jobId: claim.job.id,
          kind: message.kind,
          webhookEventId: message.webhookEventId,
          channelKey: message.channelKey,
          groupId: message.lineGroupId,
          error: assistantErrorDetails(error),
        });
        throw error;
      }
      assistantLog("info", "line.queue.completed", {
        ...trace,
        jobId: claim.job.id,
        kind: message.kind,
        webhookEventId: message.webhookEventId,
        channelKey: message.channelKey,
        groupId: message.lineGroupId,
      });
    }
  }
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
   * 官網那邊的庫存動了，快取的目錄就過期了——後續用 SKU 連結品項或做目錄鏡像時，
   * 最多會有一整天讀到舊數量。跟盤點推上去之後同一個道理。
   *
   * **只看 processed 不夠。** 目錄快取是官網公司倉的**全部**商品，不是只有
   * 連到 WMS 的那些——所以「沒連結所以 ignored」的事件同樣代表某個快取數字
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
  assistantLog("info", "line.webhook.received", { eventCount: payload.events.length });

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
    const messageId = typeof event.message?.id === "string" ? event.message.id.trim() : undefined;
    const quotedMessageId = typeof event.message?.quotedMessageId === "string"
      ? event.message.quotedMessageId.trim()
      : undefined;
    const isImage = event.type === "message"
      && event.message?.type === "image"
      && event.message.contentProvider?.type !== "external"
      && Boolean(messageId);
    if (!group || (!text && !isImage) || (group.sourceType !== "user" && !lineEventIsMentioned(event) && !isImage)) {
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
      messageId,
      userId: event.source?.userId,
      text: text ?? LINE_IMAGE_MESSAGE_TEXT,
      messageType: event.message?.type,
      quotedMessageId,
    });
    const replyToken = typeof event.replyToken === "string" ? event.replyToken.trim() : undefined;
    const conversationEnabled = Boolean(lineChannel.enabled && lineGroup.enabled && accessToken);
    const assistantRequired = conversationEnabled
      && Boolean(replyToken)
      && !isImage
      && (group.sourceType === "user" || lineEventIsMentioned(event));
    const queueRequired = conversationEnabled && (assistantRequired || isImage);
    const result = await recordAssistantLineMessage(c.get("db"), {
      channelKey: lineChannel.channelKey,
      lineGroupId: lineGroup.lineGroupId,
      sourceType: group.sourceType,
      webhookEventId,
      lineMessageId: messageId,
      lineUserId: event.source?.userId,
      quotedMessageId,
      messageType: isImage ? "image" : "text",
      text: text ?? LINE_IMAGE_MESSAGE_TEXT,
      imageDownloadStatus: isImage && conversationEnabled ? "pending" : "none",
      queueRequired,
    });
    if (result.inserted) recorded += 1;
    else duplicates += 1;
    assistantLog("info", "line.event.recorded", {
      webhookEventId,
      channelKey: lineChannel.channelKey,
      groupId: lineGroup.lineGroupId,
      sourceType: group.sourceType,
      messageId: event.message?.id ?? null,
      inserted: result.inserted,
    });

    const queueBase = {
      assistantKey: lineChannel.assistantKey,
      channelKey: lineChannel.channelKey,
      groupRowId: lineGroup.id,
      lineGroupId: lineGroup.lineGroupId,
      sourceType: group.sourceType,
      webhookEventId,
      contextGeneration: lineGroup.contextResetAt ?? "",
      ...(messageId ? { messageId } : {}),
      ...(quotedMessageId ? { quotedMessageId } : {}),
      messageType: isImage ? "image" : "text",
      replyDeadlineAt: lineReplyDeadlineAt(),
      ...(result.message.sequence > 0 ? { sequence: result.message.sequence } : {}),
    } as const;
    const profileSyncNeeded = Boolean(
      result.inserted &&
      accessToken &&
      group.sourceType !== "room" &&
      shouldSyncLineGroupProfile(lineGroup),
    );

    const sessionReset = lineEventIsSessionReset(event);
    let resetGeneration = queueBase.contextGeneration;
    if (result.inserted && sessionReset) {
      const resetGroup = await resetAssistantLineContext(c.get("db"), {
        channelKey: lineChannel.channelKey,
        id: lineGroup.id,
      });
      resetGeneration = resetGroup?.contextResetAt ?? resetGeneration;
    }
    if (sessionReset) {
      if (lineChannel.enabled && lineGroup.enabled && accessToken && replyToken) {
        await enqueueLineAssistantJob(c.get("db"), c.env, {
          ...queueBase,
          contextGeneration: resetGeneration,
          kind: "reset",
          replyToken,
        });
      } else if (profileSyncNeeded) {
        await enqueueLineAssistantJob(c.get("db"), c.env, {
          ...queueBase,
          contextGeneration: resetGeneration,
          kind: "profile",
        });
      }
      continue;
    }

    if (conversationEnabled && replyToken && assistantRequired) {
      const selfMention = event.message?.mention?.mentionees?.find((mentionee) => mentionee.isSelf);
      const questionText = lineQuestionText(rawText ?? text ?? "", selfMention).slice(0, 5_000);
      await enqueueLineAssistantJob(c.get("db"), c.env, {
        ...queueBase,
        kind: "assistant",
        runId: await stableLineRunId(webhookEventId),
        replyToken,
        questionText,
      });
    } else if (isImage && conversationEnabled && messageId) {
      await enqueueLineAssistantJob(c.get("db"), c.env, {
        ...queueBase,
        kind: "media",
        messageId,
        messageType: "image",
      });
    } else {
      if (profileSyncNeeded) {
        await enqueueLineAssistantJob(c.get("db"), c.env, { ...queueBase, kind: "profile" });
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
