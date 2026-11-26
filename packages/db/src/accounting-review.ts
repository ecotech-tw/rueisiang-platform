import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { AccountingError } from "./accounting-expenses.js";
import type { ExpenseStatus } from "./accounting-expense-fields.js";
import { toDbTimestamp } from "./db-timestamp.js";
import { hrEmployeeName } from "./hr-people.js";
import { activityEvents } from "./schema/activity.js";
import { accountingExpenseCategories, accountingExpenseReceipts, accountingExpenses } from "./schema/accounting.js";
import { users } from "./schema/auth.js";
import { hrEmployments } from "./schema/hr-people.js";

/*
 * 報公帳的會計那一端：看所有報帳、核准、退回、標記撥款，以及維護支出類別。規格見 docs/accounting-prd.md。
 *
 * 權限由路由的 accounting:* 把關；這裡另外守住「不能審自己的單」，因為那是業務規則、不是權限——
 * 會計也是員工，也會報帳。只有一位會計時由管理者審（管理者有所有權限）。
 */

export interface AccountingActor { id: string; email: string }

const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });

/*
 * 一句 UPDATE 加一筆操作紀錄放同一個 D1 batch；紀錄用 `WHERE changes() > 0` 只在 UPDATE 真的改到列時才寫，
 * 沒改到（版本過期、狀態不對、自己的單）就什麼都不留。drizzle 的 batch 收不了這種手寫 SQL，所以直接用 D1 的
 * prepare／batch，跟 HR 的 writeHrMutation 同一種作法。回傳 UPDATE 改到的列數。
 *
 * followUps 接在紀錄後面（例如通知送件人）；changes() 這時已經是上一句 INSERT 的結果，所以它們要自己帶條件，
 * 用「轉換後的狀態與版本」確認 UPDATE 成功了才寫。
 */
async function guardedWrite(db: Database, mutation: { toSQL(): { sql: string; params: unknown[] } }, event: ReturnType<typeof activityRow>, now: string, followUps: ReturnType<typeof sql>[] = []) {
  const update = mutation.toSQL();
  const log = dialect.sqlToQuery(sql`INSERT INTO activity_events (id, entity_type, entity_id, entity_label, event_type, summary, source, actor_type, actor_id, actor_email, payload_json, created_at)
    SELECT ${event.id}, ${event.entityType}, ${event.entityId}, ${event.entityLabel}, ${event.eventType}, ${event.summary}, ${event.source}, ${event.actorType}, ${event.actorId}, ${event.actorEmail}, ${event.payloadJson}, ${now}
    WHERE changes() > 0`);
  const [result] = await db.$client.batch([
    db.$client.prepare(update.sql).bind(...update.params),
    db.$client.prepare(log.sql).bind(...log.params),
    ...followUps.map((followUp) => {
      const query = dialect.sqlToQuery(followUp);
      return db.$client.prepare(query.sql).bind(...query.params);
    }),
  ]);
  return result?.results?.length ?? 0;
}

export const REVIEW_STATUS_FILTERS = ["pending", "approved", "rejected", "paid", "cancelled", "all"] as const;
export type ReviewStatusFilter = typeof REVIEW_STATUS_FILTERS[number];

export interface ReviewExpense {
  id: string;
  status: ExpenseStatus;
  submitterUserId: string;
  submitterName: string;
  employeeNumber: string;
  categoryName: string;
  spentOn: string;
  amountMinor: number;
  invoiceNumber: string;
  sellerTaxId: string;
  description: string;
  payoutMethod: "direct" | "payroll" | null;
  reviewNote: string;
  reviewerName: string | null;
  reviewedAt: string | null;
  paidAt: string | null;
  revision: number;
  createdAt: string;
  receiptIds: string[];
  /** 同一個發票號碼還出現在幾張沒撤回的報帳單上；送件時只提醒、不擋，所以要在這裡讓會計看得到。 */
  duplicateInvoiceCount: number;
}

const reviewer = sql<string | null>`(SELECT coalesce(nullif(reviewer_user.display_name, ''), reviewer_user.email) FROM users AS reviewer_user WHERE reviewer_user.id = accounting_expenses.reviewer_user_id)`;
const duplicateCount = sql<number>`(SELECT count(*) FROM accounting_expenses AS other
  WHERE other.invoice_number = accounting_expenses.invoice_number AND other.invoice_number <> ''
    AND other.id <> accounting_expenses.id AND other.status <> 'cancelled')`;

export async function listExpensesForReview(db: Database, status: ReviewStatusFilter): Promise<ReviewExpense[]> {
  const rows = await db.select({
    id: accountingExpenses.id,
    status: accountingExpenses.status,
    submitterUserId: accountingExpenses.submitterUserId,
    submitterName: hrEmployeeName,
    employeeNumber: hrEmployments.employeeNumber,
    categoryName: accountingExpenseCategories.name,
    spentOn: accountingExpenses.spentOn,
    amountMinor: accountingExpenses.amountMinor,
    invoiceNumber: accountingExpenses.invoiceNumber,
    sellerTaxId: accountingExpenses.sellerTaxId,
    description: accountingExpenses.description,
    payoutMethod: accountingExpenses.payoutMethod,
    reviewNote: accountingExpenses.reviewNote,
    reviewerName: reviewer,
    reviewedAt: accountingExpenses.reviewedAt,
    paidAt: accountingExpenses.paidAt,
    revision: accountingExpenses.revision,
    createdAt: accountingExpenses.createdAt,
    duplicateInvoiceCount: duplicateCount,
  }).from(accountingExpenses)
    .innerJoin(accountingExpenseCategories, eq(accountingExpenseCategories.id, accountingExpenses.categoryId))
    .innerJoin(users, eq(users.id, accountingExpenses.submitterUserId))
    .leftJoin(hrEmployments, eq(hrEmployments.id, accountingExpenses.employmentId))
    .where(status === "all" ? undefined : eq(accountingExpenses.status, status))
    // 待審的照送件先後處理；其他狀態看最新的。新表只有一種時間格式，可以直接拿欄位排序。
    .orderBy(status === "pending" ? asc(accountingExpenses.createdAt) : desc(accountingExpenses.createdAt), asc(accountingExpenses.id))
    .limit(300);
  if (!rows.length) return [];
  const receipts = await db.select({ id: accountingExpenseReceipts.id, expenseId: accountingExpenseReceipts.expenseId }).from(accountingExpenseReceipts)
    .where(inArray(accountingExpenseReceipts.expenseId, rows.map((row) => row.id)))
    .orderBy(asc(accountingExpenseReceipts.sortOrder));
  return rows.map((row) => ({
    ...row,
    employeeNumber: row.employeeNumber ?? "",
    duplicateInvoiceCount: Number(row.duplicateInvoiceCount),
    receiptIds: receipts.filter((receipt) => receipt.expenseId === row.id).map((receipt) => receipt.id),
  }));
}

export async function findExpenseReceiptForReview(db: Database, expenseId: string, receiptId: string) {
  const [receipt] = await db.select({ objectKey: accountingExpenseReceipts.objectKey, contentType: accountingExpenseReceipts.contentType })
    .from(accountingExpenseReceipts)
    .where(and(eq(accountingExpenseReceipts.id, receiptId), eq(accountingExpenseReceipts.expenseId, expenseId)))
    .limit(1);
  return receipt ?? null;
}

/**
 * 狀態轉換只寫一句有條件的 UPDATE：狀態、版本、送件人都在 WHERE 裡，兩位會計同時按也只有一位會成功。
 * 沒更新到時再讀一次，講出是哪一種原因，會計才知道該重新整理還是別再按了。
 */
async function transition(db: Database, input: {
  id: string;
  expectedRevision: number;
  actor: AccountingActor;
  from: ExpenseStatus;
  set: Partial<typeof accountingExpenses.$inferInsert>;
  extraWhere?: ReturnType<typeof eq>;
  eventType: string;
  summary: string;
  /** 通知送件人：標題，以及接在「金額・用途」後面的一句話。 */
  notify: { event: string; title: string; detail: string };
}) {
  const now = toDbTimestamp();
  const conditions = [
    eq(accountingExpenses.id, input.id),
    eq(accountingExpenses.status, input.from),
    eq(accountingExpenses.revision, input.expectedRevision),
    ne(accountingExpenses.submitterUserId, input.actor.id),
    ...(input.extraWhere ? [input.extraWhere] : []),
  ];
  const event = activityRow({ entityType: "accounting_expense", entityId: input.id, source: "accounting", eventType: input.eventType, summary: input.summary, actor: input.actor });
  const nextStatus = input.set.status ?? input.from;
  // 通知在員工自助的「通知」裡；內文的金額與用途在 SQL 裡從支出單組出來，不必先讀一次。
  const notification = sql`INSERT INTO hr_notifications (id, user_id, source_key, kind, entity_kind, entity_id, title, body)
    SELECT ${crypto.randomUUID()}, submitter_user_id, ${`expense:${input.id}:${input.notify.event}`}, 'request_reviewed', 'expense', id, ${input.notify.title},
      substr('NT$ ' || printf('%,d', amount_minor / 100) || '・' || description || char(10) || ${input.notify.detail}, 1, 1000)
    FROM accounting_expenses WHERE id = ${input.id} AND revision = ${input.expectedRevision + 1} AND status = ${nextStatus}
    ON CONFLICT(source_key) DO NOTHING`;
  const changed = await guardedWrite(db, db.update(accountingExpenses).set({ ...input.set, revision: input.expectedRevision + 1, updatedAt: now })
    .where(and(...conditions)).returning({ id: accountingExpenses.id }), event, now, [notification]);
  if (changed) return { id: input.id };
  const [current] = await db.select({ status: accountingExpenses.status, revision: accountingExpenses.revision, submitterUserId: accountingExpenses.submitterUserId })
    .from(accountingExpenses).where(eq(accountingExpenses.id, input.id)).limit(1);
  if (!current) throw new AccountingError(404, "找不到這張報帳單。");
  if (current.submitterUserId === input.actor.id) throw new AccountingError(403, "不能審核自己的報帳單，請另一位會計或管理者處理。");
  if (current.status !== input.from || current.revision !== input.expectedRevision) throw new AccountingError(409, "這張報帳單剛被處理過，請重新整理後再確認。");
  throw new AccountingError(409, "這張報帳單目前不能這樣處理，請重新整理後再確認。");
}

/** 第一版只開放直接撥款；併入月薪要一起產生薪資加扣項，在下一批做。 */
export async function approveExpense(db: Database, id: string, expectedRevision: number, actor: AccountingActor) {
  return transition(db, {
    id, expectedRevision, actor, from: "pending",
    set: { status: "approved", payoutMethod: "direct", reviewerUserId: actor.id, reviewedAt: toDbTimestamp(), reviewNote: "" },
    eventType: "expense_approved", summary: "報帳核准（直接撥款）",
    notify: { event: "approved", title: "報帳已核准", detail: "會計審核通過，等待撥款。" },
  });
}

export async function rejectExpense(db: Database, id: string, expectedRevision: number, note: string, actor: AccountingActor) {
  const reason = note.trim();
  if (!reason || reason.length > 500) throw new AccountingError(400, "請寫退回原因（500 字以內），員工才知道要怎麼改。");
  return transition(db, {
    id, expectedRevision, actor, from: "pending",
    set: { status: "rejected", reviewerUserId: actor.id, reviewedAt: toDbTimestamp(), reviewNote: reason },
    eventType: "expense_rejected", summary: "報帳退回",
    notify: { event: "rejected", title: "報帳已退回", detail: `退回原因：${reason}` },
  });
}

/*
 * 撥款是會計轉帳之後回來標記；核准與撥款可以是同一位會計。仍然不讓人標記自己的單已撥款：
 * 錢是不是真的進了自己的帳戶，不該由自己說了算。
 */
export async function markExpensePaid(db: Database, id: string, expectedRevision: number, actor: AccountingActor) {
  return transition(db, {
    id, expectedRevision, actor, from: "approved",
    set: { status: "paid", paidAt: toDbTimestamp() },
    extraWhere: eq(accountingExpenses.payoutMethod, "direct"),
    eventType: "expense_paid", summary: "報帳已撥款",
    notify: { event: "paid", title: "報帳已撥款", detail: "會計已經轉帳，請留意帳戶。" },
  });
}

export interface ExpenseCategory { id: string; name: string; sortOrder: number; archived: boolean; expenseCount: number }

export async function listExpenseCategories(db: Database): Promise<ExpenseCategory[]> {
  const rows = await db.select({
    id: accountingExpenseCategories.id,
    name: accountingExpenseCategories.name,
    sortOrder: accountingExpenseCategories.sortOrder,
    archivedAt: accountingExpenseCategories.archivedAt,
    // 寫完整表名：單表查詢裡 drizzle 不替欄位加表名，子查詢會把 id 當成 accounting_expenses 自己的欄位。
    expenseCount: sql<number>`(SELECT count(*) FROM accounting_expenses WHERE accounting_expenses.category_id = accounting_expense_categories.id)`,
  }).from(accountingExpenseCategories)
    .orderBy(asc(accountingExpenseCategories.sortOrder), asc(accountingExpenseCategories.name));
  return rows.map(({ archivedAt, ...row }) => ({ ...row, archived: archivedAt !== null, expenseCount: Number(row.expenseCount) }));
}

function categoryName(value: string) {
  const name = value.trim();
  if (!name || name.length > 50) throw new AccountingError(400, "類別名稱必須是 1～50 字。");
  return name;
}

function isUniqueViolation(error: unknown) {
  for (let cause: unknown = error, depth = 0; depth < 5 && cause instanceof Error; depth += 1, cause = cause.cause) {
    if (/UNIQUE constraint failed/.test(cause.message)) return true;
  }
  return false;
}

export async function createExpenseCategory(db: Database, input: { name: string; sortOrder: number }, actor: AccountingActor) {
  const name = categoryName(input.name);
  const id = `expense-category-${crypto.randomUUID()}`;
  try {
    await db.batch([
      db.insert(accountingExpenseCategories).values({ id, name, sortOrder: input.sortOrder }),
      db.insert(activityEvents).values(activityRow({ entityType: "accounting_expense_category", entityId: id, entityLabel: name, source: "accounting", eventType: "expense_category_created", summary: "新增支出類別", actor })),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new AccountingError(409, "已經有同名的類別。");
    throw error;
  }
  return { id };
}

/** 類別不能刪：舊的支出單指著它。不用的就停用，員工送件時選不到，歷史照樣看得到名稱。 */
export async function updateExpenseCategory(db: Database, id: string, input: { name: string; sortOrder: number; archived: boolean }, actor: AccountingActor) {
  const name = categoryName(input.name);
  const now = toDbTimestamp();
  try {
    const changed = await guardedWrite(db, db.update(accountingExpenseCategories).set({
      name,
      sortOrder: input.sortOrder,
      archivedAt: input.archived ? sql`coalesce(${accountingExpenseCategories.archivedAt}, ${now})` : null,
      updatedAt: now,
    }).where(eq(accountingExpenseCategories.id, id)).returning({ id: accountingExpenseCategories.id }),
    activityRow({ entityType: "accounting_expense_category", entityId: id, entityLabel: name, source: "accounting", eventType: "expense_category_updated", summary: input.archived ? "支出類別已停用" : "支出類別已更新", actor }), now);
    if (!changed) throw new AccountingError(404, "找不到這個類別。");
  } catch (error) {
    if (isUniqueViolation(error)) throw new AccountingError(409, "已經有同名的類別。");
    throw error;
  }
  return { id };
}
