import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { cancelHrLeaveRequest, cancelHrOvertimeRequest, createDatabase, HrError, reviewHrLeaveRequest, reviewHrOvertimeRequest, syncSystemRoles } from "@rueisiang/db";
import { hrEmployments, hrPayrollPeriods, hrPayrollRequestSourceRuns, hrPayrollRequestSources, hrPayrollRuns, hrScheduleEntries, hrScheduleVersions, hrShiftTemplates, hrShiftVersions, scopes, userRoleAssignments, users } from "@rueisiang/db/schema";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "hr-request-test-secret-test-secret";
let d1: LocalD1;
let adminCookie: string;
let employeeCookie: string;

async function sessionCookie(id: string, email: string, name: string) {
  return `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id, email, name, pictureUrl: "" }), SECRET))}`;
}

async function request(path: string, method = "GET", payload?: Record<string, unknown>, cookie = adminCookie) {
  return app.fetch(new Request(`https://test.local/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  }), { DB: d1, AUTH_SESSION_SECRET: SECRET, GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" } as never);
}

async function assignEmployee() {
  const response = await request("/hr/employees", "POST", { userId: "employee", legalName: "申請員工", employeeNumber: "E-REQUEST", position: "一般職員", serviceStartOn: "2026-01-01" });
  expect(response.status, await response.clone().text()).toBe(201);
}

async function assignEmployeeSupervisor() {
  await assignEmployee();
  const approver = await request("/hr/employees", "POST", { userId: "admin", legalName: "審核主管", employeeNumber: "E-APPROVER", position: "一般職員", serviceStartOn: "2026-01-01" });
  expect(approver.status, await approver.clone().text()).toBe(201);
  const employee = await (await request("/hr/employees/employee")).json() as { employments: Array<{ revision: number }> };
  const supervisor = await request("/hr/employees/employee/supervisor", "PATCH", { supervisorUserId: "admin", revision: employee.employments[0]!.revision });
  expect(supervisor.status, await supervisor.clone().text()).toBe(200);
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  const db = createDatabase(d1 as never);
  await syncSystemRoles(db);
  await db.insert(users).values([
    { id: "admin", email: "admin@example.test", displayName: "管理者", status: "active" },
    { id: "employee", email: "employee@example.test", displayName: "員工", status: "active" },
  ]);
  await db.insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  adminCookie = await sessionCookie("admin", "admin@example.test", "管理者");
  employeeCookie = await sessionCookie("employee", "employee@example.test", "員工");
});

afterEach(() => d1.sqlite.close());

describe("HR 申請中心", () => {
  it("假別主檔可以建立、修改與停用，停用不會出現在新的申請選單", async () => {
    const created = await request("/hr/leave-types", "POST", { name: "測試特休", defaultPayRatePpm: 1_000_000 });
    expect(created.status, await created.clone().text()).toBe(201);
    const createdBody = await created.json() as { id: string };

    const updated = await request(`/hr/leave-types/${createdBody.id}`, "PATCH", { name: "測試特休（修訂）", defaultPayRatePpm: 800_000 });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const disabled = await request(`/hr/leave-types/${createdBody.id}/status`, "POST", { active: false });
    expect(disabled.status, await disabled.clone().text()).toBe(200);

    const allTypes = await request("/hr/leave-types");
    expect(allTypes.status, await allTypes.clone().text()).toBe(200);
    expect((await allTypes.json() as { leaveTypes: Array<{ id: string; name: string; defaultPayRatePpm: number; active: number }> }).leaveTypes).toContainEqual(expect.objectContaining({ id: createdBody.id, name: "測試特休（修訂）", defaultPayRatePpm: 800_000, active: 0 }));

    const activeTypes = await request("/hr/requests/leave-types");
    expect(activeTypes.status, await activeTypes.clone().text()).toBe(200);
    expect((await activeTypes.json() as { leaveTypes: Array<{ id: string }> }).leaveTypes.some((item) => item.id === createdBody.id)).toBe(false);
  });

  it("後台代登請假與加班直接核准，但保留正式申請狀態", async () => {
    await assignEmployee();
    const leaveType = await request("/hr/leave-types", "POST", { name: "測試特休", defaultPayRatePpm: 1_000_000 });
    expect(leaveType.status, await leaveType.clone().text()).toBe(201);
    const leaveTypeBody = await leaveType.json() as { id: string };

    const leave = await request("/hr/requests/leave", "POST", {
      employeeUserId: "employee", leaveTypeId: leaveTypeBody.id, startsAt: "2026-01-05T09:00", endsAt: "2026-01-05T17:00", reason: "後台代登測試",
    });
    expect(leave.status, await leave.clone().text()).toBe(201);
    const overtime = await request("/hr/requests/overtime", "POST", {
      employeeUserId: "employee", requestedStart: "2026-01-06T18:00", requestedEnd: "2026-01-06T20:00", settlementKind: "pay", reason: "後台加班代登測試",
    });
    expect(overtime.status, await overtime.clone().text()).toBe(201);

    const center = await request("/hr/requests");
    expect(center.status, await center.clone().text()).toBe(200);
    const body = await center.json() as { leaves: Array<{ request: { status: string; reviewComment: string | null } }>; overtime: Array<{ request: { status: string; actualStart: string | null; actualEnd: string | null } }> };
    expect(body.leaves[0]?.request).toMatchObject({ status: "approved", reviewComment: "HR 後台建立後直接核准" });
    expect(body.overtime[0]?.request).toMatchObject({ status: "approved", actualStart: expect.any(String), actualEnd: expect.any(String) });
  });

  it("已被薪資批次採用的請假與加班不能取消", async () => {
    await assignEmployee();
    const leaveType = await request("/hr/leave-types", "POST", { name: "鎖定測試假", defaultPayRatePpm: 1_000_000 });
    const leaveTypeId = (await leaveType.json() as { id: string }).id;
    const leaveResponse = await request("/hr/requests/leave", "POST", { employeeUserId: "employee", leaveTypeId, startsAt: "2026-01-05T09:00", endsAt: "2026-01-05T17:00", reason: "薪資鎖定" });
    const leaveId = (await leaveResponse.json() as { id: string }).id;
    const overtimeResponse = await request("/hr/requests/overtime", "POST", { employeeUserId: "employee", requestedStart: "2026-01-06T18:00", requestedEnd: "2026-01-06T20:00", settlementKind: "pay", reason: "薪資鎖定" });
    const overtimeId = (await overtimeResponse.json() as { id: string }).id;
    const db = createDatabase(d1 as never);
    await db.insert(hrPayrollPeriods).values({ id: "locked-period", periodKey: "2026-01", attendanceStart: "2026-01-01", attendanceEnd: "2026-02-01", createdBy: "admin" });
    await db.insert(hrPayrollRuns).values({ id: "locked-run", payrollPeriodId: "locked-period", versionNumber: 1, requestId: "locked-request", inputRevision: 1, engineVersion: "test", status: "ready", createdBy: "admin" });
    await db.insert(hrPayrollRequestSourceRuns).values({ payrollRunId: "locked-run" });
    await db.insert(hrPayrollRequestSources).values([
      { id: "locked-leave", payrollRunId: "locked-run", sourceKind: "leave", sourceId: leaveId },
      { id: "locked-overtime", payrollRunId: "locked-run", sourceKind: "overtime", sourceId: overtimeId },
    ]);

    const center = await request("/hr/requests?page=1&pageSize=25");
    const listed = await center.json() as { rows: Array<{ id: string; payrollLocked: boolean }> };
    expect(listed.rows.filter((row) => row.id === leaveId || row.id === overtimeId).every((row) => row.payrollLocked)).toBe(true);

    const leaveCancel = await request(`/hr/requests/leave/${leaveId}/cancel`, "POST");
    const overtimeCancel = await request(`/hr/requests/overtime/${overtimeId}/cancel`, "POST");
    expect(leaveCancel.status, await leaveCancel.clone().text()).toBe(409);
    expect(overtimeCancel.status, await overtimeCancel.clone().text()).toBe(409);

    const batchRequest = await request("/hr/requests/overtime", "POST", { employeeUserId: "employee", requestedStart: "2026-01-07T18:00", requestedEnd: "2026-01-07T20:00", settlementKind: "pay", reason: "薪資鎖定批次" });
    const batchRequestId = (await batchRequest.json() as { id: string }).id;
    await db.insert(hrPayrollRequestSources).values({ id: "locked-batch-overtime", payrollRunId: "locked-run", sourceKind: "overtime", sourceId: batchRequestId });
    const batchCancel = await request("/hr/requests/overtime/cancel-batch", "POST", { ids: [batchRequestId] });
    expect(batchCancel.status, await batchCancel.clone().text()).toBe(409);
  });

  it("申請中心的搜尋、篩選與分頁由 API 在資料庫端完成", async () => {
    await assignEmployee();
    const leaveType = await request("/hr/leave-types", "POST", { name: "分頁測試假", defaultPayRatePpm: 1_000_000 });
    const leaveTypeId = (await leaveType.json() as { id: string }).id;
    const leave = await request("/hr/requests/leave", "POST", {
      employeeUserId: "employee", leaveTypeId, startsAt: "2026-01-05T09:00", endsAt: "2026-01-05T17:00", reason: "分頁請假原因",
    });
    expect(leave.status, await leave.clone().text()).toBe(201);
    const overtime = await request("/hr/requests/overtime", "POST", {
      employeeUserId: "employee", requestedStart: "2026-01-06T18:00", requestedEnd: "2026-01-06T20:00", settlementKind: "pay", reason: "分頁加班原因",
    });
    expect(overtime.status, await overtime.clone().text()).toBe(201);
    const form = await request("/hr/me/form-requests", "POST", {
      correctionDate: "2026-01-07", requestedTime: "09:00", requestedEventKind: "clock_in", reason: "分頁補打卡原因",
    }, employeeCookie);
    expect(form.status, await form.clone().text()).toBe(201);

    const firstPage = await request("/hr/requests?page=1&pageSize=10");
    expect(firstPage.status, await firstPage.clone().text()).toBe(200);
    const firstBody = await firstPage.json() as { rows: Array<{ kind: string }>; pagination: { page: number; pageSize: number; total: number } };
    expect(firstBody.rows).toHaveLength(3);
    expect(firstBody.pagination).toMatchObject({ page: 1, pageSize: 10, total: 3 });

    const searchResult = await request("/hr/requests?page=1&pageSize=25&search=%E8%A3%9C%E6%89%93%E5%8D%A1%E5%8E%9F%E5%9B%A0");
    expect(searchResult.status, await searchResult.clone().text()).toBe(200);
    const searchBody = await searchResult.json() as { rows: Array<{ kind: string; reason: string }>; pagination: { total: number } };
    expect(searchBody.rows).toEqual([expect.objectContaining({ kind: "clock_correction", reason: "分頁補打卡原因" })]);
    expect(searchBody.pagination.total).toBe(1);

    const filteredResult = await request("/hr/requests?page=1&pageSize=25&kind=overtime&status=approved");
    expect(filteredResult.status, await filteredResult.clone().text()).toBe(200);
    const filteredBody = await filteredResult.json() as { rows: Array<{ kind: string; status: string }> };
    expect(filteredBody.rows).toEqual([expect.objectContaining({ kind: "overtime", status: "approved" })]);
  });

  it("請假時數依工作時段計算，給薪比例固定採用假別預設值並以實際時段防重疊", async () => {
    await assignEmployee();
    const leaveType = await request("/hr/leave-types", "POST", { name: "自動計算測試假", defaultPayRatePpm: 500_000 });
    const leaveTypeId = (await leaveType.json() as { id: string }).id;

    const first = await request("/hr/requests/leave", "POST", {
      employeeUserId: "employee", leaveTypeId, startsAt: "2026-01-05T09:00", endsAt: "2026-01-05T17:00", durationMinutes: 30, payRatePpm: 0, reason: "端點計算",
    });
    expect(first.status, await first.clone().text()).toBe(201);
    const firstId = (await first.json() as { id: string }).id;
    const center = await (await request("/hr/requests")).json() as { leaves: Array<{ request: { id: string; startsAt: string; endsAt: string; durationMinutes: number; payRatePpm: number } }> };
    expect(center.leaves.find((item) => item.request.id === firstId)?.request).toMatchObject({
      startsAt: "2026-01-05 01:00:00", endsAt: "2026-01-05 09:00:00", durationMinutes: 420, payRatePpm: 500_000,
    });

    const adjacent = await request("/hr/requests/leave", "POST", {
      employeeUserId: "employee", leaveTypeId, startsAt: "2026-01-05T17:00", endsAt: "2026-01-05T18:00", reason: "相鄰時段",
    });
    expect(adjacent.status, await adjacent.clone().text()).toBe(201);
    const overlap = await request("/hr/requests/leave", "POST", {
      employeeUserId: "employee", leaveTypeId, startsAt: "2026-01-05T16:00", endsAt: "2026-01-05T17:00", reason: "重疊時段",
    });
    expect(overlap.status).toBe(409);

    const tooLong = await request("/hr/requests/leave", "POST", {
      employeeUserId: "employee", leaveTypeId, startsAt: "2026-02-01T09:00", endsAt: "2026-03-04T09:30", reason: "超過最長期間",
    });
    expect(tooLong.status).toBe(400);

    const estimate = await request("/hr/requests/leave-duration", "POST", {
      employeeUserId: "employee", startsAt: "2026-09-22T09:00", endsAt: "2026-09-23T17:00",
    });
    expect(estimate.status, await estimate.clone().text()).toBe(200);
    expect((await estimate.json() as { durationMinutes: number }).durationMinutes).toBe(900);

    const screenshotCase = await request("/hr/requests/leave", "POST", {
      employeeUserId: "employee", leaveTypeId, startsAt: "2026-09-22T09:00", endsAt: "2026-09-23T17:00", reason: "跨工作日計算",
    });
    expect(screenshotCase.status, await screenshotCase.clone().text()).toBe(201);
    const screenshotId = (await screenshotCase.json() as { id: string }).id;
    const afterScheduleCalculation = await (await request("/hr/requests")).json() as { leaves: Array<{ request: { id: string; durationMinutes: number } }> };
    expect(afterScheduleCalculation.leaves.find((item) => item.request.id === screenshotId)?.request.durationMinutes).toBe(900);
  });

  it("加班申請的原因可以留空", async () => {
    await assignEmployee();
    const adminCreated = await request("/hr/requests/overtime", "POST", {
      employeeUserId: "employee", requestedStart: "2026-01-06T18:00", requestedEnd: "2026-01-06T20:00", settlementKind: "pay",
    });
    expect(adminCreated.status, await adminCreated.clone().text()).toBe(201);
    const adminCreatedBody = await adminCreated.json() as { id: string };

    const employeeCreated = await request("/hr/me/overtime", "POST", {
      requestedStart: "2026-01-07T18:00", requestedEnd: "2026-01-07T20:00", settlementKind: "pay", reason: "",
    }, employeeCookie);
    expect(employeeCreated.status, await employeeCreated.clone().text()).toBe(201);
    const employeeCreatedBody = await employeeCreated.json() as { id: string };

    const center = await request("/hr/requests");
    expect(center.status, await center.clone().text()).toBe(200);
    const body = await center.json() as { overtime: Array<{ request: { id: string; reason: string } }> };
    expect(body.overtime.find((item) => item.request.id === adminCreatedBody.id)?.request.reason).toBe("");
    expect(body.overtime.find((item) => item.request.id === employeeCreatedBody.id)?.request.reason).toBe("");
  });

  it("HR 代登不允許申請人直接核准自己的請假與加班", async () => {
    await request("/hr/employees", "POST", { userId: "admin", legalName: "管理員工", employeeNumber: "E-ADMIN", position: "一般職員", serviceStartOn: "2026-01-01" });
    const leaveType = await request("/hr/leave-types", "POST", { name: "自審測試假", defaultPayRatePpm: 1_000_000 });
    const leaveTypeId = (await leaveType.json() as { id: string }).id;
    const leave = await request("/hr/requests/leave", "POST", { employeeUserId: "admin", leaveTypeId, startsAt: "2026-01-05T09:00", endsAt: "2026-01-05T09:30", reason: "自審測試" });
    expect(leave.status).toBe(409);
    const overtime = await request("/hr/requests/overtime", "POST", { employeeUserId: "admin", requestedStart: "2026-01-06T18:00", requestedEnd: "2026-01-06T20:00", settlementKind: "pay", reason: "自審測試" });
    expect(overtime.status).toBe(409);
  });

  it("批次代登加班整批全有或全無，並指出是哪一天撞到既有申請", async () => {
    await assignEmployee();
    const entries = [
      { requestedStart: "2026-01-06T18:00", requestedEnd: "2026-01-06T18:30" },
      { requestedStart: "2026-01-07T18:00", requestedEnd: "2026-01-07T19:00" },
    ];
    const created = await request("/hr/requests/overtime/batch", "POST", { employeeUserId: "employee", settlementKind: "pay", reason: "", entries });
    expect(created.status, await created.clone().text()).toBe(201);
    expect((await created.json() as { ids: string[] }).ids).toHaveLength(2);
    const afterCreate = await (await request("/hr/requests")).json() as { overtime: Array<{ request: { status: string; actualStart: string | null } }> };
    expect(afterCreate.overtime).toHaveLength(2);
    expect(afterCreate.overtime.every((item) => item.request.status === "approved" && item.request.actualStart)).toBe(true);

    const blocked = await request("/hr/requests/overtime/batch", "POST", { employeeUserId: "employee", settlementKind: "pay", reason: "", entries: [
      { requestedStart: "2026-01-08T18:00", requestedEnd: "2026-01-08T19:00" },
      { requestedStart: "2026-01-07T18:30", requestedEnd: "2026-01-07T19:30" },
    ] });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain("2026-01-07");
    const afterBlocked = await (await request("/hr/requests")).json() as { overtime: unknown[] };
    expect(afterBlocked.overtime).toHaveLength(2);

    const batch = (payload: Record<string, unknown>) => request("/hr/requests/overtime/batch", "POST", { employeeUserId: "employee", settlementKind: "pay", reason: "", ...payload });
    expect((await batch({ entries: [] })).status).toBe(400);
    expect((await batch({ entries: [{ requestedStart: "2026-01-09T18:00", requestedEnd: "2026-01-09T18:20" }] })).status).toBe(400);
    expect((await batch({ entries: [
      { requestedStart: "2026-01-09T18:00", requestedEnd: "2026-01-09T19:00" },
      { requestedStart: "2026-01-09T18:30", requestedEnd: "2026-01-09T19:30" },
    ] })).status).toBe(400);
    expect((await batch({ entries: Array.from({ length: 32 }, (_, index) => ({ requestedStart: `2026-03-${String(index % 28 + 1).padStart(2, "0")}T18:00`, requestedEnd: `2026-03-${String(index % 28 + 1).padStart(2, "0")}T19:00` })) })).status).toBe(400);
    expect((await batch({ entries }, )).status).toBe(409);
    expect((await request("/hr/requests/overtime/batch", "POST", { employeeUserId: "employee", settlementKind: "pay", reason: "", entries: [{ requestedStart: "2026-01-12T18:00", requestedEnd: "2026-01-12T19:00" }] }, employeeCookie)).status).toBe(403);
    const afterInvalid = await (await request("/hr/requests")).json() as { overtime: unknown[] };
    expect(afterInvalid.overtime).toHaveLength(2);
  });

  it("員工一次送出多天加班：每天一筆待審，審核者整批只收到一則通知", async () => {
    await assignEmployeeSupervisor();
    const mine = (payload: Record<string, unknown>, cookie = employeeCookie) => request("/hr/me/overtime/batch", "POST", { settlementKind: "pay", reason: "月底補登", ...payload }, cookie);
    const created = await mine({ entries: [
      { requestedStart: "2026-01-10T18:00", requestedEnd: "2026-01-10T20:00" },
      { requestedStart: "2026-01-06T18:00", requestedEnd: "2026-01-06T19:00" },
      { requestedStart: "2026-01-07T18:00", requestedEnd: "2026-01-07T19:00" },
    ] });
    expect(created.status, await created.clone().text()).toBe(201);
    const { ids } = await created.json() as { ids: string[] };
    expect(ids).toHaveLength(3);

    const inbox = await (await request("/hr/me/overtime", "GET", undefined, adminCookie)).json() as { reviewRequests: Array<{ request: { id: string; status: string; actualStart: string | null; approverUserId: string; batchId: string | null }; employeeUserId: string }> };
    expect(inbox.reviewRequests).toHaveLength(3);
    const batchId = inbox.reviewRequests[0]!.request.batchId;
    expect(batchId).toBeTruthy();
    expect(inbox.reviewRequests.every((item) => item.request.batchId === batchId)).toBe(true);
    expect(inbox.reviewRequests.every((item) => item.employeeUserId === "employee" && item.request.status === "pending" && item.request.actualStart === null && item.request.approverUserId === "admin")).toBe(true);

    const notifications = await (await request("/hr/me/notifications", "GET", undefined, adminCookie)).json() as { notifications: Array<{ entityId: string; entityScope: string; kind: string; title: string; body: string }>; unreadCount: number };
    expect(notifications.unreadCount).toBe(1);
    // 通知掛在批次鍵上而不是某一筆：批裡任何一筆被取消或先審掉，通知仍然點得進整批。
    expect(notifications.notifications[0]).toMatchObject({ entityId: batchId, entityScope: "batch", kind: "request_submitted", title: "有 3 筆新的加班申請待審核" });
    expect(notifications.notifications[0]!.body).toContain("2026-01-06、2026-01-07、2026-01-10");

    const days = await request("/hr/me/overtime-days?startsOn=2026-01-05&endsOn=2026-01-08", "GET", undefined, employeeCookie);
    expect(days.status, await days.clone().text()).toBe(200);
    expect((await days.json() as { days: Array<{ date: string; existing: unknown[] }> }).days.map((day) => [day.date, day.existing.length])).toEqual([["2026-01-05", 0], ["2026-01-06", 1], ["2026-01-07", 1]]);

    // 撞到自己既有的申請時整批不建，也不多發通知。
    const blocked = await mine({ entries: [
      { requestedStart: "2026-01-08T18:00", requestedEnd: "2026-01-08T19:00" },
      { requestedStart: "2026-01-07T18:30", requestedEnd: "2026-01-07T19:30" },
    ] });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain("2026-01-07");
    // 員工只能替自己申請：帶別人的 ID 會被忽略，帶支援人員 ID 直接拒絕。
    // 本人入口一律付薪：選補休整批拒絕；待審的付薪申請也不能改成補休。
    expect((await mine({ settlementKind: "compensatory", entries: [{ requestedStart: "2026-01-14T18:00", requestedEnd: "2026-01-14T19:00" }] })).status).toBe(400);
    expect((await request("/hr/me/overtime", "POST", { requestedStart: "2026-01-14T18:00", requestedEnd: "2026-01-14T19:00", settlementKind: "compensatory", reason: "" }, employeeCookie)).status).toBe(400);
    expect((await request(`/hr/me/overtime/${ids[0]}`, "PATCH", { requestedStart: "2026-01-06T18:00", requestedEnd: "2026-01-06T19:30", settlementKind: "compensatory", reason: "", revision: 1 }, employeeCookie)).status).toBe(400);
    const forged = await mine({ employeeUserId: "admin", entries: [{ requestedStart: "2026-01-12T18:00", requestedEnd: "2026-01-12T19:00" }] });
    expect(forged.status, await forged.clone().text()).toBe(201);
    expect((await mine({ workerId: "worker-1", entries: [{ requestedStart: "2026-01-13T18:00", requestedEnd: "2026-01-13T19:00" }] })).status).toBe(400);
    const after = await (await request("/hr/me/overtime", "GET", undefined, employeeCookie)).json() as { requests: unknown[] };
    expect(after.requests).toHaveLength(4);
    const adminOwn = await (await request("/hr/me/overtime", "GET", undefined, adminCookie)).json() as { requests: unknown[] };
    expect(adminOwn.requests).toHaveLength(0);
    const afterNotifications = await (await request("/hr/me/notifications", "GET", undefined, adminCookie)).json() as { notifications: Array<{ title: string }>; unreadCount: number };
    expect(afterNotifications.unreadCount).toBe(2);
    expect(afterNotifications.notifications.some((item) => item.title === "有新的加班申請待審核")).toBe(true);
  });

  it("整批加班逐筆核准、逐筆取消時，通知各合成一則並逐行累積；駁回仍然一筆一則", async () => {
    await assignEmployeeSupervisor();
    const created = await request("/hr/me/overtime/batch", "POST", { settlementKind: "pay", reason: "月底補登", entries: [6, 7, 8, 9, 12, 13].map((day) => ({ requestedStart: `2026-01-${String(day).padStart(2, "0")}T18:00`, requestedEnd: `2026-01-${String(day).padStart(2, "0")}T19:00` })) }, employeeCookie);
    expect(created.status, await created.clone().text()).toBe(201);
    const { ids } = await created.json() as { ids: string[] };
    type Notice = { entityId: string; entityScope: string; kind: string; title: string; body: string; readAt: string | null };
    const notices = async (cookie: string) => (await (await request("/hr/me/notifications", "GET", undefined, cookie)).json() as { notifications: Notice[]; unreadCount: number });
    const batchId = (await notices(adminCookie)).notifications[0]!.entityId;
    const review = (id: string, decision: string, comment = "") => request(`/hr/me/overtime/${id}/review`, "POST", { revision: 1, decision, comment }, adminCookie);

    // 第一筆有意見、第二筆沒有：前一筆的意見不能被後一筆蓋掉，而且看得出是哪一天的。
    expect((await review(ids[0]!, "approved", "只核 1 小時")).status).toBe(200);
    expect((await review(ids[1]!, "approved")).status).toBe(200);
    let mine = await notices(employeeCookie);
    expect(mine.notifications).toHaveLength(1);
    expect(mine.notifications[0]).toMatchObject({ entityId: batchId, entityScope: "batch", kind: "request_reviewed", title: "加班申請已核准", body: "2026-01-06 已核准：只核 1 小時\n2026-01-07 已核准。" });

    // 讀過之後又核准一筆：同一則接上新的一行並重新變成未讀，不另外多一則。
    expect((await request("/hr/me/notifications/read-all", "POST", {}, employeeCookie)).status).toBe(200);
    expect((await notices(employeeCookie)).unreadCount).toBe(0);
    expect((await review(ids[2]!, "approved")).status).toBe(200);
    mine = await notices(employeeCookie);
    expect(mine.notifications).toHaveLength(1);
    expect(mine.unreadCount).toBe(1);
    expect(mine.notifications[0]!.readAt).toBeNull();
    expect(mine.notifications[0]!.body).toBe("2026-01-06 已核准：只核 1 小時\n2026-01-07 已核准。\n2026-01-08 已核准。");

    // 駁回各有各的理由，掛在那一筆申請上。
    expect((await review(ids[3]!, "rejected", "這天沒有加班紀錄")).status).toBe(200);
    mine = await notices(employeeCookie);
    expect(mine.notifications).toHaveLength(2);
    expect(mine.notifications.find((item) => item.title === "加班申請已駁回")).toMatchObject({ entityId: ids[3], entityScope: "request", body: "這天沒有加班紀錄" });

    // 員工連續取消兩天：審核者只有一則取消通知，兩天都列在裡面。
    expect((await request(`/hr/me/overtime/${ids[4]}/cancel`, "POST", {}, employeeCookie)).status).toBe(200);
    expect((await request("/hr/me/notifications/read-all", "POST", {}, adminCookie)).status).toBe(200);
    expect((await request(`/hr/me/overtime/${ids[5]}/cancel`, "POST", {}, employeeCookie)).status).toBe(200);
    const inbox = await notices(adminCookie);
    const cancelled = inbox.notifications.filter((item) => item.kind === "request_cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ entityId: batchId, entityScope: "batch", readAt: null, body: "申請人已取消 2026-01-12 的待審加班申請。\n申請人已取消 2026-01-13 的待審加班申請。" });
    expect(inbox.unreadCount).toBe(1);
  });

  it("審核者可以一次核准整批待審加班：只核准還在待審的，申請人只多一行通知", async () => {
    await assignEmployeeSupervisor();
    const created = await request("/hr/me/overtime/batch", "POST", { settlementKind: "pay", reason: "月底補登", entries: [6, 7, 8, 9].map((day) => ({ requestedStart: `2026-01-0${day}T18:00`, requestedEnd: `2026-01-0${day}T19:00` })) }, employeeCookie);
    const { ids } = await created.json() as { ids: string[] };
    const batchId = ((await (await request("/hr/me/notifications", "GET", undefined, adminCookie)).json()) as { notifications: Array<{ entityId: string }> }).notifications[0]!.entityId;
    const seen = (requestIds: string[], revision = 1) => requestIds.map((id) => ({ id, revision }));
    const approve = (cookie: string, requests: Array<{ id: string; revision: number }>, comment = "") => request(`/hr/me/overtime/batches/${batchId}/approve`, "POST", { comment, requests }, cookie);

    // 申請人自己不能核准自己的批次。
    expect((await approve(employeeCookie, seen(ids))).status).toBe(404);

    // 先逐筆駁回一天、核准一天，剩下兩天整批核准：只動還在待審的那兩筆。
    expect((await request(`/hr/me/overtime/${ids[0]}/review`, "POST", { revision: 1, decision: "rejected", comment: "這天沒有加班紀錄" }, adminCookie)).status).toBe(200);
    expect((await request(`/hr/me/overtime/${ids[1]}/review`, "POST", { revision: 1, decision: "approved", comment: "" }, adminCookie)).status).toBe(200);
    const approved = await approve(adminCookie, seen([ids[2]!, ids[3]!]), "辛苦了");
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(await approved.json()).toEqual({ ids: [ids[2], ids[3]], status: "approved" });

    const mine = await (await request("/hr/me/overtime", "GET", undefined, employeeCookie)).json() as { requests: Array<{ request: { id: string; status: string; actualStart: string | null; decisionReason: string } }> };
    const byId = new Map(mine.requests.map((item) => [item.request.id, item.request]));
    expect(byId.get(ids[0]!)?.status).toBe("rejected");
    expect([ids[1], ids[2], ids[3]].every((id) => byId.get(id!)?.status === "approved" && byId.get(id!)?.actualStart)).toBe(true);
    expect(byId.get(ids[2]!)?.decisionReason).toBe("辛苦了");

    const notices = await (await request("/hr/me/notifications", "GET", undefined, employeeCookie)).json() as { notifications: Array<{ title: string; body: string; entityId: string }> };
    const approvedNotice = notices.notifications.filter((item) => item.title === "加班申請已核准");
    expect(approvedNotice).toHaveLength(1);
    // 逐筆核准的那一天一行，整批核准的兩天合成一行。
    expect(approvedNotice[0]).toMatchObject({ entityId: batchId, body: "2026-01-07 已核准。\n2026-01-08、2026-01-09 已核准：辛苦了" });

    // 整批核准的每一筆都查得到是誰核准的，不是只掛在第一筆上。
    const events = d1.sqlite.prepare("SELECT entity_id, actor_id FROM activity_events WHERE event_type='overtime_requests_reviewed' ORDER BY entity_id").all() as Array<{ entity_id: string; actor_id: string }>;
    expect(events.map((event) => event.entity_id).sort()).toEqual([ids[2], ids[3]].sort());
    expect(events.every((event) => event.actor_id === "admin")).toBe(true);

    // 整批都處理完之後再按一次：沒有東西可核准。
    expect((await approve(adminCookie, seen([ids[2]!, ids[3]!]))).status).toBe(404);
    expect((await request("/hr/me/overtime/batches/not-a-batch/approve", "POST", { comment: "", requests: seen([ids[2]!]) }, adminCookie)).status).toBe(404);
    expect((await approve(adminCookie, [])).status).toBe(400);
    expect((await (await request("/hr/me/overtime", "GET", undefined, adminCookie)).json() as { reviewRequests: unknown[] }).reviewRequests).toHaveLength(0);
  });

  it("整批核准只核准審核者在確認框裡看到的內容：申請人中途改過或筆數不同都擋下，整批不動", async () => {
    await assignEmployeeSupervisor();
    const created = await request("/hr/me/overtime/batch", "POST", { settlementKind: "pay", reason: "", entries: [6, 7, 8].map((day) => ({ requestedStart: `2026-01-0${day}T18:00`, requestedEnd: `2026-01-0${day}T19:00` })) }, employeeCookie);
    const { ids } = await created.json() as { ids: string[] };
    const batchId = ((await (await request("/hr/me/notifications", "GET", undefined, adminCookie)).json()) as { notifications: Array<{ entityId: string }> }).notifications[0]!.entityId;
    const approve = (requests: Array<{ id: string; revision: number }>) => request(`/hr/me/overtime/batches/${batchId}/approve`, "POST", { comment: "", requests }, adminCookie);
    const pending = async () => (await (await request("/hr/me/overtime", "GET", undefined, adminCookie)).json() as { reviewRequests: Array<{ request: { id: string; revision: number; status: string; requestedStart: string; requestedEnd: string; actualStart: string | null; actualEnd: string | null } }> }).reviewRequests;

    // 審核者打開確認框時看到三筆各 1 小時（revision 1）；申請人接著把 1/7 改成 4 小時。
    const seen = (await pending()).map((item) => ({ id: item.request.id, revision: item.request.revision }));
    const edited = await request(`/hr/me/overtime/${ids[1]}`, "PATCH", { requestedStart: "2026-01-07T18:00", requestedEnd: "2026-01-07T22:00", settlementKind: "pay", reason: "", revision: 1 }, employeeCookie);
    expect(edited.status, await edited.clone().text()).toBe(200);

    const stale = await approve(seen);
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("有變動");
    expect((await pending()).every((item) => item.request.status === "pending" && item.request.actualStart === null)).toBe(true);

    // 少看一筆也不行：畫面寫「核准 N 筆」，就只能核准那 N 筆。
    const latest = (await pending()).map((item) => ({ id: item.request.id, revision: item.request.revision }));
    expect((await approve(latest.slice(0, 2))).status).toBe(409);
    expect((await approve([...latest.slice(0, 2), { id: "not-in-batch", revision: 1 }])).status).toBe(409);
    expect((await pending())).toHaveLength(3);

    // 看過最新的內容再核准：核定時段等於改過之後的申請時段。
    const approved = await approve(latest);
    expect(approved.status, await approved.clone().text()).toBe(200);
    const mine = await (await request("/hr/me/overtime", "GET", undefined, employeeCookie)).json() as { requests: Array<{ request: { id: string; status: string; requestedEnd: string; actualStart: string | null; actualEnd: string | null; requestedStart: string } }> };
    const changed = mine.requests.find((item) => item.request.id === ids[1])!.request;
    expect(changed).toMatchObject({ status: "approved", actualStart: changed.requestedStart, actualEnd: changed.requestedEnd });
    expect((Date.parse(`${changed.actualEnd!.replace(" ", "T")}Z`) - Date.parse(`${changed.actualStart!.replace(" ", "T")}Z`)) / 3_600_000).toBe(4);
  });

  it("逐筆審核只核准審核者看到的那一版：對話框開著時申請人改了時數，按下去會被擋", async () => {
    await assignEmployeeSupervisor();
    const created = await request("/hr/me/overtime", "POST", { requestedStart: "2026-01-06T18:00", requestedEnd: "2026-01-06T19:00", settlementKind: "pay", reason: "" }, employeeCookie);
    const id = (await created.json() as { id: string }).id;
    const review = (decision: string, revision: number | undefined, comment = "") => request(`/hr/me/overtime/${id}/review`, "POST", { decision, comment, ...(revision === undefined ? {} : { revision }) }, adminCookie);
    const current = () => d1.sqlite.prepare("SELECT status, revision, actual_start, actual_end, requested_end FROM hr_overtime_requests WHERE id=?").get(id) as { status: string; revision: number; actual_start: string | null; actual_end: string | null; requested_end: string };

    // 審核者打開對話框時看到 1 小時（revision 1）；申請人接著改成 4 小時。
    const edited = await request(`/hr/me/overtime/${id}`, "PATCH", { requestedStart: "2026-01-06T18:00", requestedEnd: "2026-01-06T22:00", settlementKind: "pay", reason: "", revision: 1 }, employeeCookie);
    expect(edited.status, await edited.clone().text()).toBe(200);

    for (const decision of ["approved", "rejected"]) {
      const stale = await review(decision, 1, "依照畫面上的內容決定");
      expect(stale.status).toBe(409);
      expect(await stale.text()).toContain("修改過");
    }
    expect(current()).toMatchObject({ status: "pending", revision: 2, actual_start: null });

    // 沒帶版本就不收：選填的話，漏送的那個畫面會照最新內容寫入。
    const missing = await review("approved", undefined);
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("版本");
    expect(current().status).toBe("pending");

    // 看過最新的內容再核准：核定的是改過之後的 4 小時。
    expect((await review("approved", 2)).status).toBe(200);
    const approved = current();
    expect(approved).toMatchObject({ status: "approved", actual_end: approved.requested_end });
  });

  it("審核的寫入也守版本：讀出來之後、寫進去之前被改掉的申請不會被核准", async () => {
    await assignEmployeeSupervisor();
    const created = await request("/hr/me/overtime", "POST", { requestedStart: "2026-01-06T18:00", requestedEnd: "2026-01-06T19:00", settlementKind: "pay", reason: "" }, employeeCookie);
    const id = (await created.json() as { id: string }).id;
    const db = createDatabase(d1 as never);
    // 寫入走 D1 batch；在它執行前先把那一列改掉，模擬兩個請求交錯。
    const realBatch = d1.batch;
    d1.batch = ((statements: Parameters<typeof d1.batch>[0]) => {
      d1.batch = realBatch;
      d1.sqlite.prepare("UPDATE hr_overtime_requests SET revision=revision+1, requested_start='2026-01-06 12:00:00', requested_end='2026-01-06 14:00:00' WHERE id=?").run(id);
      return realBatch.call(d1, statements);
    }) as typeof d1.batch;
    try {
      const rejection = await reviewHrOvertimeRequest(db, id, "approved", "", { id: "admin", email: "admin@example.test" }).then(() => null, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(HrError);
      // 不是籠統的「不存在、不可自審或已處理」：審核者要知道是內容被改了。
      expect((rejection as HrError).message).toContain("修改過");
    } finally {
      d1.batch = realBatch;
    }
    expect(d1.sqlite.prepare("SELECT status, revision, actual_start FROM hr_overtime_requests WHERE id=?").get(id)).toEqual({ status: "pending", revision: 2, actual_start: null });
  });

  it("單筆申請與後台代登不帶批次鍵，通知維持一筆一則", async () => {
    await assignEmployeeSupervisor();
    const single = await request("/hr/me/overtime", "POST", { requestedStart: "2026-01-20T18:00", requestedEnd: "2026-01-20T19:00", settlementKind: "pay", reason: "" }, employeeCookie);
    const singleId = (await single.json() as { id: string }).id;
    expect((await request(`/hr/me/overtime/${singleId}/cancel`, "POST", {}, employeeCookie)).status).toBe(200);
    const after = await (await request("/hr/me/notifications", "GET", undefined, adminCookie)).json() as { notifications: Array<{ kind: string; entityId: string; entityScope: string; body: string }> };
    expect(after.notifications.find((item) => item.kind === "request_cancelled")).toMatchObject({ entityId: singleId, entityScope: "request", body: "申請人已取消 2026-01-20 的待審加班申請。" });

    // 後台代登直接核准、沒有通知要合併；批次鍵只代表「本人送出、待審核的一批」。
    const proxied = await request("/hr/requests/overtime/batch", "POST", { employeeUserId: "employee", settlementKind: "pay", reason: "", entries: [21, 22].map((day) => ({ requestedStart: `2026-01-${day}T18:00`, requestedEnd: `2026-01-${day}T19:00` })) });
    expect(proxied.status, await proxied.clone().text()).toBe(201);
    const mine = await (await request("/hr/me/overtime", "GET", undefined, employeeCookie)).json() as { requests: Array<{ request: { batchId: string | null; status: string } }> };
    expect(mine.requests).toHaveLength(2);
    expect(mine.requests.every((item) => item.request.status === "approved" && item.request.batchId === null)).toBe(true);
  });

  it("通知內文超過上限時整行捨棄最舊的，每一行的日期都留著", async () => {
    await assignEmployeeSupervisor();
    const created = await request("/hr/me/overtime/batch", "POST", { settlementKind: "pay", reason: "", entries: [6, 7, 8].map((day) => ({ requestedStart: `2026-01-0${day}T18:00`, requestedEnd: `2026-01-0${day}T19:00` })) }, employeeCookie);
    const { ids } = await created.json() as { ids: string[] };
    const review = (id: string, comment: string) => request(`/hr/me/overtime/${id}/review`, "POST", { revision: 1, decision: "approved", comment }, adminCookie);
    const body = async () => (await (await request("/hr/me/notifications", "GET", undefined, employeeCookie)).json() as { notifications: Array<{ body: string }> }).notifications[0]!.body;

    // 意見長度就是上限：單獨一行也放不下時截的是意見，日期前綴完整。
    const maxComment = `${"長".repeat(996)}😀結尾`;
    expect([...maxComment].length).toBe(999);
    expect((await review(ids[0]!, maxComment)).status).toBe(200);
    const first = await body();
    expect([...first].length).toBeLessThanOrEqual(1000);
    expect(first.startsWith("2026-01-06 已核准：長")).toBe(true);
    expect(first.endsWith("…")).toBe(true);

    // 再接兩行就超過上限：最舊的那一行整行捨棄，不留沒有日期的殘段。
    expect((await review(ids[1]!, "😀短意見")).status).toBe(200);
    expect(await body()).toBe("…\n2026-01-07 已核准：😀短意見");
    expect((await review(ids[2]!, "")).status).toBe(200);
    expect(await body()).toBe("…\n2026-01-07 已核准：😀短意見\n2026-01-08 已核准。");
  });

  it("加班日曆帶出每天的下班時間與已存在的申請", async () => {
    await assignEmployee();
    const days = async () => {
      const response = await request("/hr/requests/overtime-days?employeeUserId=employee&startsOn=2026-01-05&endsOn=2026-01-08");
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json() as { days: Array<{ date: string; shiftEnd: string | null; existing: Array<{ requestedStart: string; status: string }> }> }).days;
    };

    // 一般辦公沒有逐日班表：每天都是公司標準下班時間（台北 18:00）。
    expect(await days()).toEqual([
      { date: "2026-01-05", shiftEnd: "2026-01-05 10:00:00", existing: [] },
      { date: "2026-01-06", shiftEnd: "2026-01-06 10:00:00", existing: [] },
      { date: "2026-01-07", shiftEnd: "2026-01-07 10:00:00", existing: [] },
    ]);

    const db = createDatabase(d1 as never);
    const employment = d1.sqlite.prepare("SELECT id FROM hr_employments WHERE employee_user_id=? AND archived_at IS NULL").get("employee") as { id: string };
    await db.insert(scopes).values({ id: "scope-counter", sourceType: "manual", scopeKind: "store", name: "測試櫃點", normalizedName: "測試櫃點" });
    await db.insert(hrShiftTemplates).values({ id: "overtime-shift", code: "overtime-shift", name: "加班測試班", createdBy: "admin" });
    await db.insert(hrShiftVersions).values({ id: "overtime-shift-v1", shiftTemplateId: "overtime-shift", dayType: "weekday", versionNumber: 1, startSecond: 11 * 3600, endSecond: 20 * 3600, standardMinutes: 480, breakMinutes: 60, createdBy: "admin" });
    await db.insert(hrScheduleVersions).values({ id: "overtime-schedule-2026-01", periodStart: "2026-01-01", periodEnd: "2026-02-01", versionNumber: 1, status: "published", submittedBy: "admin", approvedBy: "admin" });
    await db.insert(hrScheduleEntries).values([
      { id: "overtime-entry-06", scheduleVersionId: "overtime-schedule-2026-01", employmentId: employment.id, scopeId: "scope-counter", shiftVersionId: "overtime-shift-v1", workDate: "2026-01-06", startsAt: "2026-01-06 11:00:00", endsAt: "2026-01-06 20:00:00", standardMinutes: 480, breakMinutes: 60, createdBy: "admin" },
    ]);
    const overtime = await request("/hr/requests/overtime", "POST", { employeeUserId: "employee", requestedStart: "2026-01-06T20:00", requestedEnd: "2026-01-06T21:00", settlementKind: "pay", reason: "" });
    expect(overtime.status, await overtime.clone().text()).toBe(201);

    // 有已發布班表後只認班表：沒排班的日子沒有可帶入的下班時間。
    expect(await days()).toEqual([
      { date: "2026-01-05", shiftEnd: null, existing: [] },
      { date: "2026-01-06", shiftEnd: "2026-01-06 12:00:00", existing: [expect.objectContaining({ requestedStart: "2026-01-06 12:00:00", status: "approved" })] },
      { date: "2026-01-07", shiftEnd: null, existing: [] },
    ]);

    const overnight = await request("/hr/requests/overtime", "POST", { employeeUserId: "employee", requestedStart: "2026-01-06T23:00", requestedEnd: "2026-01-07T01:00", settlementKind: "pay", reason: "跨午夜申請" });
    expect(overnight.status, await overnight.clone().text()).toBe(201);
    const overnightStartUtc = "2026-01-06 15:00:00";
    const afterOvernight = await days();
    expect(afterOvernight.find((day) => day.date === "2026-01-06")?.existing).toEqual(expect.arrayContaining([expect.objectContaining({ requestedStart: overnightStartUtc, status: "approved" })]));
    expect(afterOvernight.find((day) => day.date === "2026-01-07")?.existing).toEqual(expect.arrayContaining([expect.objectContaining({ requestedStart: overnightStartUtc, status: "approved" })]));

    expect((await request("/hr/requests/overtime-days?employeeUserId=employee&startsOn=2026-01-05&endsOn=2026-01-05")).status).toBe(400);
    expect((await request("/hr/requests/overtime-days?employeeUserId=employee&startsOn=2026-01-05&endsOn=2026-01-08", "GET", undefined, employeeCookie)).status).toBe(403);
  });

  it("已被月度人工假勤使用的假別不可重新分類為特休", async () => {
    await assignEmployee();
    const leaveType = await request("/hr/payroll/monthly-data/leave-types", "POST", { name: "月度分類測試假", defaultPayRatePpm: 1_000_000 });
    const leaveTypeId = (await leaveType.json() as { id: string }).id;
    const profile = await (await request("/hr/employees/employee")).json() as { employments: Array<{ id: string }> };
    const entry = await request("/hr/payroll/monthly-data/leave", "POST", { employmentId: profile.employments[0]!.id, leaveTypeId, leaveDate: "2026-01-05", hoursHalfUnits: 2, payRatePpm: 1_000_000, deductionAmount: 0, note: "分類保護" });
    expect(entry.status, await entry.clone().text()).toBe(201);
    const updated = await request(`/hr/leave-types/${leaveTypeId}`, "PATCH", { name: "月度分類測試假", defaultPayRatePpm: 1_000_000, leaveKind: "annual" });
    expect(updated.status).toBe(409);
  });

  it("本人入口仍會進入待審核，管理端可以走同一個審核階段", async () => {
    await assignEmployee();
    const leaveType = await request("/hr/leave-types", "POST", { name: "測試病假", defaultPayRatePpm: 500_000 });
    const leaveTypeBody = await leaveType.json() as { id: string };

    const pendingLeave = await request("/hr/me/leave-requests", "POST", {
      leaveTypeId: leaveTypeBody.id, startsAt: "2026-02-05T09:00", endsAt: "2026-02-05T13:00", reason: "本人請假測試",
    }, employeeCookie);
    expect(pendingLeave.status, await pendingLeave.clone().text()).toBe(201);
    const pendingLeaveBody = await pendingLeave.json() as { id: string };

    const pendingOvertime = await request("/hr/me/overtime", "POST", {
      requestedStart: "2026-02-06T18:00", requestedEnd: "2026-02-06T20:00", settlementKind: "pay", reason: "本人加班測試",
    }, employeeCookie);
    expect(pendingOvertime.status, await pendingOvertime.clone().text()).toBe(201);
    const pendingOvertimeBody = await pendingOvertime.json() as { id: string };

    const center = await (await request("/hr/requests")).json() as { leaves: Array<{ request: { id: string; status: string } }>; overtime: Array<{ request: { id: string; status: string } }> };
    expect(center.leaves.find((item) => item.request.id === pendingLeaveBody.id)?.request.status).toBe("pending");
    expect(center.overtime.find((item) => item.request.id === pendingOvertimeBody.id)?.request.status).toBe("pending");

    const leaveReview = await request(`/hr/requests/leave/${pendingLeaveBody.id}/review`, "POST", { revision: 1, decision: "approved", comment: "管理端核准" });
    expect(leaveReview.status, await leaveReview.clone().text()).toBe(200);
    const overtimeReview = await request(`/hr/overtime/${pendingOvertimeBody.id}/review`, "POST", { revision: 1, decision: "approved", comment: "管理端核准" });
    expect(overtimeReview.status, await overtimeReview.clone().text()).toBe(200);

    const after = await (await request("/hr/requests")).json() as { leaves: Array<{ request: { id: string; status: string } }>; overtime: Array<{ request: { id: string; status: string } }> };
    expect(after.leaves.find((item) => item.request.id === pendingLeaveBody.id)?.request.status).toBe("approved");
    expect(after.overtime.find((item) => item.request.id === pendingOvertimeBody.id)?.request.status).toBe("approved");
  });

  it("本人可取得啟用假別、預覽請假時數並查看與取消申請狀態", async () => {
    await assignEmployee();
    const leaveType = await request("/hr/leave-types", "POST", { name: "本人請假測試假", defaultPayRatePpm: 1_000_000 });
    expect(leaveType.status, await leaveType.clone().text()).toBe(201);
    const leaveTypeId = (await leaveType.json() as { id: string }).id;

    const types = await request("/hr/me/leave-types", "GET", undefined, employeeCookie);
    expect(types.status, await types.clone().text()).toBe(200);
    expect((await types.json() as { leaveTypes: Array<{ id: string; leaveKind: string; credits: unknown[] }> }).leaveTypes).toEqual(expect.arrayContaining([expect.objectContaining({ id: leaveTypeId, leaveKind: "other", credits: [] })]));

    const duration = await request("/hr/me/leave-duration", "POST", { startsAt: "2026-02-05T09:00", endsAt: "2026-02-05T13:00" }, employeeCookie);
    expect(duration.status, await duration.clone().text()).toBe(200);
    expect((await duration.json() as { durationMinutes: number }).durationMinutes).toBe(180);

    // 2026-02-05 11:00 起 3 小時：午休不算，所以是 15:00 而不是 14:00。
    const sameDayEnd = await request("/hr/me/leave-end", "POST", { startsAt: "2026-02-05T11:00", durationMinutes: 180 }, employeeCookie);
    expect(sameDayEnd.status, await sameDayEnd.clone().text()).toBe(200);
    expect(await sameDayEnd.json()).toMatchObject({ endsAt: "2026-02-05 07:00:00", durationMinutes: 180 });
    // 16:00 起 4 小時：當天只剩 2 小時，其餘接到隔天早上。
    const nextDayEnd = await request("/hr/me/leave-end", "POST", { startsAt: "2026-02-05T16:00", durationMinutes: 240 }, employeeCookie);
    expect(await nextDayEnd.json()).toMatchObject({ endsAt: "2026-02-06 03:00:00", durationMinutes: 240 });
    expect((await request("/hr/me/leave-end", "POST", { startsAt: "2026-02-05T09:00", durationMinutes: 45 }, employeeCookie)).status).toBe(400);
    expect((await request("/hr/me/leave-end", "POST", { startsAt: "2026-02-05T09:00", durationMinutes: 44_640 }, employeeCookie)).status).toBe(400);

    const created = await request("/hr/me/leave-requests", "POST", { leaveTypeId, startsAt: "2026-02-05T09:00", endsAt: "2026-02-05T13:00", reason: "本人狀態測試" }, employeeCookie);
    expect(created.status, await created.clone().text()).toBe(201);
    const requestId = (await created.json() as { id: string }).id;
    const listed = await request("/hr/me/leave-requests", "GET", undefined, employeeCookie);
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect((await listed.json() as { requests: Array<{ request: { id: string; status: string; durationMinutes: number } }> }).requests.find((item) => item.request.id === requestId)?.request).toMatchObject({ status: "pending", durationMinutes: 180 });

    const cancelled = await request(`/hr/me/leave-requests/${requestId}/cancel`, "POST", {}, employeeCookie);
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    const afterCancel = await request("/hr/me/leave-requests", "GET", undefined, employeeCookie);
    expect((await afterCancel.json() as { requests: Array<{ request: { id: string; status: string } }> }).requests.find((item) => item.request.id === requestId)?.request.status).toBe("cancelled");
  });

  it("時數反推結束時間：排班制照班次與無薪休息走，零星班次不會把一般辦公的結束時間拉走", async () => {
    await assignEmployee();
    const end = async (startsAt: string, durationMinutes: number) => {
      const response = await request("/hr/me/leave-end", "POST", { startsAt, durationMinutes }, employeeCookie);
      return { status: response.status, ...(await response.json() as { endsAt?: string; durationMinutes?: number }) };
    };
    const db = createDatabase(d1 as never);
    const employment = d1.sqlite.prepare("SELECT id FROM hr_employments WHERE employee_user_id=? AND archived_at IS NULL").get("employee") as { id: string };
    await db.insert(scopes).values({ id: "scope-counter", sourceType: "manual", scopeKind: "store", name: "測試櫃點", normalizedName: "測試櫃點" });
    await db.insert(hrShiftTemplates).values({ id: "leave-shift", code: "leave-shift", name: "請假測試班", createdBy: "admin" });
    await db.insert(hrShiftVersions).values({ id: "leave-shift-v1", shiftTemplateId: "leave-shift", dayType: "weekday", versionNumber: 1, startSecond: 11 * 3600, endSecond: 20 * 3600, standardMinutes: 480, breakMinutes: 60, createdBy: "admin" });
    await db.insert(hrScheduleVersions).values({ id: "leave-schedule-2026-03", periodStart: "2026-03-01", periodEnd: "2026-04-01", versionNumber: 1, status: "published", submittedBy: "admin", approvedBy: "admin" });
    const entry = (id: string, workDate: string, from: string, to: string, standardMinutes: number, breakMinutes: number) => ({ id, scheduleVersionId: "leave-schedule-2026-03", employmentId: employment.id, scopeId: "scope-counter", shiftVersionId: "leave-shift-v1", workDate, startsAt: `${workDate} ${from}`, endsAt: `${workDate} ${to}`, standardMinutes, breakMinutes, createdBy: "admin" });
    await db.insert(hrScheduleEntries).values([
      entry("leave-entry-10", "2026-03-10", "11:00:00", "20:00:00", 480, 60),
      entry("leave-entry-12", "2026-03-12", "11:00:00", "20:00:00", 480, 60),
      entry("leave-entry-28", "2026-03-28", "10:00:00", "14:00:00", 240, 0),
    ]);

    // 班次 11:00–20:00、午休 12:00–13:00：17:00 起 3 小時停在當天 20:00，不會被標準工時拖到隔天早上。
    expect(await end("2026-03-10T17:00", 180)).toMatchObject({ status: 200, endsAt: "2026-03-10 12:00:00", durationMinutes: 180 });
    // 跨無薪休息。
    expect(await end("2026-03-10T11:30", 60)).toMatchObject({ status: 200, endsAt: "2026-03-10 05:30:00", durationMinutes: 60 });
    // 11 日沒有班次，當天班次用完後接到 12 日。
    expect(await end("2026-03-10T19:00", 120)).toMatchObject({ status: 200, endsAt: "2026-03-12 04:00:00", durationMinutes: 120 });
    // 16 日前後都沒有班次，照標準工時算；28 日那筆零星班次不能把結束時間拉過去。
    expect(await end("2026-03-16T11:00", 180)).toMatchObject({ status: 200, endsAt: "2026-03-16 07:00:00", durationMinutes: 180 });

    // 遠處一筆壞掉的班次（時間不是有效時刻）不擋今天的換算；請假區間碰到那一天才回報設定錯誤。
    await db.insert(hrScheduleEntries).values([entry("leave-entry-30", "2026-03-30", "25:00:00", "26:00:00", 60, 0)]);
    expect(await end("2026-03-10T17:00", 180)).toMatchObject({ status: 200, endsAt: "2026-03-10 12:00:00" });
    expect((await end("2026-03-29T09:00", 60)).status).toBe(409);

    // 同一天班次重疊時正向算法會把重疊的一小時算兩次；反推回傳的時數必須跟正向算出來的一樣。
    await db.insert(hrScheduleEntries).values([
      entry("leave-entry-20a", "2026-03-20", "09:00:00", "18:00:00", 540, 0),
      entry("leave-entry-20b", "2026-03-20", "10:00:00", "11:00:00", 60, 0),
    ]);
    const overlapping = await end("2026-03-20T09:00", 570);
    expect(overlapping).toMatchObject({ status: 200, endsAt: "2026-03-20 09:30:00", durationMinutes: 570 });
    const forward = await request("/hr/me/leave-duration", "POST", { startsAt: "2026-03-20T09:00", endsAt: "2026-03-20T17:30" }, employeeCookie);
    expect((await forward.json() as { durationMinutes: number }).durationMinutes).toBe(570);
  });

  it("請假審核只核准審核者看到的那一版：本人入口與申請中心都擋下被申請人改過的內容", async () => {
    await assignEmployeeSupervisor();
    const leaveType = await request("/hr/leave-types", "POST", { name: "版本比對測試假", defaultPayRatePpm: 1_000_000 });
    const leaveTypeId = (await leaveType.json() as { id: string }).id;
    const leave = await request("/hr/me/leave-requests", "POST", { leaveTypeId, startsAt: "2026-02-05T09:00", endsAt: "2026-02-05T13:00", reason: "" }, employeeCookie);
    expect(leave.status, await leave.clone().text()).toBe(201);
    const leaveId = (await leave.json() as { id: string }).id;
    const centerRow = async () => (await (await request("/hr/requests?page=1&pageSize=25")).json() as { rows: Array<{ id: string; kind: string; revision: number | null; durationMinutes: number | null }> }).rows.find((row) => row.id === leaveId)!;
    const current = () => d1.sqlite.prepare("SELECT status, revision, duration_minutes FROM hr_leave_requests WHERE id=?").get(leaveId) as { status: string; revision: number; duration_minutes: number };

    // 審核者（本人入口的主管、申請中心的 HR）都在這時候看到半天、版本 1。
    const shorter = current().duration_minutes;
    expect(await centerRow()).toMatchObject({ kind: "leave", revision: 1, durationMinutes: shorter });
    // 申請人接著把它改成整天。
    const edited = await request(`/hr/me/leave-requests/${leaveId}`, "PATCH", { leaveTypeId, startsAt: "2026-02-05T09:00", endsAt: "2026-02-05T18:00", reason: "", revision: 1 }, employeeCookie);
    expect(edited.status, await edited.clone().text()).toBe(200);
    const longer = current().duration_minutes;
    expect(longer).toBeGreaterThan(shorter);

    for (const [path, decision] of [[`/hr/me/leave-requests/${leaveId}/review`, "approved"], [`/hr/me/leave-requests/${leaveId}/review`, "rejected"], [`/hr/requests/leave/${leaveId}/review`, "approved"]] as const) {
      const stale = await request(path, "POST", { decision, comment: "依照畫面上的內容決定", revision: 1 }, adminCookie);
      expect(stale.status, path).toBe(409);
      expect(await stale.text()).toContain("修改過");
    }
    // 同一個對話框的「取消申請」也一樣：看著舊內容按下去不會把改過的申請取消掉。
    const staleCancel = await request(`/hr/requests/leave/${leaveId}/cancel`, "POST", { revision: 1 });
    expect(staleCancel.status).toBe(409);
    expect(await staleCancel.text()).toContain("修改過");
    // 沒帶版本的審核不收。
    expect((await request(`/hr/requests/leave/${leaveId}/review`, "POST", { decision: "approved", comment: "" })).status).toBe(400);
    expect(current()).toMatchObject({ status: "pending", revision: 2 });

    // 重新整理後看到的是改過的內容與新的版本，這時候核准才會過。
    expect(await centerRow()).toMatchObject({ revision: 2, durationMinutes: longer });
    expect((await request(`/hr/requests/leave/${leaveId}/review`, "POST", { decision: "approved", comment: "", revision: 2 }, adminCookie)).status).toBe(200);
    expect(current().status).toBe("approved");
  });

  it("申請中心審核加班也比對版本；補打卡待審後不能修改，沒有版本", async () => {
    await assignEmployeeSupervisor();
    const created = await request("/hr/me/overtime", "POST", { requestedStart: "2026-02-10T18:00", requestedEnd: "2026-02-10T19:00", settlementKind: "pay", reason: "" }, employeeCookie);
    const id = (await created.json() as { id: string }).id;
    const rows = async () => (await (await request("/hr/requests?page=1&pageSize=25")).json() as { rows: Array<{ id: string; kind: string; revision: number | null }> }).rows;
    expect((await rows()).find((row) => row.id === id)).toMatchObject({ kind: "overtime", revision: 1 });

    // 申請人把結束時間延後：審核者預填的核定時段（18:00～19:00）仍落在新的申請時段之內，
    // 「核定時段必須在申請時段內」那條既有的檢查擋不到，只有版本比對擋得下來。
    const edited = await request(`/hr/me/overtime/${id}`, "PATCH", { requestedStart: "2026-02-10T18:00", requestedEnd: "2026-02-10T22:00", settlementKind: "pay", reason: "", revision: 1 }, employeeCookie);
    expect(edited.status, await edited.clone().text()).toBe(200);
    const stale = await request(`/hr/requests/overtime/${id}/review`, "POST", { decision: "approved", comment: "", actualStart: "2026-02-10T18:00", actualEnd: "2026-02-10T19:00", revision: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("修改過");
    expect((await request(`/hr/requests/overtime/${id}/cancel`, "POST", { revision: 1 })).status).toBe(409);
    expect(d1.sqlite.prepare("SELECT status FROM hr_overtime_requests WHERE id=?").get(id)).toEqual({ status: "pending" });
    expect((await request(`/hr/requests/overtime/${id}/review`, "POST", { decision: "approved", comment: "", actualStart: "2026-02-10T18:00", actualEnd: "2026-02-10T22:00", revision: 2 })).status).toBe(200);

    const correction = await request("/hr/me/form-requests", "POST", { correctionDate: "2026-02-03", requestedTime: "09:00", requestedEventKind: "clock_in", reason: "忘記打卡", approverUserId: "admin" }, employeeCookie);
    expect(correction.status, await correction.clone().text()).toBe(201);
    const correctionId = (await correction.json() as { id: string }).id;
    expect((await request(`/hr/me/form-requests/${correctionId}/submit`, "POST", {}, employeeCookie)).status).toBe(200);
    expect((await rows()).find((row) => row.id === correctionId)).toMatchObject({ kind: "clock_correction", revision: null });
    // 這就是補打卡不需要版本比對的理由：送出之後申請人改不了內容。
    expect((await request(`/hr/me/form-requests/${correctionId}`, "PATCH", { correctionDate: "2026-02-03", requestedTime: "08:00", requestedEventKind: "clock_in", reason: "改時間", approverUserId: "admin" }, employeeCookie)).status).toBe(409);
  });

  it("請假審核的寫入也守版本：讀出來之後、寫進去之前被改掉的申請不會被核准", async () => {
    await assignEmployeeSupervisor();
    const leaveType = await request("/hr/leave-types", "POST", { name: "寫入守門測試假", defaultPayRatePpm: 1_000_000 });
    const leaveTypeId = (await leaveType.json() as { id: string }).id;
    const leave = await request("/hr/me/leave-requests", "POST", { leaveTypeId, startsAt: "2026-02-05T09:00", endsAt: "2026-02-05T13:00", reason: "" }, employeeCookie);
    const leaveId = (await leave.json() as { id: string }).id;
    const db = createDatabase(d1 as never);
    // 寫入走 D1 batch；在它執行前先把那一列的版本往前推，模擬兩個請求交錯。
    const realBatch = d1.batch;
    d1.batch = ((statements: Parameters<typeof d1.batch>[0]) => {
      d1.batch = realBatch;
      d1.sqlite.prepare("UPDATE hr_leave_requests SET revision=revision+1 WHERE id=?").run(leaveId);
      return realBatch.call(d1, statements);
    }) as typeof d1.batch;
    try {
      const rejection = await reviewHrLeaveRequest(db, leaveId, "approved", "", { id: "admin", email: "admin@example.test" }).then(() => null, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(HrError);
      expect((rejection as HrError).message).toContain("修改過");
    } finally {
      d1.batch = realBatch;
    }
    expect(d1.sqlite.prepare("SELECT status, revision FROM hr_leave_requests WHERE id=?").get(leaveId)).toEqual({ status: "pending", revision: 2 });
  });

  it("管理端代為取消的寫入也守版本；格式壞掉的請求不會變成不比對版本的取消", async () => {
    await assignEmployeeSupervisor();
    const leaveType = await request("/hr/leave-types", "POST", { name: "取消守門測試假", defaultPayRatePpm: 1_000_000 });
    const leaveTypeId = (await leaveType.json() as { id: string }).id;
    const leaveId = (await (await request("/hr/me/leave-requests", "POST", { leaveTypeId, startsAt: "2026-02-05T09:00", endsAt: "2026-02-05T13:00", reason: "" }, employeeCookie)).json() as { id: string }).id;
    const overtimeId = (await (await request("/hr/me/overtime", "POST", { requestedStart: "2026-02-10T18:00", requestedEnd: "2026-02-10T19:00", settlementKind: "pay", reason: "" }, employeeCookie)).json() as { id: string }).id;
    const db = createDatabase(d1 as never);
    const admin = { id: "admin", email: "admin@example.test" };

    // 取消函式讀完、D1 batch 寫入之前，申請人的修改落地（版本 +1）：取消不可以套在沒看過的內容上。
    async function cancelWhileEdited(table: string, id: string, cancel: () => Promise<unknown>) {
      const realBatch = d1.batch;
      d1.batch = ((statements: Parameters<typeof d1.batch>[0]) => {
        d1.batch = realBatch;
        d1.sqlite.prepare(`UPDATE ${table} SET revision=revision+1 WHERE id=?`).run(id);
        return realBatch.call(d1, statements);
      }) as typeof d1.batch;
      try {
        return await cancel().then(() => null, (error: unknown) => error);
      } finally {
        d1.batch = realBatch;
      }
    }
    expect(await cancelWhileEdited("hr_leave_requests", leaveId, () => cancelHrLeaveRequest(db, leaveId, admin, { allowAny: true }))).toBeInstanceOf(HrError);
    expect(d1.sqlite.prepare("SELECT status, revision FROM hr_leave_requests WHERE id=?").get(leaveId)).toEqual({ status: "pending", revision: 2 });
    expect(await cancelWhileEdited("hr_overtime_requests", overtimeId, () => cancelHrOvertimeRequest(db, overtimeId, admin, { allowAny: true }))).toBeInstanceOf(HrError);
    // 加班的取消是刪除整列；被擋下時那一列還在。
    expect(d1.sqlite.prepare("SELECT status, revision FROM hr_overtime_requests WHERE id=?").get(overtimeId)).toEqual({ status: "pending", revision: 2 });

    // 只有空的 body 才算「沒帶版本」。被截斷的 JSON 要回 400，不能悄悄變成不比對的取消。
    const malformed = (path: string) => app.fetch(new Request(`https://test.local/api${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: adminCookie }, body: '{"revision": 1' }), { DB: d1, AUTH_SESSION_SECRET: SECRET, GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" } as never);
    expect((await malformed(`/hr/requests/leave/${leaveId}/cancel`)).status).toBe(400);
    expect((await malformed(`/hr/requests/overtime/${overtimeId}/cancel`)).status).toBe(400);
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM hr_overtime_requests WHERE id=?").get(overtimeId)).toEqual({ n: 1 });

    // 沒有 body 的取消維持可用（本來就這樣呼叫），帶對版本的也可以。
    expect((await request(`/hr/requests/overtime/${overtimeId}/cancel`, "POST")).status).toBe(200);
    expect((await request(`/hr/requests/leave/${leaveId}/cancel`, "POST", { revision: 2 })).status).toBe(200);
  });

  it("請假與加班待審可由指定主管處理，修改版本受控並通知雙方", async () => {
    await assignEmployeeSupervisor();
    const leaveType = await request("/hr/leave-types", "POST", { name: "手機簽核測試假", defaultPayRatePpm: 1_000_000 });
    expect(leaveType.status, await leaveType.clone().text()).toBe(201);
    const leaveTypeId = (await leaveType.json() as { id: string }).id;

    const leave = await request("/hr/me/leave-requests", "POST", {
      leaveTypeId, startsAt: "2026-02-05T09:00", endsAt: "2026-02-05T13:00", reason: "手機修改測試",
    }, employeeCookie);
    expect(leave.status, await leave.clone().text()).toBe(201);
    const leaveId = (await leave.json() as { id: string }).id;
    const leaveList = await (await request("/hr/me/leave-requests", "GET", undefined, employeeCookie)).json() as { requests: Array<{ request: { id: string; revision: number; status: string } }> };
    const initialLeave = leaveList.requests.find((item) => item.request.id === leaveId)?.request;
    expect(initialLeave).toMatchObject({ revision: 1, status: "pending" });

    const updatedLeave = await request(`/hr/me/leave-requests/${leaveId}`, "PATCH", {
      leaveTypeId, startsAt: "2026-02-09T09:00", endsAt: "2026-02-09T13:00", reason: "手機更新後的原因", revision: initialLeave?.revision,
    }, employeeCookie);
    expect(updatedLeave.status, await updatedLeave.clone().text()).toBe(200);
    expect((await request(`/hr/me/leave-requests/${leaveId}`, "PATCH", {
      leaveTypeId, startsAt: "2026-02-09T09:00", endsAt: "2026-02-09T13:00", reason: "舊版本不可覆蓋", revision: 1,
    }, employeeCookie)).status).toBe(409);

    const overtime = await request("/hr/me/overtime", "POST", {
      requestedStart: "2026-02-10T18:00", requestedEnd: "2026-02-10T20:00", settlementKind: "pay", reason: "主管手機簽核",
    }, employeeCookie);
    expect(overtime.status, await overtime.clone().text()).toBe(201);
    const overtimeId = (await overtime.json() as { id: string }).id;

    const leaveInbox = await (await request("/hr/me/leave-requests", "GET", undefined, adminCookie)).json() as { reviewRequests: Array<{ request: { id: string; status: string; approverUserId: string } }> };
    expect(leaveInbox.reviewRequests.find((item) => item.request.id === leaveId)?.request).toMatchObject({ status: "pending", approverUserId: "admin" });
    const overtimeInbox = await (await request("/hr/me/overtime", "GET", undefined, adminCookie)).json() as { reviewRequests: Array<{ request: { id: string; status: string; approverUserId: string }; employeeUserId: string }> };
    expect(overtimeInbox.reviewRequests.find((item) => item.request.id === overtimeId)).toMatchObject({ request: { status: "pending", approverUserId: "admin" }, employeeUserId: "employee" });

    const approverNotifications = await (await request("/hr/me/notifications", "GET", undefined, adminCookie)).json() as { notifications: Array<{ id: string; entityId: string; kind: string }>; unreadCount: number };
    expect(approverNotifications.unreadCount).toBe(3);
    expect(approverNotifications.notifications.filter((item) => item.entityId === leaveId && item.kind === "request_submitted")).toHaveLength(2);
    expect(approverNotifications.notifications.some((item) => item.entityId === overtimeId && item.kind === "request_submitted")).toBe(true);

    expect((await request(`/hr/me/leave-requests/${leaveId}/review`, "POST", { revision: 2, decision: "approved", comment: "手機核准" }, adminCookie)).status).toBe(200);
    expect((await request(`/hr/me/overtime/${overtimeId}/review`, "POST", { revision: 1, decision: "rejected", comment: "請補充工時說明" }, adminCookie)).status).toBe(200);
    const employeeNotifications = await (await request("/hr/me/notifications", "GET", undefined, employeeCookie)).json() as { notifications: Array<{ id: string; entityId: string; title: string }>; unreadCount: number };
    expect(employeeNotifications.unreadCount).toBe(2);
    expect(employeeNotifications.notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: leaveId, title: "請假申請已核准" }),
      expect.objectContaining({ entityId: overtimeId, title: "加班申請已駁回" }),
    ]));

    // 通知只能由擁有者標記已讀，其他人的通知 ID 不可操作。
    const markForeignRead = await request(`/hr/me/notifications/${approverNotifications.notifications[0]!.id}/read`, "POST", {}, employeeCookie);
    expect(markForeignRead.status).toBe(404);
    expect((await request(`/hr/me/notifications/${employeeNotifications.notifications[0]!.id}/read`, "POST", {}, employeeCookie)).status).toBe(200);
    expect((await (await request("/hr/me/notifications", "GET", undefined, employeeCookie)).json() as { unreadCount: number }).unreadCount).toBe(1);
    const readAll = await request("/hr/me/notifications/read-all", "POST", {}, employeeCookie);
    expect(readAll.status).toBe(200);
    expect((await (await request("/hr/me/notifications", "GET", undefined, employeeCookie)).json() as { unreadCount: number }).unreadCount).toBe(0);
  });

  it("找不到非本人審核者時拒絕建立請假與加班申請", async () => {
    const employment = await request("/hr/employees", "POST", { userId: "admin", legalName: "唯一管理者", employeeNumber: "E-ONLY-ADMIN", position: "管理者", serviceStartOn: "2026-01-01" });
    expect(employment.status, await employment.clone().text()).toBe(201);
    const leaveType = await request("/hr/leave-types", "POST", { name: "無審核者測試假", defaultPayRatePpm: 1_000_000 });
    const leaveTypeId = (await leaveType.json() as { id: string }).id;

    expect((await request("/hr/me/leave-requests", "POST", { leaveTypeId, startsAt: "2026-02-05T09:00", endsAt: "2026-02-05T13:00", reason: "沒有其他審核者" }, adminCookie)).status).toBe(409);
    expect((await request("/hr/me/overtime", "POST", { requestedStart: "2026-02-06T18:00", requestedEnd: "2026-02-06T20:00", settlementKind: "pay", reason: "沒有其他審核者" }, adminCookie)).status).toBe(409);
    const inbox = await (await request("/hr/me/leave-requests", "GET", undefined, adminCookie)).json() as { requests: unknown[] };
    expect(inbox.requests).toHaveLength(0);
  });

  it("HR 管理者的待審清單不顯示本人申請", async () => {
    d1.sqlite.prepare("INSERT INTO users(id,email,display_name,status) VALUES ('admin-two','admin-two@example.test','第二管理者','active')").run();
    d1.sqlite.prepare("INSERT INTO user_role_assignments(user_id,role_id) VALUES ('admin-two','role-admin')").run();
    await assignEmployeeSupervisor();
    const leaveType = await request("/hr/leave-types", "POST", { name: "自審排除測試假", defaultPayRatePpm: 1_000_000 });
    const leaveTypeId = (await leaveType.json() as { id: string }).id;
    const employeeLeave = await request("/hr/me/leave-requests", "POST", { leaveTypeId, startsAt: "2026-02-05T09:00", endsAt: "2026-02-05T13:00", reason: "員工申請" }, employeeCookie);
    expect(employeeLeave.status, await employeeLeave.clone().text()).toBe(201);
    const employeeLeaveId = (await employeeLeave.json() as { id: string }).id;
    const selfLeave = await request("/hr/me/leave-requests", "POST", { leaveTypeId, startsAt: "2026-02-09T09:00", endsAt: "2026-02-09T13:00", reason: "管理者本人申請" }, adminCookie);
    expect(selfLeave.status, await selfLeave.clone().text()).toBe(201);
    const selfLeaveId = (await selfLeave.json() as { id: string }).id;

    const leaveInbox = await (await request("/hr/me/leave-requests", "GET", undefined, adminCookie)).json() as { reviewRequests: Array<{ request: { id: string } }> };
    expect(leaveInbox.reviewRequests.map((item) => item.request.id)).toContain(employeeLeaveId);
    expect(leaveInbox.reviewRequests.map((item) => item.request.id)).not.toContain(selfLeaveId);

    const employeeOvertime = await request("/hr/me/overtime", "POST", { requestedStart: "2026-02-10T18:00", requestedEnd: "2026-02-10T20:00", settlementKind: "pay", reason: "員工加班申請" }, employeeCookie);
    const employeeOvertimeId = (await employeeOvertime.json() as { id: string }).id;
    const selfOvertime = await request("/hr/me/overtime", "POST", { requestedStart: "2026-02-11T18:00", requestedEnd: "2026-02-11T20:00", settlementKind: "pay", reason: "管理者本人加班申請" }, adminCookie);
    const selfOvertimeId = (await selfOvertime.json() as { id: string }).id;
    const overtimeInbox = await (await request("/hr/me/overtime", "GET", undefined, adminCookie)).json() as { reviewRequests: Array<{ request: { id: string } }> };
    expect(overtimeInbox.reviewRequests.map((item) => item.request.id)).toContain(employeeOvertimeId);
    expect(overtimeInbox.reviewRequests.map((item) => item.request.id)).not.toContain(selfOvertimeId);
  });

  it("請假被駁回後以新申請重送，原駁回紀錄保留", async () => {
    await assignEmployee();
    const leaveType = await request("/hr/leave-types", "POST", { name: "駁回重送測試假", defaultPayRatePpm: 1_000_000 });
    const leaveTypeId = (await leaveType.json() as { id: string }).id;
    const values = { leaveTypeId, startsAt: "2026-02-05T09:00", endsAt: "2026-02-05T13:00", reason: "第一次申請" };
    const first = await request("/hr/me/leave-requests", "POST", values, employeeCookie);
    expect(first.status, await first.clone().text()).toBe(201);
    const firstId = (await first.json() as { id: string }).id;
    expect((await request(`/hr/requests/leave/${firstId}/review`, "POST", { revision: 1, decision: "rejected", comment: "請調整申請日期" })).status).toBe(200);

    const resubmitted = await request("/hr/me/leave-requests", "POST", { ...values, startsAt: "2026-02-06T09:00", endsAt: "2026-02-06T13:00", reason: "依意見重新申請" }, employeeCookie);
    expect(resubmitted.status, await resubmitted.clone().text()).toBe(201);
    const secondId = (await resubmitted.json() as { id: string }).id;
    const records = await (await request("/hr/me/leave-requests", "GET", undefined, employeeCookie)).json() as { requests: Array<{ request: { id: string; status: string; reviewComment: string | null } }> };
    expect(records.requests.find((item) => item.request.id === firstId)?.request).toMatchObject({ status: "rejected", reviewComment: "請調整申請日期" });
    expect(records.requests.find((item) => item.request.id === secondId)?.request.status).toBe("pending");
  });

  it("本人可以更新待審加班申請，已核准申請需取消後重送", async () => {
    await assignEmployee();

    const pending = await request("/hr/me/overtime", "POST", {
      requestedStart: "2026-02-06T18:00", requestedEnd: "2026-02-06T20:00", settlementKind: "pay", reason: "待審更新測試",
    }, employeeCookie);
    expect(pending.status, await pending.clone().text()).toBe(201);
    const pendingId = (await pending.json() as { id: string }).id;
    const pendingRequests = await (await request("/hr/me/overtime", "GET", undefined, employeeCookie)).json() as { requests: Array<{ request: { id: string; revision: number } }> };
    const pendingRevision = pendingRequests.requests.find((item) => item.request.id === pendingId)?.request.revision;
    expect(pendingRevision).toBe(1);

    const blocker = await request("/hr/requests/overtime", "POST", {
      employeeUserId: "employee", requestedStart: "2026-02-08T18:00", requestedEnd: "2026-02-08T20:00", settlementKind: "pay", reason: "更新重疊測試",
    });
    expect(blocker.status, await blocker.clone().text()).toBe(201);

    const updated = await request(`/hr/me/overtime/${pendingId}`, "PATCH", {
      requestedStart: "2026-02-07T18:00", requestedEnd: "2026-02-07T20:00", settlementKind: "pay", reason: "已更新的加班原因", revision: pendingRevision,
    }, employeeCookie);
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect((await request(`/hr/me/overtime/${pendingId}`, "PATCH", {
      requestedStart: "2026-02-07T18:00", requestedEnd: "2026-02-07T20:00", settlementKind: "pay", reason: "過期版本", revision: pendingRevision,
    }, employeeCookie)).status).toBe(409);
    expect((await request(`/hr/me/overtime/${pendingId}`, "PATCH", {
      requestedStart: "2026-02-08T18:00", requestedEnd: "2026-02-08T20:00", settlementKind: "pay", reason: "不應重疊", revision: 2,
    }, employeeCookie)).status).toBe(409);
    expect((await request(`/hr/me/overtime/${pendingId}`, "PATCH", {
      requestedStart: "2026-02-07T18:00", requestedEnd: "2026-02-07T20:00", settlementKind: "pay", reason: "非本人更新", revision: 2,
    })).status).toBe(404);

    const center = await (await request("/hr/requests")).json() as { overtime: Array<{ request: { id: string; status: string; requestedStart: string; requestedEnd: string; settlementKind: string; reason: string } }> };
    expect(center.overtime.find((item) => item.request.id === pendingId)?.request).toMatchObject({
      status: "pending", requestedStart: "2026-02-07 10:00:00", requestedEnd: "2026-02-07 12:00:00", settlementKind: "pay", reason: "已更新的加班原因",
    });

    const approved = await request("/hr/requests/overtime", "POST", {
      employeeUserId: "employee", requestedStart: "2026-02-09T18:00", requestedEnd: "2026-02-09T20:00", settlementKind: "pay", reason: "核准後不可更新",
    });
    expect(approved.status, await approved.clone().text()).toBe(201);
    const approvedId = (await approved.json() as { id: string }).id;
    expect((await request(`/hr/me/overtime/${approvedId}`, "PATCH", {
      requestedStart: "2026-02-10T18:00", requestedEnd: "2026-02-10T20:00", settlementKind: "pay", reason: "不應修改已核准", revision: 1,
    }, employeeCookie)).status).toBe(409);
  });

  it("本人與管理端可以取消待審與已核准的加班申請", async () => {
    await assignEmployee();

    const pending = await request("/hr/me/overtime", "POST", {
      requestedStart: "2026-02-06T18:00", requestedEnd: "2026-02-06T20:00", settlementKind: "pay", reason: "待審取消測試",
    }, employeeCookie);
    expect(pending.status, await pending.clone().text()).toBe(201);
    const pendingId = (await pending.json() as { id: string }).id;
    expect((await request(`/hr/me/overtime/${pendingId}/cancel`, "POST", {}, adminCookie)).status).toBe(404);
    expect((await request(`/hr/me/overtime/${pendingId}/cancel`, "POST", {}, employeeCookie)).status).toBe(200);

    const approvedForEmployee = await request("/hr/requests/overtime", "POST", {
      employeeUserId: "employee", requestedStart: "2026-02-07T18:00", requestedEnd: "2026-02-07T20:00", settlementKind: "pay", reason: "本人取消已核准測試",
    });
    expect(approvedForEmployee.status, await approvedForEmployee.clone().text()).toBe(201);
    const approvedForEmployeeId = (await approvedForEmployee.json() as { id: string }).id;
    expect((await request(`/hr/me/overtime/${approvedForEmployeeId}/cancel`, "POST", {}, employeeCookie)).status).toBe(200);

    const approvedForAdmin = await request("/hr/requests/overtime", "POST", {
      employeeUserId: "employee", requestedStart: "2026-02-08T18:00", requestedEnd: "2026-02-08T20:00", settlementKind: "pay", reason: "管理端取消測試",
    });
    expect(approvedForAdmin.status, await approvedForAdmin.clone().text()).toBe(201);
    const approvedForAdminId = (await approvedForAdmin.json() as { id: string }).id;
    expect((await request(`/hr/requests/overtime/${approvedForAdminId}/cancel`, "POST", {})).status).toBe(200);

    // 取消就是刪除：申請紀錄不留 cancelled 列，內容改由稽核事件的快照保存。
    const center = await (await request("/hr/requests")).json() as { overtime: Array<{ request: { id: string } }> };
    expect(center.overtime).toEqual([]);
    expect((await request(`/hr/me/overtime/${approvedForEmployeeId}/cancel`, "POST", {}, employeeCookie)).status).toBe(404);
    const audit = d1.sqlite.prepare("SELECT entity_label, payload_json FROM activity_events WHERE event_type='overtime_request_cancelled' AND entity_id=?").get(approvedForAdminId) as { entity_label: string; payload_json: string };
    expect(audit.entity_label).toBe("申請員工");
    expect(JSON.parse(audit.payload_json)).toMatchObject({
      id: approvedForAdminId, employeeUserId: "employee", status: "approved", requestedStart: "2026-02-08 10:00:00", requestedEnd: "2026-02-08 12:00:00",
      actualStart: "2026-02-08 10:00:00", actualEnd: "2026-02-08 12:00:00", settlementKind: "pay", ratePpm: 1_333_333, reason: "管理端取消測試",
      reviewedBy: "admin", reviewedAt: expect.any(String), decisionReason: "HR 後台建立後直接核准", createdBy: "admin", createdAt: expect.any(String),
    });

    // 刪掉之後同一個時段可以重新申請，單筆與批次都一樣。
    const again = await request("/hr/requests/overtime", "POST", { employeeUserId: "employee", requestedStart: "2026-02-08T18:00", requestedEnd: "2026-02-08T20:00", settlementKind: "pay", reason: "" });
    expect(again.status, await again.clone().text()).toBe(201);
    const batchAgain = await request("/hr/requests/overtime/batch", "POST", { employeeUserId: "employee", settlementKind: "pay", reason: "", entries: [{ requestedStart: "2026-02-07T18:00", requestedEnd: "2026-02-07T20:00" }] });
    expect(batchAgain.status, await batchAgain.clone().text()).toBe(201);
  });

  it("管理端可整批取消已核准加班，整批全有或全無並保留人員快照", async () => {
    await assignEmployee();
    const db = createDatabase(d1 as never);
    await db.insert(hrEmployments).values({ id: "worker-bulk", personKind: "worker", employeeNumber: "W-BULK", legalName: "支援人員", position: "支援人員" });

    const employeeRequest = await request("/hr/requests/overtime", "POST", {
      employeeUserId: "employee", requestedStart: "2026-02-12T18:00", requestedEnd: "2026-02-12T20:00", settlementKind: "pay", reason: "批次取消正式員工",
    });
    expect(employeeRequest.status, await employeeRequest.clone().text()).toBe(201);
    const employeeId = (await employeeRequest.json() as { id: string }).id;
    const workerRequest = await request("/hr/requests/overtime", "POST", {
      workerId: "worker-bulk", requestedStart: "2026-02-13T18:00", requestedEnd: "2026-02-13T20:00", settlementKind: "compensatory", reason: "批次取消支援人員",
    });
    expect(workerRequest.status, await workerRequest.clone().text()).toBe(201);
    const workerId = (await workerRequest.json() as { id: string }).id;
    const pendingRequest = await request("/hr/me/overtime", "POST", {
      requestedStart: "2026-02-14T18:00", requestedEnd: "2026-02-14T20:00", settlementKind: "pay", reason: "不可批次刪除待審申請",
    }, employeeCookie);
    expect(pendingRequest.status, await pendingRequest.clone().text()).toBe(201);
    const pendingId = (await pendingRequest.json() as { id: string }).id;

    const cancelBatch = (ids: string[], cookie = adminCookie) => request("/hr/requests/overtime/cancel-batch", "POST", { ids }, cookie);
    expect((await cancelBatch([], adminCookie)).status).toBe(400);
    expect((await cancelBatch([employeeId, employeeId])).status).toBe(400);
    expect((await cancelBatch(["missing-overtime"])).status).toBe(404);
    expect((await cancelBatch(Array.from({ length: 101 }, (_, index) => `overtime-${index}`))).status).toBe(400);
    expect((await cancelBatch([employeeId], employeeCookie)).status).toBe(403);
    expect((await cancelBatch([employeeId, pendingId])).status).toBe(409);

    const unchanged = await (await request("/hr/requests")).json() as { overtime: Array<{ request: { id: string; status: string } }> };
    expect(unchanged.overtime.map(({ request }) => request.id)).toEqual(expect.arrayContaining([employeeId, workerId, pendingId]));
    expect(unchanged.overtime.find(({ request }) => request.id === employeeId)?.request.status).toBe("approved");

    const cancelled = await cancelBatch([employeeId, workerId]);
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    expect(await cancelled.json()).toEqual({ ids: [employeeId, workerId], count: 2 });
    const remaining = await (await request("/hr/requests")).json() as { overtime: Array<{ request: { id: string; status: string } }> };
    expect(remaining.overtime.map(({ request }) => request.id)).toEqual([pendingId]);

    const audit = d1.sqlite.prepare("SELECT entity_id, event_type, payload_json FROM activity_events WHERE event_type='overtime_requests_cancelled'").get() as { entity_id: string; event_type: string; payload_json: string };
    expect(audit.entity_id).toBe(employeeId);
    expect(JSON.parse(audit.payload_json)).toMatchObject({
      requestIds: [employeeId, workerId],
      requests: [
        expect.objectContaining({ id: employeeId, personKind: "employee", employeeUserId: "employee", status: "approved", reason: "批次取消正式員工" }),
        expect.objectContaining({ id: workerId, personKind: "worker", workerId: "worker-bulk", status: "approved", reason: "批次取消支援人員" }),
      ],
    });

    const resubmitted = await request("/hr/requests/overtime", "POST", {
      employeeUserId: "employee", requestedStart: "2026-02-12T18:00", requestedEnd: "2026-02-12T20:00", settlementKind: "pay", reason: "刪除後可以重送",
    });
    expect(resubmitted.status, await resubmitted.clone().text()).toBe(201);
  });

  it("被駁回的加班申請保留紀錄，但不佔用時段", async () => {
    await assignEmployee();
    const slot = { requestedStart: "2026-02-09T18:00", requestedEnd: "2026-02-09T19:00", settlementKind: "pay", reason: "" };
    const pending = await request("/hr/me/overtime", "POST", slot, employeeCookie);
    expect(pending.status, await pending.clone().text()).toBe(201);
    const pendingId = (await pending.json() as { id: string }).id;
    expect((await request(`/hr/overtime/${pendingId}/review`, "POST", { revision: 1, decision: "rejected", comment: "時段不符" })).status).toBe(200);

    const again = await request("/hr/requests/overtime", "POST", { employeeUserId: "employee", ...slot });
    expect(again.status, await again.clone().text()).toBe(201);
    const center = await (await request("/hr/requests")).json() as { overtime: Array<{ request: { status: string } }> };
    expect(center.overtime.map((item) => item.request.status).sort()).toEqual(["approved", "rejected"]);
    // 仍然有效的申請之間，唯一鍵照舊擋住完全相同的時段。
    expect((await request("/hr/requests/overtime", "POST", { employeeUserId: "employee", ...slot })).status).toBe(409);
  });

  describe("補打卡申請", () => {
    const correction = { correctionDate: "2026-01-07", requestedTime: "09:00", requestedEventKind: "clock_in", reason: "手機故障", approverUserId: "admin" };

    async function createDraft(values: Record<string, unknown> = correction) {
      const created = await request("/hr/me/form-requests", "POST", values, employeeCookie);
      expect(created.status, await created.clone().text()).toBe(201);
      return (await created.json() as { id: string }).id;
    }
    async function statusOf(id: string) {
      const response = await request(`/hr/me/form-requests/${id}`, "GET", undefined, employeeCookie);
      return response.status === 200 ? (await response.json() as { request: { status: string } }).request.status : response.status;
    }

    beforeEach(async () => {
      await assignEmployee();
      // 審核者必須是啟用中的員工，所以管理者也要有任職資料。
      const approver = await request("/hr/employees", "POST", { userId: "admin", legalName: "審核主管", employeeNumber: "E-APPROVER", position: "一般職員", serviceStartOn: "2026-01-01" });
      expect(approver.status, await approver.clone().text()).toBe(201);
    });

    it("補登時間不可晚於現在", async () => {
      const future = await request("/hr/me/form-requests", "POST", { ...correction, correctionDate: "2099-01-01" }, employeeCookie);
      expect(future.status).toBe(400);
      const id = await createDraft();
      expect((await request(`/hr/me/form-requests/${id}`, "PATCH", { ...correction, correctionDate: "2099-01-01" }, employeeCookie)).status).toBe(400);
    });

    it("同一個時間點的同一種打卡只能有一張審核中或已核准的申請", async () => {
      const first = await createDraft();
      const sameTime = await createDraft();
      const secondShift = await createDraft({ ...correction, requestedTime: "13:00" });
      const otherKind = await createDraft({ ...correction, requestedEventKind: "clock_out" });
      const submit = async (id: string) => (await request(`/hr/me/form-requests/${id}/submit`, "POST", {}, employeeCookie)).status;

      expect(await submit(first)).toBe(200);
      expect(await submit(sameTime)).toBe(409);
      // 兩段班一天補兩次上班、同一時間補另一種打卡，都是合理的申請。
      expect(await submit(secondShift)).toBe(200);
      expect(await submit(otherKind)).toBe(200);

      // 取消後那個時間點空出來；核准後則一直佔著，不然會核准出兩筆一樣的打卡事件。
      expect((await request(`/hr/me/form-requests/${first}/cancel`, "POST", {}, employeeCookie)).status).toBe(200);
      expect(await statusOf(first)).toBe("cancelled");
      expect(await submit(sameTime)).toBe(200);
      expect((await request(`/hr/me/form-requests/${sameTime}/review`, "POST", { decision: "approved" })).status).toBe(200);
      expect(await submit(await createDraft())).toBe(409);
    });

    it("檢查上線前留下的未來時間申請，送出與核准都會被擋，駁回不受影響", async () => {
      const draft = await createDraft();
      d1.sqlite.prepare("UPDATE hr_form_requests SET correction_date='2099-01-01', requested_at='2099-01-01 01:00:00' WHERE id=?").run(draft);
      expect((await request(`/hr/me/form-requests/${draft}/submit`, "POST", {}, employeeCookie)).status).toBe(400);

      d1.sqlite.prepare("UPDATE hr_form_requests SET status='pending', submitted_at=CURRENT_TIMESTAMP WHERE id=?").run(draft);
      expect((await request(`/hr/me/form-requests/${draft}/review`, "POST", { decision: "approved" })).status).toBe(400);
      expect(d1.sqlite.prepare("SELECT count(*) AS count FROM hr_clock_events WHERE correction_request_id=?").get(draft)).toEqual({ count: 0 });
      expect((await request(`/hr/me/form-requests/${draft}/review`, "POST", { decision: "rejected", comment: "時間不對" })).status).toBe(200);
    });

    it("只有申請人能取消審核中的申請，取消後審核者不能再核准", async () => {
      const id = await createDraft();
      expect((await request(`/hr/me/form-requests/${id}/cancel`, "POST", {}, employeeCookie)).status).toBe(409);
      expect((await request(`/hr/me/form-requests/${id}/submit`, "POST", {}, employeeCookie)).status).toBe(200);
      expect((await request(`/hr/me/form-requests/${id}/cancel`, "POST", {})).status).toBe(404);
      expect((await request(`/hr/me/form-requests/${id}/cancel`, "POST", {}, employeeCookie)).status).toBe(200);
      expect((await request(`/hr/me/form-requests/${id}/review`, "POST", { decision: "approved" })).status).toBe(409);
      expect(d1.sqlite.prepare("SELECT count(*) AS count FROM hr_clock_events WHERE correction_request_id=?").get(id)).toEqual({ count: 0 });

      const center = await (await request("/hr/requests?page=1&pageSize=25&kind=clock_correction&status=cancelled")).json() as { rows: Array<{ id: string }> };
      expect(center.rows.map((row) => row.id)).toEqual([id]);
    });

    it("已核准的申請不能取消，打卡事件保留", async () => {
      const id = await createDraft();
      expect((await request(`/hr/me/form-requests/${id}/submit`, "POST", {}, employeeCookie)).status).toBe(200);
      expect((await request(`/hr/me/form-requests/${id}/review`, "POST", { decision: "approved" })).status).toBe(200);
      expect((await request(`/hr/me/form-requests/${id}/cancel`, "POST", {}, employeeCookie)).status).toBe(409);
      expect(d1.sqlite.prepare("SELECT count(*) AS count FROM hr_clock_events WHERE correction_request_id=?").get(id)).toEqual({ count: 1 });
      const notifications = await (await request("/hr/me/notifications", "GET", undefined, employeeCookie)).json() as { notifications: Array<{ entityId: string; title: string }>; unreadCount: number };
      expect(notifications.unreadCount).toBe(1);
      expect(notifications.notifications).toContainEqual(expect.objectContaining({ entityId: id, title: "補打卡申請已核准" }));
    });

    it("草稿可以由申請人刪除，送出後不能刪", async () => {
      const draft = await createDraft();
      expect((await request(`/hr/me/form-requests/${draft}`, "DELETE", {})).status).toBe(404);
      expect((await request(`/hr/me/form-requests/${draft}`, "DELETE", {}, employeeCookie)).status).toBe(200);
      expect(await statusOf(draft)).toBe(404);

      const submitted = await createDraft();
      expect((await request(`/hr/me/form-requests/${submitted}/submit`, "POST", {}, employeeCookie)).status).toBe(200);
      expect((await request(`/hr/me/form-requests/${submitted}`, "DELETE", {}, employeeCookie)).status).toBe(409);
      expect(await statusOf(submitted)).toBe("pending");
    });
  });
});
