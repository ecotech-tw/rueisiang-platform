import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const RELAY_PATH = "/codex/responses";
const HEALTH_PATH = "/healthz";
const DEFAULT_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api";
const RELAY_TOKEN_HEADER = "x-codex-relay-token";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "cdn-loop",
  "expect",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-real-ip",
]);

function isCloudflareManagedHeader(name) {
  const normalized = name.toLowerCase();
  return normalized.startsWith("cf-") || normalized.startsWith("cf_");
}

function headerValue(headers, name) {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : undefined;
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

export function isAuthorized(headers, expectedToken) {
  const presented = headerValue(headers, RELAY_TOKEN_HEADER)?.trim();
  const expected = expectedToken?.trim();
  if (!presented || !expected) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

export function filterRequestHeaders(headers) {
  const output = new Headers();
  const entries = headers instanceof Headers
    ? headers.entries()
    : Object.entries(headers ?? {});
  for (const [name, rawValue] of entries) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized)
      || normalized === RELAY_TOKEN_HEADER
      || normalized.startsWith("x-forwarded-")
      || isCloudflareManagedHeader(normalized)) {
      continue;
    }
    if (rawValue === undefined) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
    output.set(name, value);
  }
  return output;
}

function normalizeUpstreamBaseUrl(value) {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") {
    throw new Error("CODEX_UPSTREAM_BASE_URL 必須是 https://chatgpt.com/backend-api。 ");
  }
  if (url.username || url.password || url.search || url.hash
    || (url.pathname !== "/backend-api" && url.pathname !== "/backend-api/")) {
    throw new Error("CODEX_UPSTREAM_BASE_URL 只允許 chatgpt.com 的 /backend-api path。 ");
  }
  url.pathname = "/backend-api";
  return url;
}

export function buildUpstreamUrl(baseUrl = DEFAULT_UPSTREAM_BASE_URL) {
  const base = normalizeUpstreamBaseUrl(baseUrl);
  base.pathname = `${base.pathname}${RELAY_PATH}`;
  return base;
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function responseHeaders(response) {
  const headers = {};
  for (const [name, value] of response.headers) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || normalized === "content-encoding") continue;
    headers[name] = value;
  }
  return headers;
}

function parseTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.floor(timeout);
}

function requestPath(request) {
  return new URL(request.url ?? "/", "http://codex-relay.invalid").pathname;
}

function logEvent(logger, event) {
  logger({
    service: "codex-relay",
    ...event,
  });
}

export function createRelayServer({
  token,
  upstreamBaseUrl = DEFAULT_UPSTREAM_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  logger = (event) => console.info(JSON.stringify(event)),
} = {}) {
  const relayToken = token?.trim();
  if (!relayToken) throw new Error("CODEX_RELAY_TOKEN 不可為空。 ");
  const upstreamUrl = buildUpstreamUrl(upstreamBaseUrl);
  const requestTimeoutMs = parseTimeout(timeoutMs);

  const handleRequest = async (request, response) => {
    const path = requestPath(request);
    if (request.method === "GET" && path === HEALTH_PATH) {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method !== "POST" || path !== RELAY_PATH) {
      writeJson(response, 404, { error: "Not found" });
      return;
    }
    if (!isAuthorized(request.headers, relayToken)) {
      writeJson(response, 401, { error: "Unauthorized" });
      return;
    }

    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      writeJson(response, 413, { error: "Request body too large" });
      return;
    }

    const requestId = randomUUID();
    const startedAt = Date.now();
    const controller = new AbortController();
    let abortReason;
    const abort = (reason) => {
      if (controller.signal.aborted) return;
      abortReason = reason;
      controller.abort(new Error(reason));
    };
    const timeout = setTimeout(() => abort("relay-timeout"), requestTimeoutMs);
    const abortFromClient = () => {
      if (request.aborted || (!request.complete && request.destroyed)) {
        abort("client-disconnected");
      }
    };
    let upstreamStatus;
    request.once("aborted", abortFromClient);
    request.once("close", abortFromClient);

    try {
      const targetUrl = new URL(upstreamUrl.toString());
      const upstreamResponse = await fetchImpl(targetUrl, {
        method: "POST",
        headers: filterRequestHeaders(request.headers),
        body: request,
        signal: controller.signal,
        duplex: "half",
      });
      upstreamStatus = upstreamResponse.status;

      response.setHeader("x-codex-relay-request-id", requestId);
      response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse));
      if (!upstreamResponse.body) {
        response.end();
      } else {
        await pipeline(Readable.fromWeb(upstreamResponse.body), response);
      }
      logEvent(logger, {
        requestId,
        method: "POST",
        path: RELAY_PATH,
        status: upstreamResponse.status,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const status = abortReason === "relay-timeout"
        ? 504
        : abortReason === "client-disconnected"
          ? 499
          : 502;
      if (!response.headersSent) {
        writeJson(response, status, {
          error: abortReason === "relay-timeout"
            ? "Upstream request timed out"
            : abortReason === "client-disconnected"
              ? "Client disconnected"
              : "Upstream request failed",
          requestId,
        });
      } else {
        response.destroy();
      }
      logEvent(logger, {
        requestId,
        method: "POST",
        path: RELAY_PATH,
        status,
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : "UnknownError",
        ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
        ...(abortReason ? { abortReason } : {}),
      });
    } finally {
      clearTimeout(timeout);
      request.off("aborted", abortFromClient);
      request.off("close", abortFromClient);
    }
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      if (!response.headersSent) writeJson(response, 500, { error: "Relay internal error" });
      else response.destroy();
      logEvent(logger, {
        method: request.method,
        path: requestPath(request),
        status: 500,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });
  });

  return server;
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint) && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isMainModule()) {
  const server = createRelayServer({
    token: process.env.CODEX_RELAY_TOKEN,
    upstreamBaseUrl: process.env.CODEX_UPSTREAM_BASE_URL,
    timeoutMs: process.env.RELAY_TIMEOUT_MS,
  });
  const host = process.env.LISTEN_HOST || "0.0.0.0";
  const port = Number(process.env.LISTEN_PORT || 8787);
  server.listen(port, host, () => {
    console.info(JSON.stringify({
      service: "codex-relay",
      event: "listening",
      host,
      port,
      upstream: "https://chatgpt.com/backend-api/codex/responses",
    }));
  });
}
