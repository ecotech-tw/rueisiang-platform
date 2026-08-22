import { readCyberbizTopic, verifyCyberbizWebhook } from "@rueisiang/cyberbiz";
import {
  dispatchCyberbizWebhook,
  ensureAssistantDefaults,
  getActiveAssistantPrompt,
  getAssistantConfig,
  ensureAssistantLineChannel,
  findAssistantLineGroup,
  listAssistantLineMessages,
  resolveLineToolKeys,
  recordAssistantRun,
  recordAssistantLineMessage,
  upsertAssistantLineGroup,
} from "@rueisiang/db";
import {
  ASSISTANT_KEY,
  ASSISTANT_MODELS,
  DEFAULT_ASSISTANT_MODEL,
  DEFAULT_ASSISTANT_PROMPT,
  currentAssistantRuntimeContext,
  runGemini,
} from "@rueisiang/assistant";
import { PLATFORM_TOOL_KEYS, toolsForSurface } from "@rueisiang/tools";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { forgetCatalog } from "../cyberbiz-catalog.js";
import { cyberbizClient, cyberbizInventoryClient } from "../cyberbiz.js";
import type { AppEnv, Env } from "../env.js";
import { decryptLineSecret } from "../line-secrets.js";
import { cacheClient } from "../upstash.js";
import type { Context } from "hono";
import {
  isLineWebhookEvent,
  lineEventGroup,
  lineEventIsMentioned,
  lineEventRawText,
  lineEventText,
  lineQuestionText,
  pushLineMessage,
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
const LINE_TOOL_DEFINITIONS = toolsForSurface("line");
const LINE_MODEL_MAP = new Map(ASSISTANT_MODELS.map((model) => [model.id, model]));

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

async function runLineAssistant(input: {
  db: AppEnv["Variables"]["db"];
  env: AppEnv["Bindings"];
  accessToken: string;
  assistantKey: string;
  channelKey: string;
  /** 群組那一列的 id，不是 LINE 的群組 id——對話層的工具授權掛在這個 id 上。 */
  groupRowId: string;
  lineGroupId: string;
  userText: string;
  questionText: string;
}): Promise<void> {
  const runId = crypto.randomUUID();
  const started = Date.now();
  let modelId = DEFAULT_ASSISTANT_MODEL;
  let promptRevisionId = "unavailable";
  let promptText = input.questionText;
  try {
    if (!input.env.GEMINI_API_KEY) throw new Error("平台還沒設定 GEMINI_API_KEY。");
    await ensureAssistantDefaults(input.db, {
      assistantKey: input.assistantKey,
      defaultModel: DEFAULT_ASSISTANT_MODEL,
      defaultPrompt: DEFAULT_ASSISTANT_PROMPT,
      toolKeys: PLATFORM_TOOL_KEYS,
    });
    /*
     * toolMode 在這裡重讀，不採信收 webhook 當下那一份。
     *
     * 這條路是排程執行的，收件與回答之間隔著一段時間；管理員在那之間把群組從 inherit
     * 改成 custom 的話，用舊值等於讓這一輪照舊拿到 channel 的全部工具。授權每次執行都
     * 回 DB 重讀是這個 codebase 的既定原則（CLAUDE.md），LINE 這條也不例外。
     */
    const group = await findAssistantLineGroup(input.db, { channelKey: input.channelKey, id: input.groupRowId });
    if (!group) throw new Error("找不到這個 LINE 群組的設定。");
    if (!group.enabled) throw new Error("這個 LINE 群組已經被取消授權。");

    const [config, prompt, allowedToolKeys, messages] = await Promise.all([
      getAssistantConfig(input.db, input.assistantKey),
      getActiveAssistantPrompt(input.db, input.assistantKey),
      resolveLineToolKeys(input.db, {
        channelKey: input.channelKey,
        groupId: input.groupRowId,
        toolMode: group.toolMode,
      }),
      listAssistantLineMessages(input.db, { channelKey: input.channelKey, lineGroupId: input.lineGroupId, limit: 12 }),
    ]);
    modelId = config?.activeModel ?? DEFAULT_ASSISTANT_MODEL;
    const model = LINE_MODEL_MAP.get(modelId);
    if (!model?.supported || !prompt) throw new Error("小香的模型或 prompt 設定目前無法使用。");
    promptRevisionId = prompt.id;

    // resolveLineToolKeys 已經把「全域狀態 ∩ channel 白名單 ∩ 對話白名單」收斂完了，
    // 這裡只負責把鍵值換成實際的工具定義，不要在這條路上長出第二套判斷。
    const allowed = new Set(allowedToolKeys);
    const tools = LINE_TOOL_DEFINITIONS.filter((tool) => allowed.has(tool.key));
    const context = messages
      .map((message) => message.text.length > 1_000 ? `${message.text.slice(0, 1_000)}…` : message.text)
      .join("\n");
    const contextPreamble = "以下是同一個 LINE 群組中最近的提及訊息，請把它們視為使用者提供的對話內容：";
    const questionPreamble = "請回答這次最新問題：";
    const fixedPrompt = [contextPreamble, questionPreamble, input.questionText].join("\n");
    const contextBudget = Math.max(0, 8_000 - fixedPrompt.length);
    const boundedContext = context.length > contextBudget ? context.slice(-contextBudget) : context;
    promptText = [contextPreamble, boundedContext, questionPreamble, input.questionText].join("\n");

    const result = await runGemini({
      apiKey: input.env.GEMINI_API_KEY,
      model: modelId,
      runId,
      systemPrompt: prompt.systemPrompt,
      runtimeContext: currentAssistantRuntimeContext(),
      userText: promptText,
      tools,
      toolContext: { surface: "line", db: input.db, env: input.env },
    });
    if (result.thoughts) {
      console.info("LINE 小香 thought summary", {
        runId,
        groupId: input.lineGroupId,
        thoughts: result.thoughts.slice(0, 12_000),
      });
    }
    const toolFailure = result.toolCalls.find((toolCall) => toolCall.status === "failed");
    await pushLineMessage(input.accessToken, input.lineGroupId, result.text);
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
    try {
      await pushLineMessage(input.accessToken, input.lineGroupId, "小香目前無法完成回答，請稍後再試。");
    } catch (pushError) {
      console.error("LINE 錯誤提示也無法送出", { runId, groupId: input.lineGroupId, error: pushError });
    }
  }
}

function scheduleLineAssistant(c: { executionCtx: { waitUntil(promise: Promise<unknown>): void } }, job: Promise<void>): Promise<void> {
  try {
    c.executionCtx.waitUntil(job);
    return Promise.resolve();
  } catch {
    // 本機 node:http 與單元測試沒有 ExecutionContext，改成等待完成讓行為可驗證。
    return job;
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

  const lineChannel = await ensureAssistantLineChannel(c.get("db"), { assistantKey: ASSISTANT_KEY });
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
    if (!text || !group || !lineEventIsMentioned(event)) {
      ignored += 1;
      continue;
    }

    const lineGroup = await upsertAssistantLineGroup(c.get("db"), {
      channelKey: lineChannel.channelKey,
      lineGroupId: group.id,
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

    if (result.inserted && lineChannel.enabled && lineGroup.enabled && accessToken) {
      const selfMention = event.message?.mention?.mentionees?.find((mentionee) => mentionee.isSelf);
      const questionText = lineQuestionText(rawText ?? text, selfMention);
      await scheduleLineAssistant(c, runLineAssistant({
        db: c.get("db"),
        env: c.env,
        accessToken,
        assistantKey: lineChannel.assistantKey,
        channelKey: lineChannel.channelKey,
        groupRowId: lineGroup.id,
        lineGroupId: lineGroup.lineGroupId,
        userText: text,
        questionText,
      }));
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
