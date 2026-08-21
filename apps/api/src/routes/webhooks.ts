import { readCyberbizTopic, verifyCyberbizWebhook } from "@rueisiang/cyberbiz";
import {
  ensureAssistantDefaults,
  getActiveAssistantPrompt,
  getAssistantConfig,
  ensureAssistantLineChannel,
  listAssistantLineMessages,
  listAssistantToolConfigs,
  processCustomerWebhook,
  recordAssistantRun,
  recordAssistantLineMessage,
  upsertAssistantLineGroup,
} from "@rueisiang/db";
import {
  ASSISTANT_KEY,
  ASSISTANT_MODELS,
  DEFAULT_ASSISTANT_MODEL,
  DEFAULT_ASSISTANT_PROMPT,
  OPEN_METEO_TOOL_KEY,
  openMeteoTool,
  runGemini,
  type AssistantToolDefinition,
} from "@rueisiang/assistant";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { cyberbizClient } from "../cyberbiz.js";
import { decryptLineSecret } from "../line-secrets.js";
import {
  isLineWebhookEvent,
  lineEventGroup,
  lineEventIsMentioned,
  lineEventRawText,
  lineEventText,
  lineQuestionText,
  pushLineMessage,
  replyLineMessage,
  verifyLineWebhookSignature,
  type LineWebhookPayload,
} from "../line.js";

/**
 * CYBERBIZ 送進來的 webhook。
 *
 * 這是整個系統唯一不需要登入的寫入端點，所以驗證要嚴：沒設密鑰就一律不收，
 * 驗不過就 401，兩者都不會透露原因。
 *
 * 路徑沿用舊 CRM 的 /api/webhooks/cyberbiz/customers，切換時只要改網域那一段。
 */

/** 2 MB。正常的會員事件遠小於這個，超過的多半是打錯地方。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LINE_TOOL_DEFINITIONS: AssistantToolDefinition[] = [openMeteoTool];
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
      assistantKey: ASSISTANT_KEY,
      defaultModel: DEFAULT_ASSISTANT_MODEL,
      defaultPrompt: DEFAULT_ASSISTANT_PROMPT,
      toolKeys: [OPEN_METEO_TOOL_KEY],
    });
    const [config, prompt, configuredTools, messages] = await Promise.all([
      getAssistantConfig(input.db, ASSISTANT_KEY),
      getActiveAssistantPrompt(input.db, ASSISTANT_KEY),
      listAssistantToolConfigs(input.db),
      listAssistantLineMessages(input.db, { assistantKey: ASSISTANT_KEY, lineGroupId: input.lineGroupId, limit: 12 }),
    ]);
    modelId = config?.activeModel ?? DEFAULT_ASSISTANT_MODEL;
    const model = LINE_MODEL_MAP.get(modelId);
    if (!model?.supported || !prompt) throw new Error("小香的模型或 prompt 設定目前無法使用。");
    promptRevisionId = prompt.id;

    const enabledTools = new Set(configuredTools.filter((tool) => tool.status === "enabled").map((tool) => tool.key));
    const tools = LINE_TOOL_DEFINITIONS.filter((tool) => enabledTools.has(tool.key));
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
      systemPrompt: prompt.systemPrompt,
      userText: promptText,
      tools,
    });
    if (result.thoughts) {
      console.info("LINE 小香 thought summary", {
        runId,
        groupId: input.lineGroupId,
        thoughts: result.thoughts.slice(0, 12_000),
      });
    }
    await pushLineMessage(input.accessToken, input.lineGroupId, result.text);
    await recordAssistantRun(input.db, {
      id: runId,
      channel: "line",
      groupId: input.lineGroupId,
      model: modelId,
      promptRevisionId,
      inputChars: promptText.length,
      outputChars: result.text.length,
      usage: result.usage,
      status: "success",
      durationMs: Date.now() - started,
      toolCalls: result.toolCalls,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "小香目前無法完成回答。";
    console.error("LINE 小香回覆失敗", { runId, groupId: input.lineGroupId, error });
    try {
      await recordAssistantRun(input.db, {
        id: runId,
        channel: "line",
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

export const webhooks = new Hono<AppEnv>()
  .post("/cyberbiz/customers", async (c) => {
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

    let payload: unknown = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON payload" });
    }

    const topic = readCyberbizTopic(c.req.raw, payload);
    const outcome = await processCustomerWebhook(c.get("db"), {
      rawBody,
      topic,
      client: cyberbizClient(c.env),
    });

    return c.json(outcome);
  })

  /** 給人與監控用的探測點：確認這條路由活著、密鑰有沒有設。 */
  .get("/cyberbiz/customers", (c) => {
    return c.json({
      ok: true,
      integration: "CYBERBIZ 會員 webhook",
      configured: Boolean(c.env.CYBERBIZ_WEBHOOK_SECRET),
      events: ["會員註冊", "會員修改", "會員 UID 資料新增", "會員 UID 資料更新", "更新會員標籤"],
    });
  })

  .post("/line", async (c) => {
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
    if (lineChannel.channelSecretEncrypted && !storedSecret) {
      console.error("LINE Channel Secret 解密失敗，將嘗試環境變數 fallback", { assistantKey: ASSISTANT_KEY });
    }
    const webhookSecret = storedSecret || c.env.LINE_CHANNEL_SECRET;
    if (!webhookSecret) throw new HTTPException(503, { message: "LINE channel 尚未設定 webhook secret。" });
    const storedAccessToken = lineChannel.accessTokenEncrypted
      ? await decryptLineSecret(lineChannel.accessTokenEncrypted, c.env.AUTH_SESSION_SECRET)
      : null;
    if (lineChannel.accessTokenEncrypted && !storedAccessToken) {
      console.error("LINE Channel Access Token 解密失敗，將嘗試環境變數 fallback", { assistantKey: ASSISTANT_KEY });
    }
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
        assistantKey: ASSISTANT_KEY,
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
        assistantKey: ASSISTANT_KEY,
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
        if (event.replyToken) {
          try {
            await replyLineMessage(accessToken, event.replyToken, "收到，正在整理資訊，請稍候…");
          } catch (error) {
            console.error("LINE 收件確認訊息送出失敗", { groupId: lineGroup.lineGroupId, error });
          }
        }
        await scheduleLineAssistant(c, runLineAssistant({
          db: c.get("db"),
          env: c.env,
          accessToken,
          lineGroupId: lineGroup.lineGroupId,
          userText: text,
          questionText,
        }));
      }
    }

    return c.json({ status: "accepted", recorded, duplicates, ignored });
  });
