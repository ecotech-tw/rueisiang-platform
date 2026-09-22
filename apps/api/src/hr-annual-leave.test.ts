import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, ensureHrAnnualLeaveEntitlements, listHrAnnualLeaveEntitlements, syncSystemRoles } from "@rueisiang/db";
import { hrAnnualLeaveEntitlements, hrAnnualLeaveLedger, hrEmployments, userRoleAssignments, users } from "@rueisiang/db/schema";
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

  it("漏跑前一個月份時，下一次結帳會補算已到期的特休週期", async () => {
    const db = createDatabase(d1 as never);
    const profile = await (await request("/hr/employees/employee")).json() as { employments: Array<{ id: string }> };
    const employmentId = profile.employments[0]!.id;
    const compensation = await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2025-03-01", payBasis: "monthly", baseAmountMinor: 3_000_000, note: "補算測試月薪" });
    expect(compensation.status, await compensation.clone().text()).toBe(201);

    const calculated = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-03", employeeUserIds: ["employee"], requestId: "annual-settlement-catch-up" });
    expect(calculated.status, await calculated.clone().text()).toBe(200);
    const calculatedBody = await calculated.json() as { run: { employees: Array<{ lines: Array<{ lineKey: string; amountMinor: number; explanation: Record<string, unknown> }> }> } };
    expect(calculatedBody.run.employees[0]?.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineKey: "annual_leave_settlement", amountMinor: 300_000, explanation: expect.objectContaining({ settlementItems: expect.arrayContaining([expect.objectContaining({ settlementDate: "2026-03-31", settlementReason: "period_end" })]) }) }),
    ]));

    const entitlement = await db.select({ status: hrAnnualLeaveEntitlements.status }).from(hrAnnualLeaveEntitlements)
      .where(eq(hrAnnualLeaveEntitlements.periodStart, "2025-09-01")).limit(1);
    expect(entitlement[0]?.status).toBe("open");
  });

  it("週期終結結帳將未休特休折現並標記額度已結算", async () => {
    const db = createDatabase(d1 as never);
    const profile = await (await request("/hr/employees/employee")).json() as { employments: Array<{ id: string; revision: number }> };
    const employmentId = profile.employments[0]!.id;
    const compensation = await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2025-03-01", payBasis: "monthly", baseAmountMinor: 3_000_000, note: "測試月薪" });
    expect(compensation.status, await compensation.clone().text()).toBe(201);

    const calculated = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-02", employeeUserIds: ["employee"], requestId: "annual-settlement-period-end" });
    expect(calculated.status, await calculated.clone().text()).toBe(200);
    const calculatedBody = await calculated.json() as { run: { runId: string; employees: Array<{ lines: Array<{ lineKey: string; amountMinor: number; explanation: Record<string, unknown> }> }> } };
    expect(calculatedBody.run.employees[0]?.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineKey: "annual_leave_settlement", amountMinor: 300_000, explanation: expect.objectContaining({ basis: "current_monthly_salary_div_30" }) }),
    ]));
    const beforeClose = await db.select({ status: hrAnnualLeaveEntitlements.status, settledAt: hrAnnualLeaveEntitlements.settledAt }).from(hrAnnualLeaveEntitlements)
      .where(eq(hrAnnualLeaveEntitlements.periodStart, "2025-09-01")).limit(1);
    expect(beforeClose[0]).toEqual({ status: "open", settledAt: null });

    const closed = await request(`/hr/payroll/runs/${calculatedBody.run.runId}/close`, "POST", {});
    expect(closed.status, await closed.clone().text()).toBe(200);
    const closedBody = await closed.json() as { run: { employees: Array<{ lines: Array<{ lineKey: string; amountMinor: number }> }> } };
    expect(closedBody.run.employees[0]?.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineKey: "annual_leave_settlement", amountMinor: 300_000 }),
    ]));
    const afterClose = await db.select({ id: hrAnnualLeaveEntitlements.id, status: hrAnnualLeaveEntitlements.status, settledAt: hrAnnualLeaveEntitlements.settledAt }).from(hrAnnualLeaveEntitlements)
      .where(eq(hrAnnualLeaveEntitlements.periodStart, "2025-09-01")).limit(1);
    expect(afterClose[0]?.status).toBe("settled");
    expect(afterClose[0]?.settledAt).not.toBeNull();
    const settlement = await db.select({ deltaHalfHours: hrAnnualLeaveLedger.deltaHalfHours, entryKind: hrAnnualLeaveLedger.entryKind, sourceKey: hrAnnualLeaveLedger.sourceKey }).from(hrAnnualLeaveLedger)
      .where(eq(hrAnnualLeaveLedger.sourceKey, `annual-settlement:${afterClose[0]!.id}`)).limit(1);
    expect(settlement).toEqual([{ deltaHalfHours: -48, entryKind: "settlement", sourceKey: `annual-settlement:${afterClose[0]!.id}` }]);
  });

  it("折現結帳後的特休取消改走薪資調整，不直接改動已結算台帳", async () => {
    const created = await request("/hr/leave-types", "POST", { name: "特休", leaveKind: "annual", defaultPayRatePpm: 1_000_000 });
    expect(created.status, await created.clone().text()).toBe(201);
    const leaveTypeId = (await created.json() as { id: string }).id;
    const profile = await (await request("/hr/employees/employee")).json() as { employments: Array<{ id: string }> };
    const employmentId = profile.employments[0]!.id;
    const compensation = await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2025-03-01", payBasis: "monthly", baseAmountMinor: 3_000_000, note: "測試月薪" });
    expect(compensation.status, await compensation.clone().text()).toBe(201);
    const approved = await request("/hr/requests/leave", "POST", { employeeUserId: "employee", leaveTypeId, startDate: "2025-09-01", endDate: "2025-09-01", durationMinutes: 30, reason: "先扣一筆再結算" });
    expect(approved.status, await approved.clone().text()).toBe(201);
    const requestId = (await approved.json() as { id: string }).id;
    const calculated = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-02", employeeUserIds: ["employee"], requestId: "annual-settlement-cancel-after-close" });
    expect(calculated.status, await calculated.clone().text()).toBe(200);
    const calculatedBody = await calculated.json() as { run: { runId: string } };
    const closed = await request(`/hr/payroll/runs/${calculatedBody.run.runId}/close`, "POST", {});
    expect(closed.status, await closed.clone().text()).toBe(200);

    const cancelled = await request(`/hr/requests/leave/${requestId}/cancel`, "POST", {});
    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({ error: "特休已隨薪資結算，請使用薪資調整處理取消或更正。 " });
  });

  it("核准待審請假前重新檢查任職期間，避免離職後仍生效", async () => {
    const db = createDatabase(d1 as never);
    const leaveType = await request("/hr/leave-types", "POST", { name: "任職邊界測試假", defaultPayRatePpm: 1_000_000 });
    expect(leaveType.status, await leaveType.clone().text()).toBe(201);
    const leaveTypeId = (await leaveType.json() as { id: string }).id;
    const pending = await request("/hr/me/leave-requests", "POST", { leaveTypeId, startDate: "2026-02-10", endDate: "2026-02-10", durationMinutes: 30, reason: "離職邊界" }, employeeCookie);
    expect(pending.status, await pending.clone().text()).toBe(201);
    const requestId = (await pending.json() as { id: string }).id;
    const profile = await (await request("/hr/employees/employee")).json() as { employments: Array<{ id: string; revision: number }> };
    const employmentId = profile.employments[0]!.id;
    const end = await request(`/hr/employments/${employmentId}/end`, "PATCH", { endedOn: "2026-02-01", revision: 1 });
    expect(end.status).toBe(409);

    await db.update(hrEmployments).set({ endedOn: "2026-02-01" }).where(eq(hrEmployments.id, employmentId));
    const reviewed = await request(`/hr/requests/leave/${requestId}/review`, "POST", { decision: "approved", comment: "核准" });
    expect(reviewed.status).toBe(400);
    expect((await reviewed.json() as { error: string }).error).toContain("請假日期不在有效任職期間內");
  });

  it("離職日當天不會再建立新的特休週期", async () => {
    const db = createDatabase(d1 as never);
    const profile = await (await request("/hr/employees/employee")).json() as { employments: Array<{ id: string }> };
    const employmentId = profile.employments[0]!.id;
    await db.update(hrEmployments).set({ endedOn: "2026-09-01" }).where(eq(hrEmployments.id, employmentId));
    await ensureHrAnnualLeaveEntitlements(db, { asOfDate: "2026-09-01" });
    const rows = await db.select({ periodStart: hrAnnualLeaveEntitlements.periodStart }).from(hrAnnualLeaveEntitlements)
      .where(eq(hrAnnualLeaveEntitlements.employmentId, employmentId));
    expect(rows.some((row) => row.periodStart === "2026-09-01")).toBe(false);
  });

  it("離職薪資期間用同一條折現流程結算未休特休", async () => {
    const db = createDatabase(d1 as never);
    const profile = await (await request("/hr/employees/employee")).json() as { employments: Array<{ id: string; revision: number }> };
    const employmentId = profile.employments[0]!.id;
    const compensation = await request(`/hr/employments/${employmentId}/compensation`, "POST", { validFrom: "2025-03-01", payBasis: "monthly", baseAmountMinor: 3_000_000, note: "測試月薪" });
    expect(compensation.status, await compensation.clone().text()).toBe(201);
    const ended = await request(`/hr/employments/${employmentId}/end`, "PATCH", { endedOn: "2026-01-15", revision: 1 });
    expect(ended.status, await ended.clone().text()).toBe(200);

    const calculated = await request("/hr/payroll/calculate", "POST", { periodKey: "2026-01", employeeUserIds: ["employee"], requestId: "annual-settlement-termination" });
    expect(calculated.status, await calculated.clone().text()).toBe(200);
    const calculatedBody = await calculated.json() as { run: { runId: string; employees: Array<{ lines: Array<{ lineKey: string; amountMinor: number; explanation: Record<string, unknown> }> }> } };
    const settlementLine = calculatedBody.run.employees[0]?.lines.find((line) => line.lineKey === "annual_leave_settlement");
    expect(settlementLine).toMatchObject({ amountMinor: 300_000, explanation: expect.objectContaining({ settlementItems: expect.arrayContaining([expect.objectContaining({ settlementReason: "termination", settlementDate: "2026-01-14" })]) }) });

    const closed = await request(`/hr/payroll/runs/${calculatedBody.run.runId}/close`, "POST", {});
    expect(closed.status, await closed.clone().text()).toBe(200);
    const entitlement = await db.select({ id: hrAnnualLeaveEntitlements.id, status: hrAnnualLeaveEntitlements.status }).from(hrAnnualLeaveEntitlements)
      .where(eq(hrAnnualLeaveEntitlements.periodStart, "2025-09-01")).limit(1);
    const settlement = await db.select({ entryKind: hrAnnualLeaveLedger.entryKind, deltaHalfHours: hrAnnualLeaveLedger.deltaHalfHours }).from(hrAnnualLeaveLedger)
      .where(eq(hrAnnualLeaveLedger.sourceKey, `annual-settlement:${entitlement[0]!.id}`)).limit(1);
    expect(entitlement[0]?.status).toBe("settled");
    expect(settlement).toEqual([{ entryKind: "settlement", deltaHalfHours: -48 }]);
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

    const raced = await request("/hr/requests/leave", "POST", {
      employeeUserId: "employee", leaveTypeId, startDate: "2025-09-02", endDate: "2025-09-02", durationMinutes: 30, reason: "結算競態測試",
    });
    expect(raced.status, await raced.clone().text()).toBe(201);
    const racedId = (await raced.json() as { id: string }).id;
    d1.sqlite.exec(`CREATE TRIGGER settle_before_leave_reversal
      AFTER UPDATE OF status ON hr_leave_requests
      WHEN NEW.status='cancelled'
      BEGIN
        UPDATE hr_annual_leave_entitlements SET status='settled', settled_at=CURRENT_TIMESTAMP
        WHERE id=(SELECT entitlement_id FROM hr_annual_leave_ledger WHERE leave_request_id=NEW.id AND entry_kind='leave_request');
      END`);
    const racedCancel = await request(`/hr/requests/leave/${racedId}/cancel`, "POST", {});
    expect(racedCancel.status).toBe(409);
    expect(d1.sqlite.prepare("SELECT status FROM hr_leave_requests WHERE id=?").get(racedId)).toEqual({ status: "approved" });
    expect(d1.sqlite.prepare("SELECT count(*) AS count FROM hr_annual_leave_ledger WHERE source_key=?").get(`leave-request-cancel:${racedId}`)).toEqual({ count: 0 });

    const overbooked = await request("/hr/requests/leave", "POST", {
      employeeUserId: "employee", leaveTypeId, startDate: "2026-03-02", endDate: "2026-03-08", durationMinutes: 3_360, reason: "不可挪用上一期餘額",
    });
    expect(overbooked.status, await overbooked.clone().text()).toBe(409);
  });
});
