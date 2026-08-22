export type LineSourceType = "group" | "room" | "user";

interface LineAssistantQueueMessageBase {
  assistantKey: string;
  channelKey: string;
  groupRowId: string;
  lineGroupId: string;
  sourceType: LineSourceType;
  webhookEventId: string;
  messageId?: string;
  /** LINE reply token 的實際截止時間；舊 Queue 訊息沒有這欄時由 consumer 使用保守預設值。 */
  replyDeadlineAt?: number;
}

export type LineAssistantQueueMessage = LineAssistantQueueMessageBase & (
  | { kind: "profile" }
  | { kind: "reset"; replyToken: string }
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
    !["profile", "reset", "assistant"].includes(message.kind) ||
    !nonEmptyString(message.assistantKey) ||
    !nonEmptyString(message.channelKey) ||
    !nonEmptyString(message.groupRowId) ||
    !nonEmptyString(message.lineGroupId) ||
    !["group", "room", "user"].includes(message.sourceType as string) ||
    !nonEmptyString(message.webhookEventId)
  ) {
    return false;
  }
  if (message.messageId !== undefined && !nonEmptyString(message.messageId)) return false;
  if (message.kind !== "profile" && !nonEmptyString(message.replyToken)) return false;
  if (message.kind === "assistant" && !nonEmptyString(message.runId)) return false;
  if (message.replyDeadlineAt !== undefined && (typeof message.replyDeadlineAt !== "number" || !Number.isFinite(message.replyDeadlineAt))) {
    return false;
  }
  if (message.kind === "assistant" && typeof message.questionText !== "string") return false;
  return true;
}
