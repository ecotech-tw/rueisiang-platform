import {
  createDatabase,
  createReportManualPayout,
  createReportManualSales,
  deleteReportManualPayout,
  insertReportPayoutDaily,
  insertReportSalesMonthly,
  queryReportPayout,
  queryReportSales,
  upsertReportScope,
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
});
