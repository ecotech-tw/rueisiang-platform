import {
  createDatabase,
  insertReportPayoutDaily,
  insertReportSalesDaily,
  upsertReportScope,
} from "@rueisiang/db";
import { beforeEach, describe, expect, it } from "vitest";
import { createCyberbizReportService } from "./cyberbiz-reports.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

let d1: LocalD1;

function db() {
  return createDatabase(d1 as never);
}

const WEST = "cyberbiz:store:西門3F";
const EAST = "cyberbiz:store:信義2F";

beforeEach(async () => {
  d1 = createLocalD1();
  await upsertReportScope(db(), { id: WEST, scopeKind: "store", name: "誠品西門店 3F" });
  await upsertReportScope(db(), { id: EAST, scopeKind: "store", name: "誠品信義店 2F" });
  await insertReportSalesDaily(db(), [
    { scopeId: WEST, businessDate: "2026-07-01", sku: "SKU-1", productName: "商品一", category: "沐浴", grossQuantity: 3, returnQuantity: 1, netQuantity: 2, salesAmount: 180 },
    { scopeId: WEST, businessDate: "2026-07-02", sku: "SKU-1", productName: "商品一", category: "沐浴", grossQuantity: 2, returnQuantity: 0, netQuantity: 2, salesAmount: 200 },
    { scopeId: EAST, businessDate: "2026-07-01", sku: "SKU-2", productName: "商品二", category: "食品", grossQuantity: 4, returnQuantity: 0, netQuantity: 4, salesAmount: 300 },
  ]);
  await insertReportPayoutDaily(db(), [
    { scopeId: WEST, businessDate: "2026-07-01", payoutAmount: 1000 },
    { scopeId: WEST, businessDate: "2026-07-02", payoutAmount: 2000 },
    { scopeId: EAST, businessDate: "2026-07-01", payoutAmount: 3000 },
  ]);
});

describe("報表日資料查詢", () => {
  it("可以用店名查商品銷售，且忽略名稱中的空白", async () => {
    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07",
      scopeType: "store",
      scopeName: "誠品西門店3F",
    });
    expect(result).toMatchObject({ status: "ok", scopeId: WEST, scopeName: "誠品西門店 3F" });
    expect(result.totals).toEqual({ grossQuantity: 5, returnQuantity: 1, netQuantity: 4, salesAmount: 380 });
  });

  it("公司查詢不會把其他通路的 scope 一起加總", async () => {
    const shopeeScope = "shopee:store:mall";
    await upsertReportScope(db(), { id: shopeeScope, scopeKind: "store", name: "蝦皮商城" });
    await insertReportSalesDaily(db(), [{
      scopeId: shopeeScope,
      businessDate: "2026-07-01",
      sku: "SKU-SHOPEE",
      productName: "蝦皮商品",
      category: "其他",
      grossQuantity: 100,
      returnQuantity: 0,
      netQuantity: 100,
      salesAmount: 10000,
    }]);
    await insertReportPayoutDaily(db(), [{ scopeId: shopeeScope, businessDate: "2026-07-01", payoutAmount: 20000 }]);

    const sales = await createCyberbizReportService(db()).querySales({ period: "2026-07", scopeType: "company" });
    expect(sales.totals).toEqual({ grossQuantity: 9, returnQuantity: 1, netQuantity: 8, salesAmount: 680 });

    const payout = await createCyberbizReportService(db()).queryPayout({ period: "2026-07", scopeType: "company" });
    expect(payout.totals).toEqual({ payoutAmount: 6000 });
  });

  it("公司查詢直接 aggregate 所有據點，不需要公司 aggregate row", async () => {
    const result = await createCyberbizReportService(db()).querySales({
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      scopeType: "company",
      groupBy: ["scope", "day", "day"],
    });
    expect(result).toMatchObject({ status: "ok", requestedStart: "2026-07-01", requestedEnd: "2026-07-02" });
    expect(result.totals).toEqual({ grossQuantity: 9, returnQuantity: 1, netQuantity: 8, salesAmount: 680 });
    expect(result.rows).toHaveLength(3);
    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeId: WEST, businessDate: "2026-07-01" }),
    ]));
  });

  it("年度查詢可以再依分類與月份 aggregate", async () => {
    const result = await createCyberbizReportService(db()).querySales({
      period: "2026",
      scopeType: "company",
      category: "沐浴",
      groupBy: ["month"],
    });
    expect(result).toMatchObject({ status: "ok", period: "2026" });
    expect(result.totals).toEqual({ grossQuantity: 5, returnQuantity: 1, netQuantity: 4, salesAmount: 380 });
    expect(result.rows).toEqual([{ reportMonth: "2026-07", grossQuantity: 5, returnQuantity: 1, netQuantity: 4, salesAmount: 380 }]);
  });

  it("出金以據點與日期做 aggregate，沒有 income type 或 POS 維度", async () => {
    const result = await createCyberbizReportService(db()).queryPayout({
      period: "2026-07",
      scopeType: "company",
      groupBy: ["month"],
    });
    expect(result).toMatchObject({ status: "ok", totals: { payoutAmount: 6000 } });
    expect(result.rows).toEqual([{ reportMonth: "2026-07", payoutAmount: 6000 }]);
  });

  it("沒有指定區間資料時回傳後台作業所需的狀態", async () => {
    const result = await createCyberbizReportService(db()).querySales({
      period: "2025-12",
      scopeType: "company",
    });
    expect(result).toMatchObject({ status: "NO_DATA_FOR_RANGE", period: "2025-12" });
  });

  it("拒絕不完整的自訂日期區間", async () => {
    await expect(createCyberbizReportService(db()).queryPayout({
      startDate: "2026-07-02",
      scopeType: "company",
    })).rejects.toMatchObject({ code: "invalid_report_range", status: 400 });
  });
});
