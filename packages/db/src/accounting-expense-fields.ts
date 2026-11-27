/*
 * 報公帳的欄位規則。前端從 `@rueisiang/db/accounting-expense-fields` 匯入，所以這個檔案不能 import 任何東西：
 * 員工自助的表單與 API 的驗證讀同一份上限，才不會一邊放行、一邊擋下。
 */

export const EXPENSE_RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ExpenseReceiptType = typeof EXPENSE_RECEIPT_TYPES[number];

/** 手機拍的照片先在瀏覽器縮到這個邊長再上傳；伺服器的上限比它寬，留給沒縮到的情況。 */
export const EXPENSE_RECEIPT_UPLOAD_SIDE = 2400;
export const EXPENSE_RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
export const EXPENSE_RECEIPT_MAX_PIXELS = 12_000_000;
export const EXPENSE_RECEIPT_MAX_SIDE = 8192;
export const EXPENSE_RECEIPT_MAX_FILES = 5;

/** 金額在畫面上是整數元（發票沒有角分），存進資料庫時乘 100 成為分。 */
export const EXPENSE_AMOUNT_MAX_DOLLARS = 1_000_000;
export const EXPENSE_DESCRIPTION_MAX = 500;

/** 消費日期最早只收一年內；年份打錯（2016）通常是手滑，擋下來比讓會計事後發現好。 */
export const EXPENSE_SPENT_ON_MAX_AGE_DAYS = 365;

/** 給台北的今天 `YYYY-MM-DD`，回傳最早可以報的消費日期。只做日期運算，不碰時區。 */
export function earliestExpenseDate(today: string): string {
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day - EXPENSE_SPENT_ON_MAX_AGE_DAYS)).toISOString().slice(0, 10);
}

/** 統一發票（含電子發票）號碼：兩個英文字母加八位數字。 */
export const INVOICE_NUMBER_PATTERN = /^[A-Z]{2}\d{8}$/;
export const SELLER_TAX_ID_PATTERN = /^\d{8}$/;

/** 使用者常照著發票抄成「AB-1234 5678」或小寫；比對與重複檢查前先統一。 */
export function normalizeInvoiceNumber(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

/** 併入月薪的月份「2026-12」→「2026 年 12 月」；會計、員工畫面與通知用同一種寫法。 */
export function payrollPeriodLabel(periodKey: string) {
  const [year, month] = periodKey.split("-");
  return `${year} 年 ${Number(month)} 月`;
}

export const EXPENSE_STATUS_LABELS = {
  pending: "待審核",
  approved: "已核准",
  rejected: "已退回",
  cancelled: "已撤回",
  paid: "已付款",
} as const;
export type ExpenseStatus = keyof typeof EXPENSE_STATUS_LABELS;
