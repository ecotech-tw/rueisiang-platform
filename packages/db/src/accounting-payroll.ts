import { sql, type SQL } from "drizzle-orm";
import { payrollAdjustmentCanEdit } from "./hr-payroll-adjustments.js";
import { formatTaipeiDate } from "./taipei-time.js";

/*
 * 報帳「併入月薪」跟薪資加扣項之間的接縫。規格見 docs/accounting-prd.md 的「併入月薪」。
 *
 * 支出單用 payroll_adjustment_id 指向它產生的加扣項；反過來不另存欄位，HRIS 要知道一筆加扣項是不是
 * 來自報帳就反查 accounting_expenses。這裡的 SQL 片段都寫完整表名，因為它們會被放進單表查詢與子查詢裡，
 * drizzle 不會替欄位補表名。
 */

/** 核准當月結帳了就往後掛；三個月都掛不上通常是資料有問題，讓會計改用直接撥款，不要一路往後找。 */
const PAYROLL_LOOKAHEAD_MONTHS = 3;

/** 台北的「這個月」起算，能掛加扣項的候選月份 YYYY-MM。 */
export function payrollCandidateMonths(now = new Date()): string[] {
  const [year, month] = formatTaipeiDate(now).split("-").map(Number) as [number, number];
  return Array.from({ length: PAYROLL_LOOKAHEAD_MONTHS }, (_, offset) => {
    const index = year * 12 + month - 1 + offset;
    return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`;
  });
}

const employmentId = sql`accounting_expenses.employment_id`;
const linkedPeriod = sql`(SELECT linked_adjustment.effective_period_key FROM hr_payroll_adjustments AS linked_adjustment WHERE linked_adjustment.id = accounting_expenses.payroll_adjustment_id)`;

/** 加扣項只能掛在還在職（沒封存）的員工或支援人員身上，跟 HRIS 新增加扣項同一條件。 */
export const payrollEmploymentActive = sql`EXISTS (SELECT 1 FROM hr_employments AS payroll_employment
  WHERE payroll_employment.id = accounting_expenses.employment_id AND payroll_employment.archived_at IS NULL AND payroll_employment.person_kind IN ('employee', 'worker'))`;

export function payrollPeriodEditable(periodKey: string) {
  return payrollAdjustmentCanEdit(employmentId, periodKey);
}

/** 已經掛上的加扣項還能動（那個月這個人還沒結帳）：退回時要一起拿掉它。 */
export const linkedAdjustmentEditable = payrollAdjustmentCanEdit(employmentId, linkedPeriod);

/** 加扣項掛在哪個月；直接撥款或還沒核准的是 null。 */
export const payrollPeriodKey = sql<string | null>`${linkedPeriod}`;

/*
 * 併入月薪的單，那個月這個人的薪資結帳了就算付出去了。不在結帳時回寫支出單：那要讓薪資結帳去改會計的表，
 * 兩個系統的寫入就纏在一起了。所以「已付款」是讀的時候推出來的，清單篩選也照這個值。
 */
export const effectiveExpenseStatus = sql<"pending" | "approved" | "rejected" | "cancelled" | "paid">`(CASE
  WHEN accounting_expenses.status = 'approved' AND accounting_expenses.payroll_adjustment_id IS NOT NULL AND NOT ${linkedAdjustmentEditable} THEN 'paid'
  ELSE accounting_expenses.status END)`;

/** 待審的單現在核准的話會掛在哪個月；不能併入月薪（沒有在職資料、三個月都結帳了）就是 null。 */
export function payrollOption(months: string[]): SQL<string | null> {
  const branches = sql.join(months.map((month) => sql`WHEN ${payrollPeriodEditable(month)} THEN ${month}`), sql` `);
  return sql<string | null>`(CASE WHEN accounting_expenses.status <> 'pending' OR NOT ${payrollEmploymentActive} THEN NULL ${branches} ELSE NULL END)`;
}
