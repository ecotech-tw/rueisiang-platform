import { and, asc, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { AccountingError } from "./accounting-expenses.js";
import { payrollPeriodLabel, type ExpenseStatus } from "./accounting-expense-fields.js";
import { effectiveExpenseStatus, linkedAdjustmentEditable, payrollCandidateMonths, payrollEmploymentActive, payrollOption, payrollPeriodEditable, payrollPeriodKey } from "./accounting-payroll.js";
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
 * before 排在 UPDATE 前面（例如先建好加扣項，UPDATE 才指得到它），它們自己要帶「這張單還能轉換」的條件；
 * after 接在紀錄後面（例如通知送件人），changes() 這時已經是上一句 INSERT 的結果，所以它們要用
 * 「轉換後的狀態與版本」確認 UPDATE 成功了才寫。整批是同一個 transaction，任何一句失敗就全部不算。
 */
async function guardedWrite(db: Database, mutation: { toSQL(): { sql: string; params: unknown[] } }, event: ReturnType<typeof activityRow>, now: string, steps: { before?: SQL[]; after?: SQL[] } = {}) {
  const update = mutation.toSQL();
  const prepare = (statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    return db.$client.prepare(query.sql).bind(...query.params);
  };
  const before = steps.before ?? [];
  const log = dialect.sqlToQuery(sql`INSERT INTO activity_events (id, entity_type, entity_id, entity_label, event_type, summary, source, actor_type, actor_id, actor_email, payload_json, created_at)
    SELECT ${event.id}, ${event.entityType}, ${event.entityId}, ${event.entityLabel}, ${event.eventType}, ${event.summary}, ${event.source}, ${event.actorType}, ${event.actorId}, ${event.actorEmail}, ${event.payloadJson}, ${now}
    WHERE changes() > 0`);
  const results = await db.$client.batch([
    ...before.map(prepare),
    db.$client.prepare(update.sql).bind(...update.params),
    db.$client.prepare(log.sql).bind(...log.params),
    ...(steps.after ?? []).map(prepare),
  ]);
  return results[before.length]?.results?.length ?? 0;
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
  /** 併入月薪的單掛在哪個月的薪資。 */
  payrollPeriodKey: string | null;
  /** 待審的單現在核准、選併入月薪的話會掛在哪個月；null 就是只能直接撥款。 */
  payrollOption: string | null;
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
    status: effectiveExpenseStatus,
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
    payrollPeriodKey,
    payrollOption: payrollOption(payrollCandidateMonths()),
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
    // 照推導後的狀態篩：已隨月薪發放的單在資料庫裡還是 approved，但要出現在「已付款」。
    .where(status === "all" ? undefined : sql`${effectiveExpenseStatus} = ${status}`)
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
  extraWhere?: SQL;
  before?: SQL[];
  after?: SQL[];
  eventType: string;
  summary: string;
  payload?: Record<string, unknown>;
  /** 狀態、版本都對卻沒改到時（extraWhere 擋下）要講的原因。 */
  blockedMessage?: string;
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
  const event = activityRow({ entityType: "accounting_expense", entityId: input.id, source: "accounting", eventType: input.eventType, summary: input.summary, actor: input.actor, ...(input.payload ? { payload: input.payload } : {}) });
  const nextStatus = input.set.status ?? input.from;
  // 通知在員工自助的「通知」裡；內文的金額與用途在 SQL 裡從支出單組出來，不必先讀一次。
  const notification = sql`INSERT INTO hr_notifications (id, user_id, source_key, kind, entity_kind, entity_id, title, body)
    SELECT ${crypto.randomUUID()}, submitter_user_id, ${`expense:${input.id}:${input.notify.event}`}, 'request_reviewed', 'expense', id, ${input.notify.title},
      substr('NT$ ' || printf('%,d', amount_minor / 100) || '・' || description || char(10) || ${input.notify.detail}, 1, 1000)
    FROM accounting_expenses WHERE id = ${input.id} AND revision = ${input.expectedRevision + 1} AND status = ${nextStatus}
    ON CONFLICT(source_key) DO NOTHING`;
  const changed = await guardedWrite(db, db.update(accountingExpenses).set({ ...input.set, revision: input.expectedRevision + 1, updatedAt: now })
    .where(and(...conditions)).returning({ id: accountingExpenses.id }), event, now, { before: input.before ?? [], after: [notification, ...(input.after ?? [])] });
  if (changed) return { id: input.id };
  const [current] = await db.select({ status: accountingExpenses.status, revision: accountingExpenses.revision, submitterUserId: accountingExpenses.submitterUserId })
    .from(accountingExpenses).where(eq(accountingExpenses.id, input.id)).limit(1);
  if (!current) throw new AccountingError(404, "找不到這張報帳單。");
  if (current.submitterUserId === input.actor.id) throw new AccountingError(403, "不能審核自己的報帳單，請另一位會計或管理者處理。");
  if (current.status !== input.from || current.revision !== input.expectedRevision) throw new AccountingError(409, "這張報帳單剛被處理過，請重新整理後再確認。");
  throw new AccountingError(409, input.blockedMessage ?? "這張報帳單目前不能這樣處理，請重新整理後再確認。");
}

export type ExpensePayout = { method: "direct" } | { method: "payroll"; periodKey: string };

/*
 * 從報帳產生或拿掉的加扣項，也在 HRIS 的人事紀錄（hr_personnel，跟 HRIS 自己新增、刪除加扣項同一種）留一筆，
 * HR 查加扣項的來龍去脈時不必跑去會計那邊找。跟通知一樣接在 batch 後面，用轉換後的狀態與版本確認支出單真的改了才寫。
 */
function hrAdjustmentLog(input: { adjustmentId: string; expenseId: string; status: ExpenseStatus; revision: number; actor: AccountingActor; eventType: string; summary: string; payload: Record<string, unknown> }) {
  const row = activityRow({ entityType: "hr_personnel", entityId: input.adjustmentId, source: "accounting", eventType: input.eventType, summary: input.summary, actor: input.actor, payload: { ...input.payload, expenseId: input.expenseId } });
  return sql`INSERT INTO activity_events (id, entity_type, entity_id, entity_label, event_type, summary, source, actor_type, actor_id, actor_email, payload_json)
    SELECT ${row.id}, ${row.entityType}, ${row.entityId}, ${row.entityLabel}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail}, ${row.payloadJson}
    WHERE EXISTS (SELECT 1 FROM accounting_expenses WHERE accounting_expenses.id = ${input.expenseId} AND accounting_expenses.status = ${input.status} AND accounting_expenses.revision = ${input.revision})`;
}

/*
 * 併入月薪：同一個 batch 先建加扣項（項目「代墊款」，金額照支出單），再把支出單指過去。
 * 加扣項的 INSERT 自己帶「這張單還待審、不是自己的、這個人在職、這個月還沒結帳」，UPDATE 再要求加扣項存在；
 * 任何一個條件不成立就兩邊都不寫，不會留下沒有支出單的加扣項。
 *
 * 月份由會計在畫面上看到的那個值送來（清單的 payrollOption），伺服器只接受候選月份，
 * 掛不上就請他重新整理，不偷偷改掛別的月——錢會在哪個月發，要是會計看過的那個月。
 */
export async function approveExpense(db: Database, id: string, expectedRevision: number, actor: AccountingActor, payout: ExpensePayout = { method: "direct" }) {
  const reviewed = { status: "approved" as const, reviewerUserId: actor.id, reviewedAt: toDbTimestamp(), reviewNote: "" };
  if (payout.method === "direct") {
    return transition(db, {
      id, expectedRevision, actor, from: "pending",
      set: { ...reviewed, payoutMethod: "direct" },
      eventType: "expense_approved", summary: "報帳核准（直接撥款）",
      notify: { event: "approved", title: "報帳已核准", detail: "會計審核通過，等待撥款。" },
    });
  }
  const { periodKey } = payout;
  if (!payrollCandidateMonths().includes(periodKey)) throw new AccountingError(409, "可以併入的薪資月份變了，請重新整理後再核准。");
  const adjustmentId = crypto.randomUUID();
  const label = payrollPeriodLabel(periodKey);
  const adjustmentExists = sql`EXISTS (SELECT 1 FROM hr_payroll_adjustments WHERE hr_payroll_adjustments.id = ${adjustmentId})`;
  const createAdjustment = sql`INSERT INTO hr_payroll_adjustments (id, employment_id, effective_period_key, reason, created_by, updated_by)
    SELECT ${adjustmentId}, accounting_expenses.employment_id, ${periodKey}, substr('報帳代墊款：' || accounting_expenses.description, 1, 1000), ${actor.id}, ${actor.id}
    FROM accounting_expenses
    WHERE accounting_expenses.id = ${id} AND accounting_expenses.status = 'pending' AND accounting_expenses.revision = ${expectedRevision}
      AND accounting_expenses.submitter_user_id <> ${actor.id} AND ${payrollEmploymentActive} AND ${payrollPeriodEditable(periodKey)}`;
  const createItem = sql`INSERT INTO hr_payroll_adjustment_items (id, adjustment_id, item_name, amount_minor)
    SELECT ${crypto.randomUUID()}, ${adjustmentId}, '代墊款', accounting_expenses.amount_minor FROM accounting_expenses
    WHERE accounting_expenses.id = ${id} AND ${adjustmentExists}`;
  return transition(db, {
    id, expectedRevision, actor, from: "pending",
    set: { ...reviewed, payoutMethod: "payroll", payrollAdjustmentId: adjustmentId },
    extraWhere: adjustmentExists,
    before: [createAdjustment, createItem],
    after: [hrAdjustmentLog({
      adjustmentId, expenseId: id, status: "approved", revision: expectedRevision + 1, actor,
      eventType: "payroll_adjustment_created", summary: "薪資加扣項建立（報帳代墊款）", payload: { effectivePeriodKey: periodKey },
    })],
    eventType: "expense_approved", summary: `報帳核准（併入 ${label}薪資）`,
    payload: { payoutMethod: "payroll", periodKey, payrollAdjustmentId: adjustmentId },
    notify: { event: "approved", title: "報帳已核准", detail: `會併入 ${label}的薪資一起發。` },
    blockedMessage: `${label}這個人的薪資已經結帳，或任職資料已封存，請重新整理後再選。`,
  });
}

/*
 * 待審的直接退回。已核准、還沒付出去的也能退回（核准錯了、金額要改）：直接撥款的還沒轉帳；
 * 併入月薪的要那個月這個人還沒結帳，同一個 batch 把加扣項拿掉。已付款（含已隨月薪發放）的不能退回，只能沖銷。
 */
export async function rejectExpense(db: Database, id: string, expectedRevision: number, note: string, actor: AccountingActor) {
  const reason = note.trim();
  if (!reason || reason.length > 500) throw new AccountingError(400, "請寫退回原因（500 字以內），員工才知道要怎麼改。");
  const [current] = await db.select({ status: accountingExpenses.status, payrollAdjustmentId: accountingExpenses.payrollAdjustmentId })
    .from(accountingExpenses).where(eq(accountingExpenses.id, id)).limit(1);
  const base = {
    id, expectedRevision, actor,
    eventType: "expense_rejected", summary: "報帳退回",
    notify: { event: "rejected", title: "報帳已退回", detail: `退回原因：${reason}` },
  };
  const rejected = { status: "rejected" as const, reviewerUserId: actor.id, reviewedAt: toDbTimestamp(), reviewNote: reason };
  if (current?.status !== "approved") return transition(db, { ...base, from: "pending", set: rejected });
  const adjustmentId = current.payrollAdjustmentId;
  if (!adjustmentId) return transition(db, { ...base, from: "approved", set: rejected, extraWhere: eq(accountingExpenses.payoutMethod, "direct") });
  const nowRejected = sql`EXISTS (SELECT 1 FROM accounting_expenses WHERE accounting_expenses.id = ${id} AND accounting_expenses.status = 'rejected' AND accounting_expenses.revision = ${expectedRevision + 1})`;
  return transition(db, {
    ...base, from: "approved",
    // 先放開支出單的指向，外鍵 RESTRICT 才讓加扣項刪得掉。
    set: { ...rejected, payrollAdjustmentId: null },
    extraWhere: and(eq(accountingExpenses.payrollAdjustmentId, adjustmentId), linkedAdjustmentEditable),
    after: [
      hrAdjustmentLog({
        adjustmentId, expenseId: id, status: "rejected", revision: expectedRevision + 1, actor,
        eventType: "payroll_adjustment_deleted", summary: "薪資加扣項已刪除（報帳退回）", payload: { reason },
      }),
      sql`DELETE FROM hr_payroll_adjustment_items WHERE adjustment_id = ${adjustmentId} AND ${nowRejected}`,
      sql`DELETE FROM hr_payroll_adjustments WHERE id = ${adjustmentId} AND ${nowRejected}`,
    ],
    payload: { removedPayrollAdjustmentId: adjustmentId },
    blockedMessage: "這筆已經隨月薪結帳，不能退回。",
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
