import { payrollPeriodLabel } from "@rueisiang/db/accounting-expense-fields";
import type { LedgerEntry } from "./api.js";

/*
 * 支出帳匯出成 Excel。會計事務所要的格式還不知道（docs/accounting-prd.md 第 1 節），所以欄位只定義在
 * LEDGER_EXPORT_COLUMNS 這一處；事務所給了格式，改這張表就好，畫面與資料層都不用動。
 *
 * 檔案在瀏覽器裡產生：資料就是畫面上那份清單，Worker 不必多扛一個 Excel 函式庫。
 */

export const LEDGER_EXPORT_COLUMNS: { header: string; width: number; value: (entry: LedgerEntry) => string | number }[] = [
  { header: "消費日期", width: 12, value: (entry) => entry.spentOn },
  { header: "類別", width: 12, value: (entry) => entry.categoryName },
  { header: "店別", width: 12, value: (entry) => entry.scopeName ?? "" },
  { header: "付款", width: 10, value: (entry) => entry.payerKind === "company" ? "公司直接付" : "員工代墊" },
  { header: "經手人", width: 12, value: (entry) => entry.personName },
  { header: "發票號碼", width: 14, value: (entry) => entry.invoiceNumber || "收據" },
  { header: "賣方統編", width: 11, value: (entry) => entry.sellerTaxId },
  { header: "用途說明", width: 36, value: (entry) => entry.description },
  // 金額寫數字、不寫「NT$ 1,200」：事務所要在 Excel 裡加總。
  { header: "金額（元）", width: 12, value: (entry) => entry.amountMinor / 100 },
  { header: "狀態", width: 18, value: ledgerStatusText },
];

export function ledgerStatusText(entry: LedgerEntry) {
  if (entry.payerKind === "company") return "已付款";
  if (entry.payoutMethod === "payroll" && entry.payrollPeriodKey) {
    const period = payrollPeriodLabel(entry.payrollPeriodKey);
    return entry.status === "paid" ? `已隨 ${period}薪資發放` : `併入 ${period}薪資`;
  }
  return entry.status === "paid" ? "已付款" : "待撥款";
}

/** 表頭、每一筆、最後一列合計。拆出來是為了測得到，不必真的產生檔案。 */
export function ledgerExportRows(entries: LedgerEntry[]): (string | number)[][] {
  const amountIndex = LEDGER_EXPORT_COLUMNS.findIndex((column) => column.header === "金額（元）");
  const total = LEDGER_EXPORT_COLUMNS.map((_, index) => index === 0 ? "合計" : index === amountIndex ? entries.reduce((sum, entry) => sum + entry.amountMinor, 0) / 100 : "");
  return [
    LEDGER_EXPORT_COLUMNS.map((column) => column.header),
    ...entries.map((entry) => LEDGER_EXPORT_COLUMNS.map((column) => column.value(entry))),
    total,
  ];
}

/** xlsx 很大，只有按下匯出才載入。 */
export async function downloadLedgerXlsx(entries: LedgerEntry[], month: string, label: string) {
  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.aoa_to_sheet(ledgerExportRows(entries));
  sheet["!cols"] = LEDGER_EXPORT_COLUMNS.map((column) => ({ wch: column.width }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, `${month} 支出`);
  XLSX.writeFile(book, `支出_${month}${label ? `_${label}` : ""}.xlsx`);
}
