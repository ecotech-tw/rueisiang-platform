import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, listActivity, syncSystemRoles } from "@rueisiang/db";
import { hrAttendanceLocations, hrClockEvents, scopes, userPermissionGrants, userRoleAssignments, users } from "@rueisiang/db/schema";
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
    { userId: "manager", permission: "hr:schedule:read" },
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
    expect((await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: "2026-02-01", revision: 1 })).status).toBe(409);
    expect((await request("/hr/attendance-settings/locations", "POST", { name: "writer 不可新增", geolocationRequired: false, latitude: null, longitude: null, radiusMeters: 50, active: true }, "writer")).status).toBe(403);
    expect((await request(`/hr/attendance-location-assignments/${assignment}/end`, "PATCH", { validTo: "2026-02-01", revision: 1 })).status).toBe(200);
    expect((await request(`/hr/attendance-location-assignments/${secondAssignment}/end`, "PATCH", { validTo: "2026-02-01", revision: 1 })).status).toBe(200);
    expect((await request(`/hr/employments/${job}/end`, "PATCH", { endedOn: "2026-02-01", revision: 1 })).status).toBe(200);
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
    const calendar = await (await request(`/hr/me/attendance-calendar?year=${correctionDate.slice(0, 4)}&month=${correctionDate.slice(5, 7)}`, "GET", undefined, "self")).json() as { today: string; days: { date: string; status: string }[] };
    expect(calendar.today).toBe(correctionDate);
    expect(calendar.days.find((day) => day.date === correctionDate)?.status).toBe("open");
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

  it("排班員工使用已發布排班據點打卡，且停用位置不再可用", async () => {
    const today = taipeiToday();
    await assign("self", "SCHEDULED-1");
    const job = await firstEmployment("self");
    expect((await request(`/hr/employments/${job}/attendance-mode`, "PATCH", { attendanceMode: "scheduled", revision: 1 })).status).toBe(200);
    const location = await created("/hr/attendance-settings/locations", { name: "排班打卡據點", scopeId: "scope", geolocationRequired: false, latitude: null, longitude: null, radiusMeters: 100, active: true });
    const shift = await request("/hr/shift-templates", "POST", { scopeId: "scope", code: "SCHEDULED-1", name: "日班", startTime: "09:00", endTime: "17:00", endDayOffset: 0 });
    expect(shift.status, await shift.clone().text()).toBe(201);
    const shiftId = (await shift.json() as { versionId: string }).versionId;
    const saved = await request("/hr/schedules", "POST", { periodKey: today.slice(0, 7), entries: [{ personKind: "employee", employmentId: job, scopeId: "scope", shiftVersionId: shiftId, workDate: today }] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect((await (await request("/hr/me/clock-events", "GET", undefined, "self")).json() as { canClock: boolean; locationNames: string[] }).locationNames).toContain("排班打卡據點");
    const clockedIn = await request("/hr/me/clock-events", "POST", { idempotencyKey: "scheduled-clock-in", latitude: null, longitude: null }, "self");
    expect(clockedIn.status, await clockedIn.clone().text()).toBe(201);
    expect((await clockedIn.json() as { event: { eventKind: string } }).event.eventKind).toBe("clock_in");
    await db.update(hrAttendanceLocations).set({ active: 0 }).where(eq(hrAttendanceLocations.id, location));
    expect((await (await request("/hr/me/clock-events", "GET", undefined, "self")).json() as { canClock: boolean }).canClock).toBe(false);
  });

  it("跨午夜排班在隔日仍可完成下班打卡，日曆不重複報異常", async () => {
    const today = taipeiToday();
    const previous = new Date(`${today}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const previousDate = previous.toISOString().slice(0, 10);
    const utcAt = (date: string, time: string) => new Date(`${date}T${time}+08:00`).toISOString().slice(0, 19).replace("T", " ");
    await assign("self", "OVERNIGHT-1");
    const job = await firstEmployment("self");
    expect((await request(`/hr/employments/${job}/attendance-mode`, "PATCH", { attendanceMode: "scheduled", revision: 1 })).status).toBe(200);
    await created("/hr/attendance-settings/locations", { name: "跨午夜據點", scopeId: "scope", geolocationRequired: false, latitude: null, longitude: null, radiusMeters: 100, active: true });
    const shift = await request("/hr/shift-templates", "POST", { scopeId: "scope", code: "OVERNIGHT-1", name: "跨午夜班", startTime: "23:00", endTime: "07:00", endDayOffset: 1 });
    expect(shift.status, await shift.clone().text()).toBe(201);
    const shiftId = (await shift.json() as { versionId: string }).versionId;
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
