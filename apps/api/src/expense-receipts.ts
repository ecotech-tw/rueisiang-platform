import {
  createExpense,
  findExpenseReceiptForReview,
  findMyExpenseByClientRequest,
  findMyExpenseReceipt,
  prepareCompanyExpense,
  prepareMyExpense,
  type ExpenseFieldsInput,
  type PreparedExpense,
  type StoredReceipt,
} from "@rueisiang/db";
import { EXPENSE_RECEIPT_MAX_BYTES, EXPENSE_RECEIPT_MAX_FILES, EXPENSE_RECEIPT_MAX_PIXELS, EXPENSE_RECEIPT_MAX_SIDE } from "@rueisiang/db/accounting-expense-fields";
import { type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { type AppEnv } from "./env.js";
import { validateRasterImage } from "./image-validation.js";

export const expenseBodyLimit = bodyLimit({
  maxSize: EXPENSE_RECEIPT_MAX_FILES * EXPENSE_RECEIPT_MAX_BYTES + 64 * 1024,
  onError: () => { throw new HTTPException(413, { message: `單據照片合計太大；每張最多 ${EXPENSE_RECEIPT_MAX_BYTES / 1024 / 1024} MB。` }); },
});

function requireBucket(c: Context<AppEnv>) {
  if (!c.env.UPLOADS) throw new HTTPException(503, { message: "尚未設定單據儲存空間。" });
  return c.env.UPLOADS;
}

async function deleteObjects(bucket: R2Bucket, keys: string[]) {
  for (const key of keys) {
    try { await bucket.delete(key); }
    catch (error) { console.error(JSON.stringify({ event: "accounting.expense_receipt_cleanup_failed", error: error instanceof Error ? error.message : "unknown" })); }
  }
}

function field(form: Record<string, unknown>, key: string): string {
  const value = form[key];
  return typeof value === "string" ? value : "";
}

/*
 * 送件順序：先驗證欄位與照片，再寫 R2，最後一個 batch 寫支出單與照片索引。
 * 照片已經寫進 R2、資料庫卻失敗時要把檔案刪掉，否則私有 bucket 會留下沒人指得到的單據。
 *
 * 員工報帳與會計登記公司支出走同一條路，差別只在 prepare（誰付的錢、要不要任職資料）。
 */
export async function submitMyExpense(c: Context<AppEnv>) {
  return submitExpense(c, (input) => prepareMyExpense(c.get("db"), c.get("user").id, input));
}

export async function submitCompanyExpense(c: Context<AppEnv>) {
  return submitExpense(c, (input) => prepareCompanyExpense(c.get("db"), c.get("user").id, input));
}

async function submitExpense(c: Context<AppEnv>, prepare: (input: ExpenseFieldsInput) => Promise<PreparedExpense>) {
  const db = c.get("db");
  const user = c.get("user");
  const userId = user.id;
  const bucket = requireBucket(c);
  const form = await c.req.parseBody({ all: true });
  const rawFiles = form.receipts;
  const files = (Array.isArray(rawFiles) ? rawFiles : rawFiles === undefined ? [] : [rawFiles]).filter((value): value is File => typeof value !== "string");
  if (Array.isArray(rawFiles) && files.length !== rawFiles.length) throw new HTTPException(400, { message: "單據照片格式不正確。" });
  const scopeId = field(form, "scopeId");
  const amountText = field(form, "amountDollars");
  const prepared = await prepare({
    clientRequestId: field(form, "clientRequestId"),
    categoryId: field(form, "categoryId"),
    scopeId: scopeId || null,
    spentOn: field(form, "spentOn"),
    amountDollars: /^\d+$/.test(amountText) ? Number(amountText) : Number.NaN,
    invoiceNumber: field(form, "invoiceNumber"),
    sellerTaxId: field(form, "sellerTaxId"),
    description: field(form, "description"),
    receiptCount: files.length,
    confirmDuplicate: field(form, "confirmDuplicate") === "true",
  });

  // 連按兩次送出：第二次直接回第一次的那張，不再寫照片。
  const existing = await findMyExpenseByClientRequest(db, userId, prepared.clientRequestId);
  if (existing) return c.json({ id: existing.id }, 200);

  const validated = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { contentType } = await validateRasterImage(bytes, file.type, {
      maxInputBytes: EXPENSE_RECEIPT_MAX_BYTES,
      maxPixels: EXPENSE_RECEIPT_MAX_PIXELS,
      maxSide: EXPENSE_RECEIPT_MAX_SIDE,
    });
    validated.push({ bytes, contentType });
  }

  const receipts: StoredReceipt[] = [];
  try {
    for (const { bytes, contentType } of validated) {
      const id = crypto.randomUUID();
      const objectKey = `accounting/expense-receipts/${userId}/${id}`;
      await bucket.put(objectKey, bytes, { httpMetadata: { contentType } });
      receipts.push({ id, objectKey, contentType, byteSize: bytes.byteLength });
    }
  } catch (error) {
    await deleteObjects(bucket, receipts.map((receipt) => receipt.objectKey));
    throw error;
  }

  try {
    const created = await createExpense(db, prepared, receipts, user);
    return c.json(created, 201);
  } catch (error) {
    // 兩個同時送出的請求只會有一個寫進去（clientRequestId 唯一）；輸的那個回贏的那張。
    // 傳輸錯誤也可能是「其實寫進去了」：贏的那張用的就是這次的照片時，檔案不能刪。
    const winner = await findMyExpenseByClientRequest(db, userId, prepared.clientRequestId);
    const ours = winner && receipts[0] ? await findMyExpenseReceipt(db, userId, winner.id, receipts[0].id) : null;
    if (!ours) await deleteObjects(bucket, receipts.map((receipt) => receipt.objectKey));
    if (winner) return c.json({ id: winner.id }, ours ? 201 : 200);
    throw error;
  }
}

export async function readMyExpenseReceipt(c: Context<AppEnv>, expenseId: string, receiptId: string) {
  return streamReceipt(c, await findMyExpenseReceipt(c.get("db"), c.get("user").id, expenseId, receiptId));
}

/** 會計看任何一張報帳的單據；權限由路由的 accounting:expense:read 把關。 */
export async function readExpenseReceiptForReview(c: Context<AppEnv>, expenseId: string, receiptId: string) {
  return streamReceipt(c, await findExpenseReceiptForReview(c.get("db"), expenseId, receiptId));
}

async function streamReceipt(c: Context<AppEnv>, receipt: { objectKey: string; contentType: string } | null) {
  if (!receipt) throw new HTTPException(404, { message: "找不到這張單據照片。" });
  const object = await requireBucket(c).get(receipt.objectKey);
  if (!object) throw new HTTPException(404, { message: "單據照片檔案遺失，請聯絡會計。" });
  return c.newResponse(object.body, { headers: { "Content-Type": receipt.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } });
}
