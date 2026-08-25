import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OBJECTS_PATH = "/v1/objects";
const HEALTH_PATH = "/healthz";
const STORAGE_TOKEN_HEADER = "x-storage-token";
const DEFAULT_MAX_OBJECT_BYTES = 10 * 1024 * 1024;

const MIME_TO_EXTENSION = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

const EXTENSION_TO_MIME = new Map(
  [...MIME_TO_EXTENSION].map(([mime, extension]) => [extension, mime]),
);

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const GENERATED_FILENAME_PATTERN = new RegExp(`^${UUID_PATTERN}\\.(jpg|png|webp|gif)$`);

class StorageHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "StorageHttpError";
    this.status = status;
    this.code = code;
  }
}

class ObjectTooLargeError extends StorageHttpError {
  constructor(maxBytes) {
    super(413, "object_too_large", `檔案不能超過 ${maxBytes} bytes。`);
  }
}

class HashLimitTransform extends Transform {
  constructor(maxBytes) {
    super();
    this.maxBytes = maxBytes;
    this.size = 0;
    this.hash = createHash("sha256");
  }

  _transform(chunk, encoding, callback) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.size += bytes.length;
    if (this.size > this.maxBytes) {
      callback(new ObjectTooLargeError(this.maxBytes));
      return;
    }
    this.hash.update(bytes);
    callback(null, bytes);
  }

  checksum() {
    return this.hash.digest("hex");
  }
}

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : undefined;
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

export function isAuthorized(headers, expectedToken) {
  const presented = headerValue(headers, STORAGE_TOKEN_HEADER)?.trim();
  const expected = expectedToken?.trim();
  if (!presented || !expected) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function normalizeMaxBytes(value) {
  const maxBytes = Number(value ?? DEFAULT_MAX_OBJECT_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("STORAGE_MAX_OBJECT_BYTES 必須是正整數。 ");
  }
  return maxBytes;
}

function requestPath(request) {
  return new URL(request.url ?? "/", "http://nas-storage.invalid").pathname;
}

function requestUrl(request) {
  return new URL(request.url ?? "/", "http://nas-storage.invalid");
}

function writeJson(response, status, payload, method = "GET") {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(method === "HEAD" ? undefined : body);
}

function writeError(response, error, method) {
  if (error instanceof StorageHttpError) {
    writeJson(response, error.status, { error: error.code, message: error.message }, method);
    return;
  }
  writeJson(response, 500, { error: "storage_internal_error", message: "儲存服務發生內部錯誤。" }, method);
}

function logEvent(logger, event) {
  logger({ service: "nas-storage", ...event });
}

function safeScopeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value);
}

function contentTypeFromRequest(request) {
  const contentType = headerValue(request.headers, "content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!contentType || !MIME_TO_EXTENSION.has(contentType)) {
    throw new StorageHttpError(415, "unsupported_content_type", "只接受 JPEG、PNG、WebP 或 GIF 圖片。 ");
  }
  return contentType;
}

function dateParts(now) {
  return {
    year: String(now.getUTCFullYear()),
    month: String(now.getUTCMonth() + 1).padStart(2, "0"),
  };
}

export function buildObjectKey({ namespace, scope, scopeId, contentType, now = new Date(), objectId = randomUUID() }) {
  const normalizedNamespace = namespace?.trim().toLowerCase();
  const normalizedScope = scope?.trim().toLowerCase();
  const normalizedScopeId = typeof scopeId === "string" ? scopeId.trim() : undefined;
  const extension = MIME_TO_EXTENSION.get(contentType);
  if (!extension) throw new StorageHttpError(415, "unsupported_content_type", "不支援的圖片格式。 ");

  const { year, month } = dateParts(now);
  if (normalizedNamespace === "assistant" && normalizedScope === "vision" && safeScopeId(normalizedScopeId)) {
    return `assistant/vision/${normalizedScopeId}/${year}/${month}/${objectId}.${extension}`;
  }
  if (normalizedNamespace === "wms" && normalizedScope === "zones" && safeScopeId(normalizedScopeId)) {
    return `wms/zones/${normalizedScopeId}/${year}/${month}/${objectId}.${extension}`;
  }
  throw new StorageHttpError(400, "invalid_storage_scope", "不支援的儲存 namespace 或 scope。 ");
}

function validateObjectKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 400) {
    throw new StorageHttpError(400, "invalid_object_key", "物件 key 無效。 ");
  }
  const parts = key.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new StorageHttpError(400, "invalid_object_key", "物件 key 無效。 ");
  }

  const isLegacyAssistantKey = parts.length === 5
    && parts[0] === "assistant"
    && parts[1] === "vision";
  const isAssistantKey = parts.length === 6
    && parts[0] === "assistant"
    && parts[1] === "vision"
    && safeScopeId(parts[2]);
  const isWmsKey = parts.length === 6
    && parts[0] === "wms"
    && parts[1] === "zones"
    && safeScopeId(parts[2]);
  const dateIndex = isAssistantKey ? 3 : isLegacyAssistantKey ? 2 : isWmsKey ? 3 : -1;
  if (dateIndex < 0 || !/^\d{4}$/.test(parts[dateIndex]) || !/^(0[1-9]|1[0-2])$/.test(parts[dateIndex + 1])) {
    throw new StorageHttpError(400, "invalid_object_key", "物件 key 無效。 ");
  }
  if (!GENERATED_FILENAME_PATTERN.test(parts.at(-1))) {
    throw new StorageHttpError(400, "invalid_object_key", "物件 key 無效。 ");
  }
  return parts.join("/");
}

function resolveObjectPath(root, key) {
  const normalizedKey = validateObjectKey(key);
  const rootPath = path.resolve(root);
  const objectPath = path.resolve(rootPath, ...normalizedKey.split("/"));
  const relativePath = path.relative(rootPath, objectPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new StorageHttpError(400, "invalid_object_key", "物件 key 無效。 ");
  }
  return { key: normalizedKey, path: objectPath };
}

function mimeTypeFromKey(key) {
  const extension = key.split(".").at(-1);
  return EXTENSION_TO_MIME.get(extension) ?? "application/octet-stream";
}

async function objectStat(root, key) {
  const resolved = resolveObjectPath(root, key);
  let metadata;
  try {
    metadata = await stat(resolved.path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new StorageHttpError(404, "object_not_found", "找不到這個物件。 ");
    }
    throw error;
  }
  if (!metadata.isFile()) throw new StorageHttpError(404, "object_not_found", "找不到這個物件。 ");
  return { ...resolved, size: metadata.size };
}

async function storeRequestBody(request, objectPath, maxBytes) {
  rejectDeclaredLength(request, maxBytes);

  const limiter = new HashLimitTransform(maxBytes);
  const temporaryPath = `${objectPath}.${randomUUID()}.part`;
  const writer = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
  try {
    await pipeline(request, limiter, writer);
    if (limiter.size === 0) throw new StorageHttpError(400, "empty_object", "不能儲存空的物件。 ");
    await rename(temporaryPath, objectPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return { size: limiter.size, checksum: limiter.checksum() };
}

function rejectDeclaredLength(request, maxBytes) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
    throw new ObjectTooLargeError(maxBytes);
  }
}

export function createStorageServer({
  root = process.env.STORAGE_ROOT || "/storage",
  token = process.env.STORAGE_ACCESS_TOKEN,
  maxObjectBytes = process.env.STORAGE_MAX_OBJECT_BYTES,
  now = () => new Date(),
  fetchLogger = (event) => console.info(JSON.stringify(event)),
} = {}) {
  const accessToken = token?.trim();
  if (!accessToken) throw new Error("STORAGE_ACCESS_TOKEN 不可為空。 ");
  const storageRoot = path.resolve(root);
  const maxBytes = normalizeMaxBytes(maxObjectBytes);

  const handleRequest = async (request, response) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const method = request.method ?? "GET";
    const url = requestUrl(request);
    const pathName = url.pathname;
    let status = 200;
    let bytes = 0;
    let key;
    let logged = false;
    const logSuccess = () => {
      if (logged) return;
      logged = true;
      logEvent(fetchLogger, {
        bytes,
        durationMs: Date.now() - startedAt,
        key,
        method,
        requestId,
        status,
      });
    };

    try {
      if (method === "GET" && pathName === HEALTH_PATH) {
        writeJson(response, 200, { ok: true });
        logSuccess();
        return;
      }
      if (pathName !== OBJECTS_PATH) throw new StorageHttpError(404, "not_found", "找不到這個 endpoint。 ");
      if (!isAuthorized(request.headers, accessToken)) {
        throw new StorageHttpError(401, "unauthorized", "未授權的儲存請求。 ");
      }

      if (method === "POST") {
        const namespace = url.searchParams.get("namespace");
        const scope = url.searchParams.get("scope");
        const scopeId = url.searchParams.get("scopeId") || undefined;
        const contentType = contentTypeFromRequest(request);
        key = buildObjectKey({ namespace, scope, scopeId, contentType, now: now() });
        const resolved = resolveObjectPath(storageRoot, key);
        rejectDeclaredLength(request, maxBytes);
        await mkdir(path.dirname(resolved.path), { recursive: true, mode: 0o750 });
        const result = await storeRequestBody(request, resolved.path, maxBytes);
        bytes = result.size;
        status = 201;
        writeJson(response, 201, {
          object: {
            checksum: result.checksum,
            contentType,
            key,
            size: result.size,
          },
        });
        logSuccess();
        return;
      }

      if (method === "GET" || method === "HEAD") {
        key = url.searchParams.get("key") || "";
        const object = await objectStat(storageRoot, key);
        bytes = object.size;
        response.writeHead(200, {
          "cache-control": "private, max-age=31536000, immutable",
          "content-length": object.size,
          "content-type": mimeTypeFromKey(object.key),
          etag: `"${object.size.toString(16)}-${object.key.split("/").at(-1)}"`,
          "x-storage-key": object.key,
        });
        if (method === "HEAD") {
          response.end();
          logSuccess();
          return;
        }
        await pipeline(createReadStream(object.path), response);
        logSuccess();
        return;
      }

      if (method === "DELETE") {
        key = url.searchParams.get("key") || "";
        const object = await objectStat(storageRoot, key);
        await rm(object.path);
        bytes = object.size;
        writeJson(response, 200, { key: object.key, ok: true });
        logSuccess();
        return;
      }

      throw new StorageHttpError(405, "method_not_allowed", "不支援這個 HTTP method。 ");
    } catch (error) {
      status = error instanceof StorageHttpError ? error.status : 500;
      if (!response.headersSent) writeError(response, error, method);
      else response.destroy();
      logged = true;
      logEvent(fetchLogger, {
        bytes,
        durationMs: Date.now() - startedAt,
        errorCode: error instanceof StorageHttpError ? error.code : "storage_internal_error",
        method,
        requestId,
        status,
      });
      return;
    }
  };

  return createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      if (!response.headersSent) writeError(response, error, request.method);
      else response.destroy();
    });
  });
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint) && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isMainModule()) {
  const server = createStorageServer();
  const host = process.env.LISTEN_HOST || "0.0.0.0";
  const port = Number(process.env.LISTEN_PORT || 8787);
  server.listen(port, host, () => {
    console.info(JSON.stringify({
      service: "nas-storage",
      event: "listening",
      host,
      port,
      root: process.env.STORAGE_ROOT || "/storage",
    }));
  });
}
