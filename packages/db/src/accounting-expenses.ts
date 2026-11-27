import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  EXPENSE_AMOUNT_MAX_DOLLARS,
  EXPENSE_DESCRIPTION_MAX,
  EXPENSE_RECEIPT_MAX_FILES,
  EXPENSE_SPENT_ON_MAX_AGE_DAYS,
  INVOICE_NUMBER_PATTERN,
  SELLER_TAX_ID_PATTERN,
  earliestExpenseDate,
  normalizeInvoiceNumber,
  type ExpenseReceiptType,
  type ExpenseStatus,
} from "./accounting-expense-fields.js";
import { effectiveExpenseStatus, payrollPeriodKey } from "./accounting-payroll.js";
import { toDbTimestamp } from "./db-timestamp.js";
import { getHrWorkerAccount, listHrScopes } from "./hr-people.js";
import { accountingExpenseCategories, accountingExpenseReceipts, accountingExpenses } from "./schema/accounting.js";
import { hrEmployments } from "./schema/hr-people.js";
import { scopes } from "./schema/reports.js";
import { formatTaipeiDate } from "./taipei-time.js";

/*
 * 報公帳的送件端。規格見 docs/accounting-prd.md 第 3 節。
 *
 * 這裡只處理「送件人自己」：每個函式都用 userId 限定範圍，送件人看不到、也動不了別人的單。
 * 審核、撥款與會計那一端在下一批。
 */

export class AccountingError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string, public readonly code?: string) { super(message); }
}

export interface ExpenseSubmitter { userId: string; employmentId: string; personKind: "employee" | "worker" }

/**
 * 能報帳的人：在職員工，或已連結帳號、沒有停用的支援人員。
 * 兩種人都在 hr_employments，支出單記住的是送件當下的那一筆任職資料。
 */
export async function resolveExpenseSubmitter(db: Database, userId: string): Promise<ExpenseSubmitter> {
  const [employee] = await db.select({ id: hrEmployments.id }).from(hrEmployments)
    .where(and(eq(hrEmployments.personKind, "employee"), eq(hrEmployments.employeeUserId, userId), isNull(hrEmployments.archivedAt)))
    .orderBy(desc(hrEmployments.updatedAt), desc(hrEmployments.id)).limit(1);
  if (employee) return { userId, employmentId: employee.id, personKind: "employee" };
  const worker = await getHrWorkerAccount(db, userId);
  if (worker && worker.archivedAt === null) return { userId, employmentId: worker.id, personKind: "worker" };
  throw new AccountingError(403, "只有在職員工與支援人員可以報帳。");
}

/** 員工報帳的表單只問類別；店別給會計登記公司支出用，不在這裡給。 */
export async function listExpenseFormOptions(db: Database) {
  const categories = await db.select({ id: accountingExpenseCategories.id, name: accountingExpenseCategories.name }).from(accountingExpenseCategories)
    .where(isNull(accountingExpenseCategories.archivedAt))
    .orderBy(asc(accountingExpenseCategories.sortOrder), asc(accountingExpenseCategories.name));
  return { categories };
}

export interface MyExpenseInput {
  clientRequestId: string;
  categoryId: string;
  scopeId: string | null;
  spentOn: string;
  amountDollars: number;
  invoiceNumber: string;
  sellerTaxId: string;
  description: string;
  receiptCount: number;
  confirmDuplicate: boolean;
}

export interface PreparedExpense {
  submitter: ExpenseSubmitter;
  clientRequestId: string;
  categoryId: string;
  scopeId: string | null;
  spentOn: string;
  amountMinor: number;
  invoiceNumber: string;
  sellerTaxId: string;
  description: string;
}

function validCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * 先驗證、再上傳照片：照片寫進 R2 之後才發現欄位錯，就得回頭刪檔。
 * 同一個發票號碼已經報過時預設擋下並回 `duplicate_invoice`，送件人確認後帶 confirmDuplicate 重送；
 * 不直接拒絕，因為一張發票可能拆給兩個人報。
 */
export async function prepareMyExpense(db: Database, userId: string, input: MyExpenseInput, now: Date = new Date()): Promise<PreparedExpense> {
  const submitter = await resolveExpenseSubmitter(db, userId);
  if (!/^[A-Za-z0-9-]{8,100}$/.test(input.clientRequestId)) throw new AccountingError(400, "送件識別碼格式不正確，請重新整理後再送一次。");
  if (input.receiptCount > EXPENSE_RECEIPT_MAX_FILES) throw new AccountingError(400, `單據照片最多 ${EXPENSE_RECEIPT_MAX_FILES} 張。`);
  if (!validCalendarDate(input.spentOn)) throw new AccountingError(400, "請選擇有效的消費日期。");
  const today = formatTaipeiDate(now);
  if (input.spentOn > today) throw new AccountingError(400, "消費日期不能晚於今天。");
  const earliest = earliestExpenseDate(today);
  if (input.spentOn < earliest) throw new AccountingError(400, `消費日期只能是 ${EXPENSE_SPENT_ON_MAX_AGE_DAYS} 天內（${earliest} 以後）；更早的單據請直接找會計。`);
  if (!Number.isSafeInteger(input.amountDollars) || input.amountDollars < 1 || input.amountDollars > EXPENSE_AMOUNT_MAX_DOLLARS) {
    throw new AccountingError(400, `金額必須是 1～${EXPENSE_AMOUNT_MAX_DOLLARS.toLocaleString("zh-TW")} 的整數元。`);
  }
  const invoiceNumber = normalizeInvoiceNumber(input.invoiceNumber);
  if (invoiceNumber && !INVOICE_NUMBER_PATTERN.test(invoiceNumber)) throw new AccountingError(400, "發票號碼應為兩個英文字母加八位數字，例如 AB12345678。");
  // 有發票號碼的會計查得到；收據沒有號碼，照片是唯一的憑證，所以一定要附。
  if (!invoiceNumber && input.receiptCount < 1) throw new AccountingError(400, "沒有發票號碼時，請附上收據照片。");
  const sellerTaxId = input.sellerTaxId.trim();
  if (sellerTaxId && !SELLER_TAX_ID_PATTERN.test(sellerTaxId)) throw new AccountingError(400, "賣方統編應為八位數字。");
  const description = input.description.trim();
  if (!description || description.length > EXPENSE_DESCRIPTION_MAX) throw new AccountingError(400, `用途說明必須是 1～${EXPENSE_DESCRIPTION_MAX} 字。`);

  const [category] = await db.select({ id: accountingExpenseCategories.id }).from(accountingExpenseCategories)
    .where(and(eq(accountingExpenseCategories.id, input.categoryId), isNull(accountingExpenseCategories.archivedAt))).limit(1);
  if (!category) throw new AccountingError(400, "請選擇有效的支出類別。");
  if (input.scopeId !== null) {
    const stores = await listHrScopes(db);
    if (!stores.some((store) => store.id === input.scopeId)) throw new AccountingError(400, "請選擇有效的店別。");
  }
  if (invoiceNumber && !input.confirmDuplicate) {
    const [duplicate] = await db.select({ id: accountingExpenses.id }).from(accountingExpenses)
      .where(and(eq(accountingExpenses.invoiceNumber, invoiceNumber), ne(accountingExpenses.status, "cancelled"),
        // 自己重送同一張（連按兩次）不算重複，交給 clientRequestId 處理。
        ne(accountingExpenses.clientRequestId, input.clientRequestId)))
      .limit(1);
    if (duplicate) throw new AccountingError(409, "這個發票號碼已經有人報過。確定要再報一次的話，請再按一次送出。", "duplicate_invoice");
  }
  return {
    submitter,
    clientRequestId: input.clientRequestId,
    categoryId: category.id,
    scopeId: input.scopeId,
    spentOn: input.spentOn,
    amountMinor: input.amountDollars * 100,
    invoiceNumber,
    sellerTaxId,
    description,
  };
}

export async function findMyExpenseByClientRequest(db: Database, userId: string, clientRequestId: string) {
  const [existing] = await db.select({ id: accountingExpenses.id }).from(accountingExpenses)
    .where(and(eq(accountingExpenses.submitterUserId, userId), eq(accountingExpenses.clientRequestId, clientRequestId))).limit(1);
  return existing ?? null;
}

export interface StoredReceipt { id: string; objectKey: string; contentType: ExpenseReceiptType; byteSize: number }

/** 支出單與照片索引在同一個 batch 寫入；任何一筆失敗整批不留。有發票號碼時照片是選填的補充資料，可以一張都沒有。 */
export async function createMyExpense(db: Database, prepared: PreparedExpense, receipts: StoredReceipt[]) {
  const id = crypto.randomUUID();
  const now = toDbTimestamp();
  const expense = db.insert(accountingExpenses).values({
    id,
    payerKind: "employee_advance",
    submitterUserId: prepared.submitter.userId,
    employmentId: prepared.submitter.employmentId,
    clientRequestId: prepared.clientRequestId,
    categoryId: prepared.categoryId,
    scopeId: prepared.scopeId,
    spentOn: prepared.spentOn,
    amountMinor: prepared.amountMinor,
    invoiceNumber: prepared.invoiceNumber,
    sellerTaxId: prepared.sellerTaxId,
    description: prepared.description,
    createdAt: now,
    updatedAt: now,
  });
  if (!receipts.length) {
    await expense;
    return { id };
  }
  await db.batch([
    expense,
    db.insert(accountingExpenseReceipts).values(receipts.map((receipt, index) => ({
      id: receipt.id,
      expenseId: id,
      objectKey: receipt.objectKey,
      contentType: receipt.contentType,
      byteSize: receipt.byteSize,
      sortOrder: index,
      createdAt: now,
    }))),
  ]);
  return { id };
}

export interface MyExpense {
  id: string;
  status: ExpenseStatus;
  categoryName: string;
  scopeName: string | null;
  spentOn: string;
  amountMinor: number;
  invoiceNumber: string;
  sellerTaxId: string;
  description: string;
  payoutMethod: "direct" | "payroll" | null;
  /** 併入月薪的單掛在哪個月的薪資。 */
  payrollPeriodKey: string | null;
  reviewNote: string;
  revision: number;
  createdAt: string;
  receiptIds: string[];
}

export async function listMyExpenses(db: Database, userId: string): Promise<MyExpense[]> {
  // 新表只有一種時間格式，可以直接拿欄位排序。
  const rows = await db.select({
    id: accountingExpenses.id,
    // 併入月薪的單在那個月結帳後算已付款，跟會計那邊看到的一樣。
    status: effectiveExpenseStatus,
    categoryName: accountingExpenseCategories.name,
    scopeName: scopes.name,
    spentOn: accountingExpenses.spentOn,
    amountMinor: accountingExpenses.amountMinor,
    invoiceNumber: accountingExpenses.invoiceNumber,
    sellerTaxId: accountingExpenses.sellerTaxId,
    description: accountingExpenses.description,
    payoutMethod: accountingExpenses.payoutMethod,
    payrollPeriodKey,
    reviewNote: accountingExpenses.reviewNote,
    revision: accountingExpenses.revision,
    createdAt: accountingExpenses.createdAt,
  }).from(accountingExpenses)
    .innerJoin(accountingExpenseCategories, eq(accountingExpenseCategories.id, accountingExpenses.categoryId))
    .leftJoin(scopes, eq(scopes.id, accountingExpenses.scopeId))
    .where(eq(accountingExpenses.submitterUserId, userId))
    .orderBy(desc(accountingExpenses.createdAt), desc(accountingExpenses.id))
    .limit(200);
  if (!rows.length) return [];
  const receipts = await db.select({ id: accountingExpenseReceipts.id, expenseId: accountingExpenseReceipts.expenseId }).from(accountingExpenseReceipts)
    .where(inArray(accountingExpenseReceipts.expenseId, rows.map((row) => row.id)))
    .orderBy(asc(accountingExpenseReceipts.sortOrder));
  return rows.map((row) => ({ ...row, receiptIds: receipts.filter((receipt) => receipt.expenseId === row.id).map((receipt) => receipt.id) }));
}

/** 只有待審的單可以撤回；已經被會計處理的，畫面上不會出現撤回鈕，API 也擋。 */
export async function cancelMyExpense(db: Database, userId: string, id: string, expectedRevision: number) {
  const updated = await db.update(accountingExpenses)
    .set({ status: "cancelled", revision: expectedRevision + 1, updatedAt: toDbTimestamp() })
    .where(and(eq(accountingExpenses.id, id), eq(accountingExpenses.submitterUserId, userId), eq(accountingExpenses.status, "pending"), eq(accountingExpenses.revision, expectedRevision)))
    .returning({ id: accountingExpenses.id });
  if (updated.length) return { id };
  const [current] = await db.select({ status: accountingExpenses.status }).from(accountingExpenses)
    .where(and(eq(accountingExpenses.id, id), eq(accountingExpenses.submitterUserId, userId))).limit(1);
  if (!current) throw new AccountingError(404, "找不到這張報帳單。");
  throw new AccountingError(409, current.status === "pending" ? "這張報帳單剛被更新，請重新整理後再試。" : "這張報帳單已經不是待審核，無法撤回。");
}

export async function findMyExpenseReceipt(db: Database, userId: string, expenseId: string, receiptId: string) {
  const [receipt] = await db.select({ objectKey: accountingExpenseReceipts.objectKey, contentType: accountingExpenseReceipts.contentType })
    .from(accountingExpenseReceipts)
    .innerJoin(accountingExpenses, eq(accountingExpenses.id, accountingExpenseReceipts.expenseId))
    .where(and(eq(accountingExpenseReceipts.id, receiptId), eq(accountingExpenseReceipts.expenseId, expenseId), eq(accountingExpenses.submitterUserId, userId)))
    .limit(1);
  return receipt ?? null;
}
