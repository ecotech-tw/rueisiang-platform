import { desc, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Database } from "./client.js";
import { AccountingError } from "./accounting-expenses.js";
import { toDbTimestamp } from "./db-timestamp.js";
import { accountingExpenses, accountingPettyCashEntries } from "./schema/accounting.js";
import { users } from "./schema/auth.js";

/*
 * 零用金：全公司一個錢箱。規格見 docs/accounting-prd.md 第 3 節「零用金」。
 *
 * 餘額就是 accounting_petty_cash_entries 的總和，不另存一個「目前餘額」欄位——存兩份就會有對不上的一天。
 * 會扣錢的寫入（撥款）用條件式 INSERT：「餘額夠」寫在同一句的 WHERE 裡，D1 的 batch 是依序執行的，
 * 兩個會計同時按也不會扣成負數；0264 的 trigger 是最後一道保險。
 */

export const PETTY_CASH_SHORT_MESSAGE = "零用金餘額不足，請先增加零用金。";
/** 一次增加的上限；打錯多一個 0 時擋得下來。 */
const PETTY_CASH_MAX_DOLLARS = 10_000_000;

export const pettyCashBalance = sql<number>`(SELECT coalesce(sum(petty_balance.amount_minor), 0) FROM accounting_petty_cash_entries AS petty_balance)`;

/** 這張報帳單目前從零用金付出去多少：撥款加退回，0 或負數。 */
function expenseNet(expenseId: string) {
  return sql`(SELECT coalesce(sum(petty_net.amount_minor), 0) FROM accounting_petty_cash_entries AS petty_net WHERE petty_net.expense_id = ${expenseId})`;
}

/**
 * 從零用金付一張報帳單。guard 是「這張單還能轉換」的條件（寫完整表名 accounting_expenses.*），
 * 跟「餘額夠」一起放在 WHERE 裡；任一條件不成立就不寫，呼叫端的 UPDATE 再要求這筆紀錄存在。
 */
export function pettyCashPayout(entryId: string, guard: SQL, actorId: string) {
  return sql`INSERT INTO accounting_petty_cash_entries (id, kind, amount_minor, expense_id, actor_user_id)
    SELECT ${entryId}, 'payout', -accounting_expenses.amount_minor, accounting_expenses.id, ${actorId}
    FROM accounting_expenses WHERE ${guard} AND ${pettyCashBalance} >= accounting_expenses.amount_minor`;
}

export function pettyCashEntryExists(entryId: string) {
  return sql`EXISTS (SELECT 1 FROM accounting_petty_cash_entries WHERE accounting_petty_cash_entries.id = ${entryId})`;
}

/**
 * 已付款退回待撥款時把錢退回零用金：退的是這張單目前淨付出的金額，所以退過一次就不會再退。
 * 沒有從零用金付過的（零用金上線前的舊資料、轉帳付的）淨額是 0，不寫。afterGuard 確認狀態真的退回了才寫。
 */
export function pettyCashRefund(entryId: string, expenseId: string, afterGuard: SQL, actorId: string) {
  return sql`INSERT INTO accounting_petty_cash_entries (id, kind, amount_minor, expense_id, actor_user_id)
    SELECT ${entryId}, 'refund', -${expenseNet(expenseId)}, ${expenseId}, ${actorId}
    WHERE ${expenseNet(expenseId)} < 0 AND ${afterGuard}`;
}

export async function getPettyCashBalance(db: Database) {
  const [row] = await db.all<{ balance: number }>(sql`SELECT ${pettyCashBalance} AS balance`);
  return Number(row?.balance ?? 0);
}

export interface PettyCashEntry {
  id: string;
  kind: "top_up" | "payout" | "refund" | "correction";
  amountMinor: number;
  /** 這一筆之後的餘額。 */
  balanceAfterMinor: number;
  expenseId: string | null;
  expenseDescription: string | null;
  /** 更正的那一筆指向被更正的增加。 */
  correctsEntryId: string | null;
  /** 這一筆增加已經被更正過（只能更正一次）。 */
  corrected: boolean;
  note: string;
  actorName: string;
  createdAt: string;
}

const correction = alias(accountingPettyCashEntries, "petty_correction");

/** 最近的紀錄放前面。每一筆之後的餘額從目前餘額往回推，不必掃整張表。 */
export async function listPettyCash(db: Database, limit = 300): Promise<{ balanceMinor: number; entries: PettyCashEntry[] }> {
  const balanceMinor = await getPettyCashBalance(db);
  const rows = await db.select({
    id: accountingPettyCashEntries.id,
    kind: accountingPettyCashEntries.kind,
    amountMinor: accountingPettyCashEntries.amountMinor,
    expenseId: accountingPettyCashEntries.expenseId,
    expenseDescription: accountingExpenses.description,
    correctsEntryId: accountingPettyCashEntries.correctsEntryId,
    correctionId: correction.id,
    note: accountingPettyCashEntries.note,
    actorName: sql<string>`coalesce(nullif(${users.displayName}, ''), ${users.email})`,
    createdAt: accountingPettyCashEntries.createdAt,
  }).from(accountingPettyCashEntries)
    .innerJoin(users, eq(users.id, accountingPettyCashEntries.actorUserId))
    .leftJoin(accountingExpenses, eq(accountingExpenses.id, accountingPettyCashEntries.expenseId))
    .leftJoin(correction, eq(correction.correctsEntryId, accountingPettyCashEntries.id))
    // 同一秒寫進來的照寫入順序排，餘額才推得對。
    .orderBy(desc(accountingPettyCashEntries.createdAt), desc(sql`accounting_petty_cash_entries.rowid`))
    .limit(limit);
  let after = balanceMinor;
  const entries = rows.map(({ correctionId, ...row }) => {
    const entry = { ...row, corrected: correctionId !== null, balanceAfterMinor: after };
    after -= row.amountMinor;
    return entry;
  });
  return { balanceMinor, entries };
}

/*
 * 會計增加零用金。只有增加，沒有手動減少（使用者決定）：錢只會因為報帳撥款出去。
 * 權限由路由的 accounting:petty-cash:write 把關。
 */
export async function topUpPettyCash(db: Database, input: { amountDollars: number; note: string }, actor: { id: string }) {
  if (!Number.isSafeInteger(input.amountDollars) || input.amountDollars < 1 || input.amountDollars > PETTY_CASH_MAX_DOLLARS) {
    throw new AccountingError(400, `金額必須是 1～${PETTY_CASH_MAX_DOLLARS.toLocaleString("zh-TW")} 的整數元。`);
  }
  const note = input.note.trim();
  if (note.length > 500) throw new AccountingError(400, "備註最多 500 字。");
  const id = crypto.randomUUID();
  await db.insert(accountingPettyCashEntries).values({ id, kind: "top_up", amountMinor: input.amountDollars * 100, note, actorUserId: actor.id, createdAt: toDbTimestamp() });
  return { id };
}

/*
 * 「增加」打錯金額時更正：記一筆相反數，指向那一筆增加，原本那筆留著（使用者決定，代替手動減少）。
 * 只能更正「增加」、每筆只能一次（corrects_entry_id 唯一）；扣回來會讓餘額變負（錢已經被報帳用掉）就擋。
 * 這些條件都寫在同一句 INSERT 的 WHERE 裡，兩個會計同時按也只會有一筆成功。
 */
export async function correctPettyCashTopUp(db: Database, entryId: string, input: { note: string }, actor: { id: string }) {
  const note = input.note.trim();
  if (!note || note.length > 500) throw new AccountingError(400, "請寫更正原因（500 字以內）。");
  const id = crypto.randomUUID();
  const inserted = await db.all<{ id: string }>(sql`INSERT INTO accounting_petty_cash_entries (id, kind, amount_minor, corrects_entry_id, note, actor_user_id, created_at)
    SELECT ${id}, 'correction', -original.amount_minor, original.id, ${note}, ${actor.id}, ${toDbTimestamp()}
    FROM accounting_petty_cash_entries AS original
    WHERE original.id = ${entryId} AND original.kind = 'top_up'
      AND NOT EXISTS (SELECT 1 FROM accounting_petty_cash_entries AS done WHERE done.corrects_entry_id = original.id)
      AND ${pettyCashBalance} >= original.amount_minor
    RETURNING id`);
  if (inserted.length) return { id };
  const [original] = await db.select({ kind: accountingPettyCashEntries.kind }).from(accountingPettyCashEntries).where(eq(accountingPettyCashEntries.id, entryId)).limit(1);
  if (!original || original.kind !== "top_up") throw new AccountingError(404, "只能更正「增加」的紀錄。");
  const [done] = await db.select({ id: accountingPettyCashEntries.id }).from(accountingPettyCashEntries).where(eq(accountingPettyCashEntries.correctsEntryId, entryId)).limit(1);
  if (done) throw new AccountingError(409, "這筆已經更正過了。");
  throw new AccountingError(409, "這筆錢已經有一部分被報帳用掉，扣回來餘額會不夠，不能更正。");
}
