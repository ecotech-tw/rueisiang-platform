import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { hrPayrollAdjustments } from "./hr-payroll-runs.js";
import { hrEmployments } from "./hr-people.js";
import { scopes } from "./reports.js";

/*
 * 會計（內帳）。規格見 docs/accounting-prd.md。
 *
 * 外鍵一律 RESTRICT：支出單是帳，不能因為刪了一個使用者、店別或類別就跟著消失。
 */

/** 支出類別是會計維護的清單，不是科目表；停用用 archived_at，舊的支出單仍指得到它。 */
export const accountingExpenseCategories = sqliteTable("accounting_expense_categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  sortOrder: integer("sort_order").notNull().default(0),
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("ck_accounting_expense_categories_name", sql`length(trim(${table.name})) BETWEEN 1 AND 50`),
]);

/*
 * 一張有發票的支出。員工代墊（報公帳）與公司直接付共用這張表，用 payer_kind 分，
 * 報表、匯出與帳期才只有一個來源。
 *
 * 審核與撥款的欄位現在就建好：狀態與發放方式的 CHECK 之後要改的話得重建整張表。
 *
 * 送件管道（source）：平台（HR 員工自助、會計系統）或 LINE（在群組 @小香）。LINE 送件的人有綁定平台帳號就跟平台送件一樣；
 * 沒綁定的人沒有帳號也沒有任職資料（使用者決定照樣收件），submitter_user_id 是 NULL，只記 LINE 的 userId 與名稱，
 * 而且只能直接撥款——沒有任職資料就沒有薪資可以併入。
 */
export const accountingExpenses = sqliteTable("accounting_expenses", {
  id: text("id").primaryKey(),
  payerKind: text("payer_kind", { enum: ["employee_advance", "company"] as const }).notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected", "cancelled", "paid"] as const }).notNull().default("pending"),
  submitterUserId: text("submitter_user_id").references(() => users.id, { onDelete: "restrict" }),
  source: text("source", { enum: ["platform", "line"] as const }).notNull().default("platform"),
  // LINE 送件：發話者的 userId（webhook 給的，不是使用者自己填的）與當下的名稱；沒綁定的人靠這兩欄辨識。
  lineUserId: text("line_user_id"),
  lineDisplayName: text("line_display_name").notNull().default(""),
  // 員工代墊才有：送件當下的任職資料。員工與支援人員都在 hr_employments，併入月薪的加扣項也綁在這裡。
  employmentId: text("employment_id").references(() => hrEmployments.id, { onDelete: "restrict" }),
  // 同一位送件人連按兩次送出只會有一張；LINE 送件用 webhook 事件當識別碼，同一則訊息重送也只會有一張。
  clientRequestId: text("client_request_id").notNull(),
  categoryId: text("category_id").notNull().references(() => accountingExpenseCategories.id, { onDelete: "restrict" }),
  scopeId: text("scope_id").references(() => scopes.id, { onDelete: "restrict" }),
  // 台北的日期 YYYY-MM-DD，決定落在哪個帳期。
  spentOn: text("spent_on").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  invoiceNumber: text("invoice_number").notNull().default(""),
  sellerTaxId: text("seller_tax_id").notNull().default(""),
  description: text("description").notNull(),
  payoutMethod: text("payout_method", { enum: ["direct", "payroll"] as const }),
  reviewerUserId: text("reviewer_user_id").references(() => users.id, { onDelete: "restrict" }),
  reviewedAt: text("reviewed_at"),
  reviewNote: text("review_note").notNull().default(""),
  paidAt: text("paid_at"),
  payrollAdjustmentId: text("payroll_adjustment_id").references(() => hrPayrollAdjustments.id, { onDelete: "restrict" }),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_accounting_expenses_client_request").on(table.submitterUserId, table.clientRequestId),
  // 沒綁定的人 submitter_user_id 是 NULL，上面那個唯一索引擋不到；LINE 送件另外用識別碼本身擋重複。
  uniqueIndex("idx_accounting_expenses_line_request").on(table.clientRequestId).where(sql`${table.source} = 'line'`),
  index("idx_accounting_expenses_submitter_created").on(table.submitterUserId, table.createdAt),
  index("idx_accounting_expenses_status_created").on(table.status, table.createdAt),
  index("idx_accounting_expenses_invoice").on(table.invoiceNumber).where(sql`${table.invoiceNumber} <> ''`),
  check("ck_accounting_expenses_payer_kind", sql`${table.payerKind} IN ('employee_advance', 'company')`),
  check("ck_accounting_expenses_status", sql`${table.status} IN ('pending', 'approved', 'rejected', 'cancelled', 'paid')`),
  check("ck_accounting_expenses_source", sql`${table.source} IN ('platform', 'line')`),
  // 沒有平台帳號的只能是 LINE 送件的員工代墊，而且一定要有 LINE 名稱，會計才知道是誰。
  check("ck_accounting_expenses_submitter", sql`${table.submitterUserId} IS NOT NULL OR (${table.source} = 'line' AND ${table.payerKind} = 'employee_advance' AND ${table.lineUserId} IS NOT NULL AND length(trim(${table.lineDisplayName})) > 0)`),
  check("ck_accounting_expenses_employment", sql`(${table.payerKind} = 'employee_advance' AND ${table.submitterUserId} IS NOT NULL) = (${table.employmentId} IS NOT NULL)`),
  check("ck_accounting_expenses_guest_payout", sql`${table.submitterUserId} IS NOT NULL OR ${table.payoutMethod} IS NULL OR ${table.payoutMethod} = 'direct'`),
  check("ck_accounting_expenses_spent_on", sql`${table.spentOn} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
  check("ck_accounting_expenses_amount", sql`${table.amountMinor} > 0`),
  check("ck_accounting_expenses_description", sql`length(trim(${table.description})) BETWEEN 1 AND 500`),
  check("ck_accounting_expenses_payout_method", sql`${table.payoutMethod} IS NULL OR ${table.payoutMethod} IN ('direct', 'payroll')`),
  check("ck_accounting_expenses_payroll_link", sql`${table.payrollAdjustmentId} IS NULL OR ${table.payoutMethod} = 'payroll'`),
  check("ck_accounting_expenses_revision", sql`${table.revision} > 0`),
]);

/** 單據照片本身在私有 R2 bucket（UPLOADS），這裡只存索引。 */
export const accountingExpenseReceipts = sqliteTable("accounting_expense_receipts", {
  id: text("id").primaryKey(),
  expenseId: text("expense_id").notNull().references(() => accountingExpenses.id, { onDelete: "restrict" }),
  objectKey: text("object_key").notNull().unique(),
  contentType: text("content_type", { enum: ["image/jpeg", "image/png", "image/webp"] as const }).notNull(),
  byteSize: integer("byte_size").notNull(),
  sortOrder: integer("sort_order").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_accounting_expense_receipts_expense").on(table.expenseId, table.sortOrder),
  check("ck_accounting_expense_receipts_type", sql`${table.contentType} IN ('image/jpeg', 'image/png', 'image/webp')`),
  check("ck_accounting_expense_receipts_size", sql`${table.byteSize} > 0`),
]);

/*
 * 零用金：全公司一個錢箱（使用者決定），餘額就是這張表所有金額的總和。
 * 每一筆增加、撥款、退回、更正都是一列，金額帶正負號；紀錄只能新增，改與刪由 0264 的 trigger 擋下，
 * 餘額變負數的那一筆也一樣擋（寫入時另外有條件式 INSERT，trigger 是最後一道保險）。
 *
 * 撥款（payout）與退回（refund）指向那張報帳單；同一張單的撥款與退回加起來就是「目前從零用金付出去多少」，
 * 已付款退回待撥款時照這個數字退錢。
 *
 * 沒有手動減少（使用者決定）。「增加」打錯金額時用更正（correction）：指向那一筆增加，金額是「正確金額 − 原本金額」
 * 的差額（打多了是負的、打少了是正的）。同一筆可以更正很多次，每次都跟上一次的結果比；原本那筆照樣留著。
 */
export const accountingPettyCashEntries = sqliteTable("accounting_petty_cash_entries", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["top_up", "payout", "refund", "correction"] as const }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  expenseId: text("expense_id").references(() => accountingExpenses.id, { onDelete: "restrict" }),
  correctsEntryId: text("corrects_entry_id").references((): AnySQLiteColumn => accountingPettyCashEntries.id, { onDelete: "restrict" }),
  note: text("note").notNull().default(""),
  actorUserId: text("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_accounting_petty_cash_created").on(table.createdAt),
  index("idx_accounting_petty_cash_expense").on(table.expenseId),
  index("idx_accounting_petty_cash_corrects").on(table.correctsEntryId),
  check("ck_accounting_petty_cash_kind", sql`${table.kind} IN ('top_up', 'payout', 'refund', 'correction')`),
  // 增加與退回是錢進來，撥款是錢出去；更正是差額，正負都可以但不能是 0。
  check("ck_accounting_petty_cash_sign", sql`(${table.kind} IN ('top_up', 'refund') AND ${table.amountMinor} > 0) OR (${table.kind} = 'payout' AND ${table.amountMinor} < 0) OR (${table.kind} = 'correction' AND ${table.amountMinor} <> 0)`),
  check("ck_accounting_petty_cash_expense", sql`(${table.kind} IN ('payout', 'refund')) = (${table.expenseId} IS NOT NULL)`),
  check("ck_accounting_petty_cash_correction", sql`(${table.kind} = 'correction') = (${table.correctsEntryId} IS NOT NULL)`),
  // 更正要寫原因，之後查得到為什麼扣回來。
  check("ck_accounting_petty_cash_note", sql`length(${table.note}) <= 500 AND (${table.kind} <> 'correction' OR length(trim(${table.note})) > 0)`),
]);

export type AccountingExpense = typeof accountingExpenses.$inferSelect;
export type AccountingPettyCashEntry = typeof accountingPettyCashEntries.$inferSelect;
export type AccountingExpenseCategory = typeof accountingExpenseCategories.$inferSelect;
