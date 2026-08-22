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
    mention?: {
      mentionees?: Array<{ isSelf?: boolean; index?: number; length?: number }>;
    };
  };
}

export interface LineWebhookPayload {
  events?: unknown;
}

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

export function lineEventGroup(event: LineWebhookEvent): { id: string; sourceType: "group" | "room" } | null {
  if (event.source?.type === "group" && event.source.groupId) {
    return { id: event.source.groupId, sourceType: "group" };
  }
  if (event.source?.type === "room" && event.source.roomId) {
    return { id: event.source.roomId, sourceType: "room" };
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
const LINE_BOT_API_BASE = "https://api.line.me/v2/bot";
const LINE_TEXT_LIMIT = 5_000;

function lineText(value: string): string {
  return value.slice(0, LINE_TEXT_LIMIT);
}

async function sendLineMessage(accessToken: string, payload: unknown): Promise<void> {
  const response = await fetch(`${LINE_API_BASE}/push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    console.error("LINE Messaging API 推送失敗", { status: response.status });
    throw new Error("LINE Messaging API 暫時無法推送。");
  }
}

export async function pushLineMessage(accessToken: string, lineGroupId: string, text: string): Promise<void> {
  await sendLineMessage(accessToken, { to: lineGroupId, messages: [{ type: "text", text: lineText(text) }] });
}

export interface LineGroupSummary {
  groupName: string;
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
export async function fetchLineGroupSummary(accessToken: string, groupId: string): Promise<LineGroupSummary | null> {
  // 就算跑在 waitUntil 裡也要有界線：Worker 的執行時間是有上限的，一個掛住的請求會
  // 把同一次執行裡其他該做完的事一起拖垮。
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${LINE_BOT_API_BASE}/group/${encodeURIComponent(groupId)}/summary`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn("LINE 群組資料取得失敗", { groupId, status: response.status });
      return null;
    }
    const body = await response.json() as { groupName?: unknown; pictureUrl?: unknown };
    const groupName = typeof body.groupName === "string" ? body.groupName.trim() : "";
    // pictureUrl 在規格上是必填，但沒有設定大頭貼的群組實際上不會回傳。
    const pictureUrl = typeof body.pictureUrl === "string" ? body.pictureUrl.trim() : "";
    return groupName || pictureUrl ? { groupName, pictureUrl } : null;
  } catch (error) {
    console.warn("LINE 群組資料取得失敗", { groupId, error });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
