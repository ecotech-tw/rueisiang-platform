import { assistantLog } from "@rueisiang/assistant";
import { createDatabase } from "@rueisiang/db";
import { PLATFORM_TOOL_MAP, type PlatformToolDefinition } from "@rueisiang/tools";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { createCyberbizReportService } from "../cyberbiz-reports.js";
import { nasStorageClient } from "../nas-storage.js";

const PROTOCOL_VERSION = "2025-06-18";
const LEGACY_PROTOCOL_VERSION = "2025-03-26";
const MAX_REQUEST_BYTES = 128 * 1024;
const TOOL_TIMEOUT_MS = 15_000;
const TOOL_KEYS = ["query_sales_report", "query_payout_report"] as const;

type JsonRpcId = string | number;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorResponse(id: JsonRpcId | undefined, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    ...(id === undefined ? {} : { id }),
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function resultResponse(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

async function sameSecret(presented: string | undefined, expected: string | undefined): Promise<boolean> {
  if (!presented || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function originAllowed(c: { req: { header(name: string): string | undefined }; env: AppEnv["Bindings"] }): boolean {
  const origin = c.req.header("Origin");
  if (!origin) return true;
  const configured = c.env.PUBLIC_APP_URL?.trim();
  if (!configured) return false;
  try {
    return new URL(configured).origin === origin;
  } catch {
    return false;
  }
}

function authorizedTool(key: string): PlatformToolDefinition | undefined {
  if (!(TOOL_KEYS as readonly string[]).includes(key)) return undefined;
  const tool = PLATFORM_TOOL_MAP.get(key);
  return tool?.surfaces.includes("mcp") && tool.requiredPermissions?.includes("reports:cyberbiz:read") ? tool : undefined;
}

function mcpTool(tool: PlatformToolDefinition) {
  return {
    name: tool.key,
    title: tool.label,
    description: tool.description,
    inputSchema: tool.parameters,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  };
}

async function runTool(c: AppEnv["Bindings"], request: JsonRpcRequest, tool: PlatformToolDefinition) {
  const params = isRecord(request.params) ? request.params : {};
  const args = params.arguments;
  if (args !== undefined && !isRecord(args)) {
    return resultResponse(request.id!, {
      content: [{ type: "text", text: "工具 arguments 必須是 JSON object。" }],
      isError: true,
    });
  }
  const db = createDatabase(c.DB);
  const service = createCyberbizReportService(db, nasStorageClient(c));
  const startedAt = Date.now();
  try {
    const text = await Promise.race([
      tool.execute(args ?? {}, {
        surface: "mcp",
        db,
        env: c,
        services: { cyberbizReports: service },
      }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("MCP tool timeout")), TOOL_TIMEOUT_MS)),
    ]);
    let structuredContent: unknown;
    try {
      structuredContent = JSON.parse(text);
    } catch {
      structuredContent = undefined;
    }
    assistantLog("info", "mcp.cyberbiz_report.tool_completed", {
      durationMs: Date.now() - startedAt,
      toolKey: tool.key,
    });
    return resultResponse(request.id!, {
      content: [{ type: "text", text }],
      ...(structuredContent === undefined ? {} : { structuredContent }),
      isError: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "工具執行失敗。";
    assistantLog("warn", "mcp.cyberbiz_report.tool_failed", {
      durationMs: Date.now() - startedAt,
      toolKey: tool.key,
      error: message,
    });
    return resultResponse(request.id!, {
      content: [{ type: "text", text: message }],
      isError: true,
    });
  }
}

function supportedVersion(version: unknown): string | undefined {
  if (version === PROTOCOL_VERSION || version === LEGACY_PROTOCOL_VERSION) return version;
  return undefined;
}

function initializeResult(protocolVersion: string) {
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "rueisiang-cyberbiz-reports", version: "1.0.0" },
    instructions: "只能查詢已 published 的報表；商品銷售總表只有月粒度，不能把月報拆成日資料。",
  };
}

export const cyberbizReportsMcp = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    if (!originAllowed(c)) return c.json({ error: "Origin not allowed" }, 403);
    const authorization = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!await sameSecret(authorization, c.env.CYBERBIZ_REPORT_MCP_TOKEN)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  })
  .get("/", () => new Response(null, { status: 405, headers: { Allow: "POST, GET, DELETE" } }))
  .delete("/", () => new Response(null, { status: 405, headers: { Allow: "POST, GET, DELETE" } }))
  .post("/", async (c) => {
    const contentType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return c.json({ error: "Content-Type must be application/json" }, 415);
    const accept = c.req.header("Accept") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      return c.json({ error: "Accept must include application/json and text/event-stream" }, 406);
    }
    const contentLength = Number(c.req.header("Content-Length") ?? 0);
    if (contentLength > MAX_REQUEST_BYTES) return c.json({ error: "Request too large" }, 413);

    let body: unknown;
    try {
      const text = await c.req.text();
      if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) return c.json({ error: "Request too large" }, 413);
      body = JSON.parse(text);
    } catch {
      return c.json(errorResponse(undefined, -32700, "Parse error"), 400);
    }
    if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string" || Array.isArray(body)) {
      return c.json(errorResponse(undefined, -32600, "Invalid Request"), 400);
    }
    if (body.id !== undefined && typeof body.id !== "string" && typeof body.id !== "number") {
      return c.json(errorResponse(undefined, -32600, "Invalid Request"), 400);
    }
    const request = body as JsonRpcRequest;
    if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") {
      return new Response(null, { status: 202 });
    }
    if (request.id === undefined) return c.json(errorResponse(undefined, -32600, "Request must have an id"), 400);

    if (request.method === "initialize") {
      const version = isRecord(request.params) ? supportedVersion(request.params.protocolVersion) : undefined;
      if (!version) return c.json(errorResponse(request.id, -32602, "Unsupported protocol version", { supported: [PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION] }), 400);
      return c.json(resultResponse(request.id, initializeResult(version)));
    }

    const requestedVersion = c.req.header("MCP-Protocol-Version");
    if (requestedVersion && !supportedVersion(requestedVersion)) {
      return c.json(errorResponse(request.id, -32602, "Unsupported protocol version", { supported: [PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION] }), 400);
    }
    if (request.method === "ping") return c.json(resultResponse(request.id, {}));
    if (request.method === "tools/list") {
      return c.json(resultResponse(request.id, {
        tools: TOOL_KEYS.map((key) => authorizedTool(key)).filter((tool): tool is PlatformToolDefinition => Boolean(tool)).map(mcpTool),
      }));
    }
    if (request.method === "tools/call") {
      const params = isRecord(request.params) ? request.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      const tool = authorizedTool(name);
      if (!tool) return c.json(errorResponse(request.id, -32602, `Unknown tool: ${name}`), 400);
      return c.json(await runTool(c.env, request, tool));
    }
    return c.json(errorResponse(request.id, -32601, `Method not found: ${request.method}`), 404);
  });
