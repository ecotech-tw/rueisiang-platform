export type LineSourceType = "group" | "room" | "user";

interface LineAssistantQueueMessageBase {
  assistantKey: string;
  channelKey: string;
  groupRowId: string;
  lineGroupId: string;
  sourceType: LineSourceType;
  webhookEventId: string;
  /** D1 contextResetAt；空字串／舊 Queue 訊息缺欄位代表從未 reset。 */
  contextGeneration?: string;
  /** 同一個 LINE 對話內的到達順序；舊 Queue 訊息沒有此欄位時維持相容。 */
  sequence?: number;
  messageId?: string;
  /** 群組／多人聊天室引用的原始 LINE message id。 */
  quotedMessageId?: string;
  /** LINE reply token 的實際截止時間；舊 Queue 訊息沒有這欄時由 consumer 使用保守預設值。 */
  replyDeadlineAt?: number;
  /** LINE message type；舊的文字 Queue 訊息沒有此欄位時視為 text。 */
  messageType?: "text" | "image";
}

export type LineAssistantQueueMessage = LineAssistantQueueMessageBase & (
  | { kind: "profile" }
  | { kind: "reset"; replyToken: string }
  | { kind: "media"; messageType: "image" }
  | { kind: "assistant"; runId: string; replyToken: string; questionText: string }
);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Queue body 仍要做 runtime validation，避免舊訊息或手動送入的 body 直接進資料庫／LINE API。 */
export function isLineAssistantQueueMessage(value: unknown): value is LineAssistantQueueMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (
    !nonEmptyString(message.kind) ||
    !["profile", "reset", "media", "assistant"].includes(message.kind) ||
    !nonEmptyString(message.assistantKey) ||
    !nonEmptyString(message.channelKey) ||
    !nonEmptyString(message.groupRowId) ||
    !nonEmptyString(message.lineGroupId) ||
    !["group", "room", "user"].includes(message.sourceType as string) ||
    !nonEmptyString(message.webhookEventId) ||
    (message.contextGeneration !== undefined && typeof message.contextGeneration !== "string")
  ) {
    return false;
  }
  if (message.messageType !== undefined && message.messageType !== "text" && message.messageType !== "image") return false;
  if (
    message.sequence !== undefined
    && (typeof message.sequence !== "number" || !Number.isInteger(message.sequence) || message.sequence < 1)
  ) return false;
  if (message.messageId !== undefined && !nonEmptyString(message.messageId)) return false;
  if (message.quotedMessageId !== undefined && !nonEmptyString(message.quotedMessageId)) return false;
  if ((message.kind === "reset" || message.kind === "assistant") && !nonEmptyString(message.replyToken)) return false;
  if (message.kind === "media" && (message.messageType !== "image" || !nonEmptyString(message.messageId))) return false;
  if (message.kind === "assistant" && !nonEmptyString(message.runId)) return false;
  if (message.replyDeadlineAt !== undefined && (typeof message.replyDeadlineAt !== "number" || !Number.isFinite(message.replyDeadlineAt))) {
    return false;
  }
  if (message.kind === "assistant" && typeof message.questionText !== "string") return false;
  return true;
}
