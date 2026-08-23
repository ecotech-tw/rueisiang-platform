import type { Api, Model, ProviderResponse } from "@earendil-works/pi-ai";

const MAX_DIAGNOSTIC_TEXT_LENGTH = 1_200;
const MAX_STACK_LENGTH = 2_000;

export interface PiProviderResponseDiagnostic {
  provider: string;
  model: string;
  endpoint?: string;
  status: number;
  contentType?: string;
  cfRay?: string;
  requestId?: string;
  relayRequestId?: string;
  retryAfter?: string;
  server?: string;
}

export interface PiProviderExecutionDiagnostics {
  runId?: string;
  lastResponse?: PiProviderResponseDiagnostic;
}

export interface PiErrorDiagnostic {
  name: string;
  message: string;
  stack?: string;
  cause?: {
    name: string;
    message: string;
  };
}

function header(response: ProviderResponse, name: string): string | undefined {
  const value = response.headers[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/\s+/gu, " ")
    .trim();
}

export function diagnosticText(value: string, limit = MAX_DIAGNOSTIC_TEXT_LENGTH): string {
  const normalized = /<html[\s>]/iu.test(value) || /<!doctype html/iu.test(value)
    ? stripHtml(value)
    : value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

export function providerResponseDiagnostic(
  model: Pick<Model<Api>, "id" | "provider" | "baseUrl">,
  response: ProviderResponse,
): PiProviderResponseDiagnostic {
  const contentType = header(response, "content-type");
  const cfRay = header(response, "cf-ray");
  const requestId = header(response, "x-request-id") ?? header(response, "x-openai-request-id");
  const relayRequestId = header(response, "x-codex-relay-request-id");
  const retryAfter = header(response, "retry-after");
  const server = header(response, "server");
  return {
    provider: model.provider,
    model: model.id,
    ...(model.baseUrl ? { endpoint: model.baseUrl } : {}),
    status: response.status,
    ...(contentType ? { contentType } : {}),
    ...(cfRay ? { cfRay } : {}),
    ...(requestId ? { requestId } : {}),
    ...(relayRequestId ? { relayRequestId } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    ...(server ? { server } : {}),
  };
}

function errorCause(error: unknown): PiErrorDiagnostic["cause"] {
  if (!(error instanceof Error) || !(error.cause instanceof Error)) return undefined;
  return {
    name: error.cause.name,
    message: diagnosticText(error.cause.message),
  };
}

export function serializePiError(error: unknown): PiErrorDiagnostic {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: diagnosticText(String(error)) };
  }
  const cause = errorCause(error);
  return {
    name: error.name,
    message: diagnosticText(error.message),
    ...(error.stack ? { stack: diagnosticText(error.stack, MAX_STACK_LENGTH) } : {}),
    ...(cause ? { cause } : {}),
  };
}

export function publicPiErrorMessage(
  error: unknown,
  response?: PiProviderResponseDiagnostic,
): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const status = response ? `HTTP ${response.status}` : undefined;
  if (response?.contentType?.toLowerCase().includes("text/html") || /<!doctype html|<html[\s>]/iu.test(rawMessage)) {
    return `AI provider 回傳非預期的 HTML 錯誤頁${status ? `（${status}）` : ""}，請查看 Worker log。`;
  }
  const message = diagnosticText(rawMessage);
  return message || "Pi agent 執行失敗。";
}
