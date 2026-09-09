import {
  HrError, assignHrEmployee, createHrAssignment, createHrEmployment,
  endHrAssignment, endHrEmployment, getHrEmployee, getHrSelf, listHrCandidates, listHrEmployees, listHrScopes, updateHrEmployee,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { body, requireString } from "../request.js";

function text(input: Record<string, unknown>, key: string, label: string, max = 100) {
  const value = requireString(input, key, label);
  if (value.length > max) throw new HTTPException(400, { message: `${label}最多 ${max} 字。` });
  return value;
}
function date(input: Record<string, unknown>, key: string, nullable = false): string | null {
  if (nullable && (input[key] === null || input[key] === undefined || input[key] === "")) return null;
  const value = text(input, key, "日期", 10);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > "9999-12-31" || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HTTPException(400, { message: "日期必須是有效的 YYYY-MM-DD。" });
  }
  return value;
}
function period(start: string, end: string | null) {
  if (end && end <= start) throw new HTTPException(400, { message: "結束日（不含）必須晚於開始日。" });
}
function revision(input: Record<string, unknown>) {
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1) throw new HTTPException(400, { message: "請提供有效版本，並重新整理後操作。" });
  return input.revision as number;
}

export const hr = new Hono<AppEnv>()
  .use("*", requireAuth)
  .onError((error, c) => {
    if (error instanceof HrError || error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    throw error;
  })
  // 本人資格來自員工關聯而不是手動授權；requireAuth 仍每次檢查帳號是否啟用。
  .get("/me", async (c) => c.json({ profile: await getHrSelf(c.get("db"), c.get("user").id) }))
  .get("/candidates", requirePermission("hr:employee:write"), async (c) => {
    const page = Number(c.req.query("page") ?? "1");
    const search = c.req.query("search")?.trim() ?? "";
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || search.length > 100) throw new HTTPException(400, { message: "查詢條件不正確。" });
    return c.json(await listHrCandidates(c.get("db"), { page, search, userId: c.req.query("userId") }));
  })
  .get("/scopes", requirePermission("hr:employee:read"), async (c) => c.json({ scopes: await listHrScopes(c.get("db")) }))
  .get("/employees", requirePermission("hr:employee:read"), async (c) => {
    const page = Number(c.req.query("page") ?? "1");
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new HTTPException(400, { message: "頁碼不正確。" });
    return c.json(await listHrEmployees(c.get("db"), page));
  })
  .get("/employees/:id", requirePermission("hr:employee:read"), async (c) => c.json(await getHrEmployee(c.get("db"), c.req.param("id"))))
  .post("/employees", requirePermission("hr:employee:write"), async (c) => {
    const input = await body(c);
    const hiredOn = date(input, "hiredOn")!;
    const seniorityStartOn = date(input, "seniorityStartOn")!;
    if (seniorityStartOn > hiredOn) throw new HTTPException(400, { message: "年資認列日起不得晚於到職日。" });
    return c.json(await assignHrEmployee(c.get("db"), { userId: text(input, "userId", "使用者"), employeeNumber: text(input, "employeeNumber", "員工編號", 40), hiredOn, seniorityStartOn }, c.get("user")), 201);
  })
  .patch("/employees/:id", requirePermission("hr:employee:write"), async (c) => {
    const input = await body(c);
    return c.json(await updateHrEmployee(c.get("db"), c.req.param("id"), { employeeNumber: text(input, "employeeNumber", "員工編號", 40), revision: revision(input) }, c.get("user")));
  })
  .post("/employments", requirePermission("hr:employee:write"), async (c) => {
    const input = await body(c);
    const hiredOn = date(input, "hiredOn")!;
    const endedOn = date(input, "endedOn", true);
    const seniorityStartOn = date(input, "seniorityStartOn")!;
    period(hiredOn, endedOn);
    if (seniorityStartOn > hiredOn) throw new HTTPException(400, { message: "年資認列日起不得晚於到職日。" });
    return c.json(await createHrEmployment(c.get("db"), { userId: text(input, "userId", "員工"), hiredOn, endedOn, seniorityStartOn }, c.get("user")), 201);
  })
  .patch("/employments/:id/end", requirePermission("hr:employee:write"), async (c) => {
    const input = await body(c);
    return c.json(await endHrEmployment(c.get("db"), c.req.param("id"), { endedOn: date(input, "endedOn")!, revision: revision(input) }, c.get("user")));
  })
  .post("/assignments", requirePermission("hr:employee:write"), async (c) => {
    const input = await body(c);
    const validFrom = date(input, "validFrom")!;
    const validTo = date(input, "validTo", true);
    period(validFrom, validTo);
    return c.json(await createHrAssignment(c.get("db"), { employmentId: text(input, "employmentId", "任職紀錄"), scopeId: text(input, "scopeId", "櫃點"), validFrom, validTo }, c.get("user")), 201);
  })
  .patch("/assignments/:id/end", requirePermission("hr:employee:write"), async (c) => {
    const input = await body(c);
    return c.json(await endHrAssignment(c.get("db"), c.req.param("id"), { validTo: date(input, "validTo")!, revision: revision(input) }, c.get("user")));
  });
