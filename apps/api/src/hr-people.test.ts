import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, listActivity, syncSystemRoles, taipeiWallClockToUtc } from "@rueisiang/db";
import { activityEvents, hrAttendanceLocations, hrClockEvents, hrScheduleEntries, hrScopeShiftAssignments, hrShiftTemplates, hrShiftVersions, scopes, userPermissionGrants, userRoleAssignments, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "hr-test-secret-test-secret-test-secret";
let d1: LocalD1;
let db: ReturnType<typeof createDatabase>;
let cookies: Record<string, string>;
const env = (googleMapsApiKey?: string) => ({
  DB: d1,
  AUTH_SESSION_SECRET: SECRET,
  GOOGLE_OAUTH_CLIENT_ID: "test",
  GOOGLE_OAUTH_CLIENT_SECRET: "test",
  ...(googleMapsApiKey ? { GOOGLE_MAPS_API_KEY: googleMapsApiKey } : {}),
});

async function request(path: string, method = "GET", payload?: Record<string, unknown>, actor = "admin", googleMapsApiKey?: string) {
  return app.fetch(new Request(`https://test.local/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookies[actor] ? { Cookie: cookies[actor] } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  }), env(googleMapsApiKey) as never);
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
function taipeiToday() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function dateOffset(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  db = createDatabase(d1 as never);
  await syncSystemRoles(db);
  cookies = {};
  for (const id of ["admin", "manager", "self", "other", "writer", "invited"]) {
    await db.insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: id === "invited" ? "invited" : "active" });
    const token = await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET);
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
  }
  await db.insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  await db.insert(userPermissionGrants).values([
    { userId: "manager", permission: "hr:schedule:read" }, { userId: "manager", permission: "hr:office:read" },
    { userId: "writer", permission: "hr:employee:read" }, { userId: "writer", permission: "hr:employee:write" }, { userId: "writer", permission: "hr:request:review" },
  ]);
  await db.insert(scopes).values({ id: "scope", sourceType: "manual", scopeKind: "store", name: "測試櫃點", normalizedName: "測試櫃點" });
});
afterEach(() => { vi.restoreAllMocks(); d1.sqlite.close(); });

describe("HR 員工基礎", () => {
  it("排班檢視不能讀取支援人員薪資資料", async () => {
    await created("/hr/schedule-workers", { displayName: "薪資不應外洩" });
    const response = await request("/hr/schedule-workers", "GET", undefined, "manager");
    expect(response.status).toBe(403);
  });

  it("排班月份只列出涵蓋該月份的有效任職", async () => {
    await created("/hr/employees", { userId: "self", employeeNumber: "FUTURE-1", hiredOn: "2026-09-01", seniorityStartOn: "2026-09-01" });
    const beforeHire = await request("/hr/schedules?periodKey=2026-08");
    expect(beforeHire.status, await beforeHire.clone().text()).toBe(200);
    expect((await beforeHire.json() as { employees: { userId: string }[] }).employees).toEqual([]);
    const afterHire = await request("/hr/schedules?periodKey=2026-09");
    expect(afterHire.status, await afterHire.clone().text()).toBe(200);
    expect((await afterHire.json() as { employees: { userId: string }[] }).employees).toEqual([expect.objectContaining({ userId: "self" })]);
  });

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

  it("出勤範圍讀取權限可取得員工摘要與出勤設定，但不能修改員工資料", async () => {
    await assign("self");
    expect((await request("/hr/employees?page=1&pageSize=100", "GET", undefined, "manager")).status).toBe(200);
    const officeOnly = await request("/hr/employees/self", "GET", undefined, "manager");
    expect(officeOnly.status).toBe(200);
    // 出勤權限只拿員工／任職／出勤設定，營運 scope 歷史不外流。
    const officeProfile = await officeOnly.json() as Record<string, unknown>;
    expect(officeProfile).toHaveProperty("employments");
    expect(officeProfile).toHaveProperty("attendanceAssignments");
    expect(officeProfile).not.toHaveProperty("assignments");
    expect(await (await request("/hr/employees/self")).json()).toHaveProperty("assignments");
    expect((await request("/hr/employees/self", "PATCH", { employeeNumber: "NOPE", revision: 1 }, "manager")).status).toBe(403);
  });

  it("出勤範圍的辦公位置選單回傳全部啟用中的位置，不受分頁上限影響", async () => {
    await db.insert(hrAttendanceLocations).values(Array.from({ length: 101 }, (_, index) => ({ id: `bulk-location-${index}`, name: `大量位置 ${String(index).padStart(3, "0")}`, geolocationRequired: 0, radiusMeters: 100 })));
    await db.insert(hrAttendanceLocations).values({ id: "inactive-location", name: "已停用位置", geolocationRequired: 0, radiusMeters: 100, active: 0 });
    const response = await request("/hr/attendance-settings/locations?active=1", "GET", undefined, "manager");
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { locations: Array<{ id: string }>; hasMore?: boolean };
    expect(body.locations).toHaveLength(101);
    expect(body.locations.some((location) => location.id === "inactive-location")).toBe(false);
    expect(body).not.toHaveProperty("hasMore");
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

  it("管理頁名單包含還沒登入過的邀請中員工，只排除停用帳號", async () => {
    await assign("self", "E001");
    await assign("invited", "E002");
    await assign("other", "E003");
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, "other"));
    const list = async (status: string) => (await (await request(`/hr/employees?page=1&pageSize=100&status=${status}&sortField=employeeNumber&sortDirection=asc`)).json() as { employees: { userId: string }[]; total: number });
    const roster = await list("employable");
    expect(roster.employees.map((employee) => employee.userId)).toEqual(["self", "invited"]);
    expect(roster.total).toBe(2);
    expect((await list("active")).employees.map((employee) => employee.userId)).toEqual(["self"]);
  });

  it("任職分頁分開計算在職與未在職，且最近一次任職操作可復原", async () => {
    const today = taipeiToday();
    await created("/hr/employees", { userId: "self", employeeNumber: "E001", hiredOn: dateOffset(today, -1), seniorityStartOn: dateOffset(today, -1) });
    await created("/hr/employees", { userId: "other", employeeNumber: "E002", hiredOn: dateOffset(today, 1), seniorityStartOn: dateOffset(today, 1) });

    const active = await (await request("/hr/employees?page=1&pageSize=100&employmentStatus=active")).json() as { employees: { userId: string }[]; counts: { active: number; inactive: number } };
    expect(active.employees.map((employee) => employee.userId)).toEqual(["self"]);
    expect(active.counts).toEqual({ active: 1, inactive: 1 });
    const inactive = await (await request("/hr/employees?page=1&pageSize=100&employmentStatus=inactive")).json() as { employees: { userId: string }[] };
    expect(inactive.employees.map((employee) => employee.userId)).toEqual(["other"]);

    const job = await firstEmployment("self");
    const ended = await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: today, revision: 1 });
    expect(ended.status, await ended.clone().text()).toBe(200);
    const endOperation = await ended.json() as { operationId: string };
    const endedDetail = await (await request("/hr/employees/self")).json() as { employee: { employmentStatus: string }; employments: { endedOn: string | null }[]; lastEmploymentAction: { id: string } };
    expect(endedDetail.employee.employmentStatus).toBe("inactive");
    expect(endedDetail.employments[0]?.endedOn).toBe(today);
    expect(endedDetail.lastEmploymentAction.id).toBe(endOperation.operationId);

    const undoneEnd = await request(`/hr/employment-actions/${endOperation.operationId}/undo`, "POST", {});
    expect(undoneEnd.status, await undoneEnd.clone().text()).toBe(200);
    const restored = await (await request("/hr/employees/self")).json() as { employee: { employmentStatus: string }; employments: { endedOn: string | null }[] };
    expect(restored.employee.employmentStatus).toBe("active");
    expect(restored.employments[0]?.endedOn).toBeNull();

    expect((await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: today, revision: 3 })).status).toBe(200);
    const rehired = await request("/hr/employments", "POST", { userId: "self", hiredOn: today, seniorityStartOn: today });
    expect(rehired.status, await rehired.clone().text()).toBe(201);
    const rehireOperation = await rehired.json() as { operationId: string; id: string };
    expect((await request(`/hr/employment-actions/${rehireOperation.operationId}/undo`, "POST", {})).status).toBe(200);
    expect((await (await request("/hr/employees/self")).json() as { employments: unknown[] }).employments).toHaveLength(1);
  });

  it("初次指派也能復原，且會恢復候選人狀態", async () => {
    const response = await request("/hr/employees", "POST", { userId: "self", employeeNumber: "E001", hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01" });
    expect(response.status, await response.clone().text()).toBe(201);
    const operationId = (await response.json() as { operationId: string }).operationId;
    expect((await request(`/hr/employment-actions/${operationId}/undo`, "POST", {})).status).toBe(200);
    expect((await request("/hr/employees/self")).status).toBe(404);
    expect((await (await request("/hr/candidates?search=self")).json() as { users: { userId: string }[] }).users).toEqual([expect.objectContaining({ userId: "self" })]);
  });

  it("可以修正任職到職日與年資認列日，並在新增歷史關聯後阻擋到職日改寫", async () => {
    await assign("self");
    const job = await firstEmployment("self");
    const updated = await request(`/hr/employments/${job}`, "PATCH", { hiredOn: "2025-12-01", seniorityStartOn: "2025-11-01", revision: 1 });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const changed = await (await request("/hr/employees/self")).json() as { employments: { hiredOn: string; seniorityStartOn: string; revision: number }[]; lastEmploymentAction: unknown };
    expect(changed.employments[0]).toMatchObject({ hiredOn: "2025-12-01", seniorityStartOn: "2025-11-01", revision: 2 });
    // 日期修正會遞增任職 revision，前一筆「新增任職」復原索引因此失效，避免改日期後又誤復原舊操作。
    expect(changed.lastEmploymentAction).toBeNull();

    await created("/hr/assignments", { employmentId: job, scopeId: "scope", validFrom: "2026-01-01" });
    const blocked = await request(`/hr/employments/${job}`, "PATCH", { hiredOn: "2026-02-01", seniorityStartOn: "2026-01-01", revision: 2 });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: expect.stringContaining("新的到職日前") });
  });

  it("輸入錯誤的任職可以刪除並保留稽核資料，之後能重新建立正確任職", async () => {
    await assign("self");
    const job = await firstEmployment("self");
    const deleted = await request(`/hr/employments/${job}`, "DELETE", { revision: 1 });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const detail = await (await request("/hr/employees/self")).json() as { employee: { employmentStatus: string }; employments: unknown[]; lastEmploymentAction: unknown };
    expect(detail.employee.employmentStatus).toBe("inactive");
    expect(detail.employments).toEqual([]);
    expect(detail.lastEmploymentAction).toBeNull();
    expect(d1.sqlite.prepare("SELECT revoked_at, revoked_by FROM hr_employments WHERE id=?").get(job)).toEqual({ revoked_at: expect.any(String), revoked_by: "admin" });
    expect((d1.sqlite.prepare("SELECT event_type, summary FROM activity_events WHERE entity_id=? ORDER BY rowid DESC LIMIT 1").get(job) as { event_type: string; summary: string })).toEqual({ event_type: "employment_deleted", summary: "任職資料已刪除" });
    await expect(employment("self", { hiredOn: "2026-01-01" })).resolves.toBeDefined();
  });

  it("有營運據點歸屬歷史的任職仍可刪除，但保留下游歷史且禁止新增關聯", async () => {
    await assign("self");
    const job = await firstEmployment("self");
    const assignment = await created("/hr/assignments", { employmentId: job, scopeId: "scope", validFrom: "2026-01-01" });
    const deleted = await request(`/hr/employments/${job}`, "DELETE", { revision: 1 });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const detail = await (await request("/hr/employees/self")).json() as {
      employee: { employmentStatus: string };
      employments: unknown[];
      assignments: unknown[];
    };
    expect(detail.employee.employmentStatus).toBe("inactive");
    expect(detail.employments).toEqual([]);
    expect(detail.assignments).toEqual([]);
    expect(d1.sqlite.prepare("SELECT id, employment_id, valid_to FROM hr_employee_scopes WHERE id=?").get(assignment)).toEqual({ id: assignment, employment_id: job, valid_to: null });
    expect((await request("/hr/assignments", "POST", { employmentId: job, scopeId: "scope", validFrom: "2026-02-01" })).status).toBe(409);
  });

  it("任職最近一次異動被後續修改後不能復原", async () => {
    const today = taipeiToday();
    await created("/hr/employees", { userId: "self", employeeNumber: "E001", hiredOn: dateOffset(today, -1), seniorityStartOn: dateOffset(today, -1) });
    const job = await firstEmployment("self");
    const ended = await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: today, revision: 1 });
    const operationId = (await ended.json() as { operationId: string }).operationId;
    expect((await request(`/hr/employments/${job}/attendance-mode`, "PATCH", { attendanceMode: "scheduled", monthlyRestDays: 8, revision: 2 })).status).toBe(200);
    const undo = await request(`/hr/employment-actions/${operationId}/undo`, "POST", {});
    expect(undo.status).toBe(409);
    expect(await undo.json()).toMatchObject({ error: "這筆任職資料在復原前已被其他人修改，請重新整理後確認。" });
  });

  it("營運據點歸屬會隨任職結束自動收合；停用據點不可新增", async () => {
    await assign("self");
    const job = await firstEmployment("self");
    const assignment = await created("/hr/assignments", { employmentId: job, scopeId: "scope", validFrom: "2026-01-01", validTo: "2026-03-01" });
    expect((await request("/hr/assignments", "POST", { employmentId: job, scopeId: "scope", validFrom: "2026-02-01" })).status).toBe(409);
    const ended = await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: "2026-02-01", revision: 1 });
    expect(ended.status, await ended.clone().text()).toBe(200);
    const operationId = (await ended.json() as { operationId: string }).operationId;
    const endedDetail = await (await request("/hr/employees/self")).json() as { assignments: { id: string; validTo: string | null }[]; employments: { endedOn: string | null }[] };
    expect(endedDetail.employments[0]?.endedOn).toBe("2026-02-01");
    expect(endedDetail.assignments.find((row) => row.id === assignment)).toMatchObject({ validTo: "2026-02-01" });
    expect((await request(`/hr/employment-actions/${operationId}/undo`, "POST", {})).status).toBe(200);
    const restored = await (await request("/hr/employees/self")).json() as { assignments: { id: string; validTo: string | null }[]; employments: { endedOn: string | null }[] };
    expect(restored.employments[0]?.endedOn).toBeNull();
    expect(restored.assignments.find((row) => row.id === assignment)).toMatchObject({ validTo: "2026-03-01" });
    const endedAgain = await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: "2026-02-01", revision: 3 });
    expect(endedAgain.status, await endedAgain.clone().text()).toBe(200);
    await db.update(scopes).set({ active: 0 }).where(eq(scopes.id, "scope"));
    expect((await (await request("/hr/scopes")).json() as { scopes: { id: string }[] }).scopes).toEqual([]);
    expect((await request("/hr/assignments", "POST", { employmentId: job, scopeId: "scope", validFrom: "2026-02-01" })).status).toBe(409);
  });

  it("出勤設定獨立管理辦公位置，並由員工端指派期間", async () => {
    await assign("self");
    const job = await firstEmployment("self");
    const location = await created("/hr/attendance-settings/locations", {
      name: "台北櫃",
      geolocationRequired: true,
      latitude: 25.0330,
      longitude: 121.5654,
      radiusMeters: 50,
      active: true,
    });
    const listed = await (await request("/hr/attendance-settings/locations")).json() as { locations: { id: string; hasCoordinates: boolean; geolocationRequired: boolean; revision: number }[] };
    expect(listed.locations[0]).toMatchObject({ id: location, hasCoordinates: true, geolocationRequired: true, revision: 1 });
    expect(listed.locations[0]).not.toHaveProperty("latitude");
    const detail = await (await request(`/hr/attendance-settings/locations/${location}`)).json() as { location: { latitude: number; longitude: number } };
    expect(detail.location).toMatchObject({ latitude: 25.033, longitude: 121.5654 });
    expect((await request("/hr/attendance-settings/locations", "POST", { name: "無定位辦公室", geolocationRequired: false, latitude: null, longitude: null, radiusMeters: 1, active: true })).status).toBe(201);
    expect((await request("/hr/attendance-settings/locations", "POST", { name: "錯誤座標", geolocationRequired: true, latitude: 91, longitude: 121, radiusMeters: 50, active: true })).status).toBe(400);
    const secondLocation = await created("/hr/attendance-settings/locations", { name: "新竹櫃", geolocationRequired: true, latitude: 24.8138, longitude: 120.9675, radiusMeters: 100, active: true });
    const assignment = await created(`/hr/employments/${job}/attendance-location`, { locationId: location, validFrom: "2026-01-01", validTo: null });
    const secondAssignment = await created(`/hr/employments/${job}/attendance-location`, { locationId: secondLocation, validFrom: "2026-01-01", validTo: null });
    const afterAssign = await (await request("/hr/attendance-settings/locations")).json() as { locations: { id: string }[] };
    expect(afterAssign.locations[0]).not.toHaveProperty("employees");
    const employeeDetail = await (await request("/hr/employees/self")).json() as { attendanceAssignments: { id: string; locationName: string }[] };
    expect(employeeDetail.attendanceAssignments).toEqual(expect.arrayContaining([expect.objectContaining({ id: assignment, locationName: "台北櫃" }), expect.objectContaining({ id: secondAssignment, locationName: "新竹櫃" })]));
    expect((await request(`/hr/employments/${job}/attendance-location`, "POST", { locationId: location, validFrom: "2026-01-01", validTo: null })).status).toBe(409);
    expect((await request(`/hr/attendance-settings/locations/${location}`, "PATCH", { name: "台北櫃更新", geolocationRequired: true, latitude: 25.033, longitude: 121.5654, radiusMeters: 100, active: true, revision: 1 })).status).toBe(200);
    expect((await request(`/hr/attendance-settings/locations/${location}`, "PATCH", { name: "過期版本", geolocationRequired: true, latitude: 25.033, longitude: 121.5654, radiusMeters: 100, active: true, revision: 1 })).status).toBe(409);
    expect((await request("/hr/attendance-settings/locations", "POST", { name: "writer 不可新增", geolocationRequired: false, latitude: null, longitude: null, radiusMeters: 50, active: true }, "writer")).status).toBe(403);
    const ended = await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: "2026-02-01", revision: 1 });
    expect(ended.status, await ended.clone().text()).toBe(200);
    const endedDetail = await (await request("/hr/employees/self")).json() as { attendanceAssignments: { id: string; validTo: string | null; isPrimary: boolean }[] };
    expect(endedDetail.attendanceAssignments.find((row) => row.id === assignment)).toMatchObject({ validTo: "2026-02-01", isPrimary: false });
    expect(endedDetail.attendanceAssignments.find((assignment) => assignment.id === secondAssignment)).toMatchObject({ validTo: "2026-02-01", isPrimary: false });
  });

  it("出勤範圍更新會以單一交易保存方式與多個辦公位置", async () => {
    await assign("self", "SCOPE-1");
    const job = await firstEmployment("self");
    const firstLocation = await created("/hr/attendance-settings/locations", { name: "範圍一", geolocationRequired: false, latitude: null, longitude: null, radiusMeters: 100, active: true });
    const secondLocation = await created("/hr/attendance-settings/locations", { name: "範圍二", geolocationRequired: false, latitude: null, longitude: null, radiusMeters: 100, active: true });
    const firstSave = await request(`/hr/employments/${job}/attendance-scope`, "PATCH", { attendanceMode: "scheduled", monthlyRestDays: 8, revision: 1, locationIds: [firstLocation, secondLocation], assignmentsToEnd: [] });
    expect(firstSave.status, await firstSave.clone().text()).toBe(200);
    const firstProfile = await (await request("/hr/employees/self")).json() as { employments: Array<{ attendanceMode: string; monthlyRestDays: number | null }>; attendanceAssignments: Array<{ id: string; locationId: string; revision: number; isPrimary: boolean }> };
    expect(firstProfile.employments[0]).toMatchObject({ attendanceMode: "scheduled", monthlyRestDays: 8 });
    const firstAssignment = firstProfile.attendanceAssignments.find((assignment) => assignment.locationId === firstLocation);
    expect(firstAssignment).toBeDefined();
    // 第一次加位置就要有主要位置，不能等人另外去按「設為主要」。
    expect(firstAssignment).toMatchObject({ isPrimary: true });
    const secondSave = await request(`/hr/employments/${job}/attendance-scope`, "PATCH", { attendanceMode: "scheduled", monthlyRestDays: 8, revision: 2, locationIds: [], assignmentsToEnd: [{ id: firstAssignment!.id, revision: firstAssignment!.revision }] });
    expect(secondSave.status, await secondSave.clone().text()).toBe(200);
    const secondProfile = await (await request("/hr/employees/self")).json() as { attendanceAssignments: Array<{ locationId: string; validTo: string | null; isPrimary: boolean }> };
    expect(secondProfile.attendanceAssignments.find((assignment) => assignment.locationId === firstLocation)).toMatchObject({ validTo: dateOffset(taipeiToday(), 1), isPrimary: false });
    // 結束的是主要位置時，主要位置改指還有效的那一筆。
    expect(secondProfile.attendanceAssignments.find((assignment) => assignment.locationId === secondLocation)).toMatchObject({ validTo: null, isPrimary: true });

    const failed = await request(`/hr/employments/${job}/attendance-scope`, "PATCH", { attendanceMode: "general", monthlyRestDays: null, revision: 3, locationIds: ["missing-location"], assignmentsToEnd: [] });
    expect(failed.status).toBe(409);
    const unchanged = await (await request("/hr/employees/self")).json() as { employments: Array<{ attendanceMode: string; monthlyRestDays: number | null }> };
    expect(unchanged.employments[0]).toMatchObject({ attendanceMode: "scheduled", monthlyRestDays: 8 });
  });

  it("Google Maps 搜尋結果會直接回傳可儲存的座標", async () => {
    const responseWithoutKey = await request("/hr/attendance-settings/places?query=台北辦公室");
    expect(responseWithoutKey.status).toBe(503);
    const mapsFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ places: [{ id: "place-1", displayName: { text: "台北 101" }, formattedAddress: "台北市信義區信義路五段 7 號", location: { latitude: 25.0339, longitude: 121.5645 } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const response = await request("/hr/attendance-settings/places?query=台北101", "GET", undefined, "admin", "maps-test-key");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ places: [{ id: "place-1", name: "台北 101", address: "台北市信義區信義路五段 7 號", latitude: 25.0339, longitude: 121.5645 }] });
    expect(mapsFetch).toHaveBeenCalledOnce();
  });

  it("補打卡申請會帶入主管、保留審核狀態，並讓日曆顯示目前月份", async () => {
    await assign("self");
    await assign("other", "E002");
    expect((await request("/hr/employees/self/supervisor", "PATCH", { supervisorUserId: "other", revision: 1 })).status).toBe(200);
    const approvers = await (await request("/hr/me/form-approvers", "GET", undefined, "self")).json() as { defaultApproverUserId: string | null };
    expect(approvers.defaultApproverUserId).toBe("other");
    const correctionDate = taipeiToday();
    const createdRequest = await created("/hr/me/form-requests", { correctionDate, requestedTime: "09:00", requestedEventKind: "clock_in", reason: "手機故障，無法完成打卡。", approverUserId: null }, "self");
    expect((await (await request("/hr/me/form-requests", "GET", undefined, "self")).json() as { requests: { status: string; approverUserId: string | null }[] }).requests[0]).toMatchObject({ status: "draft", approverUserId: "other" });
    expect((await request(`/hr/me/form-requests/${createdRequest}/submit`, "POST", {}, "self")).status).toBe(200);
    const reviewList = await (await request("/hr/me/form-requests", "GET", undefined, "other")).json() as { reviewRequests: { id: string; status: string }[] };
    expect(reviewList.reviewRequests).toEqual([expect.objectContaining({ id: createdRequest, status: "pending" })]);
    expect((await request(`/hr/me/form-requests/${createdRequest}/review`, "POST", { decision: "approved", comment: "核准。" }, "other")).status).toBe(200);
    expect((await (await request("/hr/me/form-requests", "GET", undefined, "self")).json() as { requests: { status: string; reviewComment: string | null }[] }).requests[0]).toMatchObject({ status: "approved", reviewComment: "核准。" });
    const correctedEvents = await db.select({ eventKind: hrClockEvents.eventKind, correctionRequestId: hrClockEvents.correctionRequestId, occurredAt: hrClockEvents.occurredAt }).from(hrClockEvents).where(eq(hrClockEvents.correctionRequestId, createdRequest));
    expect(correctedEvents).toEqual([{ eventKind: "clock_in", correctionRequestId: createdRequest, occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) }]);
    const calendar = await (await request(`/hr/me/attendance-calendar?year=${correctionDate.slice(0, 4)}&month=${correctionDate.slice(5, 7)}`, "GET", undefined, "self")).json() as { today: string; days: { date: string; status: string }[] };
    expect(calendar.today).toBe(correctionDate);
    expect(calendar.days.find((day) => day.date === correctionDate)?.status).toBe("present");
  });

  it("沒有主管或指定審核者時不能送出補打卡申請", async () => {
    await assign("self");
    const id = await created("/hr/me/form-requests", {
      correctionDate: taipeiToday(), requestedTime: "09:00", requestedEventKind: "clock_in", reason: "未指定審核者測試。", approverUserId: null,
    }, "self");
    expect((await request(`/hr/me/form-requests/${id}/submit`, "POST", {}, "self")).status).toBe(400);
    expect((await (await request(`/hr/me/form-requests/${id}`, "GET", undefined, "self")).json() as { request: { status: string } }).request.status).toBe("draft");
  });

  it("本人可用目前位置打卡，伺服器決定上下班與時間且重試不重複", async () => {
    const today = taipeiToday();
    await created("/hr/employees", { userId: "self", employeeNumber: "CLOCK-1", hiredOn: today, seniorityStartOn: today });
    const job = await firstEmployment("self");
    const location = await created("/hr/attendance-settings/locations", { name: "打卡辦公室", geolocationRequired: true, latitude: 25.033, longitude: 121.5654, radiusMeters: 100, active: true });
    const secondLocation = await created("/hr/attendance-settings/locations", { name: "另一個打卡辦公室", geolocationRequired: true, latitude: 25.033, longitude: 121.5000, radiusMeters: 100, active: true });
    await created(`/hr/employments/${job}/attendance-location`, { locationId: location, validFrom: today, validTo: null });
    await created(`/hr/employments/${job}/attendance-location`, { locationId: secondLocation, validFrom: today, validTo: null });
    expect((await request("/hr/me/clock-events", "GET", undefined, "self")).status).toBe(200);
    const status = await (await request("/hr/me/clock-events", "GET", undefined, "self")).json() as { locationNames: string[] };
    expect(status.locationNames).toEqual(expect.arrayContaining(["打卡辦公室", "另一個打卡辦公室"]));
    expect((await (await request("/hr/me/attendance-location/check", "POST", { latitude: 25.033, longitude: 121.5654 }, "self")).json() as { withinRadius: boolean }).withinRadius).toBe(true);
    expect((await (await request("/hr/me/attendance-location/check", "POST", { latitude: 25.033, longitude: 121.5000 }, "self")).json() as { withinRadius: boolean }).withinRadius).toBe(true);
    expect((await (await request("/hr/me/attendance-location/check", "POST", { latitude: 0, longitude: 0 }, "self")).json() as { withinRadius: boolean }).withinRadius).toBe(false);
    const mapFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("map", { status: 200, headers: { "Content-Type": "image/png" } }));
    const mapResponse = await request("/hr/me/attendance-map", "GET", undefined, "self", "maps-test-key");
    expect(mapResponse.status).toBe(200);
    expect(mapResponse.headers.get("Content-Type")).toBe("image/png");
    expect(String(mapFetch.mock.calls[0]?.[0])).toContain("maps.googleapis.com/maps/api/staticmap");
    mapFetch.mockRestore();
    expect((await (await request("/hr/me/clock-events", "GET", undefined, "self")).json() as { canClock: boolean; nextEventKind: string }).nextEventKind).toBe("clock_in");

    const first = await request("/hr/me/clock-events", "POST", { idempotencyKey: "clock-request-1", latitude: 25.033, longitude: 121.5654 }, "self");
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { event: { id: string; eventKind: string; occurredAt: string; distanceMeters: number | null } };
    expect(firstBody.event).toMatchObject({ eventKind: "clock_in", distanceMeters: 0 });
    expect(firstBody.event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2} /);

    const retry = await request("/hr/me/clock-events", "POST", { idempotencyKey: "clock-request-1", latitude: 0, longitude: 0 }, "self");
    expect(retry.status).toBe(200);
    expect((await retry.json() as { event: { id: string } }).event.id).toBe(firstBody.event.id);
    const second = await request("/hr/me/clock-events", "POST", { idempotencyKey: "clock-request-2", latitude: 25.033, longitude: 121.5654 }, "self");
    expect(second.status).toBe(201);
    expect((await second.json() as { event: { eventKind: string } }).event.eventKind).toBe("clock_out");
    const calendar = await (await request(`/hr/me/attendance-calendar?year=${today.slice(0, 4)}&month=${today.slice(5, 7)}`, "GET", undefined, "self")).json() as {
      days: { date: string; eventCount: number; anomaly: string | null; events: { eventKind: string }[] }[];
    };
    expect(calendar.days.find((day) => day.date === today)).toMatchObject({ eventCount: 2, anomaly: "short-duration", anomalyMessage: expect.stringContaining("出勤僅"), events: [{ eventKind: "clock_in" }, { eventKind: "clock_out" }] });
    expect((await request("/hr/me/clock-events", "POST", { idempotencyKey: "clock-request-far", latitude: 0, longitude: 0 }, "self")).status).toBe(400);
  });

  it("排班只決定工作時段，打卡位置仍需員工授權，且停用位置不再可用", async () => {
    const today = taipeiToday();
    await assign("self", "SCHEDULED-1");
    const job = await firstEmployment("self");
    expect((await request(`/hr/employments/${job}/attendance-mode`, "PATCH", { attendanceMode: "scheduled", revision: 1 })).status).toBe(200);
    const location = await created("/hr/attendance-settings/locations", { name: "排班打卡據點", scopeId: "scope", geolocationRequired: false, latitude: null, longitude: null, radiusMeters: 100, active: true });
    const shift = await request("/hr/shift-templates", "POST", { scopeId: "scope", name: "日班", startTime: "09:00", endTime: "17:00" });
    expect(shift.status, await shift.clone().text()).toBe(201);
    const shiftId = (await shift.json() as { versionId: string }).versionId;
    const saved = await request("/hr/schedules", "POST", { periodKey: today.slice(0, 7), entries: [{ personKind: "employee", employmentId: job, scopeId: "scope", shiftVersionId: shiftId, workDate: today }] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect((await (await request("/hr/me/clock-events", "GET", undefined, "self")).json() as { canClock: boolean; locationNames: string[] }).locationNames).not.toContain("排班打卡據點");
    await created(`/hr/employments/${job}/attendance-location`, { locationId: location, validFrom: today, validTo: null });
    expect((await (await request("/hr/me/clock-events", "GET", undefined, "self")).json() as { canClock: boolean; locationNames: string[] }).locationNames).toContain("排班打卡據點");
    const clockedIn = await request("/hr/me/clock-events", "POST", { idempotencyKey: "scheduled-clock-in", latitude: null, longitude: null }, "self");
    expect(clockedIn.status, await clockedIn.clone().text()).toBe(201);
    expect((await clockedIn.json() as { event: { eventKind: string } }).event.eventKind).toBe("clock_in");
    await db.update(hrAttendanceLocations).set({ active: 0 }).where(eq(hrAttendanceLocations.id, location));
    expect((await (await request("/hr/me/clock-events", "GET", undefined, "self")).json() as { canClock: boolean }).canClock).toBe(false);
  });

  it("同一天排兩段班時，打卡異常對照最接近的那一段", async () => {
    /*
     * 固定在台北時間 14:05 打卡。只假造 Date，並重新簽 session：beforeEach 用真實時間簽的 cookie
     * 在假造的時間上可能已經過期。
     */
    vi.useFakeTimers({ now: new Date("2026-10-15T06:05:00.000Z"), toFake: ["Date"] });
    try {
      for (const id of ["admin", "self"]) {
        const token = await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET);
        cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
      }
      const today = "2026-10-15";
      await assign("self", "SPLIT-1");
      const job = await firstEmployment("self");
      expect((await request(`/hr/employments/${job}/attendance-mode`, "PATCH", { attendanceMode: "scheduled", revision: 1 })).status).toBe(200);
      const location = await created("/hr/attendance-settings/locations", { name: "兩段班據點", scopeId: "scope", geolocationRequired: false, latitude: null, longitude: null, radiusMeters: 100, active: true });
      await created(`/hr/employments/${job}/attendance-location`, { locationId: location, validFrom: today, validTo: null });
      const shiftVersion = async (name: string, startTime: string, endTime: string) => {
        const response = await request("/hr/shift-templates", "POST", { scopeId: "scope", name, startTime, endTime, standardMinutes: 120, breakMinutes: 0 });
        expect(response.status, await response.clone().text()).toBe(201);
        return (await response.json() as { versionId: string }).versionId;
      };
      const morning = await shiftVersion("上午班", "09:00", "12:00");
      const afternoon = await shiftVersion("下午班", "14:00", "18:00");
      const saved = await request("/hr/schedules", "POST", { periodKey: "2026-10", entries: [
        { personKind: "employee", employmentId: job, scopeId: "scope", shiftVersionId: morning, workDate: today },
        { personKind: "employee", employmentId: job, scopeId: "scope", shiftVersionId: afternoon, workDate: today },
      ] });
      expect(saved.status, await saved.clone().text()).toBe(200);

      const clockedIn = await request("/hr/me/clock-events", "POST", { idempotencyKey: "split-clock-in", latitude: null, longitude: null }, "self");
      expect(clockedIn.status, await clockedIn.clone().text()).toBe(201);
      // 14:05 上班對的是下午班（14:00 開始、寬限 10 分鐘），不是上午班的「遲到五小時」。
      expect((await clockedIn.json() as { event: unknown }).event).toMatchObject({ eventKind: "clock_in", expectedStartMinute: 14 * 60, expectedEndMinute: 18 * 60, timeAnomalyKind: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("排班員工可以保存每月休假天數，班別的計薪工時等於班別長度", async () => {
    await assign("self", "REST-1");
    const job = await firstEmployment("self");
    const updated = await request(`/hr/employments/${job}/attendance-mode`, "PATCH", { attendanceMode: "scheduled", monthlyRestDays: 10, revision: 1 });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const profile = await (await request("/hr/employees/self")).json() as { employments: Array<{ attendanceMode: string; monthlyRestDays: number | null }> };
    expect(profile.employments[0]).toMatchObject({ attendanceMode: "scheduled", monthlyRestDays: 10 });
    const invalid = await request(`/hr/employments/${job}/attendance-mode`, "PATCH", { attendanceMode: "scheduled", monthlyRestDays: 32, revision: 2 });
    expect(invalid.status).toBe(400);
    // 舊客戶端只送出勤方式：休假天數要留著，不然排班發布的休假檢查會被靜靜關掉。
    const legacy = await request(`/hr/employments/${job}/attendance-mode`, "PATCH", { attendanceMode: "scheduled", revision: 2 });
    expect(legacy.status, await legacy.clone().text()).toBe(200);
    const kept = await (await request("/hr/employees/self")).json() as { employments: Array<{ monthlyRestDays: number | null }> };
    expect(kept.employments[0]?.monthlyRestDays).toBe(10);

    const shift = await request("/hr/shift-templates", "POST", { scopeId: "scope", name: "假日晚班", startTime: "13:00", endTime: "22:00", standardMinutes: 480, breakMinutes: 60 });
    expect(shift.status, await shift.clone().text()).toBe(201);
    const listed = await (await request("/hr/shift-templates")).json() as { shifts: Array<{ name: string; standardMinutes: number; breakMinutes: number }> };
    expect(listed.shifts.find((item) => item.name === "假日晚班")).toMatchObject({ standardMinutes: 540, breakMinutes: 0 });
    const month = taipeiToday().slice(0, 7);
    const year = Number(month.slice(0, 4));
    const monthNumber = Number(month.slice(5, 7));
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const shiftBody = await shift.json() as { id: string; versionId: string };
    const shiftId = shiftBody.versionId;
    const validEntries = Array.from({ length: lastDay - 10 }, (_, index) => {
      const day = index + 11;
      return { personKind: "employee", employmentId: job, scopeId: "scope", shiftVersionId: shiftId, workDate: `${month}-${String(day).padStart(2, "0")}` };
    });
    const published = await request("/hr/schedules", "POST", { periodKey: month, entries: validEntries });
    expect(published.status, await published.clone().text()).toBe(200);
    const publishedVersion = await published.json() as { id: string; revision: number };
    const snapshot = await db.select({ startsAt: hrScheduleEntries.startsAt, endsAt: hrScheduleEntries.endsAt, standardMinutes: hrScheduleEntries.standardMinutes, breakMinutes: hrScheduleEntries.breakMinutes }).from(hrScheduleEntries).where(eq(hrScheduleEntries.employmentId, job)).limit(1);
    expect(snapshot[0]).toMatchObject({ startsAt: `${month}-11 13:00:00`, endsAt: `${month}-11 22:00:00`, standardMinutes: 540, breakMinutes: 0 });
    const changedShift = await request(`/hr/shift-templates/${shiftBody.id}`, "PATCH", { scopeId: "scope", name: "假日晚班更新", startTime: "14:00", endTime: "22:00", standardMinutes: 420, breakMinutes: 60, revision: 1 });
    expect(changedShift.status, await changedShift.clone().text()).toBe(200);
    const [shiftAudit] = await db.select({ payloadJson: activityEvents.payloadJson }).from(activityEvents).where(eq(activityEvents.eventType, "shift_updated"));
    expect(JSON.parse(shiftAudit?.payloadJson ?? "{}")).toMatchObject({ name: "假日晚班更新", standardMinutes: 480, breakMinutes: 0 });
    const unchangedSnapshot = await db.select({ startsAt: hrScheduleEntries.startsAt, endsAt: hrScheduleEntries.endsAt, standardMinutes: hrScheduleEntries.standardMinutes, breakMinutes: hrScheduleEntries.breakMinutes }).from(hrScheduleEntries).where(eq(hrScheduleEntries.employmentId, job)).limit(1);
    expect(unchangedSnapshot[0]).toMatchObject({ startsAt: `${month}-11 13:00:00`, endsAt: `${month}-11 22:00:00`, standardMinutes: 540, breakMinutes: 0 });
    const invalidSchedule = await request("/hr/schedules", "POST", { periodKey: month, scheduleVersionId: publishedVersion.id, revision: publishedVersion.revision, entries: Array.from({ length: lastDay }, (_, index) => ({ personKind: "employee", employmentId: job, scopeId: "scope", shiftVersionId: shiftId, workDate: `${month}-${String(index + 1).padStart(2, "0")}` })) });
    expect(invalidSchedule.status).toBe(400);
  });

  it("班別只能當天上下班，代碼由系統產生，同一店可以建多個班別", async () => {
    // 以前代碼要人填且全域唯一，不同店各建一個「AM」就撞號；現在不問代碼，連建兩個都不該失敗。
    const morning = await request("/hr/shift-templates", "POST", { scopeId: "scope", name: "早班", startTime: "09:00", endTime: "14:00" });
    expect(morning.status, await morning.clone().text()).toBe(201);
    const evening = await request("/hr/shift-templates", "POST", { scopeId: "scope", name: "晚班", startTime: "14:00", endTime: "22:00" });
    expect(evening.status, await evening.clone().text()).toBe(201);
    const long = await request("/hr/shift-templates", "POST", { scopeId: "scope", name: "十小時班", startTime: "08:00", endTime: "18:00" });
    expect(long.status, await long.clone().text()).toBe(201);
    const longListed = await (await request("/hr/shift-templates")).json() as { shifts: Array<{ name: string; standardMinutes: number; breakMinutes: number }> };
    expect(longListed.shifts.find((item) => item.name === "十小時班")).toMatchObject({ standardMinutes: 600, breakMinutes: 0 });

    const overnight = await request("/hr/shift-templates", "POST", { scopeId: "scope", name: "夜班", startTime: "23:00", endTime: "07:00" });
    expect(overnight.status).toBe(400);
    expect(await overnight.text()).toContain("結束時間必須晚於開始時間");

    const listed = await request("/hr/shift-templates");
    expect(listed.status, await listed.clone().text()).toBe(200);
    const body = await listed.json() as { scopes: Array<{ id: string }>; shifts: Array<Record<string, unknown>> };
    expect(body.scopes.map((scope) => scope.id)).toContain("scope");
    expect(body.shifts).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeId: "scope", name: "早班", startSecond: 9 * 3600, endSecond: 14 * 3600 }),
      expect.objectContaining({ scopeId: "scope", name: "晚班", startSecond: 14 * 3600, endSecond: 22 * 3600 }),
    ]));
    expect(body.shifts.some((shift) => shift.name === "夜班")).toBe(false);
    // 代碼沒有任何畫面在用，不該再往外給，免得又有人拿去顯示或當成使用者要填的欄位。
    expect(body.shifts.every((shift) => !("code" in shift))).toBe(true);
  });

  it("班別直接修改名稱與時間；過期的版本、錯的時間、多店共用的班別都擋下", async () => {
    const created = await request("/hr/shift-templates", "POST", { scopeId: "scope", name: "早班", startTime: "09:00", endTime: "14:00" });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = await created.json() as { id: string };
    const find = async () => ((await (await request("/hr/shift-templates")).json()) as { shifts: Array<{ templateId: string; name: string; startSecond: number; endSecond: number; revision: number }> }).shifts.find((shift) => shift.templateId === id)!;

    const before = await find();
    const updated = await request(`/hr/shift-templates/${id}`, "PATCH", { scopeId: "scope", name: "早午班", startTime: "10:00", endTime: "15:00", revision: before.revision });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await find()).toMatchObject({ name: "早午班", startSecond: 10 * 3600, endSecond: 15 * 3600, revision: before.revision + 1 });

    // 兩個人同時開著視窗：後按儲存的人手上是舊版本，不能把前一個人的修改蓋掉。
    const stale = await request(`/hr/shift-templates/${id}`, "PATCH", { scopeId: "scope", name: "被蓋掉", startTime: "08:00", endTime: "12:00", revision: before.revision });
    expect(stale.status).toBe(409);
    expect(await find()).toMatchObject({ name: "早午班", startSecond: 10 * 3600 });

    expect((await request(`/hr/shift-templates/${id}`, "PATCH", { scopeId: "scope", name: "早午班", startTime: "15:00", endTime: "10:00", revision: before.revision + 1 })).status).toBe(400);

    // 同一個班別掛在兩家店時，改一家會連另一家一起改；寧可擋下來。
    await db.insert(scopes).values({ id: "scope-2", sourceType: "manual", scopeKind: "store", name: "第二家店", normalizedName: "第二家店" });
    await db.insert(hrScopeShiftAssignments).values({ scopeId: "scope-2", shiftTemplateId: id, createdBy: "admin" });
    const shared = await request(`/hr/shift-templates/${id}`, "PATCH", { scopeId: "scope", name: "改不了", startTime: "10:00", endTime: "15:00", revision: before.revision + 1 });
    expect(shared.status).toBe(409);
    expect(await shared.text()).toContain("同時用在多家店");
  });

  it("刪除班別：沒排過就刪掉；已排進排班或版本過期都擋下，資料不動", async () => {
    const listShifts = async () => ((await (await request("/hr/shift-templates")).json()) as { shifts: Array<{ templateId: string; revision: number; versionId: string }> }).shifts;
    const create = async (name: string) => (await (await request("/hr/shift-templates", "POST", { scopeId: "scope", name, startTime: "09:00", endTime: "14:00" })).json() as { id: string; versionId: string });

    const unused = await create("沒排過的班");
    const stale = await request(`/hr/shift-templates/${unused.id}`, "DELETE", { scopeId: "scope", revision: 999 });
    expect(stale.status).toBe(409);
    expect((await listShifts()).some((shift) => shift.templateId === unused.id)).toBe(true);
    const removed = await request(`/hr/shift-templates/${unused.id}`, "DELETE", { scopeId: "scope", revision: 1 });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await listShifts()).some((shift) => shift.templateId === unused.id)).toBe(false);

    // 排班表以外鍵指著班別；刪了那個月份就存不回去，所以要講清楚排在哪、請人先移除。
    await assign("self");
    const job = await firstEmployment("self");
    const used = await create("排過的班");
    const today = taipeiToday();
    const saved = await request("/hr/schedules", "POST", { periodKey: today.slice(0, 7), entries: [{ personKind: "employee", employmentId: job, scopeId: "scope", shiftVersionId: used.versionId, workDate: today }] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const blocked = await request(`/hr/shift-templates/${used.id}`, "DELETE", { scopeId: "scope", revision: 1 });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain(`已經排進 1 筆排班（最早 ${today}）`);
    expect((await listShifts()).some((shift) => shift.templateId === used.id)).toBe(true);
  });

  it("跨午夜排班在隔日仍可完成下班打卡，日曆不重複報異常", async () => {
    const today = taipeiToday();
    const previous = new Date(`${today}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const previousDate = previous.toISOString().slice(0, 10);
    const utcAt = (date: string, time: string) => taipeiWallClockToUtc(`${date} ${time.length === 5 ? `${time}:00` : time}`);
    await assign("self", "OVERNIGHT-1");
    const job = await firstEmployment("self");
    expect((await request(`/hr/employments/${job}/attendance-mode`, "PATCH", { attendanceMode: "scheduled", revision: 1 })).status).toBe(200);
    const location = await created("/hr/attendance-settings/locations", { name: "跨午夜據點", scopeId: "scope", geolocationRequired: false, latitude: null, longitude: null, radiusMeters: 100, active: true });
    await created(`/hr/employments/${job}/attendance-location`, { locationId: location, validFrom: previousDate, validTo: null });
    /*
     * 班別管理頁只建得出當天上下班的班別，但資料欄位與出勤的跨午夜判斷都還在；
     * 直接寫進資料庫，讓這段打卡邏輯在沒有 API 入口的情況下仍然有測試保護。
     */
    await db.insert(hrShiftTemplates).values({ id: "overnight-template", code: "overnight-template", name: "跨午夜班", active: 1, createdBy: "admin" });
    await db.insert(hrShiftVersions).values({ id: "overnight-v1", shiftTemplateId: "overnight-template", versionNumber: 1, startSecond: 23 * 3600, endSecond: 7 * 3600, endDayOffset: 1, standardMinutes: 420, breakMinutes: 60, createdBy: "admin" });
    await db.insert(hrScopeShiftAssignments).values({ scopeId: "scope", shiftTemplateId: "overnight-template", createdBy: "admin" });
    const shiftId = "overnight-v1";
    const saved = await request("/hr/schedules", "POST", { periodKey: previousDate.slice(0, 7), entries: [{ personKind: "employee", employmentId: job, scopeId: "scope", shiftVersionId: shiftId, workDate: previousDate }] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const clockInAt = utcAt(previousDate, "23:00:00");
    await db.insert(hrClockEvents).values({ id: "overnight-clock-in", employeeUserId: "self", employmentId: job, sourceKind: "portal", idempotencyKey: "overnight-clock-in", eventKind: "clock_in", occurredAt: clockInAt, receivedAt: clockInAt });
    const clockedOut = await request("/hr/me/clock-events", "POST", { idempotencyKey: "overnight-clock-out", latitude: null, longitude: null }, "self");
    expect(clockedOut.status, await clockedOut.clone().text()).toBe(201);
    expect((await clockedOut.json() as { event: { eventKind: string } }).event.eventKind).toBe("clock_out");
    const calendar = await (await request(`/hr/me/attendance-calendar?year=${today.slice(0, 4)}&month=${today.slice(5, 7)}`, "GET", undefined, "self")).json() as { days: { date: string; anomaly: string | null }[] };
    expect(calendar.days.find((day) => day.date === today)?.anomaly).toBeNull();
  });

  it("全體打卡明細只讓全平台 HR 管理者查看，並支援搜尋與日期分頁", async () => {
    await assign("self");
    const employmentId = await firstEmployment("self");
    await db.insert(hrClockEvents).values([
      { id: "event-all-1", employeeUserId: "self", employmentId, sourceKind: "portal", idempotencyKey: "event-all-1", eventKind: "clock_in", occurredAt: "2026-08-05 01:00:00", receivedAt: "2026-08-05 01:00:01" },
      { id: "event-all-2", employeeUserId: "self", employmentId, sourceKind: "manual", idempotencyKey: "event-all-2", eventKind: "clock_out", manualReason: "測試補登", occurredAt: "2026-08-05 10:00:00", receivedAt: "2026-08-05 10:00:01" },
    ]);
    const listed = await request("/hr/attendance-events?search=self&startDate=2026-08-01&endDate=2026-09-01&page=1&pageSize=10&sortField=occurredAt&sortDirection=asc");
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(await listed.json()).toMatchObject({ total: 2, events: [expect.objectContaining({ employeeName: "self", eventKind: "clock_in" }), expect.objectContaining({ manualReason: "測試補登", sourceKind: "manual" })] });
    expect((await request("/hr/attendance-events", "GET", undefined, "self")).status).toBe(403);
    expect((await request("/hr/attendance-events", "GET", undefined, "writer")).status).toBe(403);
  });

  it("出勤明細的日期篩選使用台北當地日界線", async () => {
    await assign("self");
    const employmentId = await firstEmployment("self");
    await db.insert(hrClockEvents).values([
      { id: "taipei-boundary-in", employeeUserId: "self", employmentId, sourceKind: "portal", idempotencyKey: "taipei-boundary-in", eventKind: "clock_in", occurredAt: "2026-07-31 16:30:00", receivedAt: "2026-07-31 16:30:01" },
      { id: "taipei-boundary-out", employeeUserId: "self", employmentId, sourceKind: "portal", idempotencyKey: "taipei-boundary-out", eventKind: "clock_out", occurredAt: "2026-08-01 16:30:00", receivedAt: "2026-08-01 16:30:01" },
    ]);
    const response = await request("/hr/attendance-events?startDate=2026-08-01&endDate=2026-08-02&page=1&pageSize=10&sortField=occurredAt&sortDirection=asc");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, events: [expect.objectContaining({ id: "taipei-boundary-in" })] });
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
