import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregatePayoutDocuments, aggregateSalesDocuments } from "../lib/aggregate.mjs";

function sales(scopeId, sku, quantity, amount) {
  return {
    schemaVersion: 1,
    kind: "cyberbiz_sales_monthly",
    scopeType: "store",
    scopeId,
    scopeName: scopeId,
    reportMonth: "2026-07",
    coverageStart: "2026-07-01",
    coverageEnd: "2026-07-31",
    granularity: "month",
    rows: [{ sku, productName: "沐浴露", category: "沐浴", unitPrice: 100, grossQuantity: quantity, returnQuantity: 0, netQuantity: quantity, salesAmount: amount }],
    totals: { grossQuantity: quantity, returnQuantity: 0, netQuantity: quantity, salesAmount: amount },
  };
}

test("company sales aggregate merges the same SKU and keeps total amount from each report", () => {
  const result = aggregateSalesDocuments([sales("1", "SKU-1", 2, 180), sales("2", "SKU-1", 3, 270)]);
  assert.equal(result.scopeId, "company");
  assert.deepEqual(result.totals, { grossQuantity: 5, returnQuantity: 0, netQuantity: 5, salesAmount: 450 });
  assert.equal(result.rows[0].sku, "SKU-1");
  assert.equal(result.rows[0].netQuantity, 5);
});

test("company payout aggregate concatenates rows instead of deduplicating same-day cash entries", () => {
  const base = (scopeId, amount) => ({
    schemaVersion: 1,
    kind: "cyberbiz_payout_daily",
    scopeType: "store",
    scopeId,
    scopeName: scopeId,
    reportMonth: "2026-07",
    coverageStart: "2026-07-01",
    coverageEnd: "2026-07-31",
    granularity: "day",
    rows: [{ date: "2026-07-01", closeAt: "2026-07-01 21:00:00", incomeAmount: amount, incomeType: "現金", pos: "POS 1", operator: "甲" }],
    totals: { incomeAmount: amount, rowCount: 1 },
  });
  const result = aggregatePayoutDocuments([base("1", 100), base("2", 200)]);
  assert.deepEqual(result.totals, { incomeAmount: 300, rowCount: 2 });
  assert.equal(result.rows.length, 2);
});
