import {
  ASSISTANT_KEY,
  ASSISTANT_MODELS,
  DEFAULT_ASSISTANT_MODEL,
  DEFAULT_ASSISTANT_PROMPT,
  OPEN_METEO_TOOL_KEY,
  openMeteoTool,
  runGemini,
  summarizeAssistantConversation,
  type AssistantConversationMessage,
  type AssistantToolCall,
  type AssistantToolDefinition,
  type AssistantToolStatus,
} from "@rueisiang/assistant";
import {
  createAssistantPromptRevision,
  appendAssistantSandboxMessage,
  closeAssistantSandboxSession,
  createAssistantSandboxSession,
  ensureAssistantLineChannel,
  ensureAssistantDefaults,
  findAssistantLineGroup,
  getAssistantConfig,
  getAssistantSandboxSession,
  findAssistantPromptRevision,
  getActiveAssistantPrompt,
  listAssistantPromptRevisions,
  listAssistantLineGroups,
  listAllAssistantSandboxMessages,
  listAssistantSandboxMessages,
  listAssistantSandboxSessions,
  listAssistantToolConfigs,
  recordAssistantRun,
  setActiveAssistantModel,
  setAssistantToolStatus,
  updateAssistantLineChannel,
  updateAssistantLineGroup,
  updateAssistantSandboxContext,
  updateAssistantSandboxSessionPromptRevision,
  updateAssistantSandboxSessionModel,
  upsertAssistantLineGroup,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { decryptLineSecret, encryptLineSecret } from "../line-secrets.js";
import { requireAnyPermission, requireAuth, requirePermission } from "../middleware/auth.js";
import { body, requireString } from "../request.js";

const TOOL_DEFINITIONS: AssistantToolDefinition[] = [openMeteoTool];
const TOOL_MAP = new Map(TOOL_DEFINITIONS.map((tool) => [tool.key, tool]));
const MODEL_MAP = new Map(ASSISTANT_MODELS.map((model) => [model.id, model]));
const SANDBOX_CONTEXT_CHAR_LIMIT = 24_000;
const SANDBOX_RECENT_MESSAGE_COUNT = 8;
const SANDBOX_SUMMARY_MAX_CHARS = 8_000;

type SandboxContextMessage = { role: "user" | "model"; text: string };

function contextChars(messages: SandboxContextMessage[]): number {
  return messages.reduce((total, message) => total + message.text.length, 0);
}

function asConversation(messages: SandboxContextMessage[]): AssistantConversationMessage[] {
  return messages.map((message) => ({ role: message.role, text: message.text }));
}

function buildSandboxConversation(
  session: { contextSummary: string; contextSummaryMessageCount: number },
  messages: SandboxContextMessage[],
  userText: string,
): AssistantConversationMessage[] {
  const summary = session.contextSummary.trim().slice(0, SANDBOX_SUMMARY_MAX_CHARS);
  const summaryCount = summary
    ? Math.min(Math.max(session.contextSummaryMessageCount, 0), messages.length)
    : 0;
  const summaryMessages: SandboxContextMessage[] = summary
    ? [
      { role: "user", text: `[Earlier conversation summary]\n${summary}` },
      { role: "model", text: "I will use this summary as background for the current conversation." },
    ]
    : [];
  let retained = messages.slice(summaryCount);
  let context = [...summaryMessages, ...retained];
  while (context.length > 1 && contextChars(context) + userText.length > SANDBOX_CONTEXT_CHAR_LIMIT) {
    if (!retained.length) break;
    retained = retained.slice(1);
    context = [...summaryMessages, ...retained];
  }
  if (contextChars(context) + userText.length > SANDBOX_CONTEXT_CHAR_LIMIT && context.length) {
    const available = Math.max(SANDBOX_CONTEXT_CHAR_LIMIT - userText.length, 1);
    context = context.map((message) => ({ ...message, text: message.text.slice(-available) }));
  }
  return asConversation(context);
}

async function maybeSummarizeSandboxContext(input: {
  db: AppEnv["Variables"]["db"];
  apiKey: string;
  userId: string;
  session: Awaited<ReturnType<typeof getAssistantSandboxSession>>;
  model: string;
  promptRevisionId: string;
  messages: SandboxContextMessage[];
  userText: string;
}): Promise<void> {
  const session = input.session;
  if (!session) return;
  const existingSummary = session.contextSummary.trim();
  const summaryCount = Math.min(Math.max(session.contextSummaryMessageCount, 0), input.messages.length);
  const currentContextChars = existingSummary.length + contextChars(input.messages.slice(summaryCount)) + input.userText.length;
  if (currentContextChars <= SANDBOX_CONTEXT_CHAR_LIMIT) return;

  let cutoff = Math.max(0, input.messages.length - SANDBOX_RECENT_MESSAGE_COUNT);
  if (cutoff <= summaryCount && input.messages.length > 2) cutoff = input.messages.length - 2;
  if (cutoff <= summaryCount) return;

  const messagesToSummarize = input.messages.slice(summaryCount, cutoff);
  const summaryStarted = Date.now();
  try {
    const result = await summarizeAssistantConversation({
      apiKey: input.apiKey,
      model: input.model,
      existingSummary,
      messages: asConversation(messagesToSummarize),
    });
    const summary = result.text.trim().slice(0, SANDBOX_SUMMARY_MAX_CHARS);
    if (!summary) return;
    await updateAssistantSandboxContext(input.db, {
      assistantKey: ASSISTANT_KEY,
      createdBy: input.userId,
      id: session.id,
      contextSummary: summary,
      contextSummaryMessageCount: cutoff,
    });
    try {
      await recordAssistantRun(input.db, {
        id: crypto.randomUUID(),
        channel: "sandbox",
        sessionId: session.id,
        model: input.model,
        promptRevisionId: input.promptRevisionId,
        inputChars: existingSummary.length + contextChars(messagesToSummarize),
        outputChars: summary.length,
        usage: result.usage,
        status: "success",
        durationMs: Date.now() - summaryStarted,
        actorId: input.userId,
        toolCalls: [],
      });
    } catch (error) {
      console.warn("AI Sandbox 摘要用量記錄失敗", { sessionId: session.id, error });
    }
  } catch (error) {
    // A failed compression must not block the user's actual Sandbox request.
    console.warn("AI Sandbox 自動摘要失敗，改用最近對話", { sessionId: session.id, error });
  }
}

function validToolStatus(value: string): value is AssistantToolStatus {
  return value === "enabled" || value === "development" || value === "disabled";
}

async function ensureDefaults(db: AppEnv["Variables"]["db"]): Promise<void> {
  await ensureAssistantDefaults(db, {
    assistantKey: ASSISTANT_KEY,
    defaultModel: DEFAULT_ASSISTANT_MODEL,
    defaultPrompt: DEFAULT_ASSISTANT_PROMPT,
    toolKeys: [OPEN_METEO_TOOL_KEY],
  });
}

async function sandboxConfig(env: AppEnv["Bindings"], db: AppEnv["Variables"]["db"]) {
  await ensureDefaults(db);
  const [assistantConfig, prompts, activePrompt, configuredTools] = await Promise.all([
    getAssistantConfig(db, ASSISTANT_KEY),
    listAssistantPromptRevisions(db, ASSISTANT_KEY),
    getActiveAssistantPrompt(db, ASSISTANT_KEY),
    listAssistantToolConfigs(db),
  ]);
  const statuses = new Map(configuredTools.map((tool) => [tool.key, tool.status]));
  return {
    assistantKey: ASSISTANT_KEY,
    configured: Boolean(env.GEMINI_API_KEY),
    defaultModel: DEFAULT_ASSISTANT_MODEL,
    activeModel: assistantConfig?.activeModel ?? DEFAULT_ASSISTANT_MODEL,
    activeModelUpdatedAt: assistantConfig?.updatedAt ?? null,
    models: ASSISTANT_MODELS,
    tools: TOOL_DEFINITIONS.map((tool) => {
      const configuredStatus = statuses.get(tool.key);
      return {
        key: tool.key,
        label: tool.label,
        description: tool.description,
        status: configuredStatus && validToolStatus(configuredStatus) ? configuredStatus : tool.defaultStatus,
      };
    }),
    activePrompt,
    revisions: prompts,
  };
}

async function lineConfig(c: { env: AppEnv["Bindings"]; req: { url: string }; get: (key: "db") => AppEnv["Variables"]["db"] }) {
  const db = c.get("db");
  const channel = await ensureAssistantLineChannel(db, { assistantKey: ASSISTANT_KEY });
  const groups = await listAssistantLineGroups(db, ASSISTANT_KEY);
  const [storedSecret, storedAccessToken] = await Promise.all([
    channel.channelSecretEncrypted
      ? decryptLineSecret(channel.channelSecretEncrypted, c.env.AUTH_SESSION_SECRET)
      : Promise.resolve(null),
    channel.accessTokenEncrypted
      ? decryptLineSecret(channel.accessTokenEncrypted, c.env.AUTH_SESSION_SECRET)
      : Promise.resolve(null),
  ]);
  const baseUrl = c.env.PUBLIC_APP_URL?.trim() || new URL(c.req.url).origin;
  return {
    channel: {
      assistantKey: channel.assistantKey,
      channelId: channel.channelId,
      displayName: channel.displayName,
      enabled: channel.enabled,
      updatedAt: channel.updatedAt,
    },
    credentials: {
      channelSecretConfigured: Boolean(channel.channelSecretEncrypted || c.env.LINE_CHANNEL_SECRET),
      accessTokenConfigured: Boolean(channel.accessTokenEncrypted || c.env.LINE_CHANNEL_ACCESS_TOKEN),
      channelSecretDecryptionFailed: Boolean(channel.channelSecretEncrypted) && !storedSecret,
      accessTokenDecryptionFailed: Boolean(channel.accessTokenEncrypted) && !storedAccessToken,
    },
    webhookUrl: new URL("/api/webhooks/line", `${baseUrl.replace(/\/$/u, "")}/`).toString(),
    groups: groups.map((group) => ({
      id: group.id,
      lineGroupId: group.lineGroupId,
      displayName: group.displayName,
      enabled: group.enabled,
      discoveredAt: group.discoveredAt,
      updatedAt: group.updatedAt,
    })),
  };
}

async function sandboxSessionResponse(db: AppEnv["Variables"]["db"], input: { id: string; userId: string }) {
  const session = await getAssistantSandboxSession(db, {
    assistantKey: ASSISTANT_KEY,
    createdBy: input.userId,
    id: input.id,
  });
  if (!session) return null;
  const messages = await listAssistantSandboxMessages(db, session.id);
  return {
    id: session.id,
    model: session.model,
    promptRevisionId: session.promptRevisionId,
    status: session.status,
    contextSummaryMessageCount: session.contextSummaryMessageCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    closedAt: session.closedAt,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      model: message.model,
      thoughts: message.thoughts,
      toolCalls: readSandboxToolCalls(message.toolCalls),
      createdAt: message.createdAt,
    })),
  };
}

function readToolKeys(input: Record<string, unknown>): string[] {
  const raw = input.toolKeys;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((key) => typeof key !== "string")) {
    throw new HTTPException(400, { message: "工具清單格式不正確。" });
  }
  const keys = [...new Set(raw.map((key) => key.trim()).filter(Boolean))];
  for (const key of keys) {
    if (!TOOL_MAP.has(key)) throw new HTTPException(400, { message: `不支援的工具：${key}` });
  }
  return keys;
}

function readSandboxToolCalls(value: string): AssistantToolCall[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AssistantToolCall => {
      if (!item || typeof item !== "object") return false;
      const call = item as Record<string, unknown>;
      return typeof call.toolKey === "string"
        && (call.status === "success" || call.status === "failed")
        && typeof call.durationMs === "number";
    });
  } catch {
    return [];
  }
}

export const assistant = new Hono<AppEnv>()
  .use("*", requireAuth)

  .get("/sandbox/config", requireAnyPermission("assistant:sandbox:read", "assistant:settings:read"), async (c) => {
    return c.json(await sandboxConfig(c.env, c.get("db")));
  })

  .get("/sandbox/sessions", requirePermission("assistant:sandbox:read"), async (c) => {
    const sessions = await listAssistantSandboxSessions(c.get("db"), {
      assistantKey: ASSISTANT_KEY,
      createdBy: c.get("user").id,
    });
    return c.json({ sessions: sessions.map((session) => ({
      id: session.id,
      model: session.model,
      promptRevisionId: session.promptRevisionId,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      closedAt: session.closedAt,
    })) });
  })

  .post("/sandbox/sessions", requirePermission("assistant:sandbox:write"), async (c) => {
    const input = await body(c);
    await ensureDefaults(c.get("db"));
    const assistantConfig = await getAssistantConfig(c.get("db"), ASSISTANT_KEY);
    const modelId = typeof input.model === "string" && input.model.trim()
      ? input.model.trim()
      : assistantConfig?.activeModel ?? DEFAULT_ASSISTANT_MODEL;
    const model = MODEL_MAP.get(modelId);
    if (!model || !model.supported) throw new HTTPException(400, { message: "請選擇清單中標示為可用的 Gemini 模型。" });
    const promptId = typeof input.promptRevisionId === "string" && input.promptRevisionId.trim()
      ? input.promptRevisionId.trim()
      : undefined;
    const prompt = promptId
      ? await findAssistantPromptRevision(c.get("db"), promptId)
      : await getActiveAssistantPrompt(c.get("db"), ASSISTANT_KEY);
    if (!prompt || prompt.assistantKey !== ASSISTANT_KEY) throw new HTTPException(400, { message: "找不到這個 system prompt revision。" });
    const createdSession = await createAssistantSandboxSession(c.get("db"), {
      assistantKey: ASSISTANT_KEY,
      createdBy: c.get("user").id,
      model: model.id,
      promptRevisionId: prompt.id,
    });
    return c.json({ session: await sandboxSessionResponse(c.get("db"), { id: createdSession.id, userId: c.get("user").id }) }, 201);
  })

  .get("/sandbox/sessions/:id", requirePermission("assistant:sandbox:read"), async (c) => {
    const session = await sandboxSessionResponse(c.get("db"), { id: c.req.param("id"), userId: c.get("user").id });
    if (!session) throw new HTTPException(404, { message: "找不到這個 Sandbox session。" });
    return c.json({ session });
  })

  .post("/sandbox/sessions/:id/close", requirePermission("assistant:sandbox:write"), async (c) => {
    const current = await getAssistantSandboxSession(c.get("db"), {
      assistantKey: ASSISTANT_KEY,
      createdBy: c.get("user").id,
      id: c.req.param("id"),
    });
    if (!current) throw new HTTPException(404, { message: "找不到這個 Sandbox session。" });
    await closeAssistantSandboxSession(c.get("db"), {
      assistantKey: ASSISTANT_KEY,
      createdBy: c.get("user").id,
      id: current.id,
    });
    return c.json({ session: await sandboxSessionResponse(c.get("db"), { id: current.id, userId: c.get("user").id }) });
  })

  .get("/line/config", requireAnyPermission("assistant:line:read", "assistant:settings:read"), async (c) => {
    return c.json(await lineConfig(c));
  })

  .patch("/line/config", requirePermission("assistant:line:write"), async (c) => {
    const input = await body(c);
    if (typeof input.enabled !== "boolean") {
      throw new HTTPException(400, { message: "LINE channel 是否啟用必須是布林值。" });
    }
    const displayName = requireString(input, "displayName", "顯示名稱");
    if (displayName.length > 120) throw new HTTPException(400, { message: "LINE 顯示名稱不能超過 120 字元。" });
    const channelId = requireString(input, "channelId", "LINE Channel ID");
    if (channelId.length > 120) throw new HTTPException(400, { message: "LINE Channel ID 不能超過 120 字元。" });
    const channelSecret = input.channelSecret === undefined
      ? ""
      : typeof input.channelSecret === "string"
        ? input.channelSecret.trim()
        : requireString(input, "channelSecret", "LINE Channel Secret");
    if (channelSecret.length > 500) throw new HTTPException(400, { message: "LINE Channel Secret 格式不正確。" });
    const accessToken = input.accessToken === undefined
      ? ""
      : typeof input.accessToken === "string"
        ? input.accessToken.trim()
        : requireString(input, "accessToken", "LINE Channel Access Token");
    if (accessToken.length > 2_000) throw new HTTPException(400, { message: "LINE Channel Access Token 格式不正確。" });
    await ensureAssistantLineChannel(c.get("db"), { assistantKey: ASSISTANT_KEY });
    await updateAssistantLineChannel(c.get("db"), {
      assistantKey: ASSISTANT_KEY,
      channelId,
      ...(channelSecret ? { channelSecretEncrypted: await encryptLineSecret(channelSecret, c.env.AUTH_SESSION_SECRET) } : {}),
      ...(accessToken ? { accessTokenEncrypted: await encryptLineSecret(accessToken, c.env.AUTH_SESSION_SECRET) } : {}),
      displayName,
      enabled: input.enabled,
      updatedBy: c.get("user").id,
    });
    return c.json(await lineConfig(c));
  })

  .post("/line/groups", requirePermission("assistant:line:write"), async (c) => {
    const input = await body(c);
    const lineGroupId = requireString(input, "lineGroupId", "LINE 群組 ID");
    if (lineGroupId.length > 255) throw new HTTPException(400, { message: "LINE 群組 ID 不能超過 255 字元。" });
    const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
    if (displayName.length > 120) throw new HTTPException(400, { message: "群組顯示名稱不能超過 120 字元。" });
    await ensureAssistantLineChannel(c.get("db"), { assistantKey: ASSISTANT_KEY });
    const group = await upsertAssistantLineGroup(c.get("db"), { assistantKey: ASSISTANT_KEY, lineGroupId, displayName });
    if (typeof input.enabled === "boolean" || displayName !== group.displayName) {
      const updated = await updateAssistantLineGroup(c.get("db"), {
        assistantKey: ASSISTANT_KEY,
        id: group.id,
        displayName: displayName || group.displayName,
        enabled: typeof input.enabled === "boolean" ? input.enabled : group.enabled,
      });
      return c.json({ group: updated ?? group }, 201);
    }
    return c.json({ group }, 201);
  })

  .patch("/line/groups/:id", requirePermission("assistant:line:write"), async (c) => {
    const id = c.req.param("id");
    const existing = await findAssistantLineGroup(c.get("db"), { assistantKey: ASSISTANT_KEY, id });
    if (!existing) throw new HTTPException(404, { message: "找不到這個 LINE 群組。" });
    const input = await body(c);
    const displayName = input.displayName === undefined ? existing.displayName : requireString(input, "displayName", "群組顯示名稱");
    if (displayName.length > 120) throw new HTTPException(400, { message: "群組顯示名稱不能超過 120 字元。" });
    const enabled = input.enabled === undefined ? existing.enabled : input.enabled;
    if (typeof enabled !== "boolean") throw new HTTPException(400, { message: "群組是否啟用必須是布林值。" });
    const group = await updateAssistantLineGroup(c.get("db"), { assistantKey: ASSISTANT_KEY, id, displayName, enabled });
    return c.json({ group });
  })

  .patch("/config", requirePermission("assistant:settings:write"), async (c) => {
    const input = await body(c);
    const modelId = requireString(input, "model", "模型");
    const model = MODEL_MAP.get(modelId);
    if (!model || !model.supported) {
      throw new HTTPException(400, { message: "只能套用目前清單中標示為可用的模型。" });
    }

    await ensureDefaults(c.get("db"));
    const config = await setActiveAssistantModel(c.get("db"), {
      assistantKey: ASSISTANT_KEY,
      activeModel: model.id,
      updatedBy: c.get("user").id,
    });
    return c.json({ activeModel: config.activeModel, updatedAt: config.updatedAt });
  })

  .patch("/tools/:key", requirePermission("assistant:settings:write"), async (c) => {
    const key = c.req.param("key");
    if (!TOOL_MAP.has(key)) throw new HTTPException(404, { message: `找不到工具：${key}` });

    const input = await body(c);
    const status = input.status;
    if (typeof status !== "string" || !validToolStatus(status)) {
      throw new HTTPException(400, { message: "tool 狀態必須是 enabled、development 或 disabled。" });
    }

    await ensureDefaults(c.get("db"));
    const config = await setAssistantToolStatus(c.get("db"), {
      key,
      status,
      updatedBy: c.get("user").id,
    });
    return c.json({ key: config.key, status: config.status, updatedAt: config.updatedAt });
  })

  .post("/prompts", requirePermission("assistant:sandbox:write"), async (c) => {
    const input = await body(c);
    const prompt = requireString(input, "systemPrompt", "system prompt");
    if (prompt.length > 12_000) throw new HTTPException(400, { message: "system prompt 不能超過 12,000 字元。" });

    await ensureDefaults(c.get("db"));
    const revision = await createAssistantPromptRevision(c.get("db"), {
      assistantKey: ASSISTANT_KEY,
      systemPrompt: prompt,
      createdBy: c.get("user").id,
    });
    return c.json({ revision }, 201);
  })

  .post("/sandbox/run", requirePermission("assistant:sandbox:write"), async (c) => {
    if (!c.env.GEMINI_API_KEY) {
      throw new HTTPException(503, { message: "平台還沒設定 GEMINI_API_KEY，無法執行 Sandbox。" });
    }
    const input = await body(c);
    const userText = requireString(input, "input", "測試內容");
    if (userText.length > 8_000) throw new HTTPException(400, { message: "測試內容不能超過 8,000 字元。" });

    await ensureDefaults(c.get("db"));
    const sessionId = typeof input.sessionId === "string" && input.sessionId.trim() ? input.sessionId.trim() : undefined;
    const session = sessionId
      ? await getAssistantSandboxSession(c.get("db"), { assistantKey: ASSISTANT_KEY, createdBy: c.get("user").id, id: sessionId })
      : null;
    if (sessionId && !session) throw new HTTPException(404, { message: "找不到這個 Sandbox session。" });
    if (session && session.status !== "open") {
      throw new HTTPException(409, { message: "這個 Sandbox session 已關閉，請建立新的 session。" });
    }
    const assistantConfig = await getAssistantConfig(c.get("db"), ASSISTANT_KEY);
    const requestedModel = typeof input.model === "string" && input.model.trim()
      ? input.model.trim()
      : undefined;
    const modelId = requestedModel ?? session?.model ?? assistantConfig?.activeModel ?? DEFAULT_ASSISTANT_MODEL;
    const model = MODEL_MAP.get(modelId);
    if (!model || !model.supported) {
      throw new HTTPException(400, { message: "請選擇清單中標示為可用的 Gemini 模型。" });
    }
    if (session && session.model !== model.id) {
      await updateAssistantSandboxSessionModel(c.get("db"), {
        assistantKey: ASSISTANT_KEY,
        createdBy: c.get("user").id,
        id: session.id,
        model: model.id,
      });
    }

    const requestedPromptId = typeof input.promptRevisionId === "string" && input.promptRevisionId.trim()
      ? input.promptRevisionId.trim()
      : undefined;
    const promptId = requestedPromptId ?? session?.promptRevisionId;
    const prompt = promptId
      ? await findAssistantPromptRevision(c.get("db"), promptId)
      : await getActiveAssistantPrompt(c.get("db"), ASSISTANT_KEY);
    if (!prompt || prompt.assistantKey !== ASSISTANT_KEY) {
      throw new HTTPException(400, { message: "找不到這個 system prompt revision。" });
    }
    if (session && session.promptRevisionId !== prompt.id) {
      await updateAssistantSandboxSessionPromptRevision(c.get("db"), {
        assistantKey: ASSISTANT_KEY,
        createdBy: c.get("user").id,
        id: session.id,
        promptRevisionId: prompt.id,
      });
    }

    const configuredTools = await listAssistantToolConfigs(c.get("db"));
    const statusByKey = new Map(configuredTools.map((tool) => [tool.key, tool.status]));
    const toolKeys = readToolKeys(input);
    const selectedTools = toolKeys.map((key) => {
      const status = statusByKey.get(key) ?? "disabled";
      if (status === "disabled") throw new HTTPException(400, { message: `工具「${key}」目前已停用。` });
      return TOOL_MAP.get(key)!;
    });

    const runId = crypto.randomUUID();
    const started = Date.now();
    const sandboxMessages = session
      ? await listAllAssistantSandboxMessages(c.get("db"), session.id)
      : [];
    if (session) {
      await maybeSummarizeSandboxContext({
        db: c.get("db"),
        apiKey: c.env.GEMINI_API_KEY,
        userId: c.get("user").id,
        session,
        model: model.id,
        promptRevisionId: prompt.id,
        messages: sandboxMessages.map((message) => ({ role: message.role as "user" | "model", text: message.text })),
        userText,
      });
    }
    const refreshedSession = session
      ? await getAssistantSandboxSession(c.get("db"), { assistantKey: ASSISTANT_KEY, createdBy: c.get("user").id, id: session.id })
      : null;
    const conversation = refreshedSession
      ? buildSandboxConversation(
        refreshedSession,
        sandboxMessages.map((message) => ({ role: message.role as "user" | "model", text: message.text })),
        userText,
      )
      : undefined;
    try {
      const result = await runGemini({
        apiKey: c.env.GEMINI_API_KEY,
        model: model.id,
        systemPrompt: prompt.systemPrompt,
        userText,
        conversation,
        tools: selectedTools,
      });
      await recordAssistantRun(c.get("db"), {
        id: runId,
        channel: "sandbox",
        sessionId: session?.id,
        model: model.id,
        promptRevisionId: prompt.id,
        inputChars: userText.length,
        outputChars: result.text.length,
        usage: result.usage,
        status: "success",
        durationMs: Date.now() - started,
        actorId: c.get("user").id,
        toolCalls: result.toolCalls,
      });
      if (session) {
        await appendAssistantSandboxMessage(c.get("db"), { sessionId: session.id, role: "user", text: userText });
        await appendAssistantSandboxMessage(c.get("db"), {
          sessionId: session.id,
          role: "model",
          text: result.text,
          model: model.id,
          thoughts: result.thoughts,
          toolCalls: result.toolCalls,
        });
      }
      return c.json({
        runId,
        sessionId: session?.id ?? null,
        text: result.text,
        thoughts: result.thoughts,
        model: model.id,
        promptRevision: prompt.revision,
        usage: result.usage,
        toolCalls: result.toolCalls,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sandbox 執行失敗。";
      console.error("AI Sandbox 執行失敗", { runId, model: model.id, error });
      await recordAssistantRun(c.get("db"), {
        id: runId,
        channel: "sandbox",
        sessionId: session?.id,
        model: model.id,
        promptRevisionId: prompt.id,
        inputChars: userText.length,
        outputChars: 0,
        usage: { promptTokens: 0, candidateTokens: 0, totalTokens: 0 },
        status: "failed",
        durationMs: Date.now() - started,
        actorId: c.get("user").id,
        errorMessage: message,
        toolCalls: [],
      });
      throw new HTTPException(502, { message });
    }
  });
