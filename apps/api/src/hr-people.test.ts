import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, listActivity, syncSystemRoles } from "@rueisiang/db";
import { scopes, userPermissionGrants, userRoleAssignments, users } from "@rueisiang/db/schema";
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
    method,
    headers: { "Content-Type": "application/json", ...(cookies[actor] ? { Cookie: cookies[actor] } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  }), env() as never);
}
async function created(path: string, payload: Record<string, unknown>, actor = "admin") {
  const response = await request(path, "POST", payload, actor);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json() as { id: string; userId?: string }).id;
}
async function assign(userId: string, number = "E001") {
  await created("/hr/employees", { userId, employeeNumber: number, hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01" });
  return userId;
}
async function employment(userId: string, values: Record<string, unknown> = {}) {
  return created("/hr/employments", { userId, hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01", ...values });
}
async function firstEmployment(userId: string) {
  const detail = await (await request(`/hr/employees/${userId}`)).json() as { employments: { id: string }[] };
  const id = detail.employments[0]?.id;
  if (!id) throw new Error("測試員工缺少任職紀錄");
  return id;
}
function auditCount() { return (d1.sqlite.prepare("SELECT count(*) AS n FROM activity_events WHERE source='hr'").get() as { n: number }).n; }

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  // D1 batch 是原子單位；local-d1 預設逐句執行，這裡補上 transaction 才能測到正式語意。
  let batchTail: Promise<unknown> = Promise.resolve();
  d1.batch = (statements) => {
    const pendingBatch = batchTail.then(async () => {
      d1.sqlite.exec("BEGIN");
      try {
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
  for (const id of ["admin", "self", "other", "writer", "invited"]) {
    await db.insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: id === "invited" ? "invited" : "active" });
    const token = await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET);
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
  }
  await db.insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  await db.insert(userPermissionGrants).values([
    { userId: "writer", permission: "hr:employee:read" }, { userId: "writer", permission: "hr:employee:write" },
  ]);
  await db.insert(scopes).values({ id: "scope", sourceType: "manual", scopeKind: "store", name: "測試櫃點", normalizedName: "測試櫃點" });
});
afterEach(() => { d1.sqlite.close(); });

describe("HR 員工基礎", () => {
  it("管理者只能從現有 users 指派員工，已指派 user 不再出現在候選清單", async () => {
    const candidate = await (await request("/hr/candidates?search=self")).json() as { users: { userId: string; email: string }[] };
    expect(candidate.users).toEqual([{ userId: "self", displayName: "self", email: "self@example.test", status: "active" }]);
    await assign("self");
    expect((await request("/hr/employees", "POST", { userId: "self", employeeNumber: "E002", hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01" })).status).toBe(409);
    expect((await (await request("/hr/candidates?search=self")).json() as { users: unknown[] }).users).toEqual([]);
    expect((await request("/hr/employees", "POST", { employeeNumber: "E999", hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01" })).status).toBe(400);
    expect((await request("/hr/employers")).status).toBe(404);
  });

  it("員工姓名來自 user；只能修改員工編號，revision 過期不會留下成功稽核", async () => {
    await assign("self");
    const detail = await (await request("/hr/employees/self")).json() as { employee: { userId: string; displayName: string; email: string; revision: number } };
    expect(detail.employee).toMatchObject({ userId: "self", displayName: "self", email: "self@example.test", revision: 1 });
    expect((await request("/hr/employees/self", "PATCH", { employeeNumber: "E002", revision: 1 })).status).toBe(200);
    const count = auditCount();
    expect((await request("/hr/employees/self", "PATCH", { employeeNumber: "E003", revision: 1 })).status).toBe(409);
    expect(auditCount()).toBe(count);
    expect((await request("/hr/employees/self", "PATCH", { employeeNumber: "E003", revision: 0 })).status).toBe(400);
  });

  it("本人入口不需要另一個 HR read permission，且只使用 session user", async () => {
    await assign("self");
    const self = await request("/hr/me?userId=other", "GET", undefined, "self");
    expect(await self.json()).toMatchObject({ profile: { employee: { userId: "self" } } });
    expect((await request("/hr/employees/self", "GET", undefined, "self")).status).toBe(403);
    expect(await (await request("/hr/me", "GET", undefined, "other")).json()).toEqual({ profile: null });
    expect((await request("/hr/employees", "GET", undefined, "self")).status).toBe(403);
    const authMe = await (await request("/auth/me", "GET", undefined, "self")).json() as { isEmployee: boolean };
    expect(authMe.isEmployee).toBe(true);
  });

  it("任職重疊會拒絕，結束後復職新增歷史；未知與邀請中的 user 有明確限制", async () => {
    await assign("self");
    const job = await firstEmployment("self");
    expect((await request("/hr/employments", "POST", { userId: "self", hiredOn: "2026-02-01", endedOn: "2026-03-01", seniorityStartOn: "2026-01-01" })).status).toBe(409);
    expect((await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: "2026-02-01", revision: 1 })).status).toBe(200);
    await employment("self", { hiredOn: "2026-02-01" });
    const detail = await (await request("/hr/employees/self")).json() as { employments: unknown[] };
    expect(detail.employments).toHaveLength(2);
    expect((await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: "2026-03-01", revision: 2 })).status).toBe(409);
    expect((await request("/hr/employments", "POST", { userId: "missing", hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01" })).status).toBe(409);
    await expect(created("/hr/employees", { userId: "invited", employeeNumber: "E002", hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01" })).resolves.toBe("invited");
  });

  it("櫃點期間必須在任職內，關閉指派後才可離職；停用 scope 不可新增", async () => {
    await assign("self");
    const job = await firstEmployment("self");
    const assignment = await created("/hr/assignments", { employmentId: job, scopeId: "scope", validFrom: "2026-01-01" });
    expect((await request("/hr/assignments", "POST", { employmentId: job, scopeId: "scope", validFrom: "2026-02-01" })).status).toBe(409);
    expect((await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: "2026-02-01", revision: 1 })).status).toBe(409);
    expect((await request(`/hr/assignments/${assignment}/end`, "PATCH", { validTo: "2026-02-01", revision: 1 })).status).toBe(200);
    expect((await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: "2026-02-01", revision: 1 })).status).toBe(200);
    await db.update(scopes).set({ active: 0 }).where(eq(scopes.id, "scope"));
    expect((await (await request("/hr/scopes")).json() as { scopes: { id: string }[] }).scopes).toEqual([]);
    expect((await request("/hr/assignments", "POST", { employmentId: job, scopeId: "scope", validFrom: "2026-02-01" })).status).toBe(409);
  });

  it("拒絕不合法日曆日期、區間、未知關聯及錯誤頁碼", async () => {
    await assign("self");
    for (const hiredOn of ["2026-02-30", "2026-13-01", "2026-1-1"]) {
      expect((await request("/hr/employments", "POST", { userId: "self", hiredOn, seniorityStartOn: "2026-01-01" })).status).toBe(400);
    }
    expect((await request("/hr/employments", "POST", { userId: "missing", hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01" })).status).toBe(409);
    expect((await request("/hr/employees?page=0")).status).toBe(400);
    expect((await request("/hr/employees/missing")).status).toBe(404);
  });

  it("人事 user 不能刪除，停用只保留歷史；沒有員工紀錄的 invited user 仍可刪除", async () => {
    await assign("self");
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, "self"));
    expect((await request("/admin/users/self", "DELETE")).status).toBe(409);
    expect((await request("/admin/users/invited", "DELETE")).status).toBe(200);
    expect((await request("/hr/employees/self")).status).toBe(200);
    expect((await request("/hr/me", "GET", undefined, "self")).status).toBe(403);
  });

  it("共用操作紀錄排除人事；稽核失敗時人事寫入一起回滾", async () => {
    await assign("self");
    const activity = await listActivity(db, { source: "all", search: "", page: 1, pageSize: 50 });
    expect(activity.events).toEqual([]);
    expect((await listActivity(db, { source: "hr", search: "", page: 1, pageSize: 50 })).events).toEqual([]);
    d1.sqlite.exec("CREATE TRIGGER fail_hr_audit BEFORE INSERT ON activity_events WHEN NEW.source='hr' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
    expect((await request("/hr/employees", "POST", { userId: "other", employeeNumber: "FAILED", hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01" })).status).toBe(500);
    expect(d1.sqlite.prepare("SELECT user_id FROM hr_employees WHERE user_id='other'").get()).toBeUndefined();
  });

  it("同時新增重疊任職與同版本更新，均只有一個成功與一筆稽核", async () => {
    await assign("self");
    const initialEmployment = await firstEmployment("self");
    await request(`/hr/employments/${initialEmployment}/end`, "PATCH", { endedOn: "2026-02-01", revision: 1 });
    const count = auditCount();
    const results = await Promise.all(["2026-02-01", "2026-02-01"].map((hiredOn) => request("/hr/employments", "POST", { userId: "self", hiredOn, seniorityStartOn: "2026-01-01" })));
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const edits = await Promise.all(["甲", "乙"].map((employeeNumber) => request("/hr/employees/self", "PATCH", { employeeNumber, revision: 1 })));
    expect(edits.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(auditCount()).toBe(count + 2);
  });
});
