import {
  getAssistantLineMessage,
  deleteMediaObject,
  recordMediaObject,
  updateAssistantLineMessageAttachments,
  updateAssistantLineMessageImageDownloadStatus,
  type Database,
  type StoredMediaAttachment,
} from "@rueisiang/db";
import { assistantErrorDetails, assistantLog } from "@rueisiang/assistant";
import { fetchLineMessageContent, LineContentError, LINE_IMAGE_MAX_BYTES, type LineLogContext } from "./line.js";
import { isNasStorageKey, NasStorageConfigError, NasStorageError, nasStorageClient } from "./nas-storage.js";
import type { Env } from "./env.js";

const LINE_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60_000;
const LINE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

class LineImageStorageError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, cause?: unknown) {
    super(message, { cause });
    this.name = "LineImageStorageError";
    this.retryable = retryable;
  }
}

export function parseStoredLineImageAttachments(value: string | undefined): StoredMediaAttachment[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length > 4) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const attachment = item as Record<string, unknown>;
      if (
        typeof attachment.key !== "string"
        || !isNasStorageKey(attachment.key)
        || typeof attachment.filename !== "string"
        || !attachment.filename
        || typeof attachment.contentType !== "string"
        || !LINE_IMAGE_TYPES.has(attachment.contentType)
        || typeof attachment.size !== "number"
        || !Number.isSafeInteger(attachment.size)
        || attachment.size <= 0
        || attachment.size > LINE_IMAGE_MAX_BYTES
        || typeof attachment.checksum !== "string"
        || !/^[0-9a-f]{64}$/u.test(attachment.checksum)
      ) return [];
      return [{
        key: attachment.key,
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

function imageExtension(contentType: string): string {
  switch (contentType) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return "img";
  }
}

export function isExpiredLineImageAttachment(attachment: StoredMediaAttachment): boolean {
  if (!attachment.expiresAt) return false;
  const expiresAt = Date.parse(attachment.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

function asRetryableStorageError(error: unknown): LineImageStorageError {
  if (error instanceof LineImageStorageError) return error;
  if (error instanceof NasStorageError) {
    return new LineImageStorageError("照片儲存服務暫時無法使用。", error.retryable, error);
  }
  return new LineImageStorageError("照片儲存服務暫時無法使用。", true, error);
}

/** 取回 LINE 圖片並以 assistant/vision/<chat-id>/... 保存，重試同一事件時保持冪等。 */
export async function storeLineImage(input: {
  db: Database;
  env: Pick<Env, "NAS_STORAGE_URL" | "NAS_STORAGE_TOKEN">;
  accessToken: string;
  channelKey: string;
  lineGroupId: string;
  webhookEventId: string;
  messageId: string;
  trace?: LineLogContext;
}): Promise<StoredMediaAttachment> {
  const existing = await getAssistantLineMessage(input.db, {
    channelKey: input.channelKey,
    webhookEventId: input.webhookEventId,
  });
  const existingAttachment = parseStoredLineImageAttachments(existing?.attachments)[0];
  if (existingAttachment) {
    if (isExpiredLineImageAttachment(existingAttachment)) {
      throw new LineImageStorageError("LINE 圖片附件已過期，無法重新讀取。", false);
    }
    if (existing?.imageDownloadStatus !== "stored") {
      await updateAssistantLineMessageImageDownloadStatus(input.db, {
        channelKey: input.channelKey,
        webhookEventId: input.webhookEventId,
        status: "stored",
        error: null,
      });
    }
    return existingAttachment;
  }

  let nas: ReturnType<typeof nasStorageClient>;
  try {
    nas = nasStorageClient(input.env);
  } catch (error) {
    if (error instanceof NasStorageConfigError) {
      throw new LineImageStorageError(error.message, false, error);
    }
    throw error;
  }
  if (!nas) throw new LineImageStorageError("平台尚未設定 NAS storage，無法保存 LINE 圖片。", false);

  const content = await fetchLineMessageContent(input.accessToken, input.messageId, {
    ...input.trace,
    channelKey: input.channelKey,
    groupId: input.lineGroupId,
    messageId: input.messageId,
  });
  const checksumBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", content.body));
  const checksum = Array.from(checksumBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let object: Awaited<ReturnType<typeof nas.put>>;
  try {
    object = await nas.put({
      namespace: "assistant",
      scope: "vision",
      scopeId: input.lineGroupId,
      contentType: content.contentType,
      body: content.body,
    });
  } catch (error) {
    const normalized = asRetryableStorageError(error);
    assistantLog(normalized.retryable ? "warn" : "error", "line.image.storage_failed", {
      ...input.trace,
      channelKey: input.channelKey,
      groupId: input.lineGroupId,
      messageId: input.messageId,
      retryable: normalized.retryable,
      error: assistantErrorDetails(error),
    });
    throw normalized;
  }

  const attachment: StoredMediaAttachment = {
    key: object.key,
    filename: `line-${input.messageId}.${imageExtension(object.contentType)}`.slice(0, 200),
    contentType: object.contentType,
    size: object.size,
    checksum: object.checksum || checksum,
    expiresAt: new Date(Date.now() + LINE_ATTACHMENT_TTL_MS).toISOString(),
  };
  let metadataRecorded = false;
  try {
    await recordMediaObject(input.db, {
      objectKey: attachment.key,
      namespace: "assistant",
      scopeKey: `line:${input.channelKey}:${input.lineGroupId}`,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      checksum: attachment.checksum,
      createdBy: null,
      expiresAt: attachment.expiresAt,
    });
    metadataRecorded = true;
    await updateAssistantLineMessageAttachments(input.db, {
      channelKey: input.channelKey,
      webhookEventId: input.webhookEventId,
      attachments: [attachment],
    });
  } catch (error) {
    if (metadataRecorded) await deleteMediaObject(input.db, attachment.key).catch(() => {});
    await nas.delete(attachment.key).catch((cleanupError) => {
      assistantLog("error", "line.image.rollback_failed", {
        ...input.trace,
        channelKey: input.channelKey,
        groupId: input.lineGroupId,
        messageId: input.messageId,
        objectKey: attachment.key,
        error: assistantErrorDetails(cleanupError),
      });
    });
    throw error;
  }

  assistantLog("info", "line.image.stored", {
    ...input.trace,
    channelKey: input.channelKey,
    groupId: input.lineGroupId,
    messageId: input.messageId,
    objectKey: attachment.key,
    bytes: attachment.size,
    expiresAt: attachment.expiresAt,
  });
  return attachment;
}

export function isPermanentLineImageError(error: unknown): boolean {
  return error instanceof LineContentError ? !error.retryable : error instanceof LineImageStorageError && !error.retryable;
}
