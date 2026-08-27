import assert from "node:assert/strict";
import test from "node:test";
import { ingestReport, monthlySalesIngestRows, payoutIngestRows } from "../lib/report-ingest.mjs";

test("出金匯入資料會把小數金額四捨五入成整數", () => {
  assert.deepEqual(payoutIngestRows([
    { date: "2026-07-01", incomeAmount: 100.4 },
    { date: "2026-07-02", incomeAmount: 100.6 },
  ]), [
    { businessDate: "2026-07-01", payoutAmount: 100 },
    { businessDate: "2026-07-02", payoutAmount: 101 },
  ]);
});

test("蝦皮每日列會在送入 D1 前彙總成月份商品資料", () => {
  assert.deepEqual(monthlySalesIngestRows([
    {
      businessDate: "2026-07-01", sku: "P-001", productName: "黑色", category: "未分類",
      grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 0,
    },
    {
      businessDate: "2026-07-02", sku: "P-001", productName: "白色", category: "未分類",
      grossQuantity: 2, returnQuantity: 1, netQuantity: 1, salesAmount: 0,
    },
  ], "2026-07"), [{
    reportMonth: "2026-07", sku: "P-001", productName: "黑色 / 白色", category: "未分類",
    grossQuantity: 3, returnQuantity: 1, netQuantity: 2, salesAmount: 0,
  }]);
});

test("bundle ingest 會傳月份 sales 與每日 payout，不再傳 coveredDates", async () => {
  let payload;
  const result = await ingestReport({
    apiUrl: "https://platform.example.test/",
    ingestToken: "token",
    scopeId: "shopee:store:default",
    scopeName: "蝦皮",
    reportMonth: "2026-07",
    salesRows: [{ reportMonth: "2026-07", sku: "P-001", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 0 }],
    payoutRows: [{ businessDate: "2026-07-01", payoutAmount: 250 }],
    fetcher: async (_url, init) => {
      payload = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ result: { scopeId: "shopee:store:default" } }), { status: 200 });
    },
  });

  assert.deepEqual(payload, {
    kind: "sales_and_payout",
    scopeType: "store",
    scopeId: "shopee:store:default",
    scopeName: "蝦皮",
    salesRows: [{ reportMonth: "2026-07", sku: "P-001", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 0 }],
    payoutRows: [{ businessDate: "2026-07-01", payoutAmount: 250 }],
    reportMonth: "2026-07",
  });
  assert.equal(result.scopeId, "shopee:store:default");
});
