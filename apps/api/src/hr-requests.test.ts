import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { userRoleAssignments, users } from "@rueisiang/db/schema";
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
  const response = await request("/hr/employees", "POST", { userId: "employee", employeeNumber: "E-REQUEST", hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01" });
  expect(response.status, await response.clone().text()).toBe(201);
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
      employeeUserId: "employee", leaveTypeId: leaveTypeBody.id, startDate: "2026-01-05", endDate: "2026-01-05", durationMinutes: 480, payRatePpm: 1_000_000, reason: "後台代登測試",
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

  it("本人入口仍會進入待審核，管理端可以走同一個審核階段", async () => {
    await assignEmployee();
    const leaveType = await request("/hr/leave-types", "POST", { name: "測試病假", defaultPayRatePpm: 500_000 });
    const leaveTypeBody = await leaveType.json() as { id: string };

    const pendingLeave = await request("/hr/me/leave-requests", "POST", {
      leaveTypeId: leaveTypeBody.id, startDate: "2026-02-05", endDate: "2026-02-05", durationMinutes: 240, reason: "本人請假測試",
    }, employeeCookie);
    expect(pendingLeave.status, await pendingLeave.clone().text()).toBe(201);
    const pendingLeaveBody = await pendingLeave.json() as { id: string };

    const pendingOvertime = await request("/hr/me/overtime", "POST", {
      requestedStart: "2026-02-06T18:00", requestedEnd: "2026-02-06T20:00", settlementKind: "compensatory", reason: "本人加班測試",
    }, employeeCookie);
    expect(pendingOvertime.status, await pendingOvertime.clone().text()).toBe(201);
    const pendingOvertimeBody = await pendingOvertime.json() as { id: string };

    const center = await (await request("/hr/requests")).json() as { leaves: Array<{ request: { id: string; status: string } }>; overtime: Array<{ request: { id: string; status: string } }> };
    expect(center.leaves.find((item) => item.request.id === pendingLeaveBody.id)?.request.status).toBe("pending");
    expect(center.overtime.find((item) => item.request.id === pendingOvertimeBody.id)?.request.status).toBe("pending");

    const leaveReview = await request(`/hr/requests/leave/${pendingLeaveBody.id}/review`, "POST", { decision: "approved", comment: "管理端核准" });
    expect(leaveReview.status, await leaveReview.clone().text()).toBe(200);
    const overtimeReview = await request(`/hr/overtime/${pendingOvertimeBody.id}/review`, "POST", { decision: "approved", comment: "管理端核准" });
    expect(overtimeReview.status, await overtimeReview.clone().text()).toBe(200);

    const after = await (await request("/hr/requests")).json() as { leaves: Array<{ request: { id: string; status: string } }>; overtime: Array<{ request: { id: string; status: string } }> };
    expect(after.leaves.find((item) => item.request.id === pendingLeaveBody.id)?.request.status).toBe("approved");
    expect(after.overtime.find((item) => item.request.id === pendingOvertimeBody.id)?.request.status).toBe("approved");
  });
});
