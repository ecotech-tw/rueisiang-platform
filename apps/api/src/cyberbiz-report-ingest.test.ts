import { createDatabase, upsertReportScope } from "@rueisiang/db";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createCyberbizReportService } from "./cyberbiz-reports.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const TOKEN = "report-ingest-secret";
let d1: LocalD1;

function db() {
  return createDatabase(d1 as never);
}

function request(body: unknown, token = TOKEN) {
  return app.fetch(new Request("https://platform.example.test/api/internal/cyberbiz-reports/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cyberbiz-report-token": token },
    body: JSON.stringify(body),
  }), { DB: d1, CYBERBIZ_REPORT_INGEST_TOKEN: TOKEN } as never);
}

beforeEach(() => {
  d1 = createLocalD1();
});

describe("報表日資料匯入", () => {
  it("只需要 ingest token，寫入 scope 與商品銷售日資料", async () => {
    const unauthorized = await request({ kind: "sales", scopeType: "store", scopeId: "cyberbiz:store:a", scopeName: "測試店", rows: [] }, "wrong");
    expect(unauthorized.status).toBe(401);

    const response = await request({
      kind: "sales",
      scopeType: "store",
      scopeId: "cyberbiz:store:a",
      scopeName: "測試店",
      rows: [
        { businessDate: "2026-07-01", sku: "SKU-1", productName: "商品一", category: "沐浴", grossQuantity: 3, returnQuantity: 1, netQuantity: 2, salesAmount: 180 },
        { businessDate: "2026-07-01", sku: "SKU-1", productName: "", category: "", grossQuantity: 2, returnQuantity: 0, netQuantity: 2, salesAmount: 90 },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { kind: "sales", rowCount: 1 } });

    const result = await createCyberbizReportService(db()).querySales({ period: "2026-07", scopeType: "store", scopeName: "測試店" });
    expect(result).toMatchObject({ status: "ok", totals: { netQuantity: 4, salesAmount: 270 } });
  });

  it("同一天的 payout rows 在匯入時加總，重跑時以新日資料取代", async () => {
    const first = await request({
      kind: "payout", scopeType: "store", scopeId: "cyberbiz:store:a", scopeName: "測試店",
      rows: [
        { businessDate: "2026-07-01", payoutAmount: 100 },
        { businessDate: "2026-07-01", payoutAmount: 25 },
      ],
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ result: { rowCount: 1 } });
    await request({
      kind: "payout", scopeType: "store", scopeId: "cyberbiz:store:a", scopeName: "測試店",
      rows: [{ businessDate: "2026-07-01", payoutAmount: 80 }],
    });
    const result = await createCyberbizReportService(db()).queryPayout({ period: "2026-07", scopeType: "store", scopeName: "測試店" });
    expect(result).toMatchObject({ status: "ok", totals: { payoutAmount: 80 } });
  });

  it("重新匯入 sales 的同一天會清掉已移除的 SKU", async () => {
    const first = await request({
      kind: "sales", scopeType: "store", scopeId: "cyberbiz:store:a", scopeName: "測試店",
      rows: [
        { businessDate: "2026-07-02", sku: "SKU-OLD", productName: "舊商品", category: "沐浴", grossQuantity: 3, returnQuantity: 0, netQuantity: 3, salesAmount: 300 },
        { businessDate: "2026-07-02", sku: "SKU-KEEP", productName: "保留商品", category: "沐浴", grossQuantity: 2, returnQuantity: 0, netQuantity: 2, salesAmount: 200 },
      ],
    });
    expect(first.status).toBe(200);

    const second = await request({
      kind: "sales", scopeType: "store", scopeId: "cyberbiz:store:a", scopeName: "測試店",
      rows: [{ businessDate: "2026-07-02", sku: "SKU-KEEP", productName: "保留商品", category: "沐浴", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 90 }],
    });
    expect(second.status).toBe(200);

    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07",
      scopeType: "store",
      scopeName: "測試店",
      groupBy: ["sku"],
    });
    expect(result.rows).toEqual([
      expect.objectContaining({ sku: "SKU-KEEP", netQuantity: 1, salesAmount: 90 }),
    ]);
    expect(result.totals).toEqual({ grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 90 });
  });

  it("整月重匯但中間缺幾天時，缺日的既有資料保持不變", async () => {
    const salesRow = (businessDate: string, salesAmount: number) => ({
      businessDate,
      sku: `SKU-${businessDate}`,
      productName: "商品",
      category: "沐浴",
      grossQuantity: 1,
      returnQuantity: 0,
      netQuantity: 1,
      salesAmount,
    });
    const firstRows = Array.from({ length: 31 }, (_, index) => {
      const businessDate = `2026-07-${String(index + 1).padStart(2, "0")}`;
      return salesRow(businessDate, index === 14 ? 1500 : index === 15 ? 1600 : 100 + index);
    });

    const first = await request({
      kind: "sales", scopeType: "store", scopeId: "cyberbiz:store:a", scopeName: "測試店",
      rows: firstRows,
    });
    expect(first.status).toBe(200);

    const second = await request({
      kind: "sales", scopeType: "store", scopeId: "cyberbiz:store:a", scopeName: "測試店",
      rows: firstRows
        .filter((row) => row.businessDate !== "2026-07-15" && row.businessDate !== "2026-07-16")
        .map((row) => row.businessDate === "2026-07-01"
          ? { ...row, salesAmount: 200 }
          : row.businessDate === "2026-07-31"
            ? { ...row, salesAmount: 3200 }
            : row),
    });
    expect(second.status).toBe(200);

    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07",
      scopeType: "store",
      scopeName: "測試店",
      groupBy: ["day"],
    });
    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ businessDate: "2026-07-01", salesAmount: 200 }),
      expect.objectContaining({ businessDate: "2026-07-15", salesAmount: 1500 }),
      expect.objectContaining({ businessDate: "2026-07-16", salesAmount: 1600 }),
      expect.objectContaining({ businessDate: "2026-07-31", salesAmount: 3200 }),
    ]));
    expect(result.rows).toHaveLength(31);
  });

  it("沿用既有同名 scope 的 ID，避免設定路徑改名後產生重複據點", async () => {
    await upsertReportScope(db(), { id: "legacy-store-id", scopeKind: "store", name: "測試店" });
    const response = await request({
      kind: "sales",
      scopeType: "store",
      scopeId: "cyberbiz:store:new-id",
      scopeName: "測試店",
      rows: [{ businessDate: "2026-07-01", sku: "SKU-1", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 100 }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { scopeId: "legacy-store-id" } });
    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07",
      scopeType: "store",
      scopeId: "legacy-store-id",
    });
    expect(result).toMatchObject({ status: "ok", scopeId: "legacy-store-id", totals: { netQuantity: 1, salesAmount: 100 } });
  });

  it("空白商品欄位沿用同批前值，首次空白分類回退為未分類", async () => {
    const response = await request({
      kind: "sales",
      scopeType: "store",
      scopeId: "cyberbiz:store:a",
      scopeName: "測試店",
      rows: [
        { businessDate: "2026-07-03", sku: "SKU-1", productName: "商品一", category: "沐浴", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 100 },
        { businessDate: "2026-07-03", sku: "SKU-1", productName: "", category: "", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 80 },
        { businessDate: "2026-07-03", sku: "SKU-2", productName: "", category: "", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 50 },
      ],
    });
    expect(response.status).toBe(200);

    const result = await createCyberbizReportService(db()).querySales({
      period: "2026-07",
      scopeType: "store",
      scopeName: "測試店",
      groupBy: ["sku", "category"],
    });
    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ sku: "SKU-1", category: "沐浴", netQuantity: 2, salesAmount: 180 }),
      expect.objectContaining({ sku: "SKU-2", category: "未分類", netQuantity: 1, salesAmount: 50 }),
    ]));
  });
});
