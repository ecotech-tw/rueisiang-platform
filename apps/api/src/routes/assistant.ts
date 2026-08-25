import {
  ASSISTANT_KEY,
  ASSISTANT_MODELS,
  DEFAULT_ASSISTANT_PROMPT,
  currentAssistantRuntimeContext,
  runtimeContextInstruction,
  type AssistantToolCall,
  type AssistantToolStatus,
} from "@rueisiang/assistant";
import {
  PLATFORM_TOOL_DEFINITIONS,
  PLATFORM_TOOL_KEYS,
  PLATFORM_TOOL_MAP,
  type PlatformToolDefinition,
} from "@rueisiang/tools";
import {
  createAssistantPromptRevision,
  appendAssistantSandboxMessage,
  closeAssistantSandboxSession,
  createAssistantSandboxSession,
  ensureAssistantLineChannel,
  ensureAssistantDefaults,
  findAssistantLineGroup,
  findMediaObject,
  getAssistantConfig,
  getAssistantSandboxSession,
  findAssistantPromptRevision,
  getActiveAssistantPrompt,
  isAssistantGroupToolMode,
  listAssistantChannelTools,
  listAssistantChatToolKeys,
  listAssistantPromptRevisions,
  listAssistantLineGroups,
  listAssistantSandboxMessages,
  listAssistantSandboxSessions,
  listAssistantToolConfigs,
  recordAssistantRun,
  recordMediaObject,
  setActiveAssistantModel,
  setAssistantChannelTools,
  setAssistantChatTools,
  setAssistantGroupToolMode,
  setAssistantToolStatus,
  updateAssistantLineChannel,
  updateAssistantLineGroup,
  updateAssistantSandboxSessionPromptRevision,
  updateAssistantSandboxSessionModel,
  upsertAssistantLineGroup,
  type AssistantLineSourceType,
  type StoredMediaAttachment,
} from "@rueisiang/db";
import { can, type Permission } from "@rueisiang/auth";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { decryptLineSecret, encryptLineSecret } from "../line-secrets.js";
import { requireAnyPermission, requireAuth, requirePermission } from "../middleware/auth.js";
import {
  DEFAULT_PI_CODEX_MODEL,
  PiAgentRequestError,
  piCodexCredentialConfigured,
  runPiSandboxAgent,
} from "../pi-agent.js";
import {
  isPiCodexModel,
  isPiGeminiModel,
  piAssistantModel,
  piCodexModels,
} from "../pi-agent-models.js";
import { body, requireString } from "../request.js";
import { isNasStorageKey, nasStorageClient } from "../nas-storage.js";

const TOOL_DEFINITIONS: PlatformToolDefinition[] = PLATFORM_TOOL_DEFINITIONS.filter((tool) => tool.surfaces.includes("sandbox"));
const LINE_TOOL_DEFINITIONS: PlatformToolDefinition[] = PLATFORM_TOOL_DEFINITIONS.filter((tool) => tool.surfaces.includes("line"));
const LINE_TOOL_KEYS_LIST = LINE_TOOL_DEFINITIONS.map((tool) => tool.key);
const LINE_TOOL_KEYS = new Set(LINE_TOOL_KEYS_LIST);
const TOOL_MAP = PLATFORM_TOOL_MAP;
const SANDBOX_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const SANDBOX_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const SANDBOX_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

interface UploadedImageFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isAssistantLineSourceType(value: unknown): value is AssistantLineSourceType {
  return value === "group" || value === "room" || value === "user";
}

function validToolStatus(value: string): value is AssistantToolStatus {
  return value === "enabled" || value === "development" || value === "disabled";
}

function configuredAssistantModel(env: AppEnv["Bindings"]): string {
  return resolveSandboxAssistantModelId(env.PI_AGENT_MODEL, DEFAULT_PI_CODEX_MODEL);
}

function activeAssistantModel(
  env: AppEnv["Bindings"],
  activeModel: string | undefined | null,
): string {
  return resolveSandboxAssistantModelId(activeModel, configuredAssistantModel(env));
}

function isExecutableSandboxModel(modelId: string | undefined | null): modelId is string {
  return isPiCodexModel(modelId)
    || (isPiGeminiModel(modelId)
      && ASSISTANT_MODELS.some((model) => model.id === modelId && model.supported));
}

function resolveSandboxAssistantModelId(
  modelId: string | undefined | null,
  fallbackModelId: string,
): string {
  const normalizedModelId = typeof modelId === "string" ? modelId.trim() : modelId;
  return isExecutableSandboxModel(normalizedModelId) ? normalizedModelId : fallbackModelId;
}

type SandboxModelProvider = "openai-codex" | "google";

interface SandboxModelOption {
  id: string;
  label: string;
  category: string;
  quota: { rpm: number; tpm: number; rpd: number; usedRpm?: number; usedTpm?: number; usedRpd?: number };
  provider: SandboxModelProvider;
  supported: boolean;
  configured: boolean;
  supportsVision: boolean;
  note?: string;
}

async function sandboxModelOptions(
  env: AppEnv["Bindings"],
  probeCodexCredential = true,
): Promise<SandboxModelOption[]> {
  const codexConfigured = probeCodexCredential
    ? await piCodexCredentialConfigured(env)
    : false;
  const geminiConfigured = Boolean(env.GEMINI_API_KEY?.trim());
  const codex = piCodexModels().map((model): SandboxModelOption => ({
    id: model.id,
    label: model.name,
    category: "GPT / Codex（ChatGPT OAuth）",
    quota: { rpm: 0, tpm: 0, rpd: 0 },
    provider: "openai-codex",
    supported: true,
    configured: codexConfigured,
    supportsVision: model.input.includes("image"),
    note: "由 Pi Agent 透過 ChatGPT OAuth 使用 Codex credit；實際可用模型依 ChatGPT 帳號方案為準。",
  }));
  const gemini = ASSISTANT_MODELS.map((model): SandboxModelOption => {
    const supportedByPi = isPiGeminiModel(model.id);
    return {
      ...model,
      provider: "google",
      supported: model.supported && supportedByPi,
      configured: geminiConfigured,
      supportsVision: supportedByPi ? piAssistantModel(model.id).input.includes("image") : false,
      ...(!supportedByPi && model.supported
        ? { note: "目前安裝的 Pi Google model catalog 尚未提供這個模型。" }
        : {}),
    };
  });
  return [...codex, ...gemini];
}

async function usableSandboxModel(env: AppEnv["Bindings"], modelId: string): Promise<SandboxModelOption> {
  // Gemini 執行不必為了組完整設定頁，多做一次 credential-vault DO subrequest。
  const codexModel = isPiCodexModel(modelId);
  const model = (await sandboxModelOptions(env, codexModel)).find((candidate) => candidate.id === modelId);
  if (!model?.supported) {
    throw new HTTPException(400, { message: "請選擇清單中標示為可用的 Pi 模型。" });
  }
  if (!model.configured) {
    const credential = model.provider === "openai-codex"
      ? "ChatGPT／Codex OAuth credential"
      : "GEMINI_API_KEY";
    throw new HTTPException(503, { message: `平台尚未設定 ${credential}。` });
  }
  return model;
}

async function ensureDefaults(env: AppEnv["Bindings"], db: AppEnv["Variables"]["db"]): Promise<void> {
  await ensureAssistantDefaults(db, {
    assistantKey: ASSISTANT_KEY,
    defaultModel: configuredAssistantModel(env),
    defaultPrompt: DEFAULT_ASSISTANT_PROMPT,
    toolKeys: PLATFORM_TOOL_KEYS,
  });
}

async function sandboxConfig(env: AppEnv["Bindings"], db: AppEnv["Variables"]["db"]) {
  await ensureDefaults(env, db);
  const [assistantConfig, prompts, activePrompt, configuredTools, models] = await Promise.all([
    getAssistantConfig(db, ASSISTANT_KEY),
    listAssistantPromptRevisions(db, ASSISTANT_KEY),
    getActiveAssistantPrompt(db, ASSISTANT_KEY),
    listAssistantToolConfigs(db),
    sandboxModelOptions(env),
  ]);
  const statuses = new Map(configuredTools.map((tool) => [tool.key, tool.status]));
  return {
    assistantKey: ASSISTANT_KEY,
    configured: models.some((model) => model.supported && model.configured),
    providers: {
      codex: models.some((model) => model.provider === "openai-codex" && model.configured),
      gemini: models.some((model) => model.provider === "google" && model.configured),
    },
    defaultModel: configuredAssistantModel(env),
    activeModel: activeAssistantModel(env, assistantConfig?.activeModel),
    activeModelUpdatedAt: assistantConfig?.updatedAt ?? null,
    models,
    tools: TOOL_DEFINITIONS.map((tool) => {
      const configuredStatus = statuses.get(tool.key);
      return {
        key: tool.key,
        label: tool.label,
        description: tool.description,
        surfaces: tool.surfaces,
        requiredPermissions: tool.requiredPermissions ?? [],
        status: configuredStatus && validToolStatus(configuredStatus) ? configuredStatus : tool.defaultStatus,
      };
    }),
    activePrompt,
    revisions: prompts,
  };
}

async function lineConfig(c: { env: AppEnv["Bindings"]; req: { url: string }; get: (key: "db") => AppEnv["Variables"]["db"] }) {
  const db = c.get("db");
  const channel = await ensureAssistantLineChannel(db, {
    assistantKey: ASSISTANT_KEY,
    defaultToolKeys: LINE_TOOL_KEYS_LIST,
  });
  const groups = await listAssistantLineGroups(db, channel.channelKey);
  const [channelToolRows, configuredTools] = await Promise.all([
    listAssistantChannelTools(db, channel.channelKey),
    listAssistantToolConfigs(db),
  ]);
  /*
   * 只回支援 LINE 的授權。舊版的 0025 seed 會把 sandbox-only 的工具也寫進白名單，
   * 那些鍵值存在 DB 裡但這條路永遠用不到；照實回傳的話，畫面會顯示成「已授權」，
   * 而使用者按儲存時又會被 PUT /line/tools 的 surface 檢查退回，變成怎麼存都失敗。
   */
  const channelTools = channelToolRows.filter((tool) => LINE_TOOL_KEYS.has(tool.toolKey));
  const statuses = new Map(configuredTools.map((tool) => [tool.key, tool.status]));
  const chatToolKeys = new Map(await Promise.all(groups.map(async (group) => [
    group.id,
    group.toolMode === "custom" ? await listAssistantChatToolKeys(db, group.id) : [],
  ] as const)));
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
      channelKey: channel.channelKey,
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
    /*
     * 工具目錄由這支端點自己供應，不要讓畫面去打 /sandbox/config——那支要的是
     * assistant:sandbox:read，只有 LINE 權限的人拿不到，結果會是「一個工具都沒有」
     * 這種看起來像設定錯誤、其實是權限擋住的假象。
     */
    tools: LINE_TOOL_DEFINITIONS.map((tool) => {
      const configuredStatus = statuses.get(tool.key);
      return {
        key: tool.key,
        label: tool.label,
        description: tool.description,
        surfaces: tool.surfaces,
        requiredPermissions: tool.requiredPermissions ?? [],
        status: configuredStatus && validToolStatus(configuredStatus) ? configuredStatus : tool.defaultStatus,
      };
    }),
    /** channel 白名單是 LINE 這條路的授權上限；對話層只能在這個集合裡再縮小。 */
    channelTools: channelTools.map((tool) => tool.toolKey),
    groups: groups.map((group) => ({
      id: group.id,
      lineGroupId: group.lineGroupId,
      sourceType: isAssistantLineSourceType(group.sourceType) ? group.sourceType : "group",
      displayName: group.displayName,
      pictureUrl: group.pictureUrl,
      enabled: group.enabled,
      toolMode: group.toolMode,
      tools: chatToolKeys.get(group.id) ?? [],
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
      attachments: readSandboxAttachments(message.attachments),
      durationMs: message.durationMs,
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

function readSandboxAttachments(value: string): StoredMediaAttachment[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const attachment = item as Record<string, unknown>;
      const key = typeof attachment.key === "string" ? attachment.key : attachment.objectKey;
      if (
        typeof key !== "string"
        || !isNasStorageKey(key)
        || typeof attachment.filename !== "string"
        || typeof attachment.contentType !== "string"
        || typeof attachment.size !== "number"
        || typeof attachment.checksum !== "string"
      ) return [];
      return [{
        key,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        checksum: attachment.checksum,
        expiresAt: typeof attachment.expiresAt === "string" ? attachment.expiresAt : null,
      } satisfies StoredMediaAttachment];
    });
  } catch {
    return [];
  }
}

async function sandboxAttachments(
  db: AppEnv["Variables"]["db"],
  value: unknown,
  userId: string,
): Promise<StoredMediaAttachment[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) {
    throw new HTTPException(400, { message: "圖片附件最多只能有 4 張。" });
  }
  const attachments: StoredMediaAttachment[] = [];
  let totalSize = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") throw new HTTPException(400, { message: "圖片附件格式不正確。" });
    const key = (item as Record<string, unknown>).key;
    if (typeof key !== "string" || !isNasStorageKey(key)) {
      throw new HTTPException(400, { message: "圖片附件 key 不正確。" });
    }
    const media = await findMediaObject(db, key);
    if (!media || media.namespace !== "assistant" || media.createdBy !== userId) {
      throw new HTTPException(403, { message: "沒有使用這張圖片附件的權限。" });
    }
    if (media.expiresAt && Date.parse(media.expiresAt) <= Date.now()) {
      throw new HTTPException(400, { message: `圖片附件「${media.filename}」已過期，請重新上傳。` });
    }
    if (!SANDBOX_IMAGE_TYPES.has(media.contentType)) {
      throw new HTTPException(400, { message: "目前只支援 JPEG、PNG、WebP 或 GIF 圖片。" });
    }
    totalSize += media.size;
    if (totalSize > 10 * 1024 * 1024) {
      throw new HTTPException(400, { message: "單次對話圖片總大小不能超過 10 MB。" });
    }
    attachments.push({
      key: media.objectKey,
      filename: media.filename,
      contentType: media.contentType,
      size: media.size,
      checksum: media.checksum,
      expiresAt: media.expiresAt,
    });
  }
  return attachments;
}

export const assistant = new Hono<AppEnv>()
  .use("*", requireAuth)

  .get("/sandbox/config", requireAnyPermission("assistant:sandbox:read", "assistant:settings:read"), async (c) => {
    return c.json(await sandboxConfig(c.env, c.get("db")));
  })

  .get("/sandbox/attachments", requirePermission("assistant:sandbox:read"), async (c) => {
    const key = c.req.query("key")?.trim();
    if (!key || !isNasStorageKey(key)) throw new HTTPException(400, { message: "圖片附件 key 不正確。" });
    const media = await findMediaObject(c.get("db"), key);
    if (!media || media.namespace !== "assistant" || media.createdBy !== c.get("user").id) {
      throw new HTTPException(404, { message: "找不到這張圖片附件。" });
    }
    if (media.expiresAt && Date.parse(media.expiresAt) <= Date.now()) {
      throw new HTTPException(404, { message: "這張圖片附件已過期。" });
    }
    const nas = nasStorageClient(c.env);
    if (!nas) throw new HTTPException(503, { message: "尚未設定 NAS 圖片儲存空間。" });
    const object = await nas.get(media.objectKey);
    if (!object) throw new HTTPException(404, { message: "圖片檔案已經不在了。" });
    const headers = new Headers(object.headers);
    headers.set("Content-Type", media.contentType);
    headers.set("Cache-Control", "private, max-age=3600");
    return new Response(object.body, { headers });
  })

  .post("/sandbox/attachments", requirePermission("assistant:sandbox:write"), async (c) => {
    const nas = nasStorageClient(c.env);
    if (!nas) throw new HTTPException(503, { message: "尚未設定 NAS 圖片儲存空間。" });
    const form = await c.req.formData();
    const chatId = form.get("chatId");
    if (typeof chatId !== "string" || !chatId.trim()) {
      throw new HTTPException(400, { message: "圖片附件需要指定 Sandbox chat id。" });
    }
    const session = await getAssistantSandboxSession(c.get("db"), {
      assistantKey: ASSISTANT_KEY,
      createdBy: c.get("user").id,
      id: chatId.trim(),
    });
    if (!session) throw new HTTPException(404, { message: "找不到這個 Sandbox session。" });
    if (session.status !== "open") throw new HTTPException(409, { message: "已關閉的 Sandbox session 不能再上傳圖片。" });
    const file = form.get("file") as unknown as UploadedImageFile | string | null;
    if (!file || typeof file === "string") throw new HTTPException(400, { message: "請選擇一張圖片。" });
    if (!SANDBOX_IMAGE_TYPES.has(file.type)) {
      throw new HTTPException(400, { message: "只支援 JPEG、PNG、WebP 或 GIF 圖片。" });
    }
    if (file.size <= 0 || file.size > SANDBOX_IMAGE_MAX_BYTES) {
      throw new HTTPException(400, { message: "圖片大小必須大於 0 且不能超過 5 MB。" });
    }
    const bytes = await file.arrayBuffer();
    const object = await nas.put({
      namespace: "assistant",
      scope: "vision",
      scopeId: session.id,
      contentType: file.type,
      body: bytes,
    });
    const filename = file.name.trim().slice(0, 200) || "image";
    const expiresAt = new Date(Date.now() + SANDBOX_ATTACHMENT_TTL_MS).toISOString();
    let media;
    try {
      media = await recordMediaObject(c.get("db"), {
        objectKey: object.key,
        namespace: "assistant",
        scopeKey: `sandbox:${session.id}`,
        filename,
        contentType: object.contentType,
        size: object.size,
        checksum: object.checksum,
        createdBy: c.get("user").id,
        expiresAt,
      });
    } catch (error) {
      await nas.delete(object.key).catch(() => {});
      throw error;
    }
    return c.json({
      attachment: {
        key: media.objectKey,
        filename: media.filename,
        contentType: media.contentType,
        size: media.size,
        checksum: media.checksum,
        expiresAt: media.expiresAt,
      },
    }, 201);
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
    await ensureDefaults(c.env, c.get("db"));
    const assistantConfig = await getAssistantConfig(c.get("db"), ASSISTANT_KEY);
    const modelId = typeof input.model === "string" && input.model.trim()
      ? input.model.trim()
      : activeAssistantModel(c.env, assistantConfig?.activeModel);
    const model = await usableSandboxModel(c.env, modelId);
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
    const channel = await ensureAssistantLineChannel(c.get("db"), {
      assistantKey: ASSISTANT_KEY,
      defaultToolKeys: LINE_TOOL_KEYS_LIST,
    });
    await updateAssistantLineChannel(c.get("db"), {
      channelKey: channel.channelKey,
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
    const lineGroupId = requireString(input, "lineGroupId", "LINE 對話 ID");
    if (lineGroupId.length > 255) throw new HTTPException(400, { message: "LINE 對話 ID 不能超過 255 字元。" });
    const sourceType = input.sourceType === undefined ? "group" : input.sourceType;
    if (!isAssistantLineSourceType(sourceType)) throw new HTTPException(400, { message: "LINE 對話類型不正確。" });
    const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
    if (displayName.length > 120) throw new HTTPException(400, { message: "對話顯示名稱不能超過 120 字元。" });
    const channel = await ensureAssistantLineChannel(c.get("db"), {
      assistantKey: ASSISTANT_KEY,
      defaultToolKeys: LINE_TOOL_KEYS_LIST,
    });
    const group = await upsertAssistantLineGroup(c.get("db"), { channelKey: channel.channelKey, lineGroupId, sourceType, displayName });
    if (typeof input.enabled === "boolean" || displayName !== group.displayName) {
      const updated = await updateAssistantLineGroup(c.get("db"), {
        channelKey: channel.channelKey,
        displayNameManual: Boolean(displayName),
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
    const channel = await ensureAssistantLineChannel(c.get("db"), {
      assistantKey: ASSISTANT_KEY,
      defaultToolKeys: LINE_TOOL_KEYS_LIST,
    });
    const existing = await findAssistantLineGroup(c.get("db"), { channelKey: channel.channelKey, id });
    if (!existing) throw new HTTPException(404, { message: "找不到這個 LINE 對話。" });
    const input = await body(c);
    const displayName = input.displayName === undefined ? existing.displayName : requireString(input, "displayName", "對話顯示名稱");
    if (displayName.length > 120) throw new HTTPException(400, { message: "對話顯示名稱不能超過 120 字元。" });
    const enabled = input.enabled === undefined ? existing.enabled : input.enabled;
    if (typeof enabled !== "boolean") throw new HTTPException(400, { message: "對話是否啟用必須是布林值。" });
    // 只有真的送了名稱才算人工命名——切開關送的是 { enabled } 而已，不該把名字鎖住。
    const group = await updateAssistantLineGroup(c.get("db"), {
      channelKey: channel.channelKey,
      id,
      displayName,
      enabled,
      displayNameManual: input.displayName !== undefined,
    });
    return c.json({ group });
  })

  /**
   * 設定這個 channel 能用哪些工具——LINE 這條路真正的授權來源。
   *
   * 收回一個工具時不必自己清對話層：`assistant_chat_tools` 的外鍵指向這裡的列，
   * ON DELETE CASCADE 會把底下所有對話的授權一起帶走。
   */
  .put("/line/tools", requirePermission("assistant:line:write"), async (c) => {
    const input = await body(c);
    if (!Array.isArray(input.toolKeys)) throw new HTTPException(400, { message: "toolKeys 必須是陣列。" });
    const toolKeys = input.toolKeys.filter((key): key is string => typeof key === "string");
    const unknown = toolKeys.filter((key) => !TOOL_MAP.has(key));
    if (unknown.length) throw new HTTPException(400, { message: `未知的工具：${unknown.join("、")}` });
    const notOnLine = toolKeys.filter((key) => !TOOL_MAP.get(key)?.surfaces.includes("line"));
    if (notOnLine.length) throw new HTTPException(400, { message: `這些工具不支援 LINE：${notOnLine.join("、")}` });

    const channel = await ensureAssistantLineChannel(c.get("db"), {
      assistantKey: ASSISTANT_KEY,
      defaultToolKeys: LINE_TOOL_KEYS_LIST,
    });
    await setAssistantChannelTools(c.get("db"), {
      channelKey: channel.channelKey,
      toolKeys,
      updatedBy: c.get("user").id,
    });
    return c.json(await lineConfig(c));
  })

  /**
   * 設定單一對話的工具與模式。
   *
   * `inherit` 就是 channel 給的全部；`custom` 才讀這裡設定的清單，而且只認得 channel
   * 已經授權的鍵值——超出的部分在 `setAssistantChatTools` 會被安靜忽略，因為「對話不可能
   * 超過 channel」是這套設計的核心保證，不該讓 API 有辦法繞過。
   */
  .put("/line/groups/:id/tools", requirePermission("assistant:line:write"), async (c) => {
    const id = c.req.param("id");
    const input = await body(c);
    if (!isAssistantGroupToolMode(input.toolMode)) {
      throw new HTTPException(400, { message: "toolMode 必須是 inherit 或 custom。" });
    }
    if (input.toolMode === "custom" && !Array.isArray(input.toolKeys)) {
      throw new HTTPException(400, { message: "custom 模式必須提供 toolKeys 陣列。" });
    }

    const channel = await ensureAssistantLineChannel(c.get("db"), {
      assistantKey: ASSISTANT_KEY,
      defaultToolKeys: LINE_TOOL_KEYS_LIST,
    });
    const existing = await findAssistantLineGroup(c.get("db"), { channelKey: channel.channelKey, id });
    if (!existing) throw new HTTPException(404, { message: "找不到這個 LINE 對話。" });

    await setAssistantGroupToolMode(c.get("db"), { channelKey: channel.channelKey, id, toolMode: input.toolMode });
    if (input.toolMode === "custom") {
      const toolKeys = (input.toolKeys as unknown[]).filter((key): key is string => typeof key === "string");
      await setAssistantChatTools(c.get("db"), {
        channelKey: channel.channelKey,
        groupId: id,
        toolKeys,
        updatedBy: c.get("user").id,
      });
    }
    return c.json(await lineConfig(c));
  })

  .patch("/config", requirePermission("assistant:settings:write"), async (c) => {
    const input = await body(c);
    const modelId = requireString(input, "model", "模型");
    const model = await usableSandboxModel(c.env, modelId);

    await ensureDefaults(c.env, c.get("db"));
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

    await ensureDefaults(c.env, c.get("db"));
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

    await ensureDefaults(c.env, c.get("db"));
    const revision = await createAssistantPromptRevision(c.get("db"), {
      assistantKey: ASSISTANT_KEY,
      systemPrompt: prompt,
      createdBy: c.get("user").id,
    });
    return c.json({ revision }, 201);
  })

  .post("/sandbox/run", requirePermission("assistant:sandbox:write"), async (c) => {
    const input = await body(c);
    const userText = typeof input.input === "string" ? input.input.trim() : "";
    if (userText.length > 8_000) throw new HTTPException(400, { message: "測試內容不能超過 8,000 字元。" });

    await ensureDefaults(c.env, c.get("db"));
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
    const modelId = requestedModel
      ?? session?.model
      ?? activeAssistantModel(c.env, assistantConfig?.activeModel);
    const model = await usableSandboxModel(c.env, modelId);
    const attachments = await sandboxAttachments(c.get("db"), input.attachments, c.get("user").id);
    if (!userText && !attachments.length) {
      throw new HTTPException(400, { message: "請輸入測試內容或附加至少一張圖片。" });
    }
    if (attachments.length && !model.supportsVision) {
      throw new HTTPException(400, { message: "目前選擇的模型不支援圖片輸入，請切換到支援 vision 的模型。" });
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
    for (const key of toolKeys) {
      const status = statusByKey.get(key) ?? "disabled";
      if (status === "disabled") throw new HTTPException(400, { message: `工具「${key}」目前已停用。` });
      const tool = TOOL_MAP.get(key);
      if (!tool || !tool.surfaces.includes("sandbox")) {
        throw new HTTPException(400, { message: `Sandbox 不支援工具：${key}` });
      }
      if (tool.requiredPermissions?.some((permission) => !can(c.get("user"), permission as Permission))) {
        throw new HTTPException(403, { message: `沒有使用工具「${tool.label}」的權限。` });
      }
    }

    const runId = crypto.randomUUID();
    const started = Date.now();
    const systemPrompt = [
      prompt.systemPrompt,
      runtimeContextInstruction(currentAssistantRuntimeContext()),
      "這是內部 Sandbox。請用繁體中文直接回答；需要資料時使用已提供的工具，不要虛構工具結果。",
    ].join("\n\n");
    try {
      const piResponse = await runPiSandboxAgent(c.env, {
        assistantKey: ASSISTANT_KEY,
        conversationId: session?.id ?? runId,
        sandboxSessionId: session?.id ?? null,
        actorUserId: c.get("user").id,
        contextGeneration: session?.createdAt ?? runId,
        runId,
        model: model.id,
        systemPrompt,
        userText,
        toolKeys,
        attachments: attachments.map((attachment) => ({
          key: attachment.key,
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.size,
          checksum: attachment.checksum,
          expiresAt: attachment.expiresAt,
        })),
      });
      const result = piResponse.result;
      const toolFailure = result.toolCalls.find((toolCall) => toolCall.status === "failed");
      await recordAssistantRun(c.get("db"), {
        id: runId,
        channel: "sandbox",
        assistantKey: ASSISTANT_KEY,
        sessionId: session?.id,
        model: model.id,
        promptRevisionId: prompt.id,
        inputChars: userText.length,
        outputChars: result.text.length,
        usage: result.usage,
        status: toolFailure ? "failed" : "success",
        durationMs: Date.now() - started,
        actorId: c.get("user").id,
        ...(toolFailure?.errorMessage ? { errorMessage: toolFailure.errorMessage } : {}),
        toolCalls: result.toolCalls,
      });
      if (session) {
        await appendAssistantSandboxMessage(c.get("db"), {
          sessionId: session.id,
          role: "user",
          text: userText,
          attachments,
        });
        await appendAssistantSandboxMessage(c.get("db"), {
          sessionId: session.id,
          role: "model",
          text: result.text,
          model: model.id,
          thoughts: result.thoughts,
          toolCalls: result.toolCalls,
          durationMs: Date.now() - started,
        });
      }
      return c.json({
        runId,
        sessionId: session?.id ?? null,
        text: result.text,
        thoughts: result.thoughts,
        attachments: attachments.map((attachment) => ({
          key: attachment.key,
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.size,
          checksum: attachment.checksum,
          expiresAt: attachment.expiresAt,
        })),
        model: model.id,
        promptRevision: prompt.revision,
        usage: result.usage,
        toolCalls: result.toolCalls,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sandbox 執行失敗。";
      const failedToolCalls = error instanceof PiAgentRequestError ? error.toolCalls : [];
      await recordAssistantRun(c.get("db"), {
        id: runId,
        channel: "sandbox",
        assistantKey: ASSISTANT_KEY,
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
        toolCalls: failedToolCalls,
      });
      return c.json({
        error: `${message}（診斷編號：${runId}）`,
        runId,
        toolCalls: failedToolCalls,
      }, 502);
    }
  });
