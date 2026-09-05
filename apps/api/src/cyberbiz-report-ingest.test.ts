import {
  createDatabase,
  syncCyberbizProducts,
  upsertReportScope,
} from "@rueisiang/db";
import {
  itemCategories,
  itemComponents,
  items,
  reportExternalProducts,
  reportIngestIssues,
  reportItemSalesMonthly,
  reportRuns,
  scopes,
  targetReportPayoutDaily,
  wmsItems,
} from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1 } from "./local-d1/d1.js";

const TOKEN = "report-ingest-secret";
let d1: ReturnType<typeof createTargetOnlyD1>;
const db = () => createDatabase(d1 as never);

function request(body: unknown, token = TOKEN) {
  return app.fetch(new Request("https://platform.example.test/api/internal/cyberbiz-reports/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cyberbiz-report-token": token },
    body: JSON.stringify(body),
  }), { DB: d1, CYBERBIZ_REPORT_INGEST_TOKEN: TOKEN } as never);
}

function salesBody(rows: unknown[], reportMonth = "2026-07", scopeId = "cyberbiz:store:a", scopeName = "測試店", salesWriteMode?: "replace" | "merge") {
  return {
    kind: "sales", scopeType: "store", scopeId, scopeName, reportMonth, rows,
    ...(salesWriteMode ? { salesWriteMode } : {}),
  };
}

function salesRow(sku: string, salesAmount: number, extra: Record<string, unknown> = {}) {
  return { sku, productName: "匯入名稱", category: "匯入分類", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount, ...extra };
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  await upsertReportScope(db(), { id: "cyberbiz:store:a", scopeKind: "store", name: "測試店", sourceType: "cyberbiz" });
  await upsertReportScope(db(), { id: "shopee:store:default", scopeKind: "store", name: "蝦皮", sourceType: "shopee" });
  await syncCyberbizProducts(db(), [
    { sku: "SOAP-001", productId: "p-soap", variantId: "v-soap", productName: "香皂" },
    { sku: "NET-001", productId: "p-net", variantId: "v-net", productName: "起泡網" },
  ]);
});

/** SKU 是全平台唯一的：官網同步過的 SKU 已經有 items，這裡只能補 wms_items，不能再建一筆。 */
async function seedWmsItem(id: string, sku: string, name = `WMS ${sku}`): Promise<string> {
  const [existing] = await db().select({ id: items.id }).from(items).where(eq(items.sku, sku)).limit(1);
  const itemId = existing?.id ?? id;
  if (!existing) await db().insert(items).values({ id: itemId, source: "custom", kind: "sellable", sku, name, categoryId: null, active: 1 });
  await db().insert(wmsItems).values({ itemId, quantity: 10, minStock: 2, unit: "件", notes: "" });
  return itemId;
}

async function seedMapping(id: string, channel: string, externalKey: string, itemId: string, externalName = externalKey) {
  await db().insert(reportExternalProducts).values({
    id, sourceType: channel, externalKey, externalVariantKey: "", externalName,
    resolution: "mapped", itemId, ignoredReason: "",
  });
}

describe("target 報表月資料匯入", () => {
  it("CYBERBIZ 目錄商品可直接匯入，名稱來自 items／cyberbiz_products", async () => {
    const response = await request(salesBody([salesRow("SOAP-001", 300, { grossQuantity: 3, netQuantity: 3, productName: "檔案舊名稱" })]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { kind: "sales", rowCount: 1, skippedSkus: [] } });

    const rows = await db().select({ itemId: reportItemSalesMonthly.itemId, grossQuantity: reportItemSalesMonthly.grossQuantity })
      .from(reportItemSalesMonthly);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.grossQuantity).toBe(3);
    const [item] = await db().select().from(items).where(eq(items.id, rows[0]!.itemId));
    expect(item).toMatchObject({ sku: "SOAP-001", name: "香皂", source: "cyberbiz" });
  });

  it("WMS SKU 對應會以 target item 身分寫入，名稱與分類不保存報表快照", async () => {
    await db().insert(itemCategories).values({ id: "cat-bath", depth: 0, parentId: null, parentDepth: null, name: "沐浴", color: "rose", sortOrder: 0, active: 1 });
    await seedWmsItem("wms-soap", "WMS-SOAP", "倉庫香皂");
    await db().update(items).set({ categoryId: "cat-bath" }).where(eq(items.id, "wms-soap"));
    await seedMapping("map-shopee-soap", "shopee", "SHOPEE-001", "wms-soap", "蝦皮皂");

    const response = await request(salesBody([salesRow("SHOPEE-001", 180, { grossQuantity: 2, netQuantity: 2 })], "2026-07", "shopee:store:default", "蝦皮"));
    expect(response.status).toBe(200);
    const [row] = await db().select({ sku: items.sku, name: items.name, grossQuantity: reportItemSalesMonthly.grossQuantity })
      .from(reportItemSalesMonthly).innerJoin(items, eq(items.id, reportItemSalesMonthly.itemId));
    expect(row).toEqual({ sku: "WMS-SOAP", name: "倉庫香皂", grossQuantity: 2 });
  });

  it("target BOM 會依輸入順序展開用料，銷售額只計一次", async () => {
    const componentNet = await seedWmsItem("component-net", "NET-001", "起泡網");
    const componentSoap = await seedWmsItem("component-soap", "SOAP-001", "香皂");
    await db().insert(items).values({ id: "bundle-parent", source: "custom", kind: "sellable", sku: "BUNDLE-001", name: "洗沐組", categoryId: null, active: 1 });
    await db().insert(itemComponents).values([
      { parentItemId: "bundle-parent", componentItemId: componentNet, quantity: 1 },
      { parentItemId: "bundle-parent", componentItemId: componentSoap, quantity: 2 },
    ]);
    await seedMapping("map-bundle", "shopee", "SET-001", "bundle-parent", "洗沐組");

    const response = await request(salesBody([salesRow("SET-001", 500, { grossQuantity: 3, returnQuantity: 1, netQuantity: 2 })], "2026-07", "shopee:store:default", "蝦皮"));
    expect(response.status).toBe(200);
    const rows = await db().select({ sku: items.sku, grossQuantity: reportItemSalesMonthly.grossQuantity, salesAmount: reportItemSalesMonthly.salesAmount })
      .from(reportItemSalesMonthly).innerJoin(items, eq(items.id, reportItemSalesMonthly.itemId));
    expect(rows).toEqual([
      { sku: "NET-001", grossQuantity: 3, salesAmount: 500 },
      { sku: "SOAP-001", grossQuantity: 6, salesAmount: 0 },
    ]);
  });

  it("未對應 SKU 只建立 ingest issue，不會讓同月已對應資料消失", async () => {
    const response = await request(salesBody([
      salesRow("SOAP-001", 100),
      salesRow("NOT-MAPPED", 200),
    ]));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { rowCount: 1, skippedSkus: ["NOT-MAPPED"] } });
    expect(await db().select().from(reportItemSalesMonthly)).toHaveLength(1);
    expect(await db().select({ issueType: reportIngestIssues.issueType }).from(reportIngestIssues)).toEqual([{ issueType: "unmapped" }]);
  });

  it("同月 replace 會移除舊匯入列，merge 只更新本次資料", async () => {
    await request(salesBody([salesRow("SOAP-001", 100)], "2026-07"));
    await request(salesBody([salesRow("NET-001", 200)], "2026-07"));
    expect((await db().select().from(reportItemSalesMonthly)).map((row) => row.itemId)).toEqual([
      (await db().select({ id: items.id }).from(items).where(eq(items.sku, "NET-001")))[0]!.id,
    ]);

    await request(salesBody([salesRow("SOAP-001", 300)], "2026-07"));
    await request(salesBody([salesRow("NET-001", 400)], "2026-07", "cyberbiz:store:a", "測試店", "merge"));
    const amounts = await db().select({ sku: items.sku, salesAmount: reportItemSalesMonthly.salesAmount })
      .from(reportItemSalesMonthly).innerJoin(items, eq(items.id, reportItemSalesMonthly.itemId));
    expect(amounts).toEqual(expect.arrayContaining([
      { sku: "SOAP-001", salesAmount: 300 },
      { sku: "NET-001", salesAmount: 400 },
    ]));
  });

  it("sales_and_payout 會在同一 target run 寫入兩種資料", async () => {
    const response = await request({
      kind: "sales_and_payout", scopeType: "store", scopeId: "shopee:store:default", scopeName: "蝦皮", reportMonth: "2026-07",
      salesRows: [salesRow("SOAP-001", 100, { grossQuantity: 2, netQuantity: 2 })],
      payoutRows: [{ businessDate: "2026-07-01", payoutAmount: 250 }],
    });
    expect(response.status).toBe(200);
    const [run] = await db().select().from(reportRuns).where(eq(reportRuns.status, "succeeded"));
    expect(run).toMatchObject({ importsSales: 1, importsPayout: 1, importedSalesRows: 1, importedPayoutRows: 1 });
    expect(await db().select().from(targetReportPayoutDaily)).toMatchObject([{ scopeId: "shopee:store:default", payoutAmount: 250, recordOrigin: "imported" }]);
  });

  it("不同通路同名 scope 不會互相覆蓋", async () => {
    const response = await request(salesBody([salesRow("SOAP-001", 100)], "2026-08", "cyberbiz:store:same", "同名店"));
    expect(response.status).toBe(200);
    const second = await request(salesBody([salesRow("SOAP-001", 200)], "2026-08", "shopee:store:same", "同名店"));
    expect(second.status).toBe(200);
    expect(await db().select({ id: scopes.id, sourceType: scopes.sourceType }).from(scopes).where(eq(scopes.name, "同名店")))
      .toEqual(expect.arrayContaining([{ id: "cyberbiz:store:same", sourceType: "cyberbiz" }, { id: "shopee:store:same", sourceType: "shopee" }]));
  });

  it("輸入格式錯誤時不會先留下 payout 或 report run", async () => {
    const response = await request({
      kind: "sales_and_payout", scopeType: "store", scopeId: "shopee:store:default", scopeName: "蝦皮", reportMonth: "2026-07",
      salesRows: [{ sku: "SOAP-001", grossQuantity: "bad" }], payoutRows: [{ businessDate: "2026-07-01", payoutAmount: 250 }],
    });
    expect(response.status).toBe(422);
    expect(await db().select().from(targetReportPayoutDaily)).toHaveLength(0);
    expect(await db().select({ status: reportRuns.status }).from(reportRuns)).toEqual([{ status: "failed" }]);
  });

  it("target-only database 沒有 legacy 報表表名，匯入仍可完成", async () => {
    const names = await d1.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view', 'trigger') AND (name LIKE 'report_%' OR name IN ('inventory_items', 'product_sku_mappings', 'product_categories'))").all<{ name: string }>();
    expect(names.results.map((row) => row.name)).not.toContain("report_sales_monthly");
    expect(names.results.map((row) => row.name)).not.toContain("product_sku_mappings");
    expect((await request(salesBody([salesRow("SOAP-001", 80)], "2026-09"))).status).toBe(200);
  });
});
