import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { AccountingError, validateExpenseFields, type ExpenseFields, type StoredReceipt } from "./accounting-expenses.js";
import { guardedWrite, notSubmittedBy, type AccountingActor } from "./accounting-review.js";
import { toDbTimestamp } from "./db-timestamp.js";
import { activityEvents } from "./schema/activity.js";
import { accountingExpenseCategories, accountingExpenseReceipts, accountingExpenses } from "./schema/accounting.js";
import { users } from "./schema/auth.js";
import { HR_NOTIFICATION_BODY_LIMIT } from "./schema/hr-requests.js";
import { jsonArrayValues } from "./sql-lists.js";

/*
 * 待審核的報帳可以改：送件人自己改（可以增刪照片），會計也能改（只改文字欄位、不動照片）。
 * 規格見 docs/accounting-prd.md 第 3 節「要處理的狀態」。
 *
 * 每次修改都留一筆 activity_events（event_type `expense_edited`），payload 帶 `changes: [{ field, label, from, to }]`，
 * from／to 存成畫面上看得懂的字（「NT$ 350」、類別名稱），不另開資料表：紀錄只追加、不改，跟其他操作紀錄同一個地方。
 * 修改是版本條件式 UPDATE（還在待審、版本對），紀錄、照片增刪與通知跟它在同一個 D1 batch，被別人搶先處理就什麼都不寫。
 */

export interface ExpenseEditInput {
  categoryId: string;
  spentOn: string;
  amountDollars: number;
  invoiceNumber: string;
  sellerTaxId: string;
  description: string;
  confirmDuplicate: boolean;
}

export interface ExpenseChange { field: string; label: string; from: string; to: string }

type Editor = "submitter" | "reviewer";

interface PendingExpense {
  id: string;
  submitterUserId: string | null;
  payerKind: "employee_advance" | "company";
  source: "platform" | "line";
  status: string;
  revision: number;
  clientRequestId: string;
  categoryId: string;
  categoryName: string;
  scopeId: string | null;
  spentOn: string;
  amountMinor: number;
  invoiceNumber: string;
  sellerTaxId: string;
  description: string;
  receipts: { id: string; objectKey: string; sortOrder: number }[];
}

export interface PreparedExpenseEdit {
  current: PendingExpense;
  editor: Editor;
  fields: ExpenseFields;
  changes: ExpenseChange[];
  removedReceipts: { id: string; objectKey: string }[];
  addCount: number;
}

function dollars(amountMinor: number) {
  return `NT$ ${(amountMinor / 100).toLocaleString("zh-TW")}`;
}

async function loadExpense(db: Database, id: string): Promise<PendingExpense | null> {
  const [row] = await db.select({
    id: accountingExpenses.id,
    submitterUserId: accountingExpenses.submitterUserId,
    payerKind: accountingExpenses.payerKind,
    source: accountingExpenses.source,
    status: accountingExpenses.status,
    revision: accountingExpenses.revision,
    clientRequestId: accountingExpenses.clientRequestId,
    categoryId: accountingExpenses.categoryId,
    categoryName: accountingExpenseCategories.name,
    scopeId: accountingExpenses.scopeId,
    spentOn: accountingExpenses.spentOn,
    amountMinor: accountingExpenses.amountMinor,
    invoiceNumber: accountingExpenses.invoiceNumber,
    sellerTaxId: accountingExpenses.sellerTaxId,
    description: accountingExpenses.description,
  }).from(accountingExpenses)
    .innerJoin(accountingExpenseCategories, eq(accountingExpenseCategories.id, accountingExpenses.categoryId))
    .where(eq(accountingExpenses.id, id)).limit(1);
  if (!row) return null;
  const receipts = await db.select({ id: accountingExpenseReceipts.id, objectKey: accountingExpenseReceipts.objectKey, sortOrder: accountingExpenseReceipts.sortOrder })
    .from(accountingExpenseReceipts).where(eq(accountingExpenseReceipts.expenseId, id)).orderBy(asc(accountingExpenseReceipts.sortOrder));
  return { ...row, receipts };
}

async function categoryName(db: Database, id: string, fallback: string) {
  const [row] = await db.select({ name: accountingExpenseCategories.name }).from(accountingExpenseCategories).where(eq(accountingExpenseCategories.id, id)).limit(1);
  return row?.name ?? fallback;
}

async function diff(db: Database, current: PendingExpense, fields: ExpenseFields, receiptsBefore: number, receiptsAfter: number, receiptsReplaced: boolean): Promise<ExpenseChange[]> {
  const changes: ExpenseChange[] = [];
  const push = (field: string, label: string, from: string, to: string) => { if (from !== to) changes.push({ field, label, from, to }); };
  push("spentOn", "消費日期", current.spentOn, fields.spentOn);
  push("amount", "金額", dollars(current.amountMinor), dollars(fields.amountMinor));
  if (current.categoryId !== fields.categoryId) push("category", "類別", current.categoryName, await categoryName(db, fields.categoryId, fields.categoryId));
  push("invoiceNumber", "發票號碼", current.invoiceNumber || "—", fields.invoiceNumber || "—");
  push("sellerTaxId", "賣方統編", current.sellerTaxId || "—", fields.sellerTaxId || "—");
  push("description", "用途", current.description, fields.description);
  if (receiptsReplaced) changes.push({ field: "receipts", label: "單據照片", from: `${receiptsBefore} 張`, to: receiptsBefore === receiptsAfter ? `${receiptsAfter} 張（已更換）` : `${receiptsAfter} 張` });
  return changes;
}

async function prepare(db: Database, current: PendingExpense, editor: Editor, input: ExpenseEditInput, receiptPlan: { removeIds: string[]; addCount: number }): Promise<PreparedExpenseEdit> {
  if (current.status !== "pending") throw new AccountingError(409, "這張報帳單已經不是待審核，不能修改。");
  const removeIds = [...new Set(receiptPlan.removeIds)];
  const removedReceipts = current.receipts.filter((receipt) => removeIds.includes(receipt.id));
  if (removedReceipts.length !== removeIds.length) throw new AccountingError(400, "要移除的照片不在這張報帳單上，請重新整理。");
  const receiptCount = current.receipts.length - removedReceipts.length + receiptPlan.addCount;
  const fields = await validateExpenseFields(db, {
    ...input,
    clientRequestId: current.clientRequestId,
    // 員工報帳不問店別；會計登記公司支出才有，這裡照原本的。
    scopeId: current.scopeId,
    receiptCount,
  }, { tooOldHint: editor === "submitter" ? "；更早的單據請直接找會計。" : "。", excludeExpenseId: current.id, keepCategoryId: current.categoryId,
    // LINE 送件本來就不收照片，改內容時也不要求補照片。
    receiptOptional: current.source === "line" });
  const changes = await diff(db, current, fields, current.receipts.length, receiptCount, removedReceipts.length > 0 || receiptPlan.addCount > 0);
  return { current, editor, fields, changes, removedReceipts, addCount: receiptPlan.addCount };
}

/** 送件人改自己的單；照片要先驗證、上傳 R2 之後才寫資料庫，所以分成 prepare 與 save 兩步，跟送件同一個順序。 */
export async function prepareMyExpenseEdit(db: Database, userId: string, id: string, input: ExpenseEditInput, receiptPlan: { removeIds: string[]; addCount: number }) {
  const current = await loadExpense(db, id);
  if (!current || current.submitterUserId !== userId || current.payerKind !== "employee_advance") throw new AccountingError(404, "找不到這張報帳單。");
  return prepare(db, current, "submitter", input, receiptPlan);
}

/*
 * 會計改別人待審的單。自己的單不能改，跟「不能審自己的單」同一個道理：改完再請別人審，等於自己決定了內容。
 * 會計不動照片：照片是送件人提供的憑證。
 */
export async function updateExpenseForReview(db: Database, id: string, expectedRevision: number, input: ExpenseEditInput, actor: AccountingActor) {
  const current = await loadExpense(db, id);
  if (!current || current.payerKind !== "employee_advance") throw new AccountingError(404, "找不到這張報帳單。");
  if (current.submitterUserId === actor.id) throw new AccountingError(403, "不能修改自己的報帳單，請另一位會計或管理者處理。");
  const prepared = await prepare(db, current, "reviewer", input, { removeIds: [], addCount: 0 });
  return saveExpenseEdit(db, prepared, { actor, expectedRevision, addReceipts: [] });
}

/**
 * 寫入修改。沒有任何變動就不寫（不留空紀錄、不發通知），回 changed: false。
 * 回傳 removedObjectKeys：資料庫成功後，呼叫端再去 R2 刪掉那些照片檔。
 */
export async function saveExpenseEdit(db: Database, prepared: PreparedExpenseEdit, options: { actor: AccountingActor; expectedRevision: number; addReceipts: StoredReceipt[] }) {
  const { current, fields, changes, editor } = prepared;
  if (!changes.length) return { id: current.id, changed: false, removedObjectKeys: [] as string[] };
  const nextRevision = options.expectedRevision + 1;
  const now = toDbTimestamp();
  const conditions = [
    eq(accountingExpenses.id, current.id),
    eq(accountingExpenses.status, "pending"),
    eq(accountingExpenses.revision, options.expectedRevision),
    editor === "submitter" ? eq(accountingExpenses.submitterUserId, options.actor.id) : notSubmittedBy(options.actor.id),
  ];
  const edited = sql`EXISTS (SELECT 1 FROM accounting_expenses WHERE accounting_expenses.id = ${current.id} AND accounting_expenses.status = 'pending' AND accounting_expenses.revision = ${nextRevision})`;
  const after: SQL[] = [];
  if (prepared.removedReceipts.length) {
    after.push(sql`DELETE FROM accounting_expense_receipts WHERE expense_id = ${current.id} AND id IN (${jsonArrayValues(prepared.removedReceipts.map((receipt) => receipt.id))}) AND ${edited}`);
  }
  const nextSort = current.receipts.reduce((max, receipt) => Math.max(max, receipt.sortOrder), -1) + 1;
  options.addReceipts.forEach((receipt, index) => {
    after.push(sql`INSERT INTO accounting_expense_receipts (id, expense_id, object_key, content_type, byte_size, sort_order, created_at)
      SELECT ${receipt.id}, ${current.id}, ${receipt.objectKey}, ${receipt.contentType}, ${receipt.byteSize}, ${nextSort + index}, ${now} WHERE ${edited}`);
  });
  if (editor === "reviewer") {
    const summary = changes.map((change) => `${change.label} ${change.from} → ${change.to}`).join("；");
    const body = `${dollars(fields.amountMinor)}・${fields.description}\n${summary}`.slice(0, HR_NOTIFICATION_BODY_LIMIT);
    // source_key 帶版本：同一張單可能被改好幾次，每次都要通知，不能被 ON CONFLICT 吃掉。
    after.push(sql`INSERT INTO hr_notifications (id, user_id, source_key, kind, entity_kind, entity_id, title, body)
      SELECT ${crypto.randomUUID()}, submitter_user_id, ${`expense:${current.id}:edited:${nextRevision}`}, 'request_reviewed', 'expense', id, '會計修改了你的報帳', ${body}
      FROM accounting_expenses WHERE accounting_expenses.id = ${current.id} AND accounting_expenses.status = 'pending' AND accounting_expenses.revision = ${nextRevision}
        AND accounting_expenses.submitter_user_id IS NOT NULL
      ON CONFLICT(source_key) DO NOTHING`);
  }
  const event = activityRow({
    entityType: "accounting_expense", entityId: current.id, source: editor === "submitter" ? "hr" : "accounting",
    eventType: "expense_edited", summary: editor === "submitter" ? "送件人修改報帳" : "會計修改報帳", actor: options.actor,
    payload: { editor, changes },
  });
  const changed = await guardedWrite(db, db.update(accountingExpenses).set({
    categoryId: fields.categoryId,
    spentOn: fields.spentOn,
    amountMinor: fields.amountMinor,
    invoiceNumber: fields.invoiceNumber,
    sellerTaxId: fields.sellerTaxId,
    description: fields.description,
    revision: nextRevision,
    updatedAt: now,
  }).where(and(...conditions)).returning({ id: accountingExpenses.id }), event, now, { after });
  if (!changed) throw new AccountingError(409, "這張報帳單剛被處理或修改過，請重新整理後再試。");
  return { id: current.id, changed: true, removedObjectKeys: prepared.removedReceipts.map((receipt) => receipt.objectKey) };
}

export interface ExpenseEditRecord { id: string; at: string; editor: Editor; actorName: string; changes: ExpenseChange[] }

/** 修改紀錄。權限由路由把關：送件人看自己的單（/api/hr/me），會計看所有的（accounting:expense:read）。 */
export async function listExpenseEditHistory(db: Database, expenseId: string): Promise<ExpenseEditRecord[]> {
  const rows = await db.select({
    id: activityEvents.id,
    at: activityEvents.createdAt,
    payloadJson: activityEvents.payloadJson,
    actorName: sql<string>`coalesce(nullif(trim(${users.displayName}), ''), ${activityEvents.actorEmail}, '')`,
  }).from(activityEvents)
    .leftJoin(users, eq(users.id, activityEvents.actorId))
    .where(and(eq(activityEvents.entityType, "accounting_expense"), eq(activityEvents.entityId, expenseId), eq(activityEvents.eventType, "expense_edited")))
    .orderBy(asc(activityEvents.createdAt), asc(activityEvents.id));
  return rows.map((row) => {
    let payload: { editor?: Editor; changes?: ExpenseChange[] } = {};
    try { payload = JSON.parse(row.payloadJson) as typeof payload; } catch { /* 壞掉的 payload 當成沒有細節，不讓整份紀錄讀不出來 */ }
    return { id: row.id, at: row.at, editor: payload.editor === "reviewer" ? "reviewer" : "submitter", actorName: row.actorName, changes: Array.isArray(payload.changes) ? payload.changes : [] };
  });
}

/** 送件人讀自己單子的修改紀錄前先確認是他的單。 */
export async function isMyExpense(db: Database, userId: string, expenseId: string) {
  const [row] = await db.select({ id: accountingExpenses.id }).from(accountingExpenses)
    .where(and(eq(accountingExpenses.id, expenseId), eq(accountingExpenses.submitterUserId, userId), eq(accountingExpenses.payerKind, "employee_advance"))).limit(1);
  return Boolean(row);
}
