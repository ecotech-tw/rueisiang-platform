import {
  createDatabase,
  insertReportPayoutDaily,
  insertReportSalesMonthly,
  upsertReportScope,
  type ReportGroupBy,
} from "@rueisiang/db";
import { itemCategories, items, reportExternalProducts, wmsItems } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createCyberbizReportService } from "./cyberbiz-reports.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

let d1: LocalD1;
function db() { return createDatabase(d1 as never); }

/**
 * SKU 是全平台唯一的，beforeEach 匯報表時就已經替每個 SKU 建好 items。
 * 測試要的是「同一筆商品也在倉儲裡」，所以拿既有的 id 用，不能再插一筆。
 */
async function itemIdBySku(sku: string): Promise<string> {
  const [row] = await db().select({ id: items.id }).from(items).where(eq(items.sku, sku)).limit(1);
  if (!row) throw new Error(`測試資料裡沒有 SKU ${sku}`);
  return row.id;
}

const WEST = "cyberbiz:store:西門3F";
const EAST = "cyberbiz:store:信義2F";

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  await db().insert(itemCategories).values([
    { id: "cat-bath", depth: 0, name: "沐浴", color: "rose", sortOrder: 0, active: 1 },
    { id: "cat-food", depth: 0, name: "食品", color: "mint", sortOrder: 1, active: 1 },
  ]);
  await upsertReportScope(db(), { id: WEST, scopeKind: "store", name: "誠品西門店 3F" });
  await upsertReportScope(db(), { id: EAST, scopeKind: "store", name: "誠品信義店 2F" });
  await insertReportSalesMonthly(db(), [
    { scopeId: WEST, reportMonth: "2026-07", sku: "SKU-1", productName: "商品一", category: "沐浴", grossQuantity: 5, returnQuantity: 1, netQuantity: 4, salesAmount: 380 },
    { scopeId: EAST, reportMonth: "2026-07", sku: "SKU-2", productName: "商品二", category: "食品", grossQuantity: 4, returnQuantity: 0, netQuantity: 4, salesAmount: 300 },
  ]);
  await insertReportPayoutDaily(db(), [
    { scopeId: WEST, businessDate: "2026-07-01", payoutAmount: 1000 },
    { scopeId: WEST, businessDate: "2026-07-02", payoutAmount: 2000 },
    { scopeId: EAST, businessDate: "2026-07-01", payoutAmount: 3000 },
  ]);
});

describe("報表月資料查詢", () => {
  it("可以用店名查商品銷售，且忽略名稱中的空白", async () => {
    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07", scopeType: "store", scopeName: "誠品西門店3F",
    });
    expect(result).toMatchObject({ status: "ok", scopeId: WEST, scopeName: "誠品西門店 3F" });
    expect(result.totals).toEqual({ grossQuantity: 5, returnQuantity: 1, netQuantity: 4, salesAmount: 380 });
  });

  // 公司總額不看 ID 長什麼樣：每個通路都會有自己的銷售與金額，只是顆粒度不同。
  it("公司查詢會把每一個通路一起加總，不論 ID 格式", async () => {
    const shopeeScope = "shopee:store:mall";
    await upsertReportScope(db(), { id: shopeeScope, scopeKind: "store", name: "蝦皮商城" });
    await insertReportSalesMonthly(db(), [{
      scopeId: shopeeScope, reportMonth: "2026-07", sku: "SKU-SHOPEE", productName: "蝦皮商品", category: "其他",
      grossQuantity: 100, returnQuantity: 0, netQuantity: 100, salesAmount: 10000,
    }]);
    await insertReportPayoutDaily(db(), [{ scopeId: shopeeScope, businessDate: "2026-07-01", payoutAmount: 20000 }]);
    await upsertReportScope(db(), { id: "no-prefix-scope-id", scopeKind: "store", name: "沒有前綴的通路" });
    await insertReportSalesMonthly(db(), [{
      scopeId: "no-prefix-scope-id", reportMonth: "2026-07", sku: "SKU-NO-PREFIX", productName: "沒有前綴的通路商品", category: "其他",
      grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 1,
    }]);
    await insertReportPayoutDaily(db(), [{ scopeId: "no-prefix-scope-id", businessDate: "2026-07-01", payoutAmount: 1 }]);

    const service = createCyberbizReportService(db());
    expect((await service.querySales({ period: "2026-07", scopeType: "company" })).totals)
      .toEqual({ grossQuantity: 110, returnQuantity: 1, netQuantity: 109, salesAmount: 10681 });
    expect((await service.queryPayout({ period: "2026-07", scopeType: "company" })).totals)
      .toEqual({ payoutAmount: 26001 });
  });

  it("公司查詢包含舊版 store- scope ID", async () => {
    const legacyScope = "store-legacy";
    await upsertReportScope(db(), { id: legacyScope, scopeKind: "store", name: "舊版門市" });
    await insertReportSalesMonthly(db(), [{
      scopeId: legacyScope, reportMonth: "2026-07", sku: "SKU-LEGACY", productName: "舊版商品", category: "其他",
      grossQuantity: 7, returnQuantity: 1, netQuantity: 6, salesAmount: 600,
    }]);
    await insertReportPayoutDaily(db(), [{ scopeId: legacyScope, businessDate: "2026-07-01", payoutAmount: 700 }]);

    const service = createCyberbizReportService(db());
    expect((await service.querySales({ period: "2026-07", scopeType: "company" })).totals)
      .toEqual({ grossQuantity: 16, returnQuantity: 2, netQuantity: 14, salesAmount: 1280 });
    expect((await service.queryPayout({ period: "2026-07", scopeType: "company" })).totals)
      .toEqual({ payoutAmount: 6700 });
  });

  it("公司查詢直接 aggregate 所有據點，月資料不再提供 day 分組", async () => {
    const service = createCyberbizReportService(db());
    const result = await service.querySales({
      startDate: "2026-07-01", endDate: "2026-07-31", scopeType: "company", groupBy: ["scope", "month", "month"],
    });
    expect(result).toMatchObject({ status: "ok", requestedStart: "2026-07-01", requestedEnd: "2026-07-31" });
    expect(result.totals).toEqual({ grossQuantity: 9, returnQuantity: 1, netQuantity: 8, salesAmount: 680 });
    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeId: WEST, reportMonth: "2026-07" }),
      expect.objectContaining({ scopeId: EAST, reportMonth: "2026-07" }),
    ]));
    await expect(service.querySales({ period: "2026-07", scopeType: "company", groupBy: ["day"] }))
      .rejects.toMatchObject({ status: 400, code: "invalid_group_by" });
  });

  it("groupBy 重複值會去重，未知值才拒絕", async () => {
    const service = createCyberbizReportService(db());
    const duplicate = await service.querySales({ period: "2026-07", scopeType: "company", groupBy: ["month", "month"] });
    expect(duplicate.status).toBe("ok");
    expect(duplicate.rows).toHaveLength(1);
    await expect(service.querySales({
      period: "2026-07", scopeType: "company", groupBy: ["month", "unknown"] as unknown as ReportGroupBy[],
    })).rejects.toMatchObject({ status: 400, code: "invalid_group_by" });
  });

  it("年度查詢可以依分類與月份 aggregate", async () => {
    const result = await createCyberbizReportService(db()).querySales({
      period: "2026", scopeType: "company", category: "沐浴", groupBy: ["month"],
    });
    expect(result).toMatchObject({ status: "ok", period: "2026" });
    expect(result.totals).toEqual({ grossQuantity: 5, returnQuantity: 1, netQuantity: 4, salesAmount: 380 });
    expect(result.rows).toEqual([{ reportMonth: "2026-07", grossQuantity: 5, returnQuantity: 1, netQuantity: 4, salesAmount: 380 }]);
  });

  it("部分月份查詢會回傳不支援的粒度", async () => {
    const result = await createCyberbizReportService(db()).querySales({
      startDate: "2026-07-02", endDate: "2026-07-20", scopeType: "company",
    });
    expect(result).toMatchObject({ status: "UNSUPPORTED_GRANULARITY", rows: [] });
  });

  it("範圍內有資料但篩選條件無結果時不會誤報尚未匯入", async () => {
    const result = await createCyberbizReportService(db()).querySales({ period: "2026-07", scopeType: "company", sku: "SKU-NOT-FOUND" });
    expect(result).toMatchObject({ status: "ok", rows: [], totals: { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 } });
    expect(result.message).toContain("篩選條件");
  });

  it("查外部 SKU 會經由用料換算成系統 SKU", async () => {
    const itemOne = await itemIdBySku("SKU-1");
    await db().insert(wmsItems).values({ itemId: itemOne, quantity: 1, unit: "件", minStock: 0, notes: "" });
    await db().insert(reportExternalProducts).values({
      id: "mapping-1", sourceType: "cyberbiz", externalKey: "P-001_M-001", externalVariantKey: "", externalName: "商品一", resolution: "mapped", itemId: itemOne, ignoredReason: "",
    });

    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07", scopeType: "company", sku: "P-001_M-001",
    });
    expect(result.rows).toMatchObject([{ sku: "SKU-1" }]);
    expect(result.totals.netQuantity).toBe(4);
  });

  it("查詢值本身是 WMS SKU 時不會把別筆 mapping 的商品一起加總", async () => {
    const itemOne = await itemIdBySku("SKU-1");
    const itemTwo = await itemIdBySku("SKU-2");
    await db().insert(wmsItems).values([
      { itemId: itemOne, quantity: 1, unit: "件", minStock: 0, notes: "" },
      { itemId: itemTwo, quantity: 1, unit: "件", minStock: 0, notes: "" },
    ]);
    // external_sku 允許等於另一個商品的 WMS SKU；查 SKU-1 不該把 SKU-2 的資料算進來。
    await db().insert(reportExternalProducts).values({
      id: "mapping-cross", sourceType: "cyberbiz", externalKey: "SKU-1", externalVariantKey: "", externalName: "商品二", resolution: "mapped", itemId: itemTwo, ignoredReason: "",
    });

    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07", scopeType: "company", sku: "SKU-1",
    });
    expect(result.rows).toMatchObject([{ sku: "SKU-1" }]);
    expect(result.totals.netQuantity).toBe(4);
  });

  it("別的通路的別名不會被算進來", async () => {
    const itemOne = await itemIdBySku("SKU-1");
    await db().insert(wmsItems).values({ itemId: itemOne, quantity: 1, unit: "件", minStock: 0, notes: "" });
    // scope 是 cyberbiz，蝦皮的別名不該讓 cyberbiz 的查詢命中。
    await db().insert(reportExternalProducts).values({
      id: "mapping-shopee-only", sourceType: "shopee", externalKey: "P-999_M-999", externalVariantKey: "", externalName: "商品一", resolution: "mapped", itemId: itemOne, ignoredReason: "",
    });

    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07", scopeType: "company", sku: "P-999_M-999",
    });
    expect(result.rows).toEqual([]);
  });

  it("出金仍以據點與日期做 aggregate", async () => {
    const result = await createCyberbizReportService(db()).queryPayout({ period: "2026-07", scopeType: "company", groupBy: ["scope", "day"] });
    expect(result.rows).toEqual([
      { scopeId: EAST, businessDate: "2026-07-01", payoutAmount: 3000, scopeName: "誠品信義店 2F" },
      { scopeId: WEST, businessDate: "2026-07-01", payoutAmount: 1000, scopeName: "誠品西門店 3F" },
      { scopeId: WEST, businessDate: "2026-07-02", payoutAmount: 2000, scopeName: "誠品西門店 3F" },
    ]);
  });

  it("沒有指定區間資料時回傳後台作業所需的狀態", async () => {
    const result = await createCyberbizReportService(db()).querySales({ period: "2025-12", scopeType: "company" });
    expect(result).toMatchObject({ status: "NO_DATA_FOR_RANGE", period: "2025-12" });
  });

  it("拒絕不完整的自訂日期區間", async () => {
    await expect(createCyberbizReportService(db()).queryPayout({ startDate: "2026-07-02", scopeType: "company" }))
      .rejects.toMatchObject({ code: "invalid_report_range", status: 400 });
  });

  it("同 scope kind 的重複名稱會回傳明確的 ambiguous scope 錯誤", async () => {
    await upsertReportScope(db(), { id: "cyberbiz:store:duplicate-a", scopeKind: "store", name: "重複門市" });
    await upsertReportScope(db(), { id: "cyberbiz:store:duplicate-b", sourceType: "manual", scopeKind: "store", name: "重複 門市" });
    await expect(createCyberbizReportService(db()).querySales({ period: "2026-07", scopeType: "store", scopeName: "重複門市" }))
      .rejects.toMatchObject({ status: 409, code: "ambiguous_scope" });
  });
});

describe("報表月資料匯入的 transaction 邊界", () => {
  it("同一月的刪除與寫入不會被拆進不同的 db.batch()", async () => {
    const rowsPerMonth = 200;
    const months = ["2026-08", "2026-09", "2026-10"];
    const rows = months.flatMap((reportMonth) => Array.from({ length: rowsPerMonth }, (_unused, index) => ({
      scopeId: WEST, reportMonth, sku: `SKU-${index}`, productName: `商品 ${index}`, category: "沐浴",
      grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 10,
    })));
    const real = db();
    const batches: { sql: string; params: unknown[] }[][] = [];
    const spy = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== "batch") return Reflect.get(target, prop, receiver);
        return async (statements: { toSQL(): { sql: string; params: unknown[] } }[]) => {
          batches.push(statements.map((statement) => statement.toSQL()));
          return (target as { batch: (s: unknown) => unknown }).batch(statements);
        };
      },
    });
    await insertReportSalesMonthly(spy, rows);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const deleted = new Set(batch.filter((q) => /^delete/i.test(q.sql)).map((q) => String(q.params[1])));
      const inserts = batch.filter((q) => /^insert/i.test(q.sql));
      for (const reportMonth of months) {
        const written = inserts.reduce((sum, q) => sum + q.params.filter((param) => param === reportMonth).length, 0);
        if (written === 0) continue;
        expect(deleted).toContain(reportMonth);
        expect(written).toBe(rowsPerMonth);
      }
    }
  });
});
