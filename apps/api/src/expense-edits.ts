import { prepareMyExpenseEdit, saveExpenseEdit, type ExpenseEditInput } from "@rueisiang/db";
import { type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { type AppEnv } from "./env.js";
import { deleteObjects, field, receiptFiles, requireBucket, storeReceiptFiles } from "./expense-receipts.js";

/*
 * 送件人修改待審核的報帳（multipart：欄位、新照片、要移除的照片 id）。
 * 順序跟送件一樣：先驗證，再寫 R2，最後一個 batch 寫資料庫；資料庫失敗就刪掉這次寫進 R2 的新照片，
 * 成功後才去刪被移除的舊照片（盡力而為，刪不掉只記 log，不影響已經改好的單）。
 */

function revision(value: string) {
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new HTTPException(400, { message: "請提供有效版本，並重新整理後操作。" });
  return Number(value);
}

/** JSON 的修改欄位（會計那一端）與 multipart 的（送件人）都走這裡，欄位名稱同送件表單。 */
export function expenseEditInput(read: (key: string) => string, amount: unknown, confirmDuplicate: boolean): ExpenseEditInput {
  return {
    categoryId: read("categoryId"),
    spentOn: read("spentOn"),
    amountDollars: typeof amount === "number" ? amount : typeof amount === "string" && /^\d+$/.test(amount) ? Number(amount) : Number.NaN,
    invoiceNumber: read("invoiceNumber"),
    sellerTaxId: read("sellerTaxId"),
    description: read("description"),
    confirmDuplicate,
  };
}

export async function editMyExpense(c: Context<AppEnv>, id: string) {
  const db = c.get("db");
  const user = c.get("user");
  const form = await c.req.parseBody({ all: true });
  const files = receiptFiles(form);
  const rawRemove = form.removeReceiptIds;
  const removeIds = (Array.isArray(rawRemove) ? rawRemove : rawRemove === undefined ? [] : [rawRemove]).filter((value): value is string => typeof value === "string" && value.length > 0);
  const read = (key: string) => field(form, key);
  const expectedRevision = revision(read("revision"));
  const prepared = await prepareMyExpenseEdit(db, user.id, id, expenseEditInput(read, read("amountDollars"), read("confirmDuplicate") === "true"), { removeIds, addCount: files.length });
  if (!prepared.changes.length) return c.json({ id, changed: false });

  const bucket = requireBucket(c);
  const added = await storeReceiptFiles(bucket, user.id, files);
  let saved;
  try {
    saved = await saveExpenseEdit(db, prepared, { actor: user, expectedRevision, addReceipts: added });
  } catch (error) {
    await deleteObjects(bucket, added.map((receipt) => receipt.objectKey));
    throw error;
  }
  await deleteObjects(bucket, saved.removedObjectKeys);
  return c.json({ id, changed: saved.changed });
}
