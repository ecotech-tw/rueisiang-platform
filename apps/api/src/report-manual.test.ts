import {
  createDatabase,
  createReportManualPayout,
  createReportManualSales,
  deleteReportManualPayout,
  deleteReportPayoutRecord,
  deleteReportSalesRecord,
  insertReportPayoutDaily,
  insertReportSalesMonthly,
  listReportPayoutRecords,
  listReportSalesRecords,
  queryReportPayout,
  queryReportSales,
  schema,
  upsertReportScope,
  updateReportManualPayout,
  updateReportManualSales,
  type ReportManualActor,
} from "@rueisiang/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

let d1: LocalD1;
function db() { return createDatabase(d1 as never); }

const SCOPE = "cyberbiz:store:manual-test";
const ACTOR: ReportManualActor = { id: "user-manual-test", email: "manager@ecotech.tw" };

beforeEach(async () => {
  d1 = createLocalD1();
  await upsertReportScope(db(), { id: SCOPE, scopeKind: "store", name: "人工測試據點" });
  await upsertReportScope(db(), { id: "cyberbiz:store:disabled", scopeKind: "store", name: "停用據點", active: false });
});

describe("報表人工修訂資料", () => {
  it("出金人工列會覆蓋同 key 的匯入列，也能補上新的日期", async () => {
    await insertReportPayoutDaily(db(), [
      { scopeId: SCOPE, businessDate: "2026-08-01", payoutAmount: 1000 },
      { scopeId: SCOPE, businessDate: "2026-08-02", payoutAmount: 2000 },
    ]);

    const replacement = await createReportManualPayout(db(), {
      scopeId: SCOPE,
      businessDate: "2026-08-01",
      payoutAmount: 9000,
      actor: ACTOR,
    });
    await createReportManualPayout(db(), {
      scopeId: SCOPE,
      businessDate: "2026-08-03",
      payoutAmount: 3000,
      actor: ACTOR,
    });

    const result = await queryReportPayout(db(), {
      range: { period: "2026-08", startDate: "2026-08-01", endDate: "2026-08-31" },
      scopeType: "store",
      scopeId: SCOPE,
      groupBy: ["day"],
    });
    expect(result?.rows).toEqual([
      { businessDate: "2026-08-01", payoutAmount: 9000 },
      { businessDate: "2026-08-02", payoutAmount: 2000 },
      { businessDate: "2026-08-03", payoutAmount: 3000 },
    ]);
    expect(result?.totals).toEqual({ payoutAmount: 14000 });

    await deleteReportManualPayout(db(), replacement.id, ACTOR);
    const restored = await queryReportPayout(db(), {
      range: { period: "2026-08", startDate: "2026-08-01", endDate: "2026-08-31" },
      scopeType: "store",
      scopeId: SCOPE,
      groupBy: ["day"],
    });
    expect(restored?.totals).toEqual({ payoutAmount: 6000 });
  });

  it("商品銷售人工列會覆蓋同月份 SKU，且支援自訂商品補列", async () => {
    await insertReportSalesMonthly(db(), [{
      scopeId: SCOPE,
      reportMonth: "2026-08",
      sku: "SKU-1",
      productName: "匯入商品",
      category: "一般",
      grossQuantity: 5,
      returnQuantity: 1,
      netQuantity: 4,
      salesAmount: 400,
    }]);
    await createReportManualSales(db(), {
      scopeId: SCOPE,
      reportMonth: "2026-08",
      skuSource: "custom",
      sku: "SKU-1",
      productName: "修訂商品",
      category: "修訂",
      grossQuantity: 8,
      returnQuantity: 2,
      netQuantity: 6,
      salesAmount: 600,
      actor: ACTOR,
    });
    await createReportManualSales(db(), {
      scopeId: SCOPE,
      reportMonth: "2026-08",
      skuSource: "custom",
      sku: "manual-only",
      productName: "人工補列商品",
      grossQuantity: 2,
      returnQuantity: 0,
      netQuantity: 2,
      salesAmount: 120,
      actor: ACTOR,
    });

    const result = await queryReportSales(db(), {
      range: { period: "2026-08", startDate: "2026-08-01", endDate: "2026-08-31" },
      scopeType: "store",
      scopeId: SCOPE,
      groupBy: ["sku"],
    });
    expect(result?.rows).toEqual([
      { sku: "MANUAL-ONLY", productName: "人工補列商品", grossQuantity: 2, returnQuantity: 0, netQuantity: 2, salesAmount: 120 },
      { sku: "SKU-1", productName: "修訂商品", grossQuantity: 8, returnQuantity: 2, netQuantity: 6, salesAmount: 600 },
    ]);
    expect(result?.totals).toEqual({ grossQuantity: 10, returnQuantity: 2, netQuantity: 8, salesAmount: 720 });
  });

  it("編輯已不在分類主檔的自訂商品時保留歷史分類名稱", async () => {
    const sales = await createReportManualSales(db(), {
      scopeId: SCOPE,
      reportMonth: "2026-08",
      skuSource: "custom",
      sku: "LEGACY-CATEGORY-SKU",
      productName: "歷史分類商品",
      category: "已刪除分類",
      grossQuantity: 1,
      returnQuantity: 0,
      netQuantity: 1,
      salesAmount: 100,
      actor: ACTOR,
    });

    const updated = await updateReportManualSales(db(), {
      id: sales.id,
      scopeId: SCOPE,
      reportMonth: "2026-08",
      skuSource: "custom",
      sku: "LEGACY-CATEGORY-SKU",
      productName: "歷史分類商品（修訂）",
      category: "已刪除分類",
      grossQuantity: 2,
      returnQuantity: 0,
      netQuantity: 2,
      salesAmount: 200,
      actor: ACTOR,
    });

    expect(updated.category).toBe("已刪除分類");
    expect(updated.productName).toBe("歷史分類商品（修訂）");
  });

  it("人工資料只接受公司報表可辨識的據點，且同 key 不可重複", async () => {
    await upsertReportScope(db(), { id: "invalid-scope-id", scopeKind: "store", name: "不納入據點" });
    await expect(createReportManualPayout(db(), {
      scopeId: "invalid-scope-id",
      businessDate: "2026-08-01",
      payoutAmount: 1,
      actor: ACTOR,
    })).rejects.toMatchObject({ kind: "not_found" });

    await createReportManualPayout(db(), {
      scopeId: SCOPE,
      businessDate: "2026-08-01",
      payoutAmount: 1,
      actor: ACTOR,
    });
    await expect(createReportManualPayout(db(), {
      scopeId: SCOPE,
      businessDate: "2026-08-01",
      payoutAmount: 2,
      actor: ACTOR,
    })).rejects.toMatchObject({ kind: "conflict" });
  });

  it("人工修訂清單會顯示有效匯入資料，並支援來源篩選、排序與分頁", async () => {
    await insertReportPayoutDaily(db(), [
      { scopeId: SCOPE, businessDate: "2026-08-01", payoutAmount: 1000 },
      { scopeId: SCOPE, businessDate: "2026-08-02", payoutAmount: 2000 },
      { scopeId: SCOPE, businessDate: "2026-08-03", payoutAmount: 3000 },
    ]);
    await createReportManualPayout(db(), {
      scopeId: SCOPE,
      businessDate: "2026-08-02",
      payoutAmount: 9000,
      actor: ACTOR,
    });

    const firstPage = await listReportPayoutRecords(db(), {
      page: 1,
      pageSize: 1,
      search: "",
      scopeId: "",
      sortField: "businessDate",
      sortDirection: "desc",
    });
    expect(firstPage.total).toBe(3);
    expect(firstPage.rows).toMatchObject([
      { businessDate: "2026-08-03", payoutAmount: 3000, source: "imported" },
    ]);

    const manualOnly = await listReportPayoutRecords(db(), {
      page: 1,
      pageSize: 1,
      source: "manual",
      search: "",
      scopeId: "",
      sortField: "businessDate",
      sortDirection: "desc",
    });
    expect(manualOnly.total).toBe(1);
    expect(manualOnly.rows).toMatchObject([
      { businessDate: "2026-08-02", payoutAmount: 9000, source: "manual" },
    ]);

    await insertReportSalesMonthly(db(), [
      { scopeId: SCOPE, reportMonth: "2026-08", sku: "SKU-1", productName: "匯入商品一", grossQuantity: 1, netQuantity: 1, salesAmount: 100 },
      { scopeId: SCOPE, reportMonth: "2026-08", sku: "SKU-2", productName: "匯入商品二", grossQuantity: 2, netQuantity: 2, salesAmount: 200 },
    ]);
    await createReportManualSales(db(), {
      scopeId: SCOPE,
      reportMonth: "2026-08",
      skuSource: "custom",
      sku: "SKU-1",
      productName: "修訂商品一",
      grossQuantity: 8,
      returnQuantity: 1,
      netQuantity: 7,
      salesAmount: 800,
      actor: ACTOR,
    });

    const sales = await listReportSalesRecords(db(), {
      page: 1,
      pageSize: 10,
      search: "修訂商品",
      scopeId: "",
      sortField: "sku",
      sortDirection: "asc",
    });
    expect(sales.total).toBe(1);
    expect(sales.rows).toMatchObject([
      { sku: "SKU-1", productName: "修訂商品一", salesAmount: 800, source: "manual", skuSource: "custom" },
    ]);
  });

  it("deleting a manual override restores the imported record and matches imported SKU case-insensitively", async () => {
    await insertReportPayoutDaily(db(), [{ scopeId: SCOPE, businessDate: "2026-08-01", payoutAmount: 1000 }]);
    const manualPayout = await createReportManualPayout(db(), {
      scopeId: SCOPE,
      businessDate: "2026-08-01",
      payoutAmount: 9000,
      actor: ACTOR,
    });
    await db().insert(schema.cyberbizProducts).values({
      sku: "SOAP-SYSTEM",
      productId: "manual-delete-product",
      variantId: "manual-delete-variant",
      productName: "匯入商品",
      variantName: "",
    });
    await insertReportSalesMonthly(db(), [{
      scopeId: SCOPE,
      reportMonth: "2026-08",
      sku: "soap-system",
      productName: "匯入商品",
      grossQuantity: 1,
      netQuantity: 1,
      salesAmount: 100,
    }]);
    const manualSales = await createReportManualSales(db(), {
      scopeId: SCOPE,
      reportMonth: "2026-08",
      skuSource: "cyberbiz",
      sku: "soap-system",
      productName: "修訂商品",
      grossQuantity: 2,
      returnQuantity: 0,
      netQuantity: 2,
      salesAmount: 200,
      actor: ACTOR,
    });

    await deleteReportPayoutRecord(db(), {
      source: "manual",
      id: manualPayout.id,
      scopeId: SCOPE,
      businessDate: "2026-08-01",
    }, ACTOR);
    await deleteReportSalesRecord(db(), {
      source: "manual",
      id: manualSales.id,
      scopeId: SCOPE,
      reportMonth: "2026-08",
      sku: "SOAP-SYSTEM",
    }, ACTOR);

    expect(await db().select({ payoutAmount: schema.reportPayoutDaily.payoutAmount })
      .from(schema.reportPayoutDaily)).toEqual([{ payoutAmount: 1000 }]);
    expect(await db().select({ sku: schema.reportSalesMonthly.sku, salesAmount: schema.reportSalesMonthly.salesAmount })
      .from(schema.reportSalesMonthly)).toEqual([{ sku: "soap-system", salesAmount: 100 }]);
    const deleteEvent = (await db().select({
      eventType: schema.activityEvents.eventType,
      payloadJson: schema.activityEvents.payloadJson,
    }).from(schema.activityEvents)).find((event) => event.eventType === "report_sales_record_deleted");
    expect(deleteEvent).toBeDefined();
    expect(JSON.parse(deleteEvent!.payloadJson)).toMatchObject({ source: "manual", skuSource: "cyberbiz" });

    await deleteReportSalesRecord(db(), {
      source: "imported",
      id: "imported-record",
      scopeId: SCOPE,
      reportMonth: "2026-08",
      sku: "SOAP-SYSTEM",
    }, ACTOR);
    expect(await db().select().from(schema.reportSalesMonthly)).toEqual([]);
  });

  it("allows historical manual edits for a disabled report scope", async () => {
    const disabledScope = "cyberbiz:store:disabled";
    const payout = await createReportManualPayout(db(), {
      scopeId: disabledScope,
      businessDate: "2026-08-01",
      payoutAmount: 100,
      actor: ACTOR,
    });
    const updatedPayout = await updateReportManualPayout(db(), {
      id: payout.id,
      scopeId: disabledScope,
      businessDate: "2026-08-01",
      payoutAmount: 200,
      actor: ACTOR,
    });
    expect(updatedPayout.payoutAmount).toBe(200);

    const sales = await createReportManualSales(db(), {
      scopeId: disabledScope,
      reportMonth: "2026-08",
      skuSource: "custom",
      sku: "disabled-sku",
      productName: "停用據點商品",
      grossQuantity: 1,
      returnQuantity: 0,
      netQuantity: 1,
      salesAmount: 50,
      actor: ACTOR,
    });
    const updatedSales = await updateReportManualSales(db(), {
      id: sales.id,
      scopeId: disabledScope,
      reportMonth: "2026-08",
      skuSource: "custom",
      sku: "disabled-sku",
      productName: "停用據點商品修訂",
      grossQuantity: 2,
      returnQuantity: 0,
      netQuantity: 2,
      salesAmount: 100,
      actor: ACTOR,
    });
    expect(updatedSales.productName).toBe("停用據點商品修訂");
  });
});
