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
  if (event.type !== "message" || event.message?.type !== "text" || typeof event.message.text !== "string") return null;
  return event.message.text.trim();
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
    length > 0
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

function lineText(value: string): string {
  return value.slice(0, LINE_TEXT_LIMIT);
}

async function sendLineMessage(path: "reply" | "push", accessToken: string, payload: unknown): Promise<void> {
  const response = await fetch(`${LINE_API_BASE}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    console.error("LINE Messaging API 回覆失敗", { path, status: response.status });
    throw new Error("LINE Messaging API 暫時無法回覆。");
  }
}

export async function replyLineMessage(accessToken: string, replyToken: string, text: string): Promise<void> {
  await sendLineMessage("reply", accessToken, { replyToken, messages: [{ type: "text", text: lineText(text) }] });
}

export async function pushLineMessage(accessToken: string, lineGroupId: string, text: string): Promise<void> {
  await sendLineMessage("push", accessToken, { to: lineGroupId, messages: [{ type: "text", text: lineText(text) }] });
}
