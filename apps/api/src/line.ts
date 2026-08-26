import { assistantErrorDetails, assistantLog } from "@rueisiang/assistant";

/** LINE webhook 的最小資料邊界。未知欄位不進資料庫，也不進 log。 */
export interface LineWebhookEvent {
  type?: string;
  webhookEventId?: string;
  timestamp?: number;
  source?: {
    type?: string;
    groupId?: string;
    roomId?: string;
    userId?: string;
  };
  replyToken?: string;
  message?: {
    id?: string;
    type?: string;
    text?: string;
    quotedMessageId?: string;
    contentProvider?: { type?: string };
    mention?: {
      mentionees?: Array<{ isSelf?: boolean; index?: number; length?: number }>;
    };
  };
}

export interface LineWebhookPayload {
  events?: unknown;
}

export type LineSourceType = "group" | "room" | "user";

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/** 用 Web Crypto 驗證原始 request body，不先 parse JSON。 */
export async function verifyLineWebhookSignature(rawBody: string, signature: string | undefined, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  const expected = decodeBase64(signature);
  if (!expected) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, expected, new TextEncoder().encode(rawBody));
}

/**
 * 取出這則事件所屬的 LINE 對話。
 *
 * 舊名稱先保留，因為資料表與後台 API 已經使用 `lineGroupId`；實際上這個 id 也可以是
 * roomId 或 userId。`sourceType` 是不能省略的，否則一對一會跟多人聊天室混在一起。
 */
export function lineEventGroup(event: LineWebhookEvent): { id: string; sourceType: LineSourceType } | null {
  if (event.source?.type === "group" && event.source.groupId) {
    return { id: event.source.groupId, sourceType: "group" };
  }
  if (event.source?.type === "room" && event.source.roomId) {
    return { id: event.source.roomId, sourceType: "room" };
  }
  if (event.source?.type === "user" && event.source.userId) {
    return { id: event.source.userId, sourceType: "user" };
  }
  return null;
}

/** 只接受 LINE 同時標出的 self mention，避免有人在文字中手動輸入名稱就觸發。 */
export function lineEventIsMentioned(event: LineWebhookEvent): boolean {
  return Boolean(event.message?.mention?.mentionees?.some((mentionee) => mentionee.isSelf));
}

export function lineEventText(event: LineWebhookEvent): string | null {
  const text = lineEventRawText(event);
  return text === null ? null : text.trim();
}

/** 內部測試用的隱藏指令，只能重設發送者自己的 1 對 1 對話。 */
export function lineEventIsSessionReset(event: LineWebhookEvent): boolean {
  if (event.source?.type !== "user") return false;
  const text = lineEventText(event);
  return text === "/reset" || text === "/重設";
}

/** 保留 LINE 原始文字，因為 mention offset 是以這個字串為基準。 */
export function lineEventRawText(event: LineWebhookEvent): string | null {
  if (event.type !== "message" || event.message?.type !== "text" || typeof event.message.text !== "string") return null;
  return event.message.text;
}

export function lineQuestionText(
  text: string,
  mentionee?: { isSelf?: boolean; index?: number; length?: number },
): string {
  const index = mentionee?.index;
  const length = mentionee?.length;
  if (
    mentionee?.isSelf &&
    typeof index === "number" &&
    typeof length === "number" &&
    Number.isInteger(index) &&
    Number.isInteger(length) &&
    index >= 0 &&
    length > 0 &&
    index <= text.length &&
    index + length <= text.length
  ) {
    return `${text.slice(0, index)}${text.slice(index + length)}`.trim();
  }
  // Actual LINE webhook payloads include offsets. Without them, keep the text
  // unchanged instead of guessing a display name that may have been renamed.
  return text.trim();
}

export function isLineWebhookEvent(value: unknown): value is LineWebhookEvent {
  return typeof value === "object" && value !== null;
}

const LINE_API_BASE = "https://api.line.me/v2/bot/message";
const LINE_CONTENT_API_BASE = "https://api-data.line.me/v2/bot/message";
const LINE_BOT_API_BASE = "https://api.line.me/v2/bot";
const LINE_TEXT_LIMIT = 5_000;
const LINE_ERROR_BODY_LIMIT = 1_000;
const LINE_MESSAGE_TIMEOUT_MS = 5_000;
export const LINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const LINE_CONTENT_TIMEOUT_MS = 15_000;
const LINE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** LINE API 診斷用的 correlation fields；刻意不包含 reply token、訊息文字或 access token。 */
export interface LineLogContext {
  runId?: string;
  webhookEventId?: string;
  channelKey?: string;
  groupId?: string;
  groupRowId?: string;
  messageId?: string;
  quotedMessageId?: string;
  sequence?: number;
}

function lineText(value: string): string {
  return value.slice(0, LINE_TEXT_LIMIT);
}

async function responsePreview(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let preview = "";
  try {
    while (preview.length < LINE_ERROR_BODY_LIMIT) {
      const chunk = await reader.read();
      if (chunk.done) break;
      preview += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return preview.slice(0, LINE_ERROR_BODY_LIMIT);
}

/**
 * LINE 寫入 API 的結果不能只用一個 boolean 表示。
 *
 * reply 沒有 retry key：timeout / 5xx 可能發生在 LINE 已經收件之後，
 * 這種結果不能再自動改用 Push，否則會把同一則回答送兩次。Push 則可以
 * 用相同的 X-Line-Retry-Key 安全重試；409 代表該 retry key 已被 LINE 接受。
 */
export class LineMessageError extends Error {
  readonly endpoint: "reply" | "push";
  readonly status: number | undefined;
  readonly ambiguous: boolean;
  readonly retryable: boolean;
  readonly accepted: boolean;

  constructor(input: {
    endpoint: "reply" | "push";
    status?: number;
    ambiguous: boolean;
    retryable: boolean;
    accepted?: boolean;
    cause?: unknown;
  }) {
    super(`LINE Messaging API ${input.endpoint} 失敗${input.status ? `（HTTP ${input.status}）` : ""}。`, {
      cause: input.cause,
    });
    this.name = "LineMessageError";
    this.endpoint = input.endpoint;
    this.status = input.status;
    this.ambiguous = input.ambiguous;
    this.retryable = input.retryable;
    this.accepted = input.accepted ?? false;
  }
}

async function sendLineMessage(
  accessToken: string,
  endpoint: "reply" | "push",
  payload: unknown,
  retryKey?: string,
  context: LineLogContext = {},
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LINE_MESSAGE_TIMEOUT_MS);
  const started = Date.now();
  let response: Response;
  assistantLog("info", "line.message.request", { ...context, endpoint, hasRetryKey: Boolean(retryKey) });
  try {
    response = await fetch(`${LINE_API_BASE}/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(retryKey ? { "X-Line-Retry-Key": retryKey } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    assistantLog("error", "line.message.transport_error", {
      ...context,
      endpoint,
      timeoutMs: LINE_MESSAGE_TIMEOUT_MS,
      durationMs: Date.now() - started,
      error: assistantErrorDetails(error),
    });
    throw new LineMessageError({
      endpoint,
      ambiguous: true,
      retryable: endpoint === "push",
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const responseBody = await responsePreview(response);
    assistantLog("error", "line.message.error", {
      ...context,
      status: response.status,
      endpoint,
      durationMs: Date.now() - started,
      response: responseBody,
    });
    const accepted = endpoint === "push" && response.status === 409;
    // Reply 的 400/401/403/404 通常是明確的 token/channel 問題，可以安全改走受限 Push；
    // 只有 timeout、429、5xx 或非預期的 reply 409 仍可能代表 LINE 已經收件。
    const ambiguous = !accepted && (
      response.status >= 500 ||
      response.status === 408 ||
      response.status === 429 ||
      (endpoint === "reply" && response.status === 409)
    );
    throw new LineMessageError({
      endpoint,
      status: response.status,
      ambiguous,
      retryable: endpoint === "push" && !accepted && (response.status >= 500 || response.status === 408 || response.status === 429),
      accepted,
    });
  }
  assistantLog("info", "line.message.accepted", {
    ...context,
    endpoint,
    status: response.status,
    durationMs: Date.now() - started,
  });
}

export async function replyLineMessage(
  accessToken: string,
  replyToken: string,
  text: string,
  context: LineLogContext = {},
): Promise<void> {
  await sendLineMessage(accessToken, "reply", { replyToken, messages: [{ type: "text", text: lineText(text) }] }, undefined, context);
}

export async function pushLineMessage(
  accessToken: string,
  to: string,
  text: string,
  retryKey: string,
  context: LineLogContext = {},
): Promise<void> {
  await sendLineMessage(accessToken, "push", { to, messages: [{ type: "text", text: lineText(text) }] }, retryKey, context);
}

export interface LineMessageContent {
  body: ArrayBuffer;
  contentType: string;
}

export class LineContentError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(input: { message: string; status?: number; retryable: boolean; cause?: unknown }) {
    super(input.message, { cause: input.cause });
    this.name = "LineContentError";
    this.status = input.status;
    this.retryable = input.retryable;
  }
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!result.value) continue;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new LineContentError({
          message: `LINE 圖片大小不能超過 ${Math.floor(maxBytes / 1024 / 1024)} MB。`,
          retryable: false,
        });
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/** 以 LINE message id 取回圖片 bytes；只在 Queue consumer 執行，webhook 不等待外部內容 API。 */
export async function fetchLineMessageContent(
  accessToken: string,
  messageId: string,
  context: LineLogContext = {},
): Promise<LineMessageContent> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LINE_CONTENT_TIMEOUT_MS);
  const started = Date.now();
  assistantLog("info", "line.content.request", { ...context, messageId });
  try {
    let response: Response;
    try {
      response = await fetch(`${LINE_CONTENT_API_BASE}/${encodeURIComponent(messageId)}/content`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
    } catch (error) {
      assistantLog("error", "line.content.transport_error", {
        ...context,
        messageId,
        durationMs: Date.now() - started,
        timeoutMs: LINE_CONTENT_TIMEOUT_MS,
        error: assistantErrorDetails(error),
      });
      throw new LineContentError({ message: "LINE 圖片內容暫時無法取得。", retryable: true, cause: error });
    }

    if (!response.ok) {
      const responseBody = await responsePreview(response);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      assistantLog(retryable ? "warn" : "error", "line.content.failed", {
        ...context,
        messageId,
        status: response.status,
        durationMs: Date.now() - started,
        retryable,
        response: responseBody,
      });
      throw new LineContentError({
        message: response.status === 404 || response.status === 410
          ? "LINE 圖片內容已過期或不存在。"
          : "LINE 圖片內容取得失敗。",
        status: response.status,
        retryable,
      });
    }

    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0]!.trim().toLowerCase();
    if (!LINE_IMAGE_TYPES.has(contentType)) {
      await response.body?.cancel();
      throw new LineContentError({ message: "LINE 回傳的內容不是支援的圖片格式。", retryable: false });
    }
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(declaredSize) && declaredSize > LINE_IMAGE_MAX_BYTES) {
      await response.body?.cancel();
      throw new LineContentError({
        message: `LINE 圖片大小不能超過 ${Math.floor(LINE_IMAGE_MAX_BYTES / 1024 / 1024)} MB。`,
        retryable: false,
      });
    }
    const body = await readLimitedBody(response, LINE_IMAGE_MAX_BYTES);
    if (body.byteLength === 0) throw new LineContentError({ message: "LINE 回傳空白圖片內容。", retryable: false });
    assistantLog("info", "line.content.completed", {
      ...context,
      messageId,
      contentType,
      bytes: body.byteLength,
      durationMs: Date.now() - started,
    });
    return { body, contentType };
  } finally {
    clearTimeout(timeout);
  }
}

/** LINE 台灣方案的訊息用量依 GMT+9 月份結算；固定月窗不可用伺服器本地時區計算。 */
export function linePushWindowKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("無法計算 LINE Push 計費月份。");
  return `${year}-${month}`;
}

async function fetchLineJson(
  accessToken: string,
  url: string,
  label: string,
  context: LineLogContext = {},
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      assistantLog("warn", "line.lookup.failed", { ...context, label, status: response.status });
      throw new Error(`LINE ${label} 取得失敗（HTTP ${response.status}）。`);
    }
    const body = await response.json() as unknown;
    if (typeof body !== "object" || body === null) throw new Error(`LINE ${label} 回傳格式不正確。`);
    return body as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

/** 回傳 Messaging API 本月已用 recipient 數；取不到時由呼叫端保守停用 Push。 */
export async function fetchLinePushUsage(accessToken: string, context: LineLogContext = {}): Promise<number> {
  const body = await fetchLineJson(accessToken, `${LINE_API_BASE}/quota/consumption`, "Push 用量", context);
  const totalUsage = body.totalUsage;
  if (typeof totalUsage !== "number" || !Number.isFinite(totalUsage) || totalUsage < 0) {
    throw new Error("LINE Push 用量回傳格式不正確。");
  }
  return Math.floor(totalUsage);
}

/** Push 用量以收件人數計算；群組與多人聊天室不能只當成一則。 */
export async function fetchLineChatMemberCount(
  accessToken: string,
  sourceType: LineSourceType,
  chatId: string,
  context: LineLogContext = {},
): Promise<number> {
  if (sourceType === "user") return 1;
  const prefix = sourceType === "group" ? "group" : "room";
  const body = await fetchLineJson(
    accessToken,
    `${LINE_BOT_API_BASE}/${prefix}/${encodeURIComponent(chatId)}/members/count`,
    "聊天室人數",
    context,
  );
  const count = body.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    throw new Error("LINE 聊天室人數回傳格式不正確。");
  }
  return count;
}

export interface LineGroupSummary {
  groupName: string;
  pictureUrl: string;
}

export interface LineUserProfile {
  displayName: string;
  pictureUrl: string;
}

/**
 * 取回群組的名稱與大頭貼。
 *
 * 只有 `group` 有這支 API——多人聊天室（`room`）在 Messaging API 裡只查得到人數，
 * 沒有名稱也沒有圖，那種只能繼續手動命名。
 *
 * 拿不到就回 null，不丟例外：小香被踢出群組會得到 404，那是正常會發生的事，不該讓
 * 一次同步失敗連帶把整個 webhook 弄壞——收訊息比補名稱重要得多。
 */
export async function fetchLineGroupSummary(
  accessToken: string,
  groupId: string,
  context: LineLogContext = {},
): Promise<LineGroupSummary | null> {
  // 就算跑在 Queue consumer 裡也要有界線：Worker 的執行時間是有上限的，一個掛住的請求會
  // 把同一次執行裡其他該做完的事一起拖垮。
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${LINE_BOT_API_BASE}/group/${encodeURIComponent(groupId)}/summary`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      assistantLog("warn", "line.lookup.failed", { ...context, label: "群組資料", groupId, status: response.status });
      return null;
    }
    const body = await response.json() as { groupName?: unknown; pictureUrl?: unknown };
    const groupName = typeof body.groupName === "string" ? body.groupName.trim() : "";
    // pictureUrl 在規格上是必填，但沒有設定大頭貼的群組實際上不會回傳。
    const pictureUrl = typeof body.pictureUrl === "string" ? body.pictureUrl.trim() : "";
    return groupName || pictureUrl ? { groupName, pictureUrl } : null;
  } catch (error) {
    assistantLog("warn", "line.lookup.failed", { ...context, label: "群組資料", groupId, error: assistantErrorDetails(error) });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 取回一對一對話對方的名稱與大頭貼。
 *
 * userId 必須來自 webhook，不是使用者在 LINE 上設定的可搜尋 ID。使用者沒有頭貼、
 * 尚未同意提供 profile，或已封鎖官方帳號時，LINE 可能回 404；這些情況都只能退回
 * 對話 ID，不能讓補頭貼失敗連帶影響收訊息。
 */
export async function fetchLineUserProfile(
  accessToken: string,
  userId: string,
  context: LineLogContext = {},
): Promise<LineUserProfile | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${LINE_BOT_API_BASE}/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      assistantLog("warn", "line.lookup.failed", { ...context, label: "使用者資料", userId, status: response.status });
      return null;
    }
    const body = await response.json() as { displayName?: unknown; pictureUrl?: unknown };
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const pictureUrl = typeof body.pictureUrl === "string" ? body.pictureUrl.trim() : "";
    return displayName || pictureUrl ? { displayName, pictureUrl } : null;
  } catch (error) {
    assistantLog("warn", "line.lookup.failed", { ...context, label: "使用者資料", userId, error: assistantErrorDetails(error) });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
