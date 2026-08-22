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
const LINE_TEXT_LIMIT = 5_000;
const LINE_ERROR_BODY_LIMIT = 1_000;

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

async function sendLineReply(accessToken: string, payload: unknown): Promise<void> {
  const response = await fetch(`${LINE_API_BASE}/reply`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const responseBody = await responsePreview(response);
    console.error("LINE Messaging API reply 失敗", {
      status: response.status,
      response: responseBody,
    });
    throw new Error(`LINE Messaging API reply 失敗（HTTP ${response.status}）。`);
  }
}

export async function replyLineMessage(accessToken: string, replyToken: string, text: string): Promise<void> {
  await sendLineReply(accessToken, { replyToken, messages: [{ type: "text", text: lineText(text) }] });
}
