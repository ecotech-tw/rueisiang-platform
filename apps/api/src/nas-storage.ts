import type { Env } from "./env.js";

const OBJECTS_PATH = "/v1/objects";
const STORAGE_TOKEN_HEADER = "x-storage-token";
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const GENERATED_KEY = /^(assistant\/vision\/\d{4}\/(0[1-9]|1[0-2])\/[0-9a-f-]{36}\.[A-Za-z0-9]+|wms\/zones\/[A-Za-z0-9._-]{1,100}\/\d{4}\/(0[1-9]|1[0-2])\/[0-9a-f-]{36}\.[A-Za-z0-9]+)$/;

export type NasStorageNamespace = "assistant" | "wms";

export interface NasStorageObject {
  key: string;
  size: number;
  checksum: string;
  contentType: string;
}

export interface NasStoragePutInput {
  namespace: NasStorageNamespace;
  scope: "vision" | "zones";
  scopeId?: string;
  contentType: string;
  body: ArrayBuffer;
}

export interface NasStorageClient {
  put(input: NasStoragePutInput): Promise<NasStorageObject>;
  get(key: string): Promise<Response | null>;
  delete(key: string): Promise<void>;
}

export class NasStorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NasStorageConfigError";
  }
}

export class NasStorageError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "NasStorageError";
    this.status = status;
    this.code = code;
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

interface ErrorPayload {
  error?: unknown;
  message?: unknown;
}

function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new NasStorageConfigError("NAS_STORAGE_URL 格式不正確，必須是 http 或 https URL。");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNasObject(value: unknown): value is NasStorageObject {
  if (!isRecord(value)) return false;
  return (
    typeof value.key === "string" &&
    isNasStorageKey(value.key) &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size > 0 &&
    typeof value.checksum === "string" &&
    /^[0-9a-f]{64}$/.test(value.checksum) &&
    typeof value.contentType === "string" &&
    value.contentType.length > 0
  );
}

/** 只接受 gateway 自己產生的 key，避免把任意路徑交給 NAS。 */
export function isNasStorageKey(value: string): boolean {
  return GENERATED_KEY.test(value);
}

async function readSmallText(response: Response): Promise<string | null> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!result.value) continue;
      total += result.value.byteLength;
      if (total > MAX_ERROR_BODY_BYTES) {
        await reader.cancel();
        return null;
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
  return new TextDecoder().decode(bytes);
}

async function responseError(response: Response): Promise<NasStorageError> {
  const text = await readSmallText(response);
  let payload: ErrorPayload | undefined;
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) payload = parsed as ErrorPayload;
    } catch {
      // gateway 回傳非 JSON 時，改用固定訊息，不把整段 HTML 帶進平台錯誤。
    }
  }

  const code = typeof payload?.error === "string" ? payload.error : "storage_request_failed";
  const message = typeof payload?.message === "string"
    ? payload.message
    : `NAS storage gateway 回應 HTTP ${response.status}。`;
  return new NasStorageError(response.status, code, message);
}

function objectUrl(baseUrl: string, key?: string): URL {
  const url = new URL(`${baseUrl}${OBJECTS_PATH}`);
  if (key !== undefined) url.searchParams.set("key", key);
  return url;
}

function requestHeaders(token: string, contentType?: string): HeadersInit {
  return {
    [STORAGE_TOKEN_HEADER]: token,
    ...(contentType ? { "content-type": contentType } : {}),
  };
}

function validatePutInput(input: NasStoragePutInput): void {
  if (input.namespace === "assistant" && input.scope !== "vision") {
    throw new NasStorageError(400, "invalid_scope", "assistant namespace 只支援 vision scope。");
  }
  if (input.namespace === "wms" && input.scope !== "zones") {
    throw new NasStorageError(400, "invalid_scope", "wms namespace 只支援 zones scope。");
  }
  if (input.namespace === "wms" && !input.scopeId) {
    throw new NasStorageError(400, "invalid_scope_id", "wms zones upload 需要 scopeId。");
  }
}

export function nasStorageClient(
  env: Pick<Env, "NAS_STORAGE_URL" | "NAS_STORAGE_TOKEN">,
  options: { fetch?: typeof fetch } = {},
): NasStorageClient | undefined {
  const rawUrl = env.NAS_STORAGE_URL?.trim();
  const token = env.NAS_STORAGE_TOKEN?.trim();
  if (!rawUrl && !token) return undefined;
  if (!rawUrl || !token) {
    throw new NasStorageConfigError("NAS_STORAGE_URL 與 NAS_STORAGE_TOKEN 必須同時設定。");
  }

  const baseUrl = normalizeBaseUrl(rawUrl);
  const fetcher = options.fetch ?? fetch;

  return {
    async put(input) {
      validatePutInput(input);
      const url = objectUrl(baseUrl);
      url.searchParams.set("namespace", input.namespace);
      url.searchParams.set("scope", input.scope);
      if (input.scopeId) url.searchParams.set("scopeId", input.scopeId);

      const response = await fetcher(url, {
        method: "POST",
        headers: requestHeaders(token, input.contentType),
        body: input.body,
      });
      if (!response.ok) throw await responseError(response);

      const text = await readSmallText(response);
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : undefined;
      } catch {
        throw new NasStorageError(502, "invalid_response", "NAS storage gateway 回傳的格式不正確。");
      }
      const object = isRecord(payload) ? payload.object : undefined;
      if (!isNasObject(object)) {
        throw new NasStorageError(502, "invalid_response", "NAS storage gateway 沒有回傳有效的 object。");
      }
      return object;
    },

    async get(key) {
      if (!isNasStorageKey(key)) {
        throw new NasStorageError(400, "invalid_object_key", "NAS object key 格式不正確。");
      }
      const response = await fetcher(objectUrl(baseUrl, key), {
        headers: requestHeaders(token),
      });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) throw await responseError(response);
      return response;
    },

    async delete(key) {
      if (!isNasStorageKey(key)) {
        throw new NasStorageError(400, "invalid_object_key", "NAS object key 格式不正確。");
      }
      const response = await fetcher(objectUrl(baseUrl, key), {
        method: "DELETE",
        headers: requestHeaders(token),
      });
      if (response.status === 404) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok) throw await responseError(response);
      await response.body?.cancel();
    },
  };
}
