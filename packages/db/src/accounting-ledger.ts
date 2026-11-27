import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { AccountingError, listExpenseFormOptions, validateExpenseFields, type ExpenseFieldsInput } from "./accounting-expenses.js";
import { payrollPeriodKey } from "./accounting-payroll.js";
import { guardedWrite, type AccountingActor } from "./accounting-review.js";
import { toDbTimestamp } from "./db-timestamp.js";
import { hrEmployeeName, listHrScopes } from "./hr-people.js";
import { accountingExpenseCategories, accountingExpenseReceipts, accountingExpenses } from "./schema/accounting.js";
import { users } from "./schema/auth.js";
import { hrEmployments } from "./schema/hr-people.js";
import { scopes } from "./schema/reports.js";

/*
 * 支出帳：一個月所有算數的支出，兩種付款人放在一起看、一起匯出。規格見 docs/accounting-prd.md 第 2 節。
 *
 * 「算數」的意思是錢確定要出去了：公司直接付的登記就算（作廢的不算）；員工代墊的要會計核准過
 * （待審、退回、撤回的不算）。月份照消費日期切，跟帳期同一個依據。
 */

export const LEDGER_PAYER_FILTERS = ["all", "company", "employee_advance"] as const;
export type LedgerPayerFilter = typeof LEDGER_PAYER_FILTERS[number];

export interface LedgerFilter { month: string; payer: LedgerPayerFilter; categoryId: string | null; scopeId: string | null }

export interface LedgerEntry {
  id: string;
  payerKind: "employee_advance" | "company";
  /** 員工代墊的才有意義：approved 是待撥款或等月薪，paid 是已付款；公司支出一律 paid。 */
  status: "approved" | "paid";
  spentOn: string;
  amountMinor: number;
  categoryId: string;
  categoryName: string;
  scopeId: string | null;
  scopeName: string | null;
  invoiceNumber: string;
  sellerTaxId: string;
  description: string;
  /** 員工代墊是送件人；公司支出是登記的會計。 */
  personName: string;
  payoutMethod: "direct" | "payroll" | null;
  payrollPeriodKey: string | null;
  revision: number;
  receiptIds: string[];
}

/** 一個月的支出筆數有上限，超過就請會計縮小篩選；比默默截斷、匯出少一截好。 */
const LEDGER_LIMIT = 3000;

export async function listLedger(db: Database, filter: LedgerFilter): Promise<{ entries: LedgerEntry[]; totalMinor: number }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(filter.month)) throw new AccountingError(400, "請選擇月份。");
  const counted = or(
    and(eq(accountingExpenses.payerKind, "company"), eq(accountingExpenses.status, "paid")),
    and(eq(accountingExpenses.payerKind, "employee_advance"), inArray(accountingExpenses.status, ["approved", "paid"])),
  );
  const conditions = [
    counted,
    // 消費日期是 YYYY-MM-DD 字串，直接比字串範圍，不必把每一列轉成月份。
    sql`${accountingExpenses.spentOn} >= ${`${filter.month}-01`} AND ${accountingExpenses.spentOn} <= ${`${filter.month}-31`}`,
    filter.payer === "all" ? undefined : eq(accountingExpenses.payerKind, filter.payer),
    filter.categoryId ? eq(accountingExpenses.categoryId, filter.categoryId) : undefined,
    filter.scopeId ? eq(accountingExpenses.scopeId, filter.scopeId) : undefined,
  ];
  const rows = await db.select({
    id: accountingExpenses.id,
    payerKind: accountingExpenses.payerKind,
    status: accountingExpenses.status,
    spentOn: accountingExpenses.spentOn,
    amountMinor: accountingExpenses.amountMinor,
    categoryId: accountingExpenses.categoryId,
    categoryName: accountingExpenseCategories.name,
    scopeId: accountingExpenses.scopeId,
    scopeName: scopes.name,
    invoiceNumber: accountingExpenses.invoiceNumber,
    sellerTaxId: accountingExpenses.sellerTaxId,
    description: accountingExpenses.description,
    personName: hrEmployeeName,
    payoutMethod: accountingExpenses.payoutMethod,
    payrollPeriodKey,
    revision: accountingExpenses.revision,
  }).from(accountingExpenses)
    .innerJoin(accountingExpenseCategories, eq(accountingExpenseCategories.id, accountingExpenses.categoryId))
    .innerJoin(users, eq(users.id, accountingExpenses.submitterUserId))
    .leftJoin(hrEmployments, eq(hrEmployments.id, accountingExpenses.employmentId))
    .leftJoin(scopes, eq(scopes.id, accountingExpenses.scopeId))
    .where(and(...conditions))
    .orderBy(asc(accountingExpenses.spentOn), asc(accountingExpenses.createdAt), asc(accountingExpenses.id))
    .limit(LEDGER_LIMIT + 1);
  if (rows.length > LEDGER_LIMIT) throw new AccountingError(400, `這個月超過 ${LEDGER_LIMIT.toLocaleString("zh-TW")} 筆，請用類別或店別縮小範圍。`);
  const receipts = rows.length
    ? await db.select({ id: accountingExpenseReceipts.id, expenseId: accountingExpenseReceipts.expenseId }).from(accountingExpenseReceipts)
      .where(inArray(accountingExpenseReceipts.expenseId, rows.map((row) => row.id)))
      .orderBy(asc(accountingExpenseReceipts.sortOrder))
    : [];
  const entries = rows.map((row) => ({
    ...row,
    status: row.status === "paid" ? "paid" as const : "approved" as const,
    receiptIds: receipts.filter((receipt) => receipt.expenseId === row.id).map((receipt) => receipt.id),
  }));
  return { entries, totalMinor: entries.reduce((sum, entry) => sum + entry.amountMinor, 0) };
}

/** 登記公司支出的表單選項：類別跟員工報帳同一份，另外多了店別。 */
export async function listCompanyExpenseOptions(db: Database) {
  const [{ categories }, stores] = await Promise.all([listExpenseFormOptions(db), listHrScopes(db)]);
  return { categories, scopes: stores };
}

export type CompanyExpenseUpdate = Omit<ExpenseFieldsInput, "clientRequestId" | "receiptCount">;

async function currentCompanyExpense(db: Database, id: string) {
  const [current] = await db.select({
    status: accountingExpenses.status,
    payerKind: accountingExpenses.payerKind,
    clientRequestId: accountingExpenses.clientRequestId,
    receiptCount: sql<number>`(SELECT count(*) FROM accounting_expense_receipts WHERE accounting_expense_receipts.expense_id = accounting_expenses.id)`,
  }).from(accountingExpenses).where(eq(accountingExpenses.id, id)).limit(1);
  if (!current || current.payerKind !== "company") throw new AccountingError(404, "找不到這筆公司支出。");
  if (current.status !== "paid") throw new AccountingError(409, "這筆支出已經作廢，不能再修改。");
  return current;
}

const companyWritable = (id: string, expectedRevision: number) => and(
  eq(accountingExpenses.id, id),
  eq(accountingExpenses.payerKind, "company"),
  eq(accountingExpenses.status, "paid"),
  eq(accountingExpenses.revision, expectedRevision),
);

/*
 * 登記錯了就改：欄位規則跟登記時一樣（validateExpenseFields）。照片不在這裡改——沒有發票號碼又沒有照片的話，
 * 跟登記時一樣擋下。帳期結帳（第三批）之前都能改，結帳後由 trigger 擋。
 */
export async function updateCompanyExpense(db: Database, id: string, expectedRevision: number, input: CompanyExpenseUpdate, actor: AccountingActor) {
  const current = await currentCompanyExpense(db, id);
  const fields = await validateExpenseFields(db, { ...input, clientRequestId: current.clientRequestId, receiptCount: Number(current.receiptCount) }, { tooOldHint: "。", excludeExpenseId: id });
  const now = toDbTimestamp();
  const changed = await guardedWrite(db, db.update(accountingExpenses).set({
    categoryId: fields.categoryId,
    scopeId: fields.scopeId,
    spentOn: fields.spentOn,
    amountMinor: fields.amountMinor,
    invoiceNumber: fields.invoiceNumber,
    sellerTaxId: fields.sellerTaxId,
    description: fields.description,
    revision: expectedRevision + 1,
    updatedAt: now,
  }).where(companyWritable(id, expectedRevision)).returning({ id: accountingExpenses.id }),
  activityRow({ entityType: "accounting_expense", entityId: id, source: "accounting", eventType: "company_expense_updated", summary: "修改公司支出", actor, payload: { spentOn: fields.spentOn, amountMinor: fields.amountMinor, categoryId: fields.categoryId, scopeId: fields.scopeId } }), now);
  if (!changed) throw new AccountingError(409, "這筆支出剛被改過或作廢了，請重新整理後再試。");
  return { id };
}

/** 作廢不刪：支出單留著當紀錄（照片也還在），只是不再算進支出帳與匯出。 */
export async function voidCompanyExpense(db: Database, id: string, expectedRevision: number, actor: AccountingActor) {
  await currentCompanyExpense(db, id);
  const now = toDbTimestamp();
  const changed = await guardedWrite(db, db.update(accountingExpenses).set({ status: "cancelled", revision: expectedRevision + 1, updatedAt: now })
    .where(companyWritable(id, expectedRevision)).returning({ id: accountingExpenses.id }),
  activityRow({ entityType: "accounting_expense", entityId: id, source: "accounting", eventType: "company_expense_voided", summary: "作廢公司支出", actor }), now);
  if (!changed) throw new AccountingError(409, "這筆支出剛被改過或作廢了，請重新整理後再試。");
  return { id };
}
