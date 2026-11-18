import { DEVICE_SESSION_COOKIE, SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, inviteUser, linkHrWorkerAccount, listHrPayrollSelfHistory, getHrPayrollSelfDetail, getHrClockCalendar, listHrAttendanceEvents, withdrawHrPayrollRun, syncSystemRoles } from "@rueisiang/db";
import { hrAttendanceLocations, hrClockEvents, hrEmployments, hrPayrollClosedWorkers, hrPayrollPeriods, hrPayrollRecordItems, hrPayrollRuns, hrPayrollWorkerResults, hrWorkerAccountLinks, userRoleAssignments, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "worker-self-service-test-secret";
let d1: LocalD1;
let cookies: Record<string, string>;
const db = () => createDatabase(d1 as never);
const env = () => ({ DB: d1, AUTH_SESSION_SECRET: SECRET, LINE_LIFF_CHANNEL_ID: "test-channel", GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" });

async function request(path: string, method = "GET", values?: Record<string, unknown>, actor = "admin") {
  return app.fetch(new Request(`https://test.local/api${path}`, { method,
    headers: { "Content-Type": "application/json", ...(cookies[actor] ? { Cookie: cookies[actor] } : {}) },
    ...(values ? { body: JSON.stringify(values) } : {}),
  }), env() as never);
}
async function worker(name = "支援小明") {
  const response = await request("/hr/schedule-workers", "POST", { displayName: name });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json() as { id: string }).id;
}
async function link(id: string, actor = "self") {
  const response = await request(`/hr/schedule-workers/${id}/account`, "POST", { email: `${actor}@example.test` });
  expect(response.status, await response.clone().text()).toBe(201);
}
async function assignLocation(id: string) {
  const profile = await (await request(`/hr/employees/${id}`)).json() as { employments: Array<{ revision: number }> };
  return request(`/hr/employments/${id}/attendance-scope`, "PATCH", { attendanceMode: "scheduled", monthlyRestDays: 0, revision: profile.employments[0]!.revision,
    locationIds: ["location"], assignmentsToEnd: [],
  });
}
function cookieFrom(response: Response, name: string) {
  const cookie = (response.headers.get("Set-Cookie") ?? "").split(/,\s*(?=[\w-]+=)/).find((value) => value.startsWith(`${name}=`));
  expect(cookie).toBeDefined();
  return cookie!.split(";")[0]!;
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  await syncSystemRoles(db());
  cookies = {};
  for (const id of ["admin", "self", "other", "disabled"]) {
    await db().insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: id === "disabled" ? "disabled" : "active" });
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET))}`;
  }
  await db().insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  await db().insert(hrAttendanceLocations).values({ id: "location", name: "測試櫃位", latitudeE7: 250000000, longitudeE7: 1215000000, radiusMeters: 80, geolocationRequired: 0 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); d1.sqlite.close(); });

describe("支援人員本人服務", () => {
  it("只有 HR 能連結帳號，拒絕未邀請、停用、正式員工與重複連結，保留原任職", async () => {
    const id = await worker();
    expect((await request(`/hr/schedule-workers/${id}/account`, "POST", { email: "self@example.test" }, "self")).status).toBe(403);
    for (const email of ["missing@example.test", "disabled@example.test"]) expect((await request(`/hr/schedule-workers/${id}/account`, "POST", { email })).status).toBe(400);
    await db().insert(hrEmployments).values({ id: "formal", employeeUserId: "other", employeeNumber: "E1", legalName: "正式員工" });
    expect((await request(`/hr/schedule-workers/${id}/account`, "POST", { email: "other@example.test" })).status).toBe(409);
    await link(id);
    const second = await worker("支援小美");
    expect((await request(`/hr/schedule-workers/${second}/account`, "POST", { email: "self@example.test" })).status).toBe(409);
    expect((await request("/hr/employees", "POST", { userId: "self", legalName: "不應建立", employeeNumber: "E2", position: "測試" })).status).toBe(409);
    expect(d1.sqlite.prepare("SELECT person_kind, employee_user_id FROM hr_employments WHERE id=?").get(id)).toEqual({ person_kind: "worker", employee_user_id: null });
    expect(d1.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("並行連結只允許一位人員取得帳號；資料庫也禁止改配與混用正式員工身分", async () => {
    const first = await worker(); const second = await worker("另一位");
    const results = await Promise.allSettled([first, second].map((id) => linkHrWorkerAccount(db(), id, "self@example.test", { id: "admin", email: "admin@example.test" })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [linked] = await db().select().from(hrWorkerAccountLinks);
    expect(() => d1.sqlite.prepare("UPDATE hr_worker_account_links SET user_id='other' WHERE worker_id=?").run(linked!.workerId)).toThrow("worker_account_identity_immutable");
    expect(() => d1.sqlite.prepare("INSERT INTO hr_employments (id, employee_user_id, employee_number) VALUES ('invalid-formal', 'self', 'INVALID')").run()).toThrow("worker_account_identity_conflict");
  });

  it("邀請設密碼、Email 登入後可綁定小香，LIFF session 只提供打卡與薪資", async () => {
    const id = await worker();
    const invitation = await inviteUser(db(), { email: "invited@example.test", invitedBy: "admin" });
    expect(invitation.kind).toBe("created"); if (invitation.kind !== "created") return;
    expect((await request(`/hr/schedule-workers/${id}/account`, "POST", { email: "invited@example.test" })).status).toBe(201);
    const password = "WorkerTestPassword123!";
    expect((await request(`/auth/invite/${invitation.token}`, "POST", { password, confirmPassword: password }, "anonymous")).status).toBe(200);
    const login = await request("/auth/password", "POST", { email: "invited@example.test", password }, "anonymous");
    expect(login.status).toBe(200);
    cookies.invited = cookieFrom(login, SESSION_COOKIE);
    expect(await (await request("/hr/me/session", "GET", undefined, "invited")).json()).toMatchObject({ isEmployee: false, hrSelfServiceKind: "worker" });
    vi.stubGlobal("fetch", async () => Response.json({ iss: "https://access.line.me", sub: "line-worker", aud: "test-channel", exp: Math.floor(Date.now() / 1000) + 300 }));
    const linked = await request("/hr/liff/link", "POST", { idToken: "verified-token" }, "invited");
    expect(linked.status, await linked.clone().text()).toBe(201);
    cookies.liff = cookieFrom(linked, DEVICE_SESSION_COOKIE);
    expect((await request("/hr/me/session", "GET", undefined, "liff")).status).toBe(200);
    expect((await request("/hr/me/payroll-history", "GET", undefined, "liff")).status).toBe(200);
    expect((await request("/hr/me/notifications", "GET", undefined, "liff")).status).toBe(403);
    expect((await request("/auth/me", "GET", undefined, "liff")).status).toBe(401);
    const bootstrap = await request("/hr/me/liff-session", "POST", { idToken: "verified-token" }, "anonymous");
    expect(await bootstrap.json()).toEqual({ linked: true });
  });

  it("沿用出勤範圍；支援人員必須定位，範圍外拒絕，重試不重複打卡，其他人不可冒用", async () => {
    const id = await worker(); await link(id);
    expect((await assignLocation(id)).status).toBe(200);
    const status = await (await request("/hr/me/clock-events", "GET", undefined, "self")).json();
    expect(status).toMatchObject({ canClock: true, geolocationRequired: true, nextEventKind: "clock_in" });
    expect((await request("/hr/me/clock-events", "POST", { idempotencyKey: "no-gps" }, "self")).status).toBe(400);
    expect((await request("/hr/me/clock-events", "POST", { idempotencyKey: "outside", latitude: 26, longitude: 121.5 }, "self")).status).toBe(400);
    const values = { idempotencyKey: "first", latitude: 25, longitude: 121.5, userId: "other", employmentId: "not-owned" };
    expect((await request("/hr/me/clock-events", "POST", values, "self")).status).toBe(201);
    expect((await request("/hr/me/clock-events", "POST", values, "self")).status).toBe(200);
    expect((await request("/hr/me/clock-events", "POST", { ...values, idempotencyKey: "second" }, "self")).status).toBe(201);
    const third = await request("/hr/me/clock-events", "POST", { ...values, idempotencyKey: "third" }, "self");
    expect(await third.json()).toMatchObject({ event: { eventKind: "clock_out" } });
    const fourth = await request("/hr/me/clock-events", "POST", { ...values, idempotencyKey: "fourth" }, "self");
    expect(await fourth.json()).toMatchObject({ event: { eventKind: "clock_out" } });
    const statusAfterFour = await (await request("/hr/me/clock-events", "GET", undefined, "self")).json() as { events: Array<{ eventKind: string | null }> };
    expect(statusAfterFour.events.map((event) => event.eventKind)).toEqual(["clock_out", null, null, "clock_in"]);
    const attendanceRows = await listHrAttendanceEvents(db(), { page: 1, pageSize: 25, search: "", eventKind: "all", sourceKind: "all", startDate: null, endDate: null, sortField: "occurredAt", sortDirection: "asc" });
    expect(attendanceRows.events.filter((event) => event.eventKind === null)).toHaveLength(2);
    expect((await listHrAttendanceEvents(db(), { page: 1, pageSize: 25, search: "", eventKind: "clock_in", sourceKind: "all", startDate: null, endDate: null, sortField: "occurredAt", sortDirection: "asc" })).events).toHaveLength(1);
    expect((await listHrAttendanceEvents(db(), { page: 1, pageSize: 25, search: "", eventKind: "clock_out", sourceKind: "all", startDate: null, endDate: null, sortField: "occurredAt", sortDirection: "asc" })).events).toHaveLength(1);
    const events = await db().select().from(hrClockEvents);
    expect(events.map((event) => [event.employeeUserId, event.employmentId, event.eventKind])).toEqual([["self", id, "clock_in"], ["self", id, "clock_out"], ["self", id, "clock_in"], ["self", id, "clock_out"]]);
    expect((await request("/hr/me/clock-events", "POST", { ...values, idempotencyKey: "other" }, "other")).status).toBe(400);
    expect((await request("/hr/me/attendance-calendar?year=2026&month=11", "GET", undefined, "self")).status).toBe(200);
    expect(() => d1.sqlite.prepare("INSERT INTO hr_clock_events (id, employee_user_id, employment_id, idempotency_key, event_kind) VALUES ('forged', 'other', ?, 'forged', 'clock_in')").run(id)).toThrow("hr_clock_identity_mismatch");
    // 出勤設定會前進 canonical revision，之後的支援人員編輯仍須可用。
    expect((await request(`/hr/schedule-workers/${id}`, "PATCH", { displayName: "新姓名", active: true, revision: 2 })).status).toBe(200);
  });

  it("支援人員出勤日曆讀取已發布班表及月底跨日打卡，不混入別人的紀錄", async () => {
    const id = await worker(); await link(id);
    d1.sqlite.exec(`
      INSERT INTO scopes (id, source_type, scope_kind, name, normalized_name) VALUES ('store', 'manual', 'store', '櫃位', '櫃位');
      INSERT INTO hr_shift_templates (id, code, name, created_by) VALUES ('night', 'NIGHT', '夜班', 'admin');
      INSERT INTO hr_shift_versions (id, shift_template_id, version_number, start_second, end_second, end_day_offset, standard_minutes, break_minutes, created_by) VALUES ('night-v1', 'night', 1, 79200, 21600, 1, 480, 0, 'admin');
      INSERT INTO hr_schedule_versions (id, period_start, period_end, version_number, status) VALUES ('schedule', '2020-01-01', '2020-02-01', 1, 'published');
    `);
    d1.sqlite.prepare("INSERT INTO hr_schedule_worker_entries (id, schedule_version_id, worker_id, scope_id, shift_version_id, work_date, starts_at, ends_at, standard_minutes, break_minutes, created_by) VALUES ('entry', 'schedule', ?, 'store', 'night-v1', '2020-01-31', '2020-01-31 22:00:00', '2020-02-01 06:00:00', 480, 0, 'admin')").run(id);
    await db().insert(hrClockEvents).values([
      { id: "overnight-in", employeeUserId: "self", employmentId: id, idempotencyKey: "overnight-in", eventKind: "clock_in", occurredAt: "2020-01-31 14:00:00" },
      { id: "overnight-out", employeeUserId: "self", employmentId: id, idempotencyKey: "overnight-out", eventKind: "clock_out", occurredAt: "2020-01-31 22:00:00" },
    ]);
    const calendar = await getHrClockCalendar(db(), "self", 2020, 1);
    expect(calendar.days.find((day) => day.date === "2020-01-31")).toMatchObject({ workedMinutes: 480, expectedStartAt: "2020-01-31 22:00:00", expectedEndAt: "2020-02-01 06:00:00", anomaly: null });
    expect(calendar.days.find((day) => day.date === "2020-01-30")).toMatchObject({ status: "rest", anomaly: null });
    expect((await getHrClockCalendar(db(), "self", 2020, 2)).days.find((day) => day.date === "2020-02-01")).toMatchObject({ anomaly: null });
    expect((await getHrClockCalendar(db(), "other", 2020, 1)).days.every((day) => day.events.length === 0)).toBe(true);
  });

  it("封鎖本人其他功能與管理端，停用人員及帳號後立即拒絕", async () => {
    const id = await worker(); await link(id);
    for (const path of ["/me", "/me/notifications", "/me/leave-requests", "/me/overtime", "/me/form-requests", "/me/schedules", "/overview"]) {
      expect((await request(`/hr${path}`, "GET", undefined, "self")).status, path).toBe(403);
    }
    for (const path of ["/me/leave-requests", "/me/overtime", "/me/form-requests", "/me/photo"]) expect((await request(`/hr${path}`, "POST", {}, "self")).status, path).toBe(403);
    await db().update(hrEmployments).set({ archivedAt: "2026-11-01 00:00:00" }).where(eq(hrEmployments.id, id));
    expect((await request("/hr/me/clock-events", "GET", undefined, "self")).status).toBe(403);
    expect((await request("/hr/me/payroll-history", "GET", undefined, "self")).status).toBe(403);
    expect((await request("/hr/me/device", "DELETE", undefined, "self")).status).toBe(200);
    await db().update(hrEmployments).set({ archivedAt: null }).where(eq(hrEmployments.id, id));
    await db().update(users).set({ status: "disabled" }).where(eq(users.id, "self"));
    expect((await request("/hr/me/session", "GET", undefined, "self")).status).toBe(403);
  });

  it("人員列表、支援管理與內頁顯示連結帳號，不誤列為可指派正式員工", async () => {
    const id = await worker(); await link(id);
    const roster = await (await request("/hr/employees?personKind=all")).json() as { employees: Array<{ email: string; userStatus: string; lineLinkedAt: string | null }> };
    expect(roster.employees).toContainEqual(expect.objectContaining({ email: "self@example.test", userStatus: "active", lineLinkedAt: null }));
    const profile = await (await request(`/hr/employees/${id}`)).json() as { employee: { email: string; userStatus: string } };
    expect(profile.employee).toMatchObject({ email: "self@example.test", userStatus: "active" });
    const management = await (await request("/hr/schedule-workers/management")).json() as { workers: Array<{ account: unknown }> };
    expect(management.workers[0]!.account).toMatchObject({ email: "self@example.test", status: "active" });
    const candidates = await (await request("/hr/candidates?search=self")).json() as { users: unknown[] };
    expect(candidates.users).toEqual([]);
  });

  it("舊薪資未保存項目快照時，明細以歷史金額標示而非顯示無項目", async () => {
    const id = await worker(); await link(id);
    await db().insert(hrPayrollPeriods).values({ id: "legacy-period", periodKey: "2026-10", attendanceStart: "2026-10-01", attendanceEnd: "2026-11-01", createdBy: "admin" });
    await db().insert(hrPayrollRuns).values({ id: "legacy-run", payrollPeriodId: "legacy-period", versionNumber: 1, requestId: "legacy-run", inputRevision: 1, engineVersion: "legacy", status: "ready", createdBy: "admin" });
    await db().insert(hrPayrollWorkerResults).values({ id: "legacy-result", payrollRunId: "legacy-run", workerId: id, workerName: "支援小明", payBasis: "daily", scheduledDays: 1, amountMinor: 190000, payrollLinesJson: "[]" });
    await db().update(hrPayrollRuns).set({ status: "closed" }).where(eq(hrPayrollRuns.id, "legacy-run"));
    const detail = await getHrPayrollSelfDetail(db(), "self", "legacy-run", id);
    expect(detail.record).toMatchObject({ earningMinor: 190000, deductionMinor: 0, netMinor: 190000 });
    expect(detail.lines).toEqual([{ lineKey: "legacy_worker_pay", direction: "earning", amountMinor: 190000, explanation: { itemName: "歷史薪資金額（未保存項目明細）" } }]);
  });

  it("薪資只查本人已發放資料，包含部分結帳與加扣項；歷史筆數不增加查詢次數", async () => {
    const id = await worker(); await link(id);
    const other = await worker("另一位薪資機密"); await link(other, "other");
    await db().insert(hrPayrollPeriods).values({ id: "period", periodKey: "2026-11", attendanceStart: "2026-11-01", attendanceEnd: "2026-12-01", createdBy: "admin" });
    for (const [index, status] of ["closed", "partial", "ready"].entries()) {
      const runId = `run-${index}`;
      await db().insert(hrPayrollRuns).values({ id: runId, payrollPeriodId: "period", versionNumber: index + 1, requestId: runId, inputRevision: 1, engineVersion: "test", status: "ready", createdBy: "admin" });
      await db().insert(hrPayrollWorkerResults).values([{ id: `result-${index}`, payrollRunId: runId, workerId: id, workerName: "支援小明", payBasis: "daily", scheduledDays: 1, amountMinor: 190000,
        payrollLinesJson: JSON.stringify([{ lineKey: "base_salary", direction: "earning", amountMinor: 190000, explanation: {} }, { lineKey: "adjustment_deduct", direction: "deduction", amountMinor: 10000, explanation: {} }]),
      }, { id: `other-result-${index}`, payrollRunId: runId, workerId: other, workerName: "另一位薪資機密", payBasis: "daily", scheduledDays: 1, amountMinor: 999999 }]);
      await db().insert(hrPayrollRecordItems).values({ id: `item-${index}`, payrollRunId: runId, personKind: "worker", workerId: id, itemName: "補發", direction: "earning", amountMinor: 5000, reason: "歷史加扣", createdBy: "admin" });
      if (status === "closed") await db().update(hrPayrollRuns).set({ status: "closed" }).where(eq(hrPayrollRuns.id, runId));
      if (status === "partial") await db().insert(hrPayrollClosedWorkers).values({ periodKey: "2026-11", workerId: id, payrollRunId: runId });
    }
    const history = await listHrPayrollSelfHistory(db(), "self");
    expect(history.map((record) => record.runId)).toEqual(["run-1", "run-0"]);
    expect(history[0]).toMatchObject({ earningMinor: 195000, deductionMinor: 10000, netMinor: 185000 });
    const detail = await getHrPayrollSelfDetail(db(), "self", "run-1", id);
    expect(detail.lines).toHaveLength(3);
    expect(JSON.stringify(detail)).not.toContain("另一位薪資機密");
    expect((await request(`/hr/me/payroll-history/run-1/${other}`, "GET", undefined, "self")).status).toBe(404);
    expect((await request(`/hr/me/payroll-history/run-2/${id}`, "GET", undefined, "self")).status).toBe(404);
    const database = db(); const prepare = vi.spyOn(database.$client, "prepare");
    await listHrPayrollSelfHistory(database, "self");
    expect(prepare).toHaveBeenCalledTimes(2);
    prepare.mockClear();
    await getHrPayrollSelfDetail(database, "self", "run-1", id);
    expect(prepare).toHaveBeenCalledTimes(3);
    prepare.mockRestore();
    await withdrawHrPayrollRun(db(), "run-1", "重新覆核", { id: "admin", email: "admin@example.test" });
    expect((await listHrPayrollSelfHistory(db(), "self")).map((record) => record.runId)).toEqual(["run-0"]);
    expect((await request(`/hr/me/payroll-history/run-1/${id}`, "GET", undefined, "self")).status).toBe(404);
    // 撤回 marker 保留稽核用途；重新確定發放後，新的 claim 才是目前發放狀態。
    await db().insert(hrPayrollClosedWorkers).values({ periodKey: "2026-11", workerId: id, payrollRunId: "run-1" });
    expect((await listHrPayrollSelfHistory(db(), "self")).map((record) => record.runId)).toEqual(["run-1", "run-0"]);
  });
});
