import assert from "node:assert/strict";
import test from "node:test";
import { payoutIngestRows } from "../lib/report-ingest.mjs";
import { collectSalesDailyRows } from "../lib/sales-daily.mjs";

test("出金匯入資料會把小數金額四捨五入成整數", () => {
  assert.deepEqual(payoutIngestRows([
    { date: "2026-07-01", incomeAmount: 100.4 },
    { date: "2026-07-02", incomeAmount: 100.6 },
  ]), [
    { businessDate: "2026-07-01", payoutAmount: 100 },
    { businessDate: "2026-07-02", payoutAmount: 101 },
  ]);
});

test("商品銷售單日失敗時仍保留其他日期的匯入資料", async () => {
  const result = await collectSalesDailyRows({
    range: { start: "2026-07-01", end: "2026-07-03" },
    localPath: "monthly.xlsx",
    loadDay: async (day) => {
      if (day.start === "2026-07-02") throw new Error("附件逾時");
      return {
        rows: [{
          sku: `SKU-${day.start.slice(-2)}`,
          productName: "商品",
          category: "沐浴",
          grossQuantity: 1.2,
          returnQuantity: 0,
          netQuantity: 1.2,
          salesAmount: 99.6,
        }],
      };
    },
  });

  assert.deepEqual(result.rows.map((row) => row.businessDate), ["2026-07-01", "2026-07-03"]);
  assert.deepEqual(result.rows.map((row) => row.salesAmount), [100, 100]);
  assert.deepEqual(result.failures.map(({ day }) => day.start), ["2026-07-02"]);
  assert.deepEqual(result.coveredDates, ["2026-07-01", "2026-07-03"]);
});

test("讀得到報表但零筆的日子仍算成功涵蓋，失敗的日子才排除", async () => {
  const result = await collectSalesDailyRows({
    range: { start: "2026-07-01", end: "2026-07-03" },
    localPath: "monthly.xlsx",
    loadDay: async (day) => {
      if (day.start === "2026-07-03") throw new Error("附件逾時");
      return { rows: day.start === "2026-07-02" ? [] : [{
        sku: "SKU-01", productName: "商品", category: "沐浴",
        grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 100,
      }] };
    },
  });

  assert.deepEqual(result.rows.map((row) => row.businessDate), ["2026-07-01"]);
  assert.deepEqual(result.coveredDates, ["2026-07-01", "2026-07-02"]);
  assert.deepEqual(result.failures.map(({ day }) => day.start), ["2026-07-03"]);
});
