import {
  Agent,
  convertToLlm,
  createCompactionSummaryMessage,
  estimateTokens,
  generateSummaryWithUsage,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
  ProviderResponse,
  Usage,
} from "@earendil-works/pi-ai";
import {
  findAssistantLineGroup,
  getAssistantSandboxSession,
  getAssistantLineChannel,
  listAssistantLineMessages,
  listAllAssistantSandboxMessages,
  listAssistantSandboxMessages,
  listAssistantToolConfigs,
  loadAuthUser,
  resolveLineToolKeys,
  createDatabase,
} from "@rueisiang/db";
import { can, type Permission } from "@rueisiang/auth";
import { PLATFORM_TOOL_MAP } from "@rueisiang/tools";
import { Type, type TSchema } from "typebox";
import type { AssistantRunResult, AssistantToolCall, JsonSchemaProperty } from "@rueisiang/assistant";
import type { Env } from "./env.js";
import type {
  PiLineAgentResetRequest,
  PiLineAgentResetResponse,
  PiLineAgentRunRequest,
  PiAgentRunRequest,
  PiAgentRunResponse,
  PiSandboxAgentRunRequest,
} from "./pi-agent-contract.js";
import {
  PI_CODEX_PROVIDER_ID,
  piAssistantModel,
  streamPiAssistantModel,
} from "./pi-agent-models.js";
import {
  type PiErrorDiagnostic,
  type PiProviderExecutionDiagnostics,
  type PiProviderResponseDiagnostic,
  providerResponseDiagnostic,
  publicPiErrorMessage,
  serializePiError,
} from "./pi-agent-diagnostics.js";

const COMPACT_AFTER_TOKENS = 48_000;
const COMPACT_KEEP_RECENT_TOKENS = 12_000;
const FORCE_COMPACT_AFTER_TOKENS = 80_000;
const MODEL_REQUEST_TIMEOUT_MS = 25_000;
const MODEL_MAX_OUTPUT_TOKENS = 1_200;
const LINE_MAX_REPLY_CHARS = 4_500;

interface AgentStateRow extends Record<string, SqlStorageValue> {
  generation: string;
  session_id: string;
  summary: string;
  summary_through_seq: number;
  summary_tokens: number;
  tokens_before: number;
  model: string;
}

interface AgentMessageRow extends Record<string, SqlStorageValue> {
  seq: number;
  payload: string;
}

interface AgentRunRow extends Record<string, SqlStorageValue> {
  status: string;
  response_json: string;
}

interface CountRow extends Record<string, SqlStorageValue> {
  count: number;
}

interface SandboxBootstrapMessage {
  role: "user" | "model";
  text: string;
  model?: string;
}

interface ToolExecutionContext {
  request: PiAgentRunRequest;
  toolCalls: AssistantToolCall[];
}

class AgentExecutionError extends Error {
  readonly errorDiagnostic: PiErrorDiagnostic;

  constructor(
    message: string,
    readonly toolCalls: AssistantToolCall[],
    readonly providerResponse?: PiProviderResponseDiagnostic,
    errorDiagnostic?: PiErrorDiagnostic,
  ) {
    super(publicPiErrorMessage(new Error(message), providerResponse));
    this.name = "AgentExecutionError";
    this.errorDiagnostic = errorDiagnostic ?? serializePiError(new Error(message));
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isLineContext(value: Record<string, unknown>): boolean {
  return nonEmptyString(value.assistantKey)
    && nonEmptyString(value.channelKey)
    && nonEmptyString(value.groupRowId)
    && nonEmptyString(value.lineGroupId)
    && (value.sourceType === "group" || value.sourceType === "room" || value.sourceType === "user")
    && typeof value.contextGeneration === "string";
}

function isSandboxContext(value: Record<string, unknown>): boolean {
  return nonEmptyString(value.assistantKey)
    && nonEmptyString(value.conversationId)
    && (value.sandboxSessionId === null || nonEmptyString(value.sandboxSessionId))
    && nonEmptyString(value.actorUserId)
    && nonEmptyString(value.contextGeneration);
}

function isRunFields(input: Record<string, unknown>): boolean {
  return nonEmptyString(input.runId)
    && nonEmptyString(input.model)
    && nonEmptyString(input.systemPrompt)
    && typeof input.userText === "string"
    && Array.isArray(input.toolKeys)
    && input.toolKeys.every(nonEmptyString);
}

function isRunRequest(value: unknown): value is PiAgentRunRequest {
  const input = object(value);
  if (!input || !isRunFields(input)) return false;
  if (isLineContext(input)) return nonEmptyString(input.webhookEventId);
  return isSandboxContext(input);
}

function isResetRequest(value: unknown): value is PiLineAgentResetRequest {
  const input = object(value);
  return Boolean(input && isLineContext(input));
}

function isLineRunRequest(input: PiAgentRunRequest): input is PiLineAgentRunRequest {
  return "channelKey" in input;
}

function isSandboxRunRequest(input: PiAgentRunRequest): input is PiSandboxAgentRunRequest {
  return "conversationId" in input;
}

function parseMessage(payload: string): AgentMessage | undefined {
  try {
    const parsed = object(JSON.parse(payload));
    return parsed && nonEmptyString(parsed.role) ? parsed as unknown as AgentMessage : undefined;
  } catch {
    return undefined;
  }
}

function contextMessage(message: AgentMessage): boolean {
  return message.role !== "assistant"
    || (message.stopReason !== "error" && message.stopReason !== "aborted");
}

function schemaProperty(property: JsonSchemaProperty): TSchema {
  const options = { description: property.description };
  if (property.enum?.length) {
    return Type.Union(property.enum.map((value) => Type.Literal(value)), options);
  }
  if (property.type === "boolean") return Type.Boolean(options);
  if (property.type === "integer") return Type.Integer(options);
  if (property.type === "number") return Type.Number(options);
  return Type.String(options);
}

function toolSchema(parameters: { properties: Record<string, JsonSchemaProperty>; required?: string[] }): TSchema {
  const required = new Set(parameters.required ?? []);
  return Type.Object(Object.fromEntries(Object.entries(parameters.properties).map(([key, property]) => {
    const schema = schemaProperty(property);
    return [key, required.has(key) ? schema : Type.Optional(schema)];
  })));
}

function toolErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("CYBERBIZ API ")) return error.message.slice(0, 300);
  return "工具執行失敗。";
}

function textContent(message: AssistantMessage): string {
  return message.content
    .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("")
    .trim();
}

function thoughtContent(messages: AgentMessage[]): string {
  return messages.flatMap((message) => message.role === "assistant"
    ? message.content.flatMap((item) => item.type === "thinking" ? [item.thinking] : [])
    : []).join("\n\n").trim();
}

function addUsage(total: Usage, usage: Usage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function bootstrapAgentMessage(
  message: SandboxBootstrapMessage,
  fallbackModel: Model<Api>,
  timestamp: number,
): AgentMessage {
  if (message.role === "user") return { role: "user", content: message.text, timestamp };
  let model = fallbackModel;
  if (message.model) {
    try {
      model = piAssistantModel(message.model);
    } catch {
      // 舊 session 可能留著已下架的 model id；文字歷史仍可匯入，provider metadata 用本輪模型即可。
    }
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: message.text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp,
  };
}

function assistantUsage(messages: AgentMessage[]): AssistantRunResult["usage"] {
  const usage = emptyUsage();
  for (const message of messages) {
    if (message.role === "assistant") addUsage(usage, message.usage);
  }
  return {
    promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    candidateTokens: usage.output,
    totalTokens: usage.totalTokens,
  };
}

function boundedReply(text: string): string {
  return text.length <= LINE_MAX_REPLY_CHARS ? text : `${text.slice(0, LINE_MAX_REPLY_CHARS - 1)}…`;
}

function payloadWithOutputLimit(payload: unknown): unknown {
  const body = object(payload);
  if (!body) return payload;
  return {
    ...body,
    max_output_tokens: MODEL_MAX_OUTPUT_TOKENS,
    text: { ...object(body.text), verbosity: "low" },
  };
}

/**
 * Pi 0.84.2 的 AgentHarness durable API 尚未實作；這裡使用已完整可用的 Pi Agent，
 * transcript 由 chat 專屬 SQLite DO 保存，工具迴圈、訊息格式與 compaction 則沿用 Pi。
 */
export class AssistantChatAgent {
  private readonly sql: SqlStorage;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS assistant_agent_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          generation TEXT NOT NULL,
          session_id TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          summary_through_seq INTEGER NOT NULL DEFAULT 0,
          summary_tokens INTEGER NOT NULL DEFAULT 0,
          tokens_before INTEGER NOT NULL DEFAULT 0,
          model TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assistant_agent_messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          generation TEXT NOT NULL,
          run_id TEXT NOT NULL,
          role TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS assistant_agent_messages_generation_seq
          ON assistant_agent_messages (generation, seq);
        CREATE TABLE IF NOT EXISTS assistant_agent_runs (
          run_id TEXT PRIMARY KEY,
          generation TEXT NOT NULL,
          status TEXT NOT NULL,
          response_json TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL
        )
      `);
    });
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private currentState(): AgentStateRow | undefined {
    return [...this.sql.exec<AgentStateRow>(
      `SELECT generation, session_id, summary, summary_through_seq, summary_tokens, tokens_before, model
       FROM assistant_agent_state WHERE singleton = 1 LIMIT 1`,
    )][0];
  }

  private rotateGeneration(generation: string): AgentStateRow {
    const sessionId = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO assistant_agent_state
         (singleton, generation, session_id, summary, summary_through_seq, summary_tokens, tokens_before, model, updated_at)
       VALUES (1, ?, ?, '', 0, 0, 0, '', ?)
       ON CONFLICT(singleton) DO UPDATE SET
         generation = excluded.generation,
         session_id = excluded.session_id,
         summary = '',
         summary_through_seq = 0,
         summary_tokens = 0,
         tokens_before = 0,
         model = '',
         updated_at = excluded.updated_at`,
      generation,
      sessionId,
      Date.now(),
    );
    return {
      generation,
      session_id: sessionId,
      summary: "",
      summary_through_seq: 0,
      summary_tokens: 0,
      tokens_before: 0,
      model: "",
    };
  }

  private requireGeneration(generation: string): { state: AgentStateRow; rotated: boolean } {
    const current = this.currentState();
    if (!current) return { state: this.rotateGeneration(generation), rotated: true };
    if (generation === current.generation) return { state: current, rotated: false };
    if (generation < current.generation) throw new Error("這則工作屬於已重設的舊 session，已略過。");
    return { state: this.rotateGeneration(generation), rotated: true };
  }

  private loadMessageRows(state: AgentStateRow): Array<{ seq: number; message: AgentMessage }> {
    return [...this.sql.exec<AgentMessageRow>(
      `SELECT messages.seq, messages.payload
       FROM assistant_agent_messages AS messages
       INNER JOIN assistant_agent_runs AS runs
         ON runs.run_id = messages.run_id AND runs.generation = messages.generation
       WHERE messages.generation = ? AND messages.seq > ? AND runs.status = 'completed'
       ORDER BY messages.seq ASC`,
      state.generation,
      state.summary_through_seq,
    )].flatMap((row) => {
      const message = parseMessage(row.payload);
      return message && contextMessage(message) ? [{ seq: row.seq, message }] : [];
    });
  }

  private contextMessages(state: AgentStateRow): AgentMessage[] {
    return [
      ...(state.summary ? [createCompactionSummaryMessage(state.summary, state.tokens_before, Date.now())] : []),
      ...this.loadMessageRows(state).map((row) => row.message),
    ];
  }

  private async accessToken(): Promise<string> {
    const namespace = this.env.ASSISTANT_CREDENTIAL_VAULT;
    if (!namespace) throw new Error("平台尚未綁定 ASSISTANT_CREDENTIAL_VAULT Durable Object。");
    const response = await namespace.getByName(PI_CODEX_PROVIDER_ID).fetch(new Request(
      "https://assistant-credential.internal/access-token",
      { method: "POST" },
    ));
    const payload = object(await response.json().catch(() => null));
    if (!response.ok || !nonEmptyString(payload?.accessToken)) {
      throw new Error(nonEmptyString(payload?.error) ? payload.error : "OpenAI Codex credential 無法使用。");
    }
    return payload.accessToken;
  }

  private model(modelId: string): Model<Api> {
    return piAssistantModel(modelId);
  }

  private streamModel(
    model: Model<Api>,
    context: Context,
    options: ModelsSimpleStreamOptions = {},
    diagnostics?: PiProviderExecutionDiagnostics,
  ) {
    const shared = {
      ...options,
      timeoutMs: options.timeoutMs ?? MODEL_REQUEST_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? 0,
      maxTokens: options.maxTokens ?? MODEL_MAX_OUTPUT_TOKENS,
    };
    const onResponse = async (response: ProviderResponse, responseModel: Model<Api>) => {
      const observed = providerResponseDiagnostic(responseModel, response);
      if (diagnostics) diagnostics.lastResponse = observed;
      console.info("Pi provider response", {
        ...(diagnostics?.runId ? { runId: diagnostics.runId } : {}),
        ...observed,
      });
      await options.onResponse?.(response, responseModel);
    };
    const providerOptions = model.provider === PI_CODEX_PROVIDER_ID
      ? { ...shared, transport: "sse" as const, onPayload: payloadWithOutputLimit, onResponse }
      : { ...shared, onPayload: undefined, onResponse };
    return streamPiAssistantModel(model, context, providerOptions, {
      resolveCodexAccessToken: async () => this.accessToken(),
      geminiApiKey: this.env.GEMINI_API_KEY,
    });
  }

  /** Pi compaction 只需要 Models.completeSimple；同一段 session 換 provider 後也由當下 model 建摘要。 */
  private summaryModels(diagnostics?: PiProviderExecutionDiagnostics): Models {
    return {
      completeSimple: async (model, context, options) => this.streamModel(model, context, {
        ...options,
        timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
        maxRetries: 0,
      }, diagnostics).result(),
    } as Models;
  }

  private async authorizedLineTool(input: PiLineAgentRunRequest, toolKey: string, args: unknown): Promise<string> {
    const db = createDatabase(this.env.DB);
    const [channel, group] = await Promise.all([
      getAssistantLineChannel(db, input.assistantKey),
      findAssistantLineGroup(db, { channelKey: input.channelKey, id: input.groupRowId }),
    ]);
    if (!channel || channel.channelKey !== input.channelKey || !channel.enabled) {
      throw new Error("LINE channel 目前沒有啟用。");
    }
    if (!group
      || group.lineGroupId !== input.lineGroupId
      || group.sourceType !== input.sourceType
      || (group.contextResetAt ?? "") !== input.contextGeneration
      || !group.enabled) {
      throw new Error("LINE 對話目前沒有啟用，或 session 已被重設。");
    }
    const allowed = await resolveLineToolKeys(db, {
      channelKey: input.channelKey,
      groupId: input.groupRowId,
      toolMode: group.toolMode,
    });
    if (!allowed.includes(toolKey)) throw new Error("這個工具目前沒有授權給這個 LINE 對話。");
    const tool = PLATFORM_TOOL_MAP.get(toolKey);
    if (!tool || !tool.surfaces.includes("line")) throw new Error("找不到這個 LINE 工具。");
    return tool.execute(args, { surface: "line", db, env: this.env });
  }

  private async authorizedSandboxTool(input: PiSandboxAgentRunRequest, toolKey: string, args: unknown): Promise<string> {
    const db = createDatabase(this.env.DB);
    const [user, configuredTools, session] = await Promise.all([
      loadAuthUser(db, { id: input.actorUserId }),
      listAssistantToolConfigs(db),
      input.sandboxSessionId
        ? getAssistantSandboxSession(db, {
          assistantKey: input.assistantKey,
          createdBy: input.actorUserId,
          id: input.sandboxSessionId,
        })
        : Promise.resolve(null),
    ]);
    if (!user || user.status !== "active") throw new Error("Sandbox 使用者已停權或不存在。");
    if (input.sandboxSessionId && (!session
      || session.status !== "open"
      || session.createdAt !== input.contextGeneration)) {
      throw new Error("Sandbox session 已關閉、已更換，或不屬於這位使用者。");
    }
    const status = configuredTools.find((configured) => configured.key === toolKey)?.status ?? "disabled";
    if (status === "disabled") throw new Error("這個 Sandbox 工具目前已停用。");
    const tool = PLATFORM_TOOL_MAP.get(toolKey);
    if (!tool || !tool.surfaces.includes("sandbox")) throw new Error("找不到這個 Sandbox 工具。");
    if (tool.requiredPermissions?.some((permission) => !can(user, permission as Permission))) {
      throw new Error("使用者目前沒有執行這個 Sandbox 工具的權限。");
    }
    return tool.execute(args, { surface: "sandbox", db, env: this.env, user });
  }

  private authorizedTool(input: PiAgentRunRequest, toolKey: string, args: unknown): Promise<string> {
    return isLineRunRequest(input)
      ? this.authorizedLineTool(input, toolKey, args)
      : this.authorizedSandboxTool(input, toolKey, args);
  }

  private tools(context: ToolExecutionContext): AgentTool[] {
    const surface = isLineRunRequest(context.request) ? "line" : "sandbox";
    return [...new Set(context.request.toolKeys)].flatMap((toolKey) => {
      const tool = PLATFORM_TOOL_MAP.get(toolKey);
      if (!tool || !tool.surfaces.includes(surface)) return [];
      const agentTool: AgentTool = {
        name: tool.key,
        label: tool.label,
        description: tool.description,
        parameters: toolSchema(tool.parameters),
        executionMode: "sequential",
        execute: async (_toolCallId, args, signal) => {
          const started = Date.now();
          signal?.throwIfAborted();
          try {
            const result = await this.authorizedTool(context.request, tool.key, args);
            context.toolCalls.push({
              toolKey: tool.key,
              status: "success",
              args: args as Record<string, unknown>,
              durationMs: Date.now() - started,
            });
            return { content: [{ type: "text", text: result }], details: { toolKey: tool.key } };
          } catch (error) {
            const errorMessage = toolErrorMessage(error);
            console.error("Pi agent 工具執行失敗", {
              runId: context.request.runId,
              toolKey: tool.key,
              error: serializePiError(error),
            });
            context.toolCalls.push({
              toolKey: tool.key,
              status: "failed",
              args: args as Record<string, unknown>,
              durationMs: Date.now() - started,
              errorMessage,
            });
            throw new Error(errorMessage);
          }
        },
      };
      return [agentTool];
    });
  }

  private storeMessage(generation: string, runId: string, message: AgentMessage): void {
    this.sql.exec(
      `INSERT INTO assistant_agent_messages (generation, run_id, role, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      generation,
      runId,
      message.role,
      JSON.stringify(message),
      Date.now(),
    );
  }

  private async bootstrapSandboxTranscript(
    state: AgentStateRow,
    input: PiSandboxAgentRunRequest,
    model: Model<Api>,
  ): Promise<void> {
    if (!input.sandboxSessionId) return;
    const count = [...this.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM assistant_agent_messages WHERE generation = ?",
      state.generation,
    )][0]?.count ?? 0;
    if (count > 0) return;

    const db = createDatabase(this.env.DB);
    const session = await getAssistantSandboxSession(db, {
      assistantKey: input.assistantKey,
      createdBy: input.actorUserId,
      id: input.sandboxSessionId,
    });
    if (!session
      || session.status !== "open"
      || session.createdAt !== input.contextGeneration) {
      throw new Error("Sandbox session 已關閉、已更換，或不屬於這位使用者。");
    }
    // 摘要筆數是對完整升冪 D1 transcript 計算；先取完整序列再切掉摘要涵蓋的 prefix，
    // 才不會因為最新視窗只有 100 筆而把已摘要的舊訊息重新送進 Pi context。
    const history = session.contextSummary.trim()
      ? (await listAllAssistantSandboxMessages(db, session.id))
        .slice(Math.max(session.contextSummaryMessageCount, 0))
        .slice(-100)
      : await listAssistantSandboxMessages(db, session.id, 100);
    const bootstrapMessages: SandboxBootstrapMessage[] = [
      ...(session.contextSummary.trim()
        ? [
          { role: "user" as const, text: `[Earlier conversation summary]\n${session.contextSummary.trim()}` },
          { role: "model" as const, text: "我會把這份摘要當成目前對話的既有背景。", model: session.model },
        ]
        : []),
      ...history.map((message) => ({
        role: message.role as "user" | "model",
        text: message.text,
        ...(message.model ? { model: message.model } : {}),
      })),
    ];
    if (!bootstrapMessages.length) return;

    const bootstrapRunId = `bootstrap:${state.generation}`;
    this.sql.exec(
      `INSERT OR IGNORE INTO assistant_agent_runs
         (run_id, generation, status, response_json, updated_at)
       VALUES (?, ?, 'completed', '', ?)`,
      bootstrapRunId,
      state.generation,
      Date.now(),
    );
    const started = Date.now() - bootstrapMessages.length;
    for (const [index, message] of bootstrapMessages.entries()) {
      if (!message.text) continue;
      this.storeMessage(
        state.generation,
        bootstrapRunId,
        bootstrapAgentMessage(message, model, started + index),
      );
    }
  }

  private async bootstrapLineTranscript(
    state: AgentStateRow,
    input: PiLineAgentRunRequest,
    model: Model<Api>,
  ): Promise<void> {
    const count = [...this.sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM assistant_agent_messages WHERE generation = ?",
      state.generation,
    )][0]?.count ?? 0;
    if (count > 0) return;

    const db = createDatabase(this.env.DB);
    const history = await listAssistantLineMessages(db, {
      channelKey: input.channelKey,
      lineGroupId: input.lineGroupId,
      contextResetAt: input.contextGeneration,
      limit: 50,
    });
    const bootstrapMessages: SandboxBootstrapMessage[] = history
      .filter((message) => message.webhookEventId !== input.webhookEventId)
      .map((message) => ({ role: "user" as const, text: message.text }));
    if (!bootstrapMessages.length) return;

    const bootstrapRunId = `bootstrap:${state.generation}`;
    this.sql.exec(
      `INSERT OR IGNORE INTO assistant_agent_runs
         (run_id, generation, status, response_json, updated_at)
       VALUES (?, ?, 'completed', '', ?)`,
      bootstrapRunId,
      state.generation,
      Date.now(),
    );
    const started = Date.now() - bootstrapMessages.length;
    for (const [index, message] of bootstrapMessages.entries()) {
      if (!message.text) continue;
      this.storeMessage(
        state.generation,
        bootstrapRunId,
        bootstrapAgentMessage(message, model, started + index),
      );
    }
  }

  private totalContextTokens(state: AgentStateRow): number {
    return this.contextMessages(state).reduce((total, message) => total + estimateTokens(message), 0);
  }

  private async compactIfNeeded(
    force = false,
    preferredModel?: string,
    diagnostics?: PiProviderExecutionDiagnostics,
  ): Promise<void> {
    const state = this.currentState();
    if (!state || (!state.model && !preferredModel)) return;
    const rows = this.loadMessageRows(state);
    const totalTokens = rows.reduce((total, row) => total + estimateTokens(row.message), state.summary_tokens);
    if (totalTokens <= (force ? FORCE_COMPACT_AFTER_TOKENS : COMPACT_AFTER_TOKENS)) return;

    let retainedTokens = 0;
    let cutIndex = rows.length;
    while (cutIndex > 0 && retainedTokens < COMPACT_KEEP_RECENT_TOKENS) {
      cutIndex -= 1;
      retainedTokens += estimateTokens(rows[cutIndex]!.message);
    }
    while (cutIndex < rows.length && rows[cutIndex]?.message.role !== "user") cutIndex += 1;
    if (cutIndex <= 0 || cutIndex >= rows.length) return;

    const toSummarize = rows.slice(0, cutIndex);
    const model = this.model(preferredModel ?? state.model);
    const summary = await generateSummaryWithUsage(
      toSummarize.map((row) => row.message),
      this.summaryModels(diagnostics),
      model,
      4_096,
      undefined,
      "保留內部助理需要的確認事實、使用者意圖、決策、限制、未解問題與重要工具結果；使用繁體中文。",
      state.summary || undefined,
      "minimal",
    );
    if (!summary.ok) throw new Error(summary.error.message);
    const throughSeq = toSummarize.at(-1)!.seq;
    this.sql.exec(
      `UPDATE assistant_agent_state SET
         summary = ?, summary_through_seq = ?, summary_tokens = ?, tokens_before = ?, updated_at = ?
       WHERE singleton = 1 AND generation = ?`,
      summary.value.text,
      throughSeq,
      Math.max(1, Math.ceil(summary.value.text.length / 4)),
      totalTokens,
      Date.now(),
      state.generation,
    );
  }

  private completedRun(runId: string, generation: string): PiAgentRunResponse | undefined {
    const row = [...this.sql.exec<AgentRunRow>(
      `SELECT status, response_json FROM assistant_agent_runs
       WHERE run_id = ? AND generation = ? LIMIT 1`,
      runId,
      generation,
    )][0];
    if (row?.status !== "completed" || !row.response_json) return undefined;
    try {
      return JSON.parse(row.response_json) as PiAgentRunResponse;
    } catch {
      return undefined;
    }
  }

  private async run(input: PiAgentRunRequest): Promise<PiAgentRunResponse> {
    const providerDiagnostics: PiProviderExecutionDiagnostics = { runId: input.runId };
    let { state } = this.requireGeneration(input.contextGeneration);
    const model = this.model(input.model);
    const completed = this.completedRun(input.runId, state.generation);
    if (completed) return completed;
    // Queue 重送未完成的 run 時先移除殘留 transcript；tool 的外部冪等仍由各 provider 自己保證。
    this.sql.exec(
      "DELETE FROM assistant_agent_messages WHERE generation = ? AND run_id = ?",
      state.generation,
      input.runId,
    );
    if (this.totalContextTokens(state) > FORCE_COMPACT_AFTER_TOKENS) {
      await this.compactIfNeeded(true, model.id, providerDiagnostics);
      state = this.currentState()!;
    }
    this.sql.exec(
      `INSERT INTO assistant_agent_runs (run_id, generation, status, response_json, updated_at)
       VALUES (?, ?, 'running', '', ?)
       ON CONFLICT(run_id) DO UPDATE SET
         generation = excluded.generation,
         status = 'running',
         response_json = '',
         updated_at = excluded.updated_at`,
      input.runId,
       state.generation,
       Date.now(),
     );

    if (isSandboxRunRequest(input)) {
      await this.bootstrapSandboxTranscript(state, input, model);
      await this.compactIfNeeded(false, model.id, providerDiagnostics);
      state = this.currentState()!;
    }
    if (isLineRunRequest(input)) await this.bootstrapLineTranscript(state, input, model);
    const toolContext: ToolExecutionContext = { request: input, toolCalls: [] };
    const initialMessages = this.contextMessages(state);
    const agent = new Agent({
      initialState: {
        systemPrompt: input.systemPrompt,
        model,
        thinkingLevel: "minimal",
        messages: initialMessages,
        tools: this.tools(toolContext),
      },
      convertToLlm,
      streamFn: (requestModel, context, options) => this.streamModel(requestModel, context, {
        ...options,
        timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
        maxRetries: 0,
        maxTokens: MODEL_MAX_OUTPUT_TOKENS,
      }, providerDiagnostics),
      sessionId: state.session_id,
      transport: "sse",
      maxRetryDelayMs: 1_000,
      toolExecution: "sequential",
    });
    agent.subscribe((event) => {
      if (event.type === "message_end") this.storeMessage(state.generation, input.runId, event.message);
    });

    try {
      await agent.prompt(input.userText);
    } catch (error) {
      throw new AgentExecutionError(
        error instanceof Error ? error.message : "Pi agent 執行失敗。",
        toolContext.toolCalls,
        providerDiagnostics.lastResponse,
        serializePiError(error),
      );
    }
    const newMessages = agent.state.messages.slice(initialMessages.length);
    if (agent.state.errorMessage) {
      this.sql.exec(
        "UPDATE assistant_agent_runs SET status = 'failed', updated_at = ? WHERE run_id = ?",
        Date.now(),
        input.runId,
      );
      const error = new Error(agent.state.errorMessage);
      throw new AgentExecutionError(
        agent.state.errorMessage,
        toolContext.toolCalls,
        providerDiagnostics.lastResponse,
        serializePiError(error),
      );
    }
    const finalMessage = [...newMessages].reverse().find((message): message is AssistantMessage =>
      message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted");
    const finalText = finalMessage ? textContent(finalMessage) : "";
    if (!finalText) throw new AgentExecutionError("Pi agent 沒有產生可顯示的文字回答。", toolContext.toolCalls);

    const response: PiAgentRunResponse = {
      sessionId: state.session_id,
      model: model.id,
      result: {
        text: isLineRunRequest(input) ? boundedReply(finalText) : finalText,
        thoughts: thoughtContent(newMessages),
        toolCalls: toolContext.toolCalls,
        usage: assistantUsage(newMessages),
      },
    };
    this.sql.exec(
      `UPDATE assistant_agent_state SET model = ?, updated_at = ? WHERE singleton = 1 AND generation = ?`,
      model.id,
      Date.now(),
      state.generation,
    );
    this.sql.exec(
      `UPDATE assistant_agent_runs SET status = 'completed', response_json = ?, updated_at = ? WHERE run_id = ?`,
      JSON.stringify(response),
      Date.now(),
      input.runId,
    );
    if (this.totalContextTokens(this.currentState()!) > COMPACT_AFTER_TOKENS) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
    return response;
  }

  private async reset(input: PiLineAgentResetRequest): Promise<PiLineAgentResetResponse> {
    const { state, rotated } = this.requireGeneration(input.contextGeneration);
    if (rotated) await this.ctx.storage.deleteAlarm();
    return { sessionId: state.session_id, reset: rotated };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "Not found" }, { status: 404 });
    const url = new URL(request.url);
    const payload = await request.json().catch(() => null);
    try {
      if (url.pathname === "/run" && isRunRequest(payload)) {
        try {
          return Response.json(await this.serialized(() => this.run(payload)));
        } catch (error) {
          this.sql.exec(
            "UPDATE assistant_agent_runs SET status = 'failed', updated_at = ? WHERE run_id = ?",
            Date.now(),
            payload.runId,
          );
          throw error;
        }
      }
      if (url.pathname === "/reset" && isResetRequest(payload)) {
        return Response.json(await this.serialized(() => this.reset(payload)));
      }
      return Response.json({ error: "Pi agent request 格式不正確。" }, { status: 400 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pi agent 暫時無法回應。";
      const stale = message.includes("已重設的舊 session");
      if (!stale) {
        console.error("Pi chat agent 執行失敗", {
          runId: isRunRequest(payload) ? payload.runId : undefined,
          error: error instanceof AgentExecutionError
            ? error.errorDiagnostic
            : serializePiError(error),
          ...(error instanceof AgentExecutionError && error.providerResponse
            ? { providerResponse: error.providerResponse }
            : {}),
          ...(error instanceof AgentExecutionError
            ? { toolCalls: error.toolCalls.map(({ toolKey, status, durationMs }) => ({ toolKey, status, durationMs })) }
            : {}),
        });
      }
      return Response.json({
        error: message,
        toolCalls: error instanceof AgentExecutionError ? error.toolCalls : [],
      }, { status: stale ? 409 : 503 });
    }
  }

  async alarm(): Promise<void> {
    await this.serialized(async () => {
      try {
        await this.compactIfNeeded();
      } catch (error) {
        console.error("Pi chat agent 背景 compact 失敗", { error: serializePiError(error) });
        throw error;
      }
    });
  }
}
