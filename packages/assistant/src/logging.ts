type AssistantLogLevel = "info" | "warn" | "error";

const MAX_LOG_MESSAGE_LENGTH = 2_000;

function redact(value: string): string {
  return value
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .slice(0, MAX_LOG_MESSAGE_LENGTH);
}

function errorDetails(error: unknown, depth = 0): Record<string, unknown> {
  if (depth > 2) return { message: "[nested error omitted]" };

  if (error instanceof Error) {
    const details: Record<string, unknown> = {
      name: error.name,
      message: redact(error.message),
    };
    const status = (error as Error & { status?: unknown }).status;
    if (typeof status === "number") details.status = status;
    const errorFields = error as Error & {
      endpoint?: unknown;
      ambiguous?: unknown;
      retryable?: unknown;
      accepted?: unknown;
    };
    for (const key of ["endpoint", "ambiguous", "retryable", "accepted"] as const) {
      const value = errorFields[key];
      if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") details[key] = value;
    }
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause && cause !== error) details.cause = errorDetails(cause, depth + 1);
    return details;
  }

  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    const details: Record<string, unknown> = {};
    for (const key of ["name", "message", "status", "code", "details"]) {
      const item = value[key];
      if (typeof item === "string") details[key] = redact(item);
      else if (typeof item === "number" || typeof item === "boolean") details[key] = item;
    }
    return Object.keys(details).length ? details : { message: "[object error]" };
  }

  return { message: redact(String(error)) };
}

/**
 * Worker Logs 會把 console 的 object 當成可搜尋欄位；所有 assistant 的診斷事件
 * 統一從這裡輸出，避免各條路由各自拼字串，亦避免把 prompt、tool args 或 secret 寫進 log。
 */
export function assistantLog(
  level: AssistantLogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const payload = {
    event: `assistant.${event}`,
    ...fields,
  };
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.info(payload);
}

export function assistantErrorDetails(error: unknown): Record<string, unknown> {
  return errorDetails(error);
}
