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
  ImageContent,
  Model,
  Models,
  ModelsSimpleStreamOptions,
  ProviderResponse,
  Usage,
} from "@earendil-works/pi-ai";
import {
  findAssistantLineGroup,
  findMediaObject,
  getAssistantSandboxSession,
  getAssistantLineChannel,
  listAssistantLineMessages,
  listAllAssistantSandboxMessages,
  listAssistantSandboxMessages,
  listAssistantToolConfigs,
  loadAuthUser,
  resolveLineToolKeys,
  createDatabase,
  type Database,
} from "@rueisiang/db";
import { can, type Permission } from "@rueisiang/auth";
import { PLATFORM_TOOL_MAP } from "@rueisiang/tools";
import { Type, type TSchema } from "typebox";
import type { AssistantRunResult, AssistantToolCall, JsonSchemaProperty } from "@rueisiang/assistant";
import type { Env } from "./env.js";
import { DEFAULT_PI_CODEX_MODEL } from "./pi-agent.js";
import type {
  PiAgentAttachment,
  PiLineAgentResetRequest,
  PiLineAgentResetResponse,
  PiLineAgentRunRequest,
  PiAgentRunRequest,
  PiAgentRunResponse,
  PiSandboxAgentRunRequest,
} from "./pi-agent-contract.js";
import { isNasStorageKey, NasStorageConfigError, NasStorageError, nasStorageClient } from "./nas-storage.js";
import { createCyberbizReportService } from "./cyberbiz-reports.js";
import {
  PI_CODEX_PROVIDER_ID,
  isPiAssistantModel,
  piAssistantModel,
  type PiCodexRelayConfig,
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
const COMPACT_BATCH_TOKENS = 12_000;
const INTERACTIVE_CONTEXT_TOKENS = 64_000;
const MODEL_REQUEST_TIMEOUT_MS = 25_000;
const COMPACTION_REQUEST_TIMEOUT_MS = 90_000;
const COMPACTION_CONTINUATION_DELAY_MS = 1_000;
const COMPACTION_RETRY_DELAY_MS = 60_000;
const MODEL_MAX_OUTPUT_TOKENS = 1_200;
const LINE_MAX_REPLY_CHARS = 4_500;
const MAX_HYDRATED_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_CONTEXT_BYTES_PER_TOKEN = 128;
const MIN_IMAGE_CONTEXT_TOKENS = 256;
const IMAGE_MARKER_PREFIX = "[[nas-image:";
const IMAGE_MARKER_SUFFIX = "]]";
const HISTORICAL_IMAGE_OMITTED_TEXT = "（歷史圖片只在收到新的圖片相關訊息時載入。）";
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

type CyberbizReportService = ReturnType<typeof createCyberbizReportService>;
type CyberbizReportToolService = Pick<CyberbizReportService, "querySales" | "queryPayout">;

/**
 * 報表查詢只需要 D1；延遲建立 service 讓 assistant context 維持輕量，
 * 也不會因為其他功能的 NAS 設定狀態影響天氣、CRM 或 WMS tool。
 */
export function lazyCyberbizReportService(db: Database): CyberbizReportToolService {
  let service: CyberbizReportService | undefined;
  const get = () => service ??= createCyberbizReportService(db);
  return {
    querySales: (input) => get().querySales(input),
    queryPayout: (input) => get().queryPayout(input),
  };
}

interface ImageMarker {
  key: string;
  contentType: string;
  size?: number;
  expiresAt?: string | null;
}

interface AgentStateRow extends Record<string, SqlStorageValue> {
  generation: string;
  session_id: string;
  source_type: string;
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
  attachments?: PiAgentAttachment[];
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

class PermanentImageAttachmentError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PermanentImageAttachmentError";
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
    && input.toolKeys.every(nonEmptyString)
    && (input.attachments === undefined || isAttachments(input.attachments))
    && (input.persistAttachments === undefined || typeof input.persistAttachments === "boolean");
}

function isAttachments(value: unknown): value is PiAgentAttachment[] {
  return Array.isArray(value)
    && value.length <= 4
    && value.every((item) => {
      if (!item || typeof item !== "object") return false;
      const attachment = item as Record<string, unknown>;
      return nonEmptyString(attachment.key)
        && isNasStorageKey(attachment.key)
        && nonEmptyString(attachment.filename)
        && SUPPORTED_IMAGE_TYPES.has(String(attachment.contentType))
        && typeof attachment.size === "number"
        && Number.isSafeInteger(attachment.size)
        && attachment.size > 0
        && typeof attachment.checksum === "string"
        && /^[0-9a-f]{64}$/u.test(attachment.checksum);
    });
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

function base64(bytes: Uint8Array): string {
  let result = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(result);
}

function imageMarker(attachment: PiAgentAttachment): string {
  return `${IMAGE_MARKER_PREFIX}${encodeURIComponent(JSON.stringify({
    key: attachment.key,
    contentType: attachment.contentType,
    size: attachment.size,
    expiresAt: attachment.expiresAt ?? null,
  }))}${IMAGE_MARKER_SUFFIX}`;
}

function parseImageMarker(value: string): ImageMarker | null {
  if (!value.startsWith(IMAGE_MARKER_PREFIX) || !value.endsWith(IMAGE_MARKER_SUFFIX)) return null;
  const encoded = value.slice(IMAGE_MARKER_PREFIX.length, -IMAGE_MARKER_SUFFIX.length);
  try {
    const parsed = JSON.parse(decodeURIComponent(encoded)) as Record<string, unknown>;
    const key = parsed.key;
    const contentType = parsed.contentType;
    const size = parsed.size;
    const expiresAt = parsed.expiresAt;
    if (
      typeof key === "string"
      && isNasStorageKey(key)
      && typeof contentType === "string"
      && SUPPORTED_IMAGE_TYPES.has(contentType)
      && (size === undefined || (typeof size === "number" && Number.isSafeInteger(size) && size > 0))
      && (expiresAt === undefined || expiresAt === null || typeof expiresAt === "string")
    ) return { key, contentType, ...(size === undefined ? {} : { size }), ...(expiresAt === undefined ? {} : { expiresAt }) };
  } catch {
    // 舊 session 的 marker 仍使用 key:contentType 格式，保留讀取相容性。
  }
  const separator = encoded.lastIndexOf(":");
  if (separator <= 0) return null;
  try {
    const key = decodeURIComponent(encoded.slice(0, separator));
    const contentType = decodeURIComponent(encoded.slice(separator + 1));
    return isNasStorageKey(key) && SUPPORTED_IMAGE_TYPES.has(contentType) ? { key, contentType } : null;
  } catch {
    return null;
  }
}

function isExpiredImageMarker(marker: ImageMarker, now = Date.now()): boolean {
  if (!marker.expiresAt) return false;
  const expiresAt = Date.parse(marker.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function estimatedImageContextTokens(marker: ImageMarker): number {
  const size = marker.size ?? MAX_HYDRATED_IMAGE_BYTES;
  return Math.max(MIN_IMAGE_CONTEXT_TOKENS, Math.ceil(size / IMAGE_CONTEXT_BYTES_PER_TOKEN));
}

function estimatedContextTokens(message: AgentMessage): number {
  const raw = message as AgentMessage & { content?: unknown };
  if (message.role !== "user" || !Array.isArray(raw.content)) return estimateTokens(message);

  const imageTokens = raw.content.reduce((total, item) => {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "text") return total;
    const text = (item as { text?: unknown }).text;
    if (typeof text !== "string") return total;
    const marker = parseImageMarker(text);
    return marker ? total + estimatedImageContextTokens(marker) : total;
  }, 0);
  return estimateTokens(message) + imageTokens;
}

function sanitizedMessage(message: AgentMessage, attachments: PiAgentAttachment[] = []): AgentMessage {
  const raw = message as AgentMessage & { content?: unknown };
  if (message.role !== "user" || !Array.isArray(raw.content)) return message;
  let attachmentIndex = 0;
  const content = raw.content.map((item) => {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "image") return item;
    const attachment = attachments[attachmentIndex++];
    return {
      type: "text" as const,
      text: attachment ? imageMarker(attachment) : "（圖片附件已保存，但找不到 metadata。）",
    };
  });
  return { ...raw, content } as AgentMessage;
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
  if (message.role === "user") {
    const content = [
      ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
      ...(message.attachments ?? []).map((attachment) => ({
        type: "image" as const,
        data: "",
        mimeType: attachment.contentType,
      })),
    ];
    return { role: "user", content: content.length ? content : message.text, timestamp };
  }
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

function storedAttachments(value: string | undefined): PiAgentAttachment[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 4) return [];
    const normalized = parsed.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      const key = typeof item.key === "string" ? item.key : item.objectKey;
      if (
        typeof key !== "string"
        || !isNasStorageKey(key)
        || typeof item.filename !== "string"
        || !item.filename
        || typeof item.contentType !== "string"
        || !SUPPORTED_IMAGE_TYPES.has(item.contentType)
        || typeof item.size !== "number"
        || !Number.isSafeInteger(item.size)
        || item.size <= 0
        || typeof item.checksum !== "string"
        || !/^[0-9a-f]{64}$/u.test(item.checksum)
        || (item.expiresAt !== undefined && item.expiresAt !== null && typeof item.expiresAt !== "string")
      ) return [];
      return [{
        key,
        filename: item.filename,
        contentType: item.contentType,
        size: item.size,
        checksum: item.checksum,
        ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt as string | null }),
      } satisfies PiAgentAttachment];
    });
    return normalized.length === parsed.length && isAttachments(normalized) ? normalized : [];
  } catch {
    return [];
  }
}

function boundedReply(text: string): string {
  return text.length <= LINE_MAX_REPLY_CHARS ? text : `${text.slice(0, LINE_MAX_REPLY_CHARS - 1)}…`;
}

function payloadWithOutputLimit(payload: unknown): unknown {
  const body = object(payload);
  if (!body) return payload;
  return {
    ...body,
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
          source_type TEXT NOT NULL DEFAULT '',
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
      const columns = [...this.sql.exec<{ name: string }>("PRAGMA table_info(assistant_agent_state)")];
      if (!columns.some((column) => column.name === "source_type")) {
        this.sql.exec("ALTER TABLE assistant_agent_state ADD COLUMN source_type TEXT NOT NULL DEFAULT ''");
      }
    });
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private currentState(): AgentStateRow | undefined {
    return [...this.sql.exec<AgentStateRow>(
      `SELECT generation, session_id, source_type, summary, summary_through_seq, summary_tokens, tokens_before, model
       FROM assistant_agent_state WHERE singleton = 1 LIMIT 1`,
    )][0];
  }

  private rotateGeneration(generation: string, sourceType = ""): AgentStateRow {
    const sessionId = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO assistant_agent_state
         (singleton, generation, session_id, source_type, summary, summary_through_seq, summary_tokens, tokens_before, model, updated_at)
       VALUES (1, ?, ?, ?, '', 0, 0, 0, '', ?)
       ON CONFLICT(singleton) DO UPDATE SET
         generation = excluded.generation,
         session_id = excluded.session_id,
         source_type = excluded.source_type,
         summary = '',
         summary_through_seq = 0,
         summary_tokens = 0,
         tokens_before = 0,
         model = '',
         updated_at = excluded.updated_at`,
      generation,
      sessionId,
      sourceType,
      Date.now(),
    );
    return {
      generation,
      session_id: sessionId,
      source_type: sourceType,
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

  private async hydrateMessage(
    message: AgentMessage,
    selectedMarkers: Set<string>,
    messageIndex: number,
    budget: { remaining: number },
    allowHistoricalImages: boolean,
  ): Promise<AgentMessage> {
    const raw = message as AgentMessage & { content?: unknown };
    if (message.role !== "user" || !Array.isArray(raw.content)) return message;
    const nas = allowHistoricalImages ? nasStorageClient(this.env) : undefined;
    if (allowHistoricalImages && !nas) return message;
    const content: unknown[] = [];
    for (const [contentIndex, item] of raw.content.entries()) {
      if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "text") {
        content.push(item);
        continue;
      }
      const text = (item as { text?: unknown }).text;
      if (typeof text !== "string") {
        content.push(item);
        continue;
      }
      const marker = parseImageMarker(text);
      if (!marker) {
        content.push(item);
        continue;
      }
      if (!allowHistoricalImages) {
        content.push({ type: "text" as const, text: HISTORICAL_IMAGE_OMITTED_TEXT });
        continue;
      }
      if (!selectedMarkers.has(`${messageIndex}:${contentIndex}`)) {
        content.push({ type: "text" as const, text: "（歷史圖片過多，暫不載入這張圖片。）" });
        continue;
      }
      if (!nas) {
        content.push({ type: "text" as const, text: HISTORICAL_IMAGE_OMITTED_TEXT });
        continue;
      }
      if (await this.isExpiredStoredImage(marker)) {
        content.push({ type: "text" as const, text: "（圖片已過期或不存在。）" });
        continue;
      }
      try {
        const response = await nas.get(marker.key);
        if (!response) {
          content.push({ type: "text" as const, text: "（圖片已過期或不存在。）" });
          continue;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > budget.remaining || bytes.byteLength > MAX_HYDRATED_IMAGE_BYTES) {
          content.push({ type: "text" as const, text: "（歷史圖片過多，暫不載入這張圖片。）" });
          continue;
        }
        budget.remaining -= bytes.byteLength;
        content.push({
          type: "image" as const,
          data: base64(bytes),
          mimeType: response.headers.get("content-type") || marker.contentType,
        } satisfies ImageContent);
      } catch (error) {
        console.warn("Pi agent 圖片 context 載入失敗", {
          key: marker.key,
          error: serializePiError(error),
        });
        content.push({ type: "text" as const, text: "（圖片目前無法載入。）" });
      }
    }
    return { ...raw, content } as AgentMessage;
  }

  private async isExpiredStoredImage(marker: ImageMarker): Promise<boolean> {
    if (isExpiredImageMarker(marker) || marker.expiresAt !== undefined) return isExpiredImageMarker(marker);
    try {
      const media = await findMediaObject(createDatabase(this.env.DB), marker.key);
      return Boolean(media?.expiresAt && isExpiredImageMarker({ ...marker, expiresAt: media.expiresAt }));
    } catch (error) {
      console.warn("Pi agent 圖片 expiry metadata 查詢失敗", {
        key: marker.key,
        error: serializePiError(error),
      });
      return false;
    }
  }

  private async hydrateMessages(messages: AgentMessage[], allowHistoricalImages = true): Promise<AgentMessage[]> {
    const selectedMarkers = new Set<string>();
    let remaining = MAX_HYDRATED_IMAGE_BYTES;
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex]!;
      const raw = message as AgentMessage & { content?: unknown };
      if (message.role !== "user" || !Array.isArray(raw.content)) continue;
      for (let contentIndex = raw.content.length - 1; contentIndex >= 0; contentIndex -= 1) {
        const item = raw.content[contentIndex];
        if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "text") continue;
        const text = (item as { text?: unknown }).text;
        if (typeof text !== "string") continue;
        const marker = parseImageMarker(text);
        if (!marker || isExpiredImageMarker(marker)) continue;
        const size = marker.size ?? MAX_HYDRATED_IMAGE_BYTES;
        if (size > remaining) continue;
        selectedMarkers.add(`${messageIndex}:${contentIndex}`);
        remaining -= size;
      }
    }

    const budget = { remaining: MAX_HYDRATED_IMAGE_BYTES };
    const hydrated: AgentMessage[] = [];
    for (const [messageIndex, message] of messages.entries()) {
      hydrated.push(await this.hydrateMessage(message, selectedMarkers, messageIndex, budget, allowHistoricalImages));
    }
    return hydrated;
  }

  private contextRows(state: AgentStateRow, maxTokens = Number.POSITIVE_INFINITY): Array<{ seq: number; message: AgentMessage }> {
    const rows = this.loadMessageRows(state);
    if (!Number.isFinite(maxTokens)) return rows;

    let retainedTokens = state.summary ? state.summary_tokens : 0;
    let start = rows.length;
    while (start > 0) {
      const next = rows[start - 1]!;
      const nextTokens = estimatedContextTokens(next.message);
      if (start < rows.length && retainedTokens + nextTokens > maxTokens) break;
      start -= 1;
      retainedTokens += nextTokens;
    }
    while (start < rows.length && rows[start]?.message.role !== "user") start += 1;
    return rows.slice(start);
  }

  private async contextMessages(
    state: AgentStateRow,
    maxTokens = Number.POSITIVE_INFINITY,
  ): Promise<AgentMessage[]> {
    const allRows = this.loadMessageRows(state);
    const rows = this.contextRows(state, maxTokens);
    if (rows.length < allRows.length) {
      console.info("Pi agent 互動 context 已限制大小", {
        generation: state.generation,
        maxTokens,
        omittedMessages: allRows.length - rows.length,
      });
    }
    const messages = [
      ...(state.summary ? [createCompactionSummaryMessage(state.summary, state.tokens_before, Date.now())] : []),
      ...rows.map((row) => row.message),
    ];
    const allowHistoricalImages = state.source_type !== "group" && state.source_type !== "room";
    return this.hydrateMessages(messages, allowHistoricalImages);
  }

  private async inputImages(attachments: PiAgentAttachment[] = []): Promise<ImageContent[]> {
    if (!attachments.length) return [];
    let nas: ReturnType<typeof nasStorageClient>;
    try {
      nas = nasStorageClient(this.env);
    } catch (error) {
      if (error instanceof NasStorageConfigError) throw new PermanentImageAttachmentError(error.message, error);
      throw error;
    }
    if (!nas) throw new PermanentImageAttachmentError("平台尚未設定 NAS storage，無法讀取圖片附件。");
    return Promise.all(attachments.map(async (attachment) => {
      if (attachment.expiresAt) {
        const expiresAt = Date.parse(attachment.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          throw new PermanentImageAttachmentError(`圖片附件 ${attachment.filename} 已不存在或已過期。`);
        }
      }
      let response: Response | null;
      try {
        response = await nas.get(attachment.key);
      } catch (error) {
        if (error instanceof NasStorageError && !error.retryable) {
          throw new PermanentImageAttachmentError(error.message, error);
        }
        throw error;
      }
      if (!response) throw new PermanentImageAttachmentError(`圖片附件 ${attachment.filename} 已不存在或已過期。`);
      return {
        type: "image" as const,
        data: base64(new Uint8Array(await response.arrayBuffer())),
        mimeType: response.headers.get("content-type") || attachment.contentType,
      } satisfies ImageContent;
    }));
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

  private codexRelay(): PiCodexRelayConfig | undefined {
    const baseUrl = this.env.PI_OPENAI_CODEX_RELAY_URL?.trim();
    const token = this.env.PI_OPENAI_CODEX_RELAY_TOKEN?.trim();
    if (!baseUrl && !token) return undefined;
    if (!baseUrl || !token) {
      throw new Error("Codex NAS relay 必須同時設定 PI_OPENAI_CODEX_RELAY_URL 與 PI_OPENAI_CODEX_RELAY_TOKEN。 ");
    }
    return { baseUrl, token };
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
    const providerOptions: ModelsSimpleStreamOptions = {
      ...shared,
      onResponse,
      ...(model.provider === PI_CODEX_PROVIDER_ID
        ? { transport: "sse" as const, onPayload: payloadWithOutputLimit }
        : {}),
    };
    return streamPiAssistantModel(model, context, providerOptions, {
      resolveCodexAccessToken: async () => this.accessToken(),
      codexRelay: model.provider === PI_CODEX_PROVIDER_ID ? this.codexRelay() : undefined,
      geminiApiKey: this.env.GEMINI_API_KEY,
    });
  }

  /** Pi compaction 只需要 Models.completeSimple；同一段 session 換 provider 後也由當下 model 建摘要。 */
  private summaryModels(diagnostics?: PiProviderExecutionDiagnostics): Models {
    return {
      completeSimple: async (model, context, options) => this.streamModel(model, context, {
        ...options,
        timeoutMs: COMPACTION_REQUEST_TIMEOUT_MS,
        maxRetries: 0,
      }, diagnostics).result(),
    } as Models;
  }

  private async authorizedLineTool(input: PiLineAgentRunRequest, toolKey: string, args: unknown): Promise<string> {
    const db = createDatabase(this.env.DB);
    const services = { cyberbizReports: lazyCyberbizReportService(db) };
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
    return tool.execute(args, { surface: "line", db, env: this.env, services });
  }

  private async authorizedSandboxTool(input: PiSandboxAgentRunRequest, toolKey: string, args: unknown): Promise<string> {
    const db = createDatabase(this.env.DB);
    const services = { cyberbizReports: lazyCyberbizReportService(db) };
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
    return tool.execute(args, { surface: "sandbox", db, env: this.env, user, services });
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

  private storeMessage(
    generation: string,
    runId: string,
    message: AgentMessage,
    attachments: PiAgentAttachment[] = [],
    persistAttachments = true,
  ): void {
    this.sql.exec(
      `INSERT INTO assistant_agent_messages (generation, run_id, role, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      generation,
      runId,
      message.role,
      JSON.stringify(sanitizedMessage(message, persistAttachments ? attachments : [])),
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
    const summary = session.contextSummary.trim();
    const history = summary
      ? (await listAllAssistantSandboxMessages(db, session.id))
        .slice(Math.max(session.contextSummaryMessageCount, 0))
        .slice(-100)
      : await listAssistantSandboxMessages(db, session.id, 100);
    const bootstrapMessages: SandboxBootstrapMessage[] = [
      ...history.map((message) => ({
        role: message.role as "user" | "model",
        text: message.text,
        ...(message.model ? { model: message.model } : {}),
        ...(message.role === "user" ? { attachments: storedAttachments(message.attachments) } : {}),
      })),
    ];
    if (!summary && !bootstrapMessages.length) return;

    if (summary) {
      const summaryTokens = Math.max(1, Math.ceil(summary.length / 4));
      this.sql.exec(
        `UPDATE assistant_agent_state SET
           summary = ?, summary_through_seq = 0, summary_tokens = ?, tokens_before = ?, updated_at = ?
         WHERE singleton = 1 AND generation = ?`,
        summary,
        summaryTokens,
        summaryTokens,
        Date.now(),
        state.generation,
      );
    }

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
      if (!message.text && !message.attachments?.length) continue;
      this.storeMessage(
        state.generation,
        bootstrapRunId,
        bootstrapAgentMessage(message, model, started + index),
        message.attachments,
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
      .map((message) => ({
        role: "user" as const,
        text: message.text,
        attachments: message.sourceType === "user" ? storedAttachments(message.attachments) : [],
      }));
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
      if (!message.text && !message.attachments?.length) continue;
      this.storeMessage(
        state.generation,
        bootstrapRunId,
        bootstrapAgentMessage(message, model, started + index),
        message.attachments,
      );
    }
  }

  private estimatedStoredContextTokens(state: AgentStateRow): number {
    return this.loadMessageRows(state).reduce(
      (total, row) => total + estimatedContextTokens(row.message),
      state.summary ? state.summary_tokens : 0,
    );
  }

  private async compactIfNeeded(
    preferredModel?: string,
    diagnostics?: PiProviderExecutionDiagnostics,
  ): Promise<boolean> {
    const state = this.currentState();
    if (!state || (!state.model && !preferredModel)) return false;
    const modelId = isPiAssistantModel(preferredModel)
      ? preferredModel
      : isPiAssistantModel(state.model)
        ? state.model
        : DEFAULT_PI_CODEX_MODEL;
    const sourceRows = this.loadMessageRows(state);
    const storedTokens = sourceRows.reduce(
      (total, row) => total + estimatedContextTokens(row.message),
      state.summary_tokens,
    );
    if (storedTokens <= COMPACT_AFTER_TOKENS) return false;

    const allowHistoricalImages = state.source_type !== "group" && state.source_type !== "room";
    const hydratedMessages = await this.hydrateMessages(sourceRows.map((row) => row.message), allowHistoricalImages);
    const rows = sourceRows.map((row, index) => ({
      ...row,
      message: hydratedMessages[index]!,
      estimatedTokens: estimatedContextTokens(row.message),
    }));
    const totalTokens = rows.reduce((total, row) => total + row.estimatedTokens, state.summary_tokens);

    let retainedTokens = 0;
    let retainedStart = rows.length;
    while (retainedStart > 0 && retainedTokens < COMPACT_KEEP_RECENT_TOKENS) {
      retainedStart -= 1;
      retainedTokens += rows[retainedStart]!.estimatedTokens;
    }
    while (retainedStart < rows.length && rows[retainedStart]?.message.role !== "user") retainedStart += 1;
    if (retainedStart <= 0 || retainedStart >= rows.length) return false;

    let summarizeEnd = 0;
    let summarizedTokens = 0;
    while (
      summarizeEnd < retainedStart
      && (summarizedTokens < COMPACT_BATCH_TOKENS || summarizeEnd === 0)
    ) {
      summarizedTokens += rows[summarizeEnd]!.estimatedTokens;
      summarizeEnd += 1;
    }
    while (summarizeEnd < retainedStart && rows[summarizeEnd]?.message.role !== "user") summarizeEnd += 1;
    if (summarizeEnd <= 0) return false;

    const toSummarize = rows.slice(0, summarizeEnd);
    const model = this.model(modelId);
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
    if (!summary.ok) {
      const error = new Error(summary.error.message);
      throw new AgentExecutionError(
        summary.error.message,
        [],
        diagnostics?.lastResponse,
        serializePiError(error),
      );
    }
    const throughSeq = toSummarize.at(-1)!.seq;
    this.sql.exec(
      `UPDATE assistant_agent_state SET
         summary = ?, summary_through_seq = ?, summary_tokens = ?, tokens_before = ?, model = ?, updated_at = ?
       WHERE singleton = 1 AND generation = ?`,
      summary.value.text,
      throughSeq,
      Math.max(1, Math.ceil(summary.value.text.length / 4)),
      totalTokens,
      modelId,
      Date.now(),
      state.generation,
    );
    const summaryTokens = Math.max(1, Math.ceil(summary.value.text.length / 4));
    const remainingTokens = rows
      .slice(summarizeEnd)
      .reduce((total, row) => total + row.estimatedTokens, summaryTokens);
    return remainingTokens > COMPACT_AFTER_TOKENS;
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
    const sourceType = isLineRunRequest(input) ? input.sourceType : "sandbox";
    if (state.source_type !== sourceType) {
      this.sql.exec(
        "UPDATE assistant_agent_state SET source_type = ?, updated_at = ? WHERE singleton = 1 AND generation = ?",
        sourceType,
        Date.now(),
        state.generation,
      );
      state = this.currentState()!;
    }
    const model = this.model(input.model);
    const completed = this.completedRun(input.runId, state.generation);
    if (completed) return completed;
    // Queue 重送未完成的 run 時先移除殘留 transcript；tool 的外部冪等仍由各 provider 自己保證。
    this.sql.exec(
      "DELETE FROM assistant_agent_messages WHERE generation = ? AND run_id = ?",
      state.generation,
      input.runId,
    );
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
      state = this.currentState()!;
    }
    if (isLineRunRequest(input)) await this.bootstrapLineTranscript(state, input, model);
    state = this.currentState()!;
    if (this.estimatedStoredContextTokens(state) > COMPACT_AFTER_TOKENS) {
      await this.ctx.storage.setAlarm(Date.now() + COMPACTION_CONTINUATION_DELAY_MS);
    }
    const toolContext: ToolExecutionContext = { request: input, toolCalls: [] };
    const initialMessages = await this.contextMessages(state, INTERACTIVE_CONTEXT_TOKENS);
    const images = await this.inputImages(input.attachments);
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
    const persistAttachments = isLineRunRequest(input) ? input.persistAttachments !== false : true;
    agent.subscribe((event) => {
      if (event.type === "message_end") {
        this.storeMessage(
          state.generation,
          input.runId,
          event.message,
          input.attachments,
          persistAttachments,
        );
      }
    });

    try {
      await agent.prompt(input.userText, images);
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
    if (this.estimatedStoredContextTokens(this.currentState()!) > COMPACT_AFTER_TOKENS) {
      await this.ctx.storage.setAlarm(Date.now() + COMPACTION_CONTINUATION_DELAY_MS);
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
        ...(error instanceof PermanentImageAttachmentError ? { permanent: true, code: "permanent_attachment" } : {}),
      }, { status: stale ? 409 : error instanceof PermanentImageAttachmentError ? 422 : 503 });
    }
  }

  async alarm(): Promise<void> {
    await this.serialized(async () => {
      const runId = `compaction:${crypto.randomUUID()}`;
      const diagnostics: PiProviderExecutionDiagnostics = { runId };
      const startedAt = Date.now();
      try {
        const needsContinuation = await this.compactIfNeeded(undefined, diagnostics);
        if (needsContinuation) {
          await this.ctx.storage.setAlarm(Date.now() + COMPACTION_CONTINUATION_DELAY_MS);
        }
        console.info("Pi chat agent 背景 compact 完成", {
          runId,
          durationMs: Date.now() - startedAt,
          needsContinuation,
          ...(diagnostics.lastResponse ? { providerResponse: diagnostics.lastResponse } : {}),
        });
      } catch (error) {
        const nextRetryAt = Date.now() + COMPACTION_RETRY_DELAY_MS;
        console.error("Pi chat agent 背景 compact 失敗", {
          runId,
          durationMs: Date.now() - startedAt,
          nextRetryAt,
          error: serializePiError(error),
          ...(diagnostics.lastResponse ? { providerResponse: diagnostics.lastResponse } : {}),
        });
        await this.ctx.storage.setAlarm(nextRetryAt);
      }
    });
  }
}
