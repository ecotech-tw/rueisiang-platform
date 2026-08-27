import { createDatabase, recordCyberbizReportManifest, syncSystemRoles } from "@rueisiang/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const MCP_TOKEN = "mcp-report-secret";
const SALES_KEY = "reports/cyberbiz/company/2026/07/00000000-0000-0000-0000-000000000021.json";

let d1: LocalD1;

function db() {
  return createDatabase(d1 as never);
}

function salesDocument() {
  return {
    schemaVersion: 1,
    kind: "cyberbiz_sales_monthly",
    scopeType: "company",
    scopeId: "company",
    scopeName: "Company",
    reportMonth: "2026-07",
    coverageStart: "2026-07-01",
    coverageEnd: "2026-07-31",
    granularity: "month",
    rows: [{
      sku: "SKU-1",
      productName: "Product one",
      category: "Bath",
      unitPrice: 100,
      grossQuantity: 3,
      returnQuantity: 1,
      netQuantity: 2,
      salesAmount: 180,
    }],
    totals: { grossQuantity: 3, returnQuantity: 1, netQuantity: 2, salesAmount: 180 },
  };
}

function headers(extra: Record<string, string> = {}) {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${MCP_TOKEN}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function call(method: string, id: number, params: Record<string, unknown> = {}, extra: Record<string, string> = {}) {
  return app.fetch(new Request("https://platform.example.test/api/mcp/cyberbiz-reports", {
    method: "POST",
    headers: headers(extra),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  }), {
    DB: d1,
    NAS_STORAGE_URL: "https://storage.example.test",
    NAS_STORAGE_TOKEN: "nas-secret",
    CYBERBIZ_REPORT_MCP_TOKEN: MCP_TOKEN,
    PUBLIC_APP_URL: "https://platform.example.test",
  } as never);
}

beforeEach(async () => {
  d1 = createLocalD1();
  await syncSystemRoles(db());
  await recordCyberbizReportManifest(db(), {
    reportMonth: "2026-07",
    scopeType: "company",
    scopeId: "company",
    scopeName: "Company",
    coverageStart: "2026-07-01",
    coverageEnd: "2026-07-31",
    salesGranularity: "month",
    payoutGranularity: "day",
    salesObjectKey: SALES_KEY,
    payoutObjectKey: null,
    combinedWorkbookObjectKey: null,
    driveFileId: null,
    driveUrl: null,
    storeIdsJson: "[]",
    sourceChecksum: "b".repeat(64),
    parserVersion: "cyberbiz-report-v1",
    status: "published",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CYBERBIZ reports MCP endpoint", () => {
  it("negotiates, lists exactly two tools, and executes one server-side query", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      expect(new URL(String(input)).searchParams.get("key")).toBe(SALES_KEY);
      return new Response(JSON.stringify(salesDocument()), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const initialized = await call("initialize", 1, {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    expect(initialized.status).toBe(200);
    expect((await initialized.json() as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");

    const listed = await call("tools/list", 2, {}, { "MCP-Protocol-Version": "2025-06-18" });
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { result: { tools: Array<{ name: string }> } };
    expect(listBody.result.tools.map((tool) => tool.name)).toEqual([
      "query_sales_report",
      "query_payout_report",
    ]);

    const queried = await call("tools/call", 3, {
      name: "query_sales_report",
      arguments: { period: "2026-07", scopeType: "company", category: "Bath" },
    }, { "MCP-Protocol-Version": "2025-06-18" });
    expect(queried.status).toBe(200);
    const queryBody = await queried.json() as { result: { isError: boolean; structuredContent: { status: string; totals: { salesAmount: number } } } };
    expect(queryBody.result.isError).toBe(false);
    expect(queryBody.result.structuredContent).toMatchObject({ status: "ok", totals: { salesAmount: 180 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("enforces bearer token, Origin, Accept, and protocol headers", async () => {
    const base = new Request("https://platform.example.test/api/mcp/cyberbiz-reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    });
    const unauthenticated = await app.fetch(base, { DB: d1, CYBERBIZ_REPORT_MCP_TOKEN: MCP_TOKEN } as never);
    expect(unauthenticated.status).toBe(401);

    const noAccept = await call("initialize", 1, { protocolVersion: "2025-06-18" }, { accept: "application/json" });
    expect(noAccept.status).toBe(406);

    const badOrigin = await call("initialize", 1, { protocolVersion: "2025-06-18" }, { origin: "https://evil.example.test" });
    expect(badOrigin.status).toBe(403);

    const unsupportedProtocol = await call("tools/list", 1, {}, { "MCP-Protocol-Version": "2099-01-01" });
    expect(unsupportedProtocol.status).toBe(400);
  });

  it("accepts initialized notifications without creating a tool call", async () => {
    const response = await app.fetch(new Request("https://platform.example.test/api/mcp/cyberbiz-reports", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }), {
      DB: d1,
      CYBERBIZ_REPORT_MCP_TOKEN: MCP_TOKEN,
      PUBLIC_APP_URL: "https://platform.example.test",
    } as never);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });
});
