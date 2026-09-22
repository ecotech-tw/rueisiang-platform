import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { hrEmploymentAttendanceSettings, scopes, userPermissionGrants, userRoleAssignments, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "hr-test-secret-test-secret-test-secret";
let d1: LocalD1;
let cookies: Record<string, string>;
const env = () => ({ DB: d1, AUTH_SESSION_SECRET: SECRET, GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" });

async function request(path: string, method = "GET", payload?: Record<string, unknown>, actor = "admin") {
  return app.fetch(new Request(`https://test.local/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookies[actor] ? { Cookie: cookies[actor] } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  }), env() as never);
}

async function assign(userId: string, employeeNumber = "E001", position = "一般職員", revision?: number) {
  const response = await request("/hr/employees", "POST", { userId, employeeNumber, position, attendanceMode: "general", ...(revision === undefined ? {} : { revision }) });
  expect(response.status, await response.clone().text()).toBe(201);
  return await response.json() as { id: string; employmentId: string };
}

async function profile(userId: string) {
  return await (await request(`/hr/employees/${userId}`)).json() as {
    employee: { userId: string; employeeNumber: string; position: string; supervisorUserId: string | null; employmentStatus: string; archivedAt: string | null };
    employments: Array<{ id: string; employeeNumber: string; position: string; archivedAt: string | null; revision: number }>;
  };
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  const db = createDatabase(d1 as never);
  await syncSystemRoles(db);
  cookies = {};
  for (const id of ["admin", "self", "other", "invited", "disabled"]) {
    await db.insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: id === "invited" ? "invited" : id === "disabled" ? "disabled" : "active" });
    const token = await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET);
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
  }
  await db.insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  await db.insert(userPermissionGrants).values([
    { userId: "self", permission: "hr:employee:read" },
    { userId: "other", permission: "hr:employee:read" },
  ]);
  await db.insert(scopes).values({ id: "scope", sourceType: "manual", scopeKind: "store", name: "測試櫃點", normalizedName: "測試櫃點" });
});

afterEach(() => d1.sqlite.close());

describe("HR 扁平員工主檔", () => {
  it("由 hr_employments 存在性判定員工，並將員工編號、職位與主管放在同一列", async () => {
    const result = await assign("self", "E001", "門市專員");
    expect(result.id).toBe("self");
    expect(result.employmentId).toBeTruthy();
    const detail = await profile("self");
    expect(detail.employee).toMatchObject({ userId: "self", employeeNumber: "E001", position: "門市專員", employmentStatus: "active", archivedAt: null });
    expect(detail.employments).toHaveLength(1);
    expect(detail.employments[0]).toMatchObject({ id: result.employmentId, employeeNumber: "E001", position: "門市專員", archivedAt: null });
    expect((await (await request("/hr/candidates?search=self")).json() as { users: unknown[] }).users).toEqual([]);
  });

  it("升遷／調職只更新 position，不建立新的 employmentId", async () => {
    const first = await assign("self");
    const updated = await request("/hr/employees/self", "PATCH", { employeeNumber: "E001", position: "店長", revision: (await profile("self")).employments[0]!.revision });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const detail = await profile("self");
    expect(detail.employments).toHaveLength(1);
    expect(detail.employments[0]).toMatchObject({ id: first.employmentId, position: "店長" });
    const row = d1.sqlite.prepare("SELECT revision FROM hr_employments WHERE id=?").get(first.employmentId) as { revision: number };
    expect(row.revision).toBe(2);
    expect((await request("/hr/employees/self", "PATCH", { employeeNumber: "E001", position: "過期修改", revision: 1 })).status).toBe(409);
  });

  it("封存只寫 archivedAt，保留 employmentId、下游外鍵與稽核資料", async () => {
    const first = await assign("self");
    const settings = d1.sqlite.prepare("SELECT employment_id FROM hr_employment_attendance_settings WHERE employment_id=?").get(first.employmentId) as { employment_id: string };
    expect(settings.employment_id).toBe(first.employmentId);
    const response = await request(`/hr/employments/${first.employmentId}/archive`, "POST", { revision: (await profile("self")).employments[0]!.revision });
    expect(response.status, await response.clone().text()).toBe(200);
    const archived = await profile("self");
    expect(archived.employee.employmentStatus).toBe("inactive");
    expect(archived.employee.archivedAt).toEqual(expect.any(String));
    expect(archived.employments).toEqual([expect.objectContaining({ id: first.employmentId, archivedAt: expect.any(String), revision: 2 })]);
    expect((await (await request("/hr/employees?employmentStatus=active")).json() as { total: number }).total).toBe(0);
    expect((await (await request("/hr/employees?employmentStatus=inactive")).json() as { total: number }).total).toBe(1);
    expect(d1.sqlite.prepare("SELECT count(*) AS count FROM activity_events WHERE event_type='employment_archived'").get()).toEqual({ count: 1 });
  });

  it("重新指派同一位使用者會清除 archivedAt，不會建立第二筆任職", async () => {
    const first = await assign("self", "E001", "原職位");
    expect((await request(`/hr/employments/${first.employmentId}/archive`, "POST", { revision: (await profile("self")).employments[0]!.revision })).status).toBe(200);
    expect((await request("/hr/employees", "POST", { userId: "self", employeeNumber: "STALE", position: "過期職位", attendanceMode: "general", revision: 1 })).status).toBe(409);
    const second = await assign("self", "E002", "新職位", 2);
    expect(second.employmentId).toBe(first.employmentId);
    const detail = await profile("self");
    expect(detail.employments).toHaveLength(1);
    expect(detail.employments[0]).toMatchObject({ id: first.employmentId, employeeNumber: "E002", position: "新職位", archivedAt: null });
  });

  it("目前員工編號不可重複，封存後可由另一位員工使用", async () => {
    await assign("self", "DUP-1");
    const duplicate = await request("/hr/employees", "POST", { userId: "other", employeeNumber: "DUP-1", position: "一般職員" });
    expect(duplicate.status).toBe(409);
    const self = await profile("self");
    await request(`/hr/employments/${self.employments[0]!.id}/archive`, "POST", { revision: self.employments[0]!.revision });
    expect((await assign("other", "DUP-1")).employmentId).toBeTruthy();
  });

  it("員工資料與帳號狀態分離，邀請中的帳號可以指派、停用帳號不能新指派", async () => {
    await expect(assign("invited", "INV-1")).resolves.toBeTruthy();
    const disabled = await request("/hr/employees", "POST", { userId: "disabled", employeeNumber: "DIS-1", position: "一般職員" });
    expect(disabled.status).toBe(409);
  });

  it("主管只能指定另一位目前有效且啟用中的員工", async () => {
    await assign("self");
    await assign("other", "E002", "主管");
    const update = await request("/hr/employees/self/supervisor", "PATCH", { supervisorUserId: "other", revision: (await profile("self")).employments[0]!.revision });
    expect(update.status, await update.clone().text()).toBe(200);
    expect((await profile("self")).employee.supervisorUserId).toBe("other");
    expect((await request("/hr/employees/self/supervisor", "PATCH", { supervisorUserId: "self", revision: (await profile("self")).employments[0]!.revision })).status).toBe(409);
  });

  it("非 HR 讀取權限不能讀取員工列表", async () => {
    expect((await request("/hr/employees", "GET", undefined, "other")).status).toBe(200);
    expect((await request("/hr/employees", "GET", undefined, "invited")).status).toBe(403);
  });

  it("出勤設定更新不依賴任職日期或舊 hr_employees", async () => {
    const first = await assign("self");
    const response = await request(`/hr/employments/${first.employmentId}/attendance-mode`, "PATCH", { attendanceMode: "scheduled", monthlyRestDays: 8, revision: (await profile("self")).employments[0]!.revision });
    expect(response.status, await response.clone().text()).toBe(200);
    const db = createDatabase(d1 as never);
    const [setting] = await db.select().from(hrEmploymentAttendanceSettings).where(eq(hrEmploymentAttendanceSettings.employmentId, first.employmentId));
    expect(setting?.attendanceMode).toBe("scheduled");
  });
});