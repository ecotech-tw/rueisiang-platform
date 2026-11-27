import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "./client.js";
import { AccountingError, resolveExpenseSubmitter, validateExpenseFields } from "./accounting-expenses.js";
import { submitterDisplayName } from "./accounting-review.js";
import { toDbTimestamp } from "./db-timestamp.js";
import { accountingExpenseCategories, accountingExpenses } from "./schema/accounting.js";
import { users } from "./schema/auth.js";
import { hrEmployments } from "./schema/hr-people.js";
import { formatTaipeiDate } from "./taipei-time.js";

/*
 * 在 LINE @小香 送報帳（使用者決定）：跟 HR 員工自助送件一樣進「待審核」，只是換一個管道。規格見 docs/accounting-prd.md。
 *
 * - 申請人：發話者綁定了平台帳號、而且是在職員工或支援人員，就是他本人的單（看得到、收得到通知、可以併入月薪）；
 *   沒綁定（或綁定的人不能報帳）就照樣收件，只記 LINE 的 userId 與名稱，只能直接撥款。
 * - 只問日期、內容、金額三個欄位：類別一律放預設類別，會計審核時可以改；不收照片。
 * - 發話者的 LINE userId 由呼叫端從 webhook 的訊息紀錄取得，不是使用者或模型能填的，冒用不了別人的身分。
 */

/** 預設類別：「其他」還在用就用它，被停用了就用排序最前面的類別。 */
export const LINE_EXPENSE_DEFAULT_CATEGORY_ID = "expense-category-other";

export interface LineExpenseInput {
  /** `line-` 開頭，由 webhook 事件與這筆的內容組成；同一則訊息重送也只會有一張。 */
  clientRequestId: string;
  lineUserId: string;
  lineDisplayName: string;
  /** 發話者綁定的平台帳號；沒綁定是 null。 */
  boundUserId: string | null;
  /** 台北日期 YYYY-MM-DD；沒說就是今天。 */
  spentOn: string | null;
  amountDollars: number;
  description: string;
}

export interface LineExpenseResult {
  id: string;
  /** 這次是不是重送：同一則訊息已經建過，回傳原本那張。 */
  duplicate: boolean;
  /** 有沒有對應到平台帳號；沒有的話會計要自己確認申請人是誰。 */
  bound: boolean;
  /** 有帳號就是後台名稱，沒綁定就是 LINE 名稱。 */
  submitterName: string;
  spentOn: string;
  amountMinor: number;
  description: string;
  categoryName: string;
}

async function defaultCategory(db: Database) {
  const [preferred] = await db.select({ id: accountingExpenseCategories.id, name: accountingExpenseCategories.name }).from(accountingExpenseCategories)
    .where(and(eq(accountingExpenseCategories.id, LINE_EXPENSE_DEFAULT_CATEGORY_ID), isNull(accountingExpenseCategories.archivedAt))).limit(1);
  if (preferred) return preferred;
  const [first] = await db.select({ id: accountingExpenseCategories.id, name: accountingExpenseCategories.name }).from(accountingExpenseCategories)
    .where(isNull(accountingExpenseCategories.archivedAt)).orderBy(asc(accountingExpenseCategories.sortOrder), asc(accountingExpenseCategories.name)).limit(1);
  if (!first) throw new AccountingError(409, "會計還沒有設定任何支出類別，暫時不能報帳。");
  return first;
}

async function existingLineExpense(db: Database, clientRequestId: string) {
  const [row] = await db.select({ id: accountingExpenses.id, spentOn: accountingExpenses.spentOn, amountMinor: accountingExpenses.amountMinor, description: accountingExpenses.description, submitterUserId: accountingExpenses.submitterUserId, submitterName: submitterDisplayName, categoryName: accountingExpenseCategories.name })
    .from(accountingExpenses)
    .innerJoin(accountingExpenseCategories, eq(accountingExpenseCategories.id, accountingExpenses.categoryId))
    .leftJoin(users, eq(users.id, accountingExpenses.submitterUserId))
    .leftJoin(hrEmployments, eq(hrEmployments.id, accountingExpenses.employmentId))
    .where(and(eq(accountingExpenses.source, "line"), eq(accountingExpenses.clientRequestId, clientRequestId))).limit(1);
  return row ?? null;
}

function result(row: NonNullable<Awaited<ReturnType<typeof existingLineExpense>>>, duplicate: boolean): LineExpenseResult {
  return { id: row.id, duplicate, bound: row.submitterUserId !== null, submitterName: row.submitterName, spentOn: row.spentOn, amountMinor: row.amountMinor, description: row.description, categoryName: row.categoryName };
}

/** 綁定的帳號能不能用本人身分報帳；不能（離職、不是員工）就當成沒綁定，照樣收件。 */
async function boundSubmitter(db: Database, userId: string | null) {
  if (!userId) return null;
  try {
    return await resolveExpenseSubmitter(db, userId);
  } catch (error) {
    if (error instanceof AccountingError && error.status === 403) return null;
    throw error;
  }
}

export async function submitLineExpense(db: Database, input: LineExpenseInput, now: Date = new Date()): Promise<LineExpenseResult> {
  if (!/^line-[A-Za-z0-9-]{8,94}$/.test(input.clientRequestId)) throw new AccountingError(400, "LINE 送件識別碼格式不正確。");
  const lineDisplayName = input.lineDisplayName.trim().slice(0, 100);
  if (!input.lineUserId || !lineDisplayName) throw new AccountingError(400, "認不出是誰送的報帳。");
  const existing = await existingLineExpense(db, input.clientRequestId);
  if (existing) return result(existing, true);

  const category = await defaultCategory(db);
  const submitter = await boundSubmitter(db, input.boundUserId);
  const fields = await validateExpenseFields(db, {
    clientRequestId: input.clientRequestId,
    categoryId: category.id,
    scopeId: null,
    spentOn: input.spentOn ?? formatTaipeiDate(now),
    amountDollars: input.amountDollars,
    invoiceNumber: "",
    sellerTaxId: "",
    description: input.description,
    receiptCount: 0,
    // 群組裡沒辦法一來一回確認；重複的發票號碼本來就不會出現（LINE 送件不收發票號碼）。
    confirmDuplicate: true,
  }, { now, tooOldHint: "；更早的單據請直接找會計。", receiptOptional: true });

  const id = crypto.randomUUID();
  const timestamp = toDbTimestamp();
  try {
    await db.insert(accountingExpenses).values({
      id,
      payerKind: "employee_advance",
      source: "line",
      submitterUserId: submitter?.userId ?? null,
      employmentId: submitter?.employmentId ?? null,
      lineUserId: input.lineUserId,
      lineDisplayName,
      clientRequestId: fields.clientRequestId,
      categoryId: fields.categoryId,
      spentOn: fields.spentOn,
      amountMinor: fields.amountMinor,
      description: fields.description,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } catch (error) {
    // 同一則訊息同時跑了兩次：唯一索引只讓一張寫進去，輸的那次回傳贏的那張。
    const winner = await existingLineExpense(db, input.clientRequestId);
    if (winner) return result(winner, true);
    throw error;
  }
  const created = await existingLineExpense(db, input.clientRequestId);
  if (!created) throw new AccountingError(409, "報帳單剛建立就讀不到，請稍後再查。");
  return result(created, false);
}
