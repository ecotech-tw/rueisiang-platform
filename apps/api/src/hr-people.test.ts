import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, listActivity, syncSystemRoles } from "@rueisiang/db";
import { hrEmployees, hrEmployers, scopes, userPermissionGrants, userRoleAssignments, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "hr-test-secret-test-secret-test-secret";
let d1: LocalD1;
let db: ReturnType<typeof createDatabase>;
let cookies: Record<string, string>;
const env = () => ({ DB: d1, AUTH_SESSION_SECRET: SECRET, GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" });

async function request(path: string, method = "GET", payload?: Record<string, unknown>, actor = "admin") {
  return app.fetch(new Request(`https://test.local/api${path}`, {
    method, headers: { "Content-Type": "application/json", ...(cookies[actor] ? { Cookie: cookies[actor] } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  }), env() as never);
}
async function created(path: string, payload: Record<string, unknown>) {
  const response = await request(path, "POST", payload);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json() as { id: string }).id;
}
async function employee(number = "E001") { return created("/hr/employees", { employeeNumber: number, displayName: "測試員工" }); }
async function employment(employeeId: string, values: Record<string, unknown> = {}) {
  return created("/hr/employments", { employeeId, employerId: "employer", hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01", ...values });
}
function auditCount() { return (d1.sqlite.prepare("SELECT count(*) AS n FROM activity_events WHERE source='hr'").get() as { n: number }).n; }

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  // 既有 local-d1.batch 未包交易；本測試讓 batch 真正原子執行，避免稽核失敗卻留下一半寫入的假信心。
  let batchTail: Promise<unknown> = Promise.resolve();
  d1.batch = (statements) => {
    const pendingBatch = batchTail.then(async () => {
    d1.sqlite.exec("BEGIN");
    try {
      // LocalStatement.all 的 SQL 同步執行，不在交易內 await 讓其他請求插入交易。
      const pending = statements.map((statement) => statement.all());
      const results = await Promise.all(pending);
      d1.sqlite.exec("COMMIT");
      return results;
    } catch (error) { d1.sqlite.exec("ROLLBACK"); throw error; }
    });
    batchTail = pendingBatch.catch(() => undefined);
    return pendingBatch;
  };
  db = createDatabase(d1 as never);
  await syncSystemRoles(db);
  cookies = {};
  for (const id of ["admin", "self", "other", "writer"]) {
    await db.insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: "active" });
    const token = await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET);
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
  }
  await db.insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  await db.insert(userPermissionGrants).values([
    { userId: "self", permission: "hr:self:read" }, { userId: "other", permission: "hr:self:read" },
    { userId: "writer", permission: "hr:employee:read" }, { userId: "writer", permission: "hr:employee:write" },
  ]);
  await db.insert(hrEmployers).values({ id: "employer", name: "測試雇主" });
  await db.insert(scopes).values({ id: "scope", sourceType: "manual", scopeKind: "store", name: "測試櫃點", normalizedName: "測試櫃點" });
});
afterEach(() => { d1.sqlite.close(); });

describe("HR 員工基礎", () => {
  it("可先建員工不開帳號；重複編號／統編與無效輸入不留下稽核", async () => {
    const id = await employee();
    expect((await db.select().from(hrEmployees).where(eq(hrEmployees.id, id)))[0]?.userId).toBeNull();
    const count = auditCount();
    expect((await request("/hr/employees", "POST", { employeeNumber: "E001", displayName: "重複" })).status).toBe(409);
    expect(auditCount()).toBe(count);
    expect((await request("/hr/employees", "POST", { employeeNumber: " ", displayName: "無編號" })).status).toBe(400);
    expect((await request("/hr/employers", "POST", { name: "雇主", registrationNumber: "bad" })).status).toBe(400);
    await created("/hr/employers", { name: "新雇主", registrationNumber: "12345678" });
    expect((await request("/hr/employers", "POST", { name: "重複", registrationNumber: "12345678" })).status).toBe(409);
  });

  it("更新有版本防護，零列更新不能冒出成功稽核", async () => {
    const id = await employee();
    const input = { employeeNumber: "E001", displayName: "新姓名", revision: 1 };
    expect((await request(`/hr/employees/${id}`, "PATCH", input)).status).toBe(200);
    const count = auditCount();
    expect((await request(`/hr/employees/${id}`, "PATCH", input)).status).toBe(409);
    expect(auditCount()).toBe(count);
    expect((await request(`/hr/employees/${id}`, "PATCH", { ...input, revision: 0 })).status).toBe(400);
  });

  it("綁定需要獨立權限；一帳號不能綁兩位員工，也不能綁不存在／停用帳號", async () => {
    const id = await employee();
    const second = await employee("E002");
    const bind = { userEmail: "self@example.test", revision: 1 };
    expect((await request(`/hr/employees/${id}/account`, "PUT", bind, "writer")).status).toBe(403);
    expect((await request(`/hr/employees/${id}/account`, "PUT", bind)).status).toBe(200);
    expect((await request(`/hr/employees/${second}/account`, "PUT", bind)).status).toBe(409);
    expect((await request(`/hr/employees/${second}/account`, "PUT", { userEmail: "missing@example.test", revision: 1 })).status).toBe(409);
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, "other"));
    expect((await request(`/hr/employees/${second}/account`, "PUT", { userEmail: "other@example.test", revision: 1 })).status).toBe(409);
  });

  it("本人資料只用 session 身分，不採信 query；未綁定、停權與撤權即時反映", async () => {
    const id = await employee();
    await request(`/hr/employees/${id}/account`, "PUT", { userEmail: "self@example.test", revision: 1 });
    const self = await request(`/hr/me?employeeId=other&userId=other`, "GET", undefined, "self");
    expect(await self.json()).toMatchObject({ profile: { employee: { id } } });
    expect(await (await request(`/hr/me?employeeId=${id}`, "GET", undefined, "other")).json()).toEqual({ profile: null });
    expect((await request(`/hr/employees/${id}`, "GET", undefined, "self")).status).toBe(403);
    expect((await request("/hr/employees", "GET", undefined, "self")).status).toBe(403);
    expect((await request("/hr/me", "GET", undefined, "anonymous")).status).toBe(401);
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, "self"));
    expect((await request("/hr/me", "GET", undefined, "self")).status).toBe(403);
    await db.update(users).set({ status: "active" }).where(eq(users.id, "self"));
    await db.delete(userPermissionGrants).where(eq(userPermissionGrants.userId, "self"));
    expect((await request("/hr/me", "GET", undefined, "self")).status).toBe(403);
  });

  it("不同起日的任職重疊也會拒絕，結束後復職保留原歷史", async () => {
    const id = await employee();
    const job = await employment(id);
    expect((await request("/hr/employments", "POST", { employeeId: id, employerId: "employer", hiredOn: "2026-02-01", endedOn: "2026-03-01", seniorityStartOn: "2026-01-01" })).status).toBe(409);
    expect((await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: "2026-02-01", revision: 1 })).status).toBe(200);
    await employment(id, { hiredOn: "2026-02-01" });
    const detail = await (await request(`/hr/employees/${id}`)).json() as { employments: unknown[] };
    expect(detail.employments).toHaveLength(2);
    expect((await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: "2026-03-01", revision: 2 })).status).toBe(409);
  });

  it("櫃點期間必須在任職內，關閉指派後才可離職；停用 scope 不可新增", async () => {
    const id = await employee();
    const job = await employment(id);
    const assignment = await created("/hr/assignments", { employmentId: job, scopeId: "scope", validFrom: "2026-01-01" });
    expect((await request("/hr/assignments", "POST", { employmentId: job, scopeId: "scope", validFrom: "2026-02-01" })).status).toBe(409);
    expect((await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: "2026-02-01", revision: 1 })).status).toBe(409);
    expect((await request(`/hr/assignments/${assignment}/end`, "PATCH", { validTo: "2026-02-01", revision: 1 })).status).toBe(200);
    expect((await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: "2026-02-01", revision: 1 })).status).toBe(200);
    expect((await request("/hr/assignments", "POST", { employmentId: job, scopeId: "scope", validFrom: "2025-12-01", validTo: "2026-01-01" })).status).toBe(409);
    expect((await request("/hr/assignments", "POST", { employmentId: job, scopeId: "scope", validFrom: "2026-02-01" })).status).toBe(409);
    await db.update(scopes).set({ active: 0 }).where(eq(scopes.id, "scope"));
    const options = await (await request("/hr/scopes")).json() as { scopes: { id: string }[] };
    expect(options.scopes.some((scope) => scope.id === "scope")).toBe(false);
    const nextJob = await employment(id, { hiredOn: "2026-02-01" });
    expect((await request("/hr/assignments", "POST", { employmentId: nextJob, scopeId: "scope", validFrom: "2026-02-01" })).status).toBe(409);
  });

  it("拒絕不合法日曆日期、區間、未知關聯及錯誤頁碼", async () => {
    const id = await employee();
    for (const hiredOn of ["2026-02-30", "2026-13-01", "2026-1-1"]) {
      expect((await request("/hr/employments", "POST", { employeeId: id, employerId: "employer", hiredOn, seniorityStartOn: "2026-01-01" })).status).toBe(400);
    }
    expect((await request("/hr/employments", "POST", { employeeId: "missing", employerId: "employer", hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01" })).status).toBe(409);
    expect((await request("/hr/employees?page=0")).status).toBe(400);
    expect((await request("/hr/employees/missing")).status).toBe(404);
  });

  it("綁定帳號不可 cascade 刪除；解除綁定後刪帳號保留員工與任職", async () => {
    const id = await employee();
    await employment(id);
    await request(`/hr/employees/${id}/account`, "PUT", { userEmail: "self@example.test", revision: 1 });
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, "self"));
    expect((await request("/admin/users/self", "DELETE")).status).toBe(409);
    expect((await request(`/hr/employees/${id}/account`, "PUT", { userEmail: null, revision: 2 })).status).toBe(200);
    expect((await request("/admin/users/self", "DELETE")).status).toBe(200);
    expect(await (await request(`/hr/employees/${id}`)).json()).toMatchObject({ employee: { id, userId: null }, employments: [{ employeeId: id }] });
  });

  it("同時新增重疊任職與同版本更新，均只有一個成功與一筆稽核", async () => {
    const id = await employee();
    const count = auditCount();
    const results = await Promise.all(["2026-01-01", "2026-02-01"].map((hiredOn) => request("/hr/employments", "POST", { employeeId: id, employerId: "employer", hiredOn, seniorityStartOn: "2026-01-01" })));
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const edits = await Promise.all(["甲", "乙"].map((displayName) => request(`/hr/employees/${id}`, "PATCH", { employeeNumber: "E001", displayName, revision: 1 })));
    expect(edits.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(auditCount()).toBe(count + 2);
  });

  it("共用操作紀錄排除人事；稽核失敗時人事寫入一起回滾", async () => {
    await employee();
    const activity = await listActivity(db, { source: "all", search: "", page: 1, pageSize: 50 });
    expect(activity.events).toEqual([]);
    d1.sqlite.exec("CREATE TRIGGER fail_hr_audit BEFORE INSERT ON activity_events WHEN NEW.source='hr' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
    expect((await request("/hr/employees", "POST", { employeeNumber: "FAILED", displayName: "不應留存" })).status).toBe(500);
    expect(d1.sqlite.prepare("SELECT id FROM hr_employees WHERE employee_number='FAILED'").get()).toBeUndefined();
  });
});
