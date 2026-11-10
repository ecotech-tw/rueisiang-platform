import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const UPSTREAM_ORIGIN = "https://app-store-api.cyberbiz.io";
const HEALTH_PATH = "/healthz";
const RELAY_TOKEN_HEADER = "x-cyberbiz-relay-token";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const ID = "(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+";
const SAFE_RESPONSE_HEADERS = ["content-type", "retry-after", "x-total-count", "x-total-pages"];

const ROUTES = [
  { method: "GET", name: "customers.list", pattern: /^\/v1\/customers$/ },
  { method: "POST", name: "customers.create", pattern: /^\/v1\/customers$/ },
  { method: "GET", name: "customers.item", pattern: new RegExp(`^/v1/customers/${ID}$`) },
  { method: "PUT", name: "customers.update", pattern: new RegExp(`^/v1/customers/${ID}$`) },
  { method: "GET", name: "customers.orders", pattern: new RegExp(`^/v1/customers/${ID}/orders$`) },
  { method: "GET", name: "products.list", pattern: /^\/v1\/products$/ },
  { method: "GET", name: "products.search", pattern: /^\/v1\/products\/search$/ },
  { method: "GET", name: "products.item", pattern: new RegExp(`^/v1/products/${ID}$`) },
  { method: "POST", name: "inventory.adjust", pattern: /^\/v1\/stock_adjustments$/ },
  { method: "GET", name: "orders.list", pattern: /^\/v1\/orders$/ },
  { method: "GET", name: "orders.lookup", pattern: /^\/v1\/orders\/get_order_id$/ },
  { method: "GET", name: "orders.item", pattern: new RegExp(`^/v1/orders/${ID}$`) },
];

class RelayError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

export function isAuthorized(headers, expectedToken) {
  const presented = headers[RELAY_TOKEN_HEADER] ?? headers[RELAY_TOKEN_HEADER.toLowerCase()];
  const expected = expectedToken?.trim();
  if (typeof presented !== "string" || !expected || !presented.trim()) return false;
  return timingSafeEqual(digest(presented.trim()), digest(expected));
}

export function matchRoute(method, pathname) {
  return ROUTES.find((route) => route.method === method && route.pattern.test(pathname)) ?? null;
}

function parseTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : DEFAULT_TIMEOUT_MS;
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function logEvent(logger, event) {
  logger({ service: "cyberbiz-api-relay", ...event });
}

async function readBody(request) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new RelayError(413, "request_too_large");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new RelayError(413, "request_too_large");
    chunks.push(bytes);
  }
  return size ? Buffer.concat(chunks, size) : undefined;
}

function setSafeResponseHeaders(response, upstreamResponse) {
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers.get(name);
    if (value !== null) response.setHeader(name, value);
  }
}

export function createRelayServer({
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = (event) => console.info(JSON.stringify(event)),
} = {}) {
  const relayToken = token?.trim();
  if (!relayToken || Buffer.byteLength(relayToken) < 32) {
    throw new Error("CYBERBIZ_RELAY_TOKEN 必須至少 32 bytes。");
  }
  const requestTimeoutMs = parseTimeout(timeoutMs);

  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://cyberbiz-relay.invalid");
    let route;
    let upstreamStatus;

    const log = (status, extra = {}) => logEvent(logger, {
      durationMs: Date.now() - startedAt,
      method,
      requestId,
      route: route?.name ?? "unmatched",
      status,
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
      ...extra,
    });

    try {
      if (method === "GET" && url.pathname === HEALTH_PATH) {
        writeJson(response, 200, { ok: true });
        log(200);
        return;
      }
      if (url.href.length > 4096 || url.hash || url.username || url.password) {
        throw new RelayError(400, "invalid_request");
      }
      route = matchRoute(method, url.pathname);
      if (!route) throw new RelayError(404, "route_not_allowed");
      if (!isAuthorized(request.headers, relayToken)) throw new RelayError(401, "unauthorized");

      const body = method === "GET" ? undefined : await readBody(request);
      const headers = new Headers();
      const accept = request.headers.accept;
      const authorization = request.headers.authorization;
      const contentType = request.headers["content-type"];
      if (typeof accept === "string") headers.set("accept", accept);
      if (typeof authorization === "string" && /^Bearer\s+\S+$/i.test(authorization)) {
        headers.set("authorization", authorization);
      } else {
        throw new RelayError(401, "upstream_authorization_required");
      }
      if (typeof contentType === "string" && body) headers.set("content-type", contentType);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("relay_timeout")), requestTimeoutMs);
      request.once("aborted", () => controller.abort(new Error("client_disconnected")));
      try {
        const upstreamUrl = new URL(`${url.pathname}${url.search}`, UPSTREAM_ORIGIN);
        const upstreamResponse = await fetchImpl(upstreamUrl, {
          method,
          headers,
          body,
          redirect: "manual",
          signal: controller.signal,
        });
        upstreamStatus = upstreamResponse.status;
        response.statusCode = upstreamResponse.status;
        response.setHeader("cache-control", "no-store");
        setSafeResponseHeaders(response, upstreamResponse);
        if (!upstreamResponse.body) {
          response.end();
        } else {
          await pipeline(Readable.fromWeb(upstreamResponse.body), response);
        }
        log(upstreamResponse.status);
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      const status = error instanceof RelayError ? error.status : 502;
      if (!response.headersSent) writeJson(response, status, {
        error: error instanceof RelayError ? error.code : "upstream_request_failed",
        requestId,
      });
      else response.destroy();
      log(status, { errorCode: error instanceof RelayError ? error.code : "upstream_request_failed" });
    }
  });

  return server;
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint) && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isMainModule()) {
  const server = createRelayServer({
    token: process.env.CYBERBIZ_RELAY_TOKEN,
    timeoutMs: process.env.RELAY_TIMEOUT_MS,
  });
  const host = process.env.LISTEN_HOST || "0.0.0.0";
  const port = Number(process.env.LISTEN_PORT || 8788);
  server.listen(port, host, () => {
    console.info(JSON.stringify({ service: "cyberbiz-api-relay", event: "listening", host, port }));
  });
}
