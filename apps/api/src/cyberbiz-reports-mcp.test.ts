import { createDatabase, insertReportSalesMonthly, upsertReportScope } from "@rueisiang/db";
import { itemCategories } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const MCP_TOKEN = "mcp-report-secret";
let d1: LocalD1;

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
    CYBERBIZ_REPORT_MCP_TOKEN: MCP_TOKEN,
    PUBLIC_APP_URL: "https://platform.example.test",
  } as never);
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  const db = createDatabase(d1 as never);
  await upsertReportScope(db, { id: "cyberbiz:store:test", scopeKind: "store", name: "測試店" });
  await upsertReportScope(db, { id: "cyberbiz:channel:shop", scopeKind: "channel", name: "官網" });
  await db.insert(itemCategories).values({ id: "mcp-bath", depth: 0, parentId: null, parentDepth: null, name: "沐浴", color: "rose", sortOrder: 0, active: 1 });
  await insertReportSalesMonthly(db, [{
    scopeId: "cyberbiz:store:test", reportMonth: "2026-07", sku: "SKU-1", productName: "商品一", category: "沐浴",
    grossQuantity: 3, returnQuantity: 1, netQuantity: 2, salesAmount: 180,
  }, {
    scopeId: "cyberbiz:channel:shop", reportMonth: "2026-07", sku: "SKU-1", productName: "商品一", category: "沐浴",
    grossQuantity: 4, returnQuantity: 0, netQuantity: 4, salesAmount: 360,
  }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("報表 MCP endpoint", () => {
  it("協商、列出報表工具，並直接查詢 D1 月資料", async () => {
    const initialized = await call("initialize", 1, { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } });
    expect(initialized.status).toBe(200);
    expect((await initialized.json() as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");

    const listed = await call("tools/list", 2, {}, { "MCP-Protocol-Version": "2025-06-18" });
    const listBody = await listed.json() as { result: { tools: Array<{ name: string }> } };
    expect(listBody.result.tools.map((tool) => tool.name)).toEqual(["list_report_scopes", "query_sales_report", "query_payout_report"]);

    const scopes = await call("tools/call", 3, {
      name: "list_report_scopes",
      arguments: {},
    }, { "MCP-Protocol-Version": "2025-06-18" });
    const scopesBody = await scopes.json() as { result: { isError: boolean; structuredContent: { scopes: Array<{ scopeId: string; scopeName: string; scopeType: string }> } } };
    expect(scopesBody.result.isError).toBe(false);
    expect(scopesBody.result.structuredContent.scopes).toHaveLength(3);
    expect(scopesBody.result.structuredContent.scopes).toEqual(expect.arrayContaining([
      { scopeId: "cyberbiz:store:test", scopeName: "測試店", scopeType: "store" },
      { scopeId: "shopee:store:default", scopeName: "蝦皮", scopeType: "store" },
      { scopeId: "cyberbiz:channel:shop", scopeName: "官網", scopeType: "channel" },
    ]));

    const queried = await call("tools/call", 4, {
      name: "query_sales_report",
      arguments: { period: "2026-07", scopeType: "store", scopeName: "測試店", category: "沐浴" },
    }, { "MCP-Protocol-Version": "2025-06-18" });
    const queryBody = await queried.json() as { result: { isError: boolean; structuredContent: { status: string; totals: { salesAmount: number } } } };
    expect(queryBody.result.isError).toBe(false);
    expect(queryBody.result.structuredContent).toMatchObject({ status: "ok", totals: { salesAmount: 180 } });

    const websiteQuery = await call("tools/call", 5, {
      name: "query_sales_report",
      arguments: { period: "2026-07", scopeType: "channel", scopeName: "官網" },
    }, { "MCP-Protocol-Version": "2025-06-18" });
    const websiteBody = await websiteQuery.json() as { result: { isError: boolean; structuredContent: { status: string; scopeType: string; totals: { salesAmount: number } } } };
    expect(websiteBody.result.isError).toBe(false);
    expect(websiteBody.result.structuredContent).toMatchObject({ status: "ok", scopeType: "channel", totals: { salesAmount: 360 } });
  });

  it("仍然驗證 bearer、Origin、Accept 與 protocol header", async () => {
    const unauthenticated = await app.fetch(new Request("https://platform.example.test/api/mcp/cyberbiz-reports", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    }), { DB: d1, CYBERBIZ_REPORT_MCP_TOKEN: MCP_TOKEN } as never);
    expect(unauthenticated.status).toBe(401);
    expect((await call("initialize", 1, { protocolVersion: "2025-06-18" }, { accept: "application/json" })).status).toBe(406);
    expect((await call("initialize", 1, { protocolVersion: "2025-06-18" }, { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await call("tools/list", 1, {}, { "MCP-Protocol-Version": "2099-01-01" })).status).toBe(400);
  });
});
