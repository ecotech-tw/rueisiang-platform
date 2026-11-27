import {
  AccountingError,
  REVIEW_STATUS_FILTERS,
  approveExpense,
  createExpenseCategory,
  listExpenseCategories,
  listExpensesForReview,
  markExpensePaid,
  rejectExpense,
  updateExpenseCategory,
  type ExpensePayout,
  type ReviewStatusFilter,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { readExpenseReceiptForReview } from "../expense-receipts.js";
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
    if (error instanceof AccountingError || error instanceof HTTPException) return c.json({ error: error.message }, error.status);
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
  // 看類別清單的人包含審核者：核准畫面要顯示類別名稱以外，管理頁也要讀。
  .get("/categories", requireAnyPermission("accounting:category:write", "accounting:expense:read"), async (c) => c.json({ categories: await listExpenseCategories(c.get("db")) }))
  .post("/categories", requirePermission("accounting:category:write"), async (c) => c.json(await createExpenseCategory(c.get("db"), categoryInput(await body(c)), c.get("user")), 201))
  .patch("/categories/:id", requirePermission("accounting:category:write"), async (c) => {
    const input = await body(c);
    return c.json(await updateExpenseCategory(c.get("db"), c.req.param("id"), { ...categoryInput(input), archived: input.archived === true }, c.get("user")));
  });
