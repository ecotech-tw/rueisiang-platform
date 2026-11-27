import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "./api.js";
import { ledgerExportRows } from "./ledger-export.js";

const base: LedgerEntry = {
  id: "e1", payerKind: "company", status: "paid", spentOn: "2026-11-03", amountMinor: 120000,
  categoryId: "c1", categoryName: "設備維修", scopeId: "s1", scopeName: "台北店",
  invoiceNumber: "AB12345678", sellerTaxId: "12345678", description: "冷氣保養",
  personName: "陳會計", payoutMethod: null, payrollPeriodKey: null, revision: 1, receiptIds: [],
};

describe("支出匯出", () => {
  it("一筆一列、金額是可以加總的數字，最後一列是合計", () => {
    const rows = ledgerExportRows([
      base,
      { ...base, id: "e2", payerKind: "employee_advance", status: "approved", amountMinor: 35050, scopeId: null, scopeName: null, invoiceNumber: "", sellerTaxId: "", personName: "王小明", payoutMethod: "payroll", payrollPeriodKey: "2026-12", description: "清潔用品" },
    ]);
    expect(rows[0]).toEqual(["消費日期", "類別", "店別", "付款", "經手人", "發票號碼", "賣方統編", "用途說明", "金額（元）", "狀態"]);
    expect(rows[1]).toEqual(["2026-11-03", "設備維修", "台北店", "公司直接付", "陳會計", "AB12345678", "12345678", "冷氣保養", 1200, "已付款"]);
    expect(rows[2]).toEqual(["2026-11-03", "設備維修", "", "員工代墊", "王小明", "收據", "", "清潔用品", 350.5, "併入 2026 年 12 月薪資"]);
    expect(rows[3]).toEqual(["合計", "", "", "", "", "", "", "", 1550.5, ""]);
  });
});
