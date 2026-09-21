import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, ensureHrAnnualLeaveEntitlements, listHrAnnualLeaveEntitlements, syncSystemRoles } from "@rueisiang/db";
import { hrAnnualLeaveLedger, userRoleAssignments, users } from "@rueisiang/db/schema";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "hr-annual-leave-test-secret-test-secret";
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
  const assigned = await request("/hr/employees", "POST", { userId: "employee", employeeNumber: "E-ANNUAL", hiredOn: "2025-03-01", seniorityStartOn: "2025-03-01" });
  expect(assigned.status, await assigned.clone().text()).toBe(201);
});

afterEach(() => d1.sqlite.close());

describe("週年制特休額度", () => {
  it("依 seniorityStartOn 建立滿半年、週年與半小時台帳", async () => {
    const db = createDatabase(d1 as never);
    await ensureHrAnnualLeaveEntitlements(db, { asOfDate: "2027-03-01" });
    const rows = await listHrAnnualLeaveEntitlements(db, { asOfDate: "2027-03-01" });
    expect(rows.map((row) => ({ start: row.periodStart, end: row.periodEnd, service: row.serviceMonths, amount: row.entitledHalfHours }))).toEqual([
      { start: "2025-09-01", end: "2026-03-01", service: 6, amount: 48 },
      { start: "2026-03-01", end: "2027-03-01", service: 12, amount: 112 },
      { start: "2027-03-01", end: "2028-03-01", service: 24, amount: 160 },
    ]);
    const grants = await db.select({ count: sql<number>`count(*)` }).from(hrAnnualLeaveLedger).where(eq(hrAnnualLeaveLedger.entryKind, "grant"));
    expect(Number(grants[0]?.count)).toBe(3);
  });

  it("核准才扣額度、每期不互相遞延，並接受 0.5 小時單位", async () => {
    const created = await request("/hr/leave-types", "POST", { name: "特休", leaveKind: "annual", defaultPayRatePpm: 1_000_000 });
    expect(created.status, await created.clone().text()).toBe(201);
    const leaveTypeId = (await created.json() as { id: string }).id;
    const db = createDatabase(d1 as never);
    await ensureHrAnnualLeaveEntitlements(db, { asOfDate: "2027-03-01" });

    const approved = await request("/hr/requests/leave", "POST", {
      employeeUserId: "employee", leaveTypeId, startDate: "2025-09-01", endDate: "2025-09-01", durationMinutes: 30, reason: "半小時特休",
    });
    expect(approved.status, await approved.clone().text()).toBe(201);
    const approvedId = (await approved.json() as { id: string }).id;

    const pending = await request("/hr/me/leave-requests", "POST", {
      leaveTypeId, startDate: "2026-03-01", endDate: "2026-03-01", durationMinutes: 30, reason: "週年後特休",
    }, employeeCookie);
    expect(pending.status, await pending.clone().text()).toBe(201);
    const pendingId = (await pending.json() as { id: string }).id;
    const beforeReview = await listHrAnnualLeaveEntitlements(db, { asOfDate: "2027-03-01" });
    expect(beforeReview.find((row) => row.periodStart === "2026-03-01")?.balanceHalfHours).toBe(112);

    const reviewed = await request(`/hr/requests/leave/${pendingId}/review`, "POST", { decision: "approved", comment: "核准" });
    expect(reviewed.status, await reviewed.clone().text()).toBe(200);

    const rows = await listHrAnnualLeaveEntitlements(db, { asOfDate: "2027-03-01" });
    expect(rows.find((row) => row.periodStart === "2025-09-01")?.balanceHalfHours).toBe(47);
    expect(rows.find((row) => row.periodStart === "2026-03-01")?.balanceHalfHours).toBe(111);

    const cancelled = await request(`/hr/requests/leave/${approvedId}/cancel`, "POST", {});
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    const afterCancel = await listHrAnnualLeaveEntitlements(db, { asOfDate: "2027-03-01" });
    expect(afterCancel.find((row) => row.periodStart === "2025-09-01")?.balanceHalfHours).toBe(48);
    const reversals = await db.select({ count: sql<number>`count(*)` }).from(hrAnnualLeaveLedger).where(eq(hrAnnualLeaveLedger.entryKind, "settlement_reversal"));
    expect(Number(reversals[0]?.count)).toBe(1);

    const overbooked = await request("/hr/requests/leave", "POST", {
      employeeUserId: "employee", leaveTypeId, startDate: "2026-03-02", endDate: "2026-03-08", durationMinutes: 3_360, reason: "不可挪用上一期餘額",
    });
    expect(overbooked.status, await overbooked.clone().text()).toBe(409);
  });
});
