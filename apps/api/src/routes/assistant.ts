import {
  ASSISTANT_KEY,
  ASSISTANT_MODELS,
  DEFAULT_ASSISTANT_MODEL,
  DEFAULT_ASSISTANT_PROMPT,
  OPEN_METEO_TOOL_KEY,
  openMeteoTool,
  runGemini,
  type AssistantToolDefinition,
  type AssistantToolStatus,
} from "@rueisiang/assistant";
import {
  createAssistantPromptRevision,
  ensureAssistantDefaults,
  getAssistantConfig,
  findAssistantPromptRevision,
  getActiveAssistantPrompt,
  listAssistantPromptRevisions,
  listAssistantToolConfigs,
  recordAssistantRun,
  setActiveAssistantModel,
  setAssistantToolStatus,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requireAnyPermission, requireAuth, requirePermission } from "../middleware/auth.js";
import { body, requireString } from "../request.js";

const TOOL_DEFINITIONS: AssistantToolDefinition[] = [openMeteoTool];
const TOOL_MAP = new Map(TOOL_DEFINITIONS.map((tool) => [tool.key, tool]));
const MODEL_MAP = new Map(ASSISTANT_MODELS.map((model) => [model.id, model]));

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

export const assistant = new Hono<AppEnv>()
  .use("*", requireAuth)

  .get("/sandbox/config", requireAnyPermission("assistant:sandbox:read", "assistant:settings:read"), async (c) => {
    return c.json(await sandboxConfig(c.env, c.get("db")));
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
    const assistantConfig = await getAssistantConfig(c.get("db"), ASSISTANT_KEY);
    const modelId = typeof input.model === "string" && input.model.trim()
      ? input.model.trim()
      : assistantConfig?.activeModel ?? DEFAULT_ASSISTANT_MODEL;
    const model = MODEL_MAP.get(modelId);
    if (!model || !model.supported) {
      throw new HTTPException(400, { message: "請選擇清單中標示為可用的 Gemini 模型。" });
    }

    const promptId = typeof input.promptRevisionId === "string" ? input.promptRevisionId : undefined;
    const prompt = promptId
      ? await findAssistantPromptRevision(c.get("db"), promptId)
      : await getActiveAssistantPrompt(c.get("db"), ASSISTANT_KEY);
    if (!prompt || prompt.assistantKey !== ASSISTANT_KEY) {
      throw new HTTPException(400, { message: "找不到這個 system prompt revision。" });
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
    try {
      const result = await runGemini({
        apiKey: c.env.GEMINI_API_KEY,
        model: model.id,
        systemPrompt: prompt.systemPrompt,
        userText,
        tools: selectedTools,
      });
      await recordAssistantRun(c.get("db"), {
        id: runId,
        channel: "sandbox",
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
      return c.json({
        runId,
        text: result.text,
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
