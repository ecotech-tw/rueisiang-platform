import {
  AccountingError,
  LEDGER_PAYER_FILTERS,
  listPettyCash,
  REVIEW_STATUS_FILTERS,
  approveExpense,
  createExpenseCategory,
  listCompanyExpenseOptions,
  listExpenseCategories,
  listExpensesForReview,
  listLedger,
  markExpensePaid,
  rejectExpense,
  revertExpensePayment,
  topUpPettyCash,
  unapproveExpense,
  updateCompanyExpense,
  updateExpenseCategory,
  voidCompanyExpense,
  type ExpensePayout,
  type LedgerPayerFilter,
  type ReviewStatusFilter,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { expenseBodyLimit, readExpenseReceiptForReview, submitCompanyExpense } from "../expense-receipts.js";
import { requireAnyPermission, requireAuth, requirePermission } from "../middleware/auth.js";
import { body } from "../request.js";

/*
 * 會計系統（內帳）的 API。員工送件在 /api/hr/me/expenses，這裡是會計那一端。
 * 業務規則（不能審自己的單、狀態轉換）在 packages/db/src/accounting-review.ts。
 */

function revision(input: Record<string, unknown>) {
  const value = input.revision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new HTTPException(400, { message: "請提供有效版本，並重新整理後操作。" });
  return value;
}

function payout(input: Record<string, unknown>): ExpensePayout {
  if (input.payoutMethod === undefined || input.payoutMethod === "direct") return { method: "direct" };
  if (input.payoutMethod !== "payroll") throw new HTTPException(400, { message: "發放方式只能是直接撥款或併入月薪。" });
  if (typeof input.payrollPeriodKey !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.payrollPeriodKey)) throw new HTTPException(400, { message: "請選擇要併入的薪資月份。" });
  return { method: "payroll", periodKey: input.payrollPeriodKey };
}

function text(input: Record<string, unknown>, key: string) {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function companyExpenseInput(input: Record<string, unknown>) {
  const amount = input.amountDollars;
  return {
    categoryId: text(input, "categoryId"),
    scopeId: text(input, "scopeId") || null,
    spentOn: text(input, "spentOn"),
    amountDollars: typeof amount === "number" ? amount : Number.NaN,
    invoiceNumber: text(input, "invoiceNumber"),
    sellerTaxId: text(input, "sellerTaxId"),
    description: text(input, "description"),
    confirmDuplicate: input.confirmDuplicate === true,
  };
}

function categoryInput(input: Record<string, unknown>) {
  const sortOrder = input.sortOrder ?? 0;
  if (typeof input.name !== "string") throw new HTTPException(400, { message: "請填寫類別名稱。" });
  if (typeof sortOrder !== "number" || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) throw new HTTPException(400, { message: "排序必須是 0～9999 的整數。" });
  return { name: input.name, sortOrder };
}

export const accounting = new Hono<AppEnv>()
  .use("*", requireAuth)
  .use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); })
  .onError((error, c) => {
    // code 讓前端分得出「發票號碼重複，要確認」跟一般錯誤。
    if (error instanceof AccountingError) return c.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    throw error;
  })
  .get("/expenses", requirePermission("accounting:expense:read"), async (c) => {
    const status = c.req.query("status") ?? "pending";
    if (!REVIEW_STATUS_FILTERS.includes(status as ReviewStatusFilter)) throw new HTTPException(400, { message: "不認得的狀態篩選。" });
    return c.json({ expenses: await listExpensesForReview(c.get("db"), status as ReviewStatusFilter) });
  })
  .get("/expenses/:id/receipts/:receiptId", requirePermission("accounting:expense:read"), async (c) => readExpenseReceiptForReview(c, c.req.param("id"), c.req.param("receiptId")))
  .post("/expenses/:id/approve", requirePermission("accounting:expense:review"), async (c) => {
    const input = await body(c);
    return c.json(await approveExpense(c.get("db"), c.req.param("id"), revision(input), c.get("user"), payout(input)));
  })
  .post("/expenses/:id/reject", requirePermission("accounting:expense:review"), async (c) => {
    const input = await body(c);
    return c.json(await rejectExpense(c.get("db"), c.req.param("id"), revision(input), typeof input.note === "string" ? input.note : "", c.get("user")));
  })
  .post("/expenses/:id/paid", requirePermission("accounting:expense:review"), async (c) => {
    const input = await body(c);
    return c.json(await markExpensePaid(c.get("db"), c.req.param("id"), revision(input), c.get("user")));
  })
  .get("/ledger", requirePermission("accounting:expense:read"), async (c) => {
    const payer = c.req.query("payer") ?? "all";
    if (!LEDGER_PAYER_FILTERS.includes(payer as LedgerPayerFilter)) throw new HTTPException(400, { message: "不認得的付款人篩選。" });
    return c.json(await listLedger(c.get("db"), {
      month: c.req.query("month") ?? "",
      payer: payer as LedgerPayerFilter,
      categoryId: c.req.query("categoryId") || null,
      scopeId: c.req.query("scopeId") || null,
    }));
  })
  // 支出帳的篩選也要類別與店別，所以只能看的人也讀得到；名稱清單沒有敏感資料。
  .get("/company-expenses/options", requireAnyPermission("accounting:expense:read", "accounting:expense:write"), async (c) => c.json(await listCompanyExpenseOptions(c.get("db"))))
  .post("/company-expenses", requirePermission("accounting:expense:write"), expenseBodyLimit, async (c) => submitCompanyExpense(c))
  .patch("/company-expenses/:id", requirePermission("accounting:expense:write"), async (c) => {
    const input = await body(c);
    return c.json(await updateCompanyExpense(c.get("db"), c.req.param("id"), revision(input), companyExpenseInput(input), c.get("user")));
  })
  .post("/company-expenses/:id/void", requirePermission("accounting:expense:write"), async (c) => {
    const input = await body(c);
    return c.json(await voidCompanyExpense(c.get("db"), c.req.param("id"), revision(input), c.get("user")));
  })
  // 狀態退回（統計用的內部操作）：已付款退回待撥款、待撥款取消核准回到待審核。
  .post("/expenses/:id/revert-payment", requirePermission("accounting:expense:review"), async (c) => {
    const input = await body(c);
    return c.json(await revertExpensePayment(c.get("db"), c.req.param("id"), revision(input), c.get("user")));
  })
  .post("/expenses/:id/unapprove", requirePermission("accounting:expense:review"), async (c) => {
    const input = await body(c);
    return c.json(await unapproveExpense(c.get("db"), c.req.param("id"), revision(input), c.get("user")));
  })
  .get("/petty-cash", requirePermission("accounting:expense:read"), async (c) => c.json(await listPettyCash(c.get("db"))))
  .post("/petty-cash", requirePermission("accounting:petty-cash:write"), async (c) => {
    const input = await body(c);
    return c.json(await topUpPettyCash(c.get("db"), { amountDollars: typeof input.amountDollars === "number" ? input.amountDollars : Number.NaN, note: text(input, "note") }, c.get("user")), 201);
  })
  // 看類別清單的人包含審核者：核准畫面要顯示類別名稱以外，管理頁也要讀。
  .get("/categories", requireAnyPermission("accounting:category:write", "accounting:expense:read"), async (c) => c.json({ categories: await listExpenseCategories(c.get("db")) }))
  .post("/categories", requirePermission("accounting:category:write"), async (c) => c.json(await createExpenseCategory(c.get("db"), categoryInput(await body(c)), c.get("user")), 201))
  .patch("/categories/:id", requirePermission("accounting:category:write"), async (c) => {
    const input = await body(c);
    return c.json(await updateExpenseCategory(c.get("db"), c.req.param("id"), { ...categoryInput(input), archived: input.archived === true }, c.get("user")));
  });
