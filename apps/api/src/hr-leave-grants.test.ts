import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { hrLeaveGrantBatches, hrLeaveGrantLedger, hrLeaveGrants, hrEmployments, userRoleAssignments, users } from "@rueisiang/db/schema";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "hr-leave-grants-test-secret-test-secret";
let d1: LocalD1;
let adminCookie: string;
let employeeCookie: string;
let employmentId: string;
let leaveTypeId: string;

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

function dateOffset(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function todayTaipei() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function issue(amountMinutes: number, expiresOn: string, issuedOn = todayTaipei()) {
  const response = await request("/hr/leave-grants", "POST", {
    leaveTypeId,
    employmentIds: [employmentId],
    issuedOn,
    expiresOn,
    amountMinutes,
    note: "自動化測試發放",
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const { id: batchId } = await response.json() as { id: string };
  const db = createDatabase(d1 as never);
  const [grant] = await db.select({ id: hrLeaveGrants.id }).from(hrLeaveGrants).where(eq(hrLeaveGrants.batchId, batchId)).limit(1);
  return { id: grant!.id };
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  const db = createDatabase(d1 as never);
  await syncSystemRoles(db);
  await db.insert(users).values([
    { id: "admin", email: "admin@example.test", displayName: "管理者", status: "active" },
    { id: "employee", email: "employee@example.test", displayName: "額度員工", status: "active" },
  ]);
  await db.insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  adminCookie = await sessionCookie("admin", "admin@example.test", "管理者");
  employeeCookie = await sessionCookie("employee", "employee@example.test", "額度員工");

  const assigned = await request("/hr/employees", "POST", { userId: "employee", legalName: "額度員工", employeeNumber: "E-GRANT", position: "一般職員", serviceStartOn: "2025-03-01" });
  expect(assigned.status, await assigned.clone().text()).toBe(201);
  const employment = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(eq(hrEmployments.employeeUserId, "employee")).limit(1);
  employmentId = employment[0]!.id;
  const leaveType = await request("/hr/leave-types", "POST", { name: "補休", leaveKind: "grant", scheduleCheckRequired: false, defaultPayRatePpm: 1_000_000 });
  expect(leaveType.status, await leaveType.clone().text()).toBe(201);
  leaveTypeId = (await leaveType.json() as { id: string }).id;
});

afterEach(() => d1.sqlite.close());

describe("HR 假別額度發放", () => {
  it("發放時數以整數小時、使用期限含最後一天，請假略過班表並依最早到期額度扣除", async () => {
    const today = todayTaipei();
    const directHrDuration = await request("/hr/requests/leave-duration", "POST", { employeeUserId: "employee", leaveTypeId, startsAt: `${today}T23:00`, endsAt: `${dateOffset(today, 1)}T00:00` });
    expect(directHrDuration.status, await directHrDuration.clone().text()).toBe(200);
    expect(await directHrDuration.json()).toMatchObject({ durationMinutes: 60 });

    const earliestGrant = await issue(60, today);
    await issue(60, dateOffset(today, 30));

    const early = await request("/hr/me/leave-requests", "POST", { leaveTypeId, startsAt: `${dateOffset(today, -1)}T23:00`, endsAt: `${today}T00:00`, reason: "早於發放日" }, employeeCookie);
    expect(early.status).toBe(409);

    const fractional = await request("/hr/me/leave-requests", "POST", { leaveTypeId, startsAt: `${today}T09:00`, endsAt: `${today}T09:30`, reason: "半小時" }, employeeCookie);
    expect(fractional.status).toBe(400);

    const pending = await request("/hr/me/leave-requests", "POST", { leaveTypeId, startsAt: `${today}T23:00`, endsAt: `${dateOffset(today, 1)}T00:00`, reason: "跨到午夜前一小時" }, employeeCookie);
    expect(pending.status, await pending.clone().text()).toBe(201);
    const pendingBody = await pending.json() as { id: string };
    const blockedRevocation = await request(`/hr/leave-grants/${earliestGrant.id}/revoke`, "POST", {});
    expect(blockedRevocation.status).toBe(409);
    const pendingRow = await createDatabase(d1 as never).query.hrLeaveRequests.findFirst({ where: (table, { eq }) => eq(table.id, pendingBody.id) });
    expect(pendingRow?.durationMinutes).toBe(60);

    const reviewed = await request(`/hr/requests/leave/${pendingBody.id}/review`, "POST", { revision: 1, decision: "approved", comment: "核准" });
    expect(reviewed.status, await reviewed.clone().text()).toBe(200);

    const db = createDatabase(d1 as never);
    const rows = await db.select({ expiresOn: hrLeaveGrantBatches.expiresOn, amountMinutes: hrLeaveGrantBatches.amountMinutes, deltaMinutes: hrLeaveGrantLedger.deltaMinutes })
      .from(hrLeaveGrantLedger).innerJoin(hrLeaveGrants, eq(hrLeaveGrants.id, hrLeaveGrantLedger.grantId)).innerJoin(hrLeaveGrantBatches, eq(hrLeaveGrantBatches.id, hrLeaveGrants.batchId))
      .where(and(eq(hrLeaveGrantLedger.leaveRequestId, pendingBody.id), eq(hrLeaveGrantLedger.entryKind, "leave_request")));
    expect(rows).toEqual([{ expiresOn: today, amountMinutes: 60, deltaMinutes: -60 }]);

    const cancelled = await request(`/hr/me/leave-requests/${pendingBody.id}/cancel`, "POST", {}, employeeCookie);
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    const balance = await db.select({ grantId: hrLeaveGrants.id, expiresOn: hrLeaveGrantBatches.expiresOn })
      .from(hrLeaveGrants).innerJoin(hrLeaveGrantBatches, eq(hrLeaveGrantBatches.id, hrLeaveGrants.batchId));
    expect(balance).toHaveLength(2);
    const afterCancellation = await request("/hr/leave-grants?expiry=all");
    expect(afterCancellation.status, await afterCancellation.clone().text()).toBe(200);
    const grantRows = (await afterCancellation.json() as { grants: Array<{ usedMinutes: number; balanceMinutes: number }> }).grants;
    expect(grantRows).toHaveLength(2);
    expect(grantRows.every((row) => row.usedMinutes === 0 && row.balanceMinutes === 60)).toBe(true);
  });

  it("額度清單支援到期篩選、假別／關鍵字搜尋與伺服器分頁", async () => {
    const today = todayTaipei();
    for (let index = 0; index < 11; index += 1) await issue(60, dateOffset(today, 10));
    await issue(60, dateOffset(today, -1), dateOffset(today, -30));

    const changeKind = await request(`/hr/leave-types/${leaveTypeId}`, "PATCH", { name: "補休", leaveKind: "other", scheduleCheckRequired: false, defaultPayRatePpm: 1_000_000 });
    expect(changeKind.status, await changeKind.clone().text()).toBe(409);

    const firstPage = await request(`/hr/leave-grants?page=1&pageSize=10&search=E-GRANT&leaveTypeId=${leaveTypeId}&expiry=unexpired`);
    expect(firstPage.status, await firstPage.clone().text()).toBe(200);
    const firstPageBody = await firstPage.json() as { grants: unknown[]; total: number; page: number; pageSize: number; hasMore: boolean };
    expect(firstPageBody).toMatchObject({ total: 11, page: 1, pageSize: 10, hasMore: true });
    expect(firstPageBody.grants).toHaveLength(10);

    const secondPage = await request(`/hr/leave-grants?page=2&pageSize=10&search=E-GRANT&leaveTypeId=${leaveTypeId}&expiry=unexpired`);
    expect(secondPage.status, await secondPage.clone().text()).toBe(200);
    const secondPageBody = await secondPage.json() as { grants: unknown[]; total: number; page: number; pageSize: number; hasMore: boolean };
    expect(secondPageBody).toMatchObject({ total: 11, page: 2, pageSize: 10, hasMore: false });
    expect(secondPageBody.grants).toHaveLength(1);

    const expired = await request(`/hr/leave-grants?expiry=expired&leaveTypeId=${leaveTypeId}`);
    expect(expired.status, await expired.clone().text()).toBe(200);
    expect(await expired.json()).toMatchObject({ total: 1, hasMore: false });

    const all = await request(`/hr/leave-grants?expiry=all&leaveTypeId=${leaveTypeId}`);
    expect(all.status, await all.clone().text()).toBe(200);
    expect(await all.json()).toMatchObject({ total: 12 });

    const defaults = await request("/hr/leave-grants");
    expect(defaults.status, await defaults.clone().text()).toBe(200);
    expect(await defaults.json()).toMatchObject({ total: 11, page: 1, pageSize: 25 });
  });

  it("在職員工可查可用額度，撤銷只沖回未使用餘額", async () => {
    const today = todayTaipei();
    const batch = await issue(120, dateOffset(today, 10));
    const listed = await request("/hr/leave-grants");
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect((await listed.json() as { grants: Array<{ id: string; employeeName: string; balanceMinutes: number }> }).grants)
      .toEqual([expect.objectContaining({ id: batch.id, employeeName: "額度員工", balanceMinutes: 120 })]);

    const employeeOptions = await request(`/hr/me/leave-types?asOfDate=${today}`, "GET", undefined, employeeCookie);
    expect(employeeOptions.status).toBe(200);
    expect((await employeeOptions.json() as { leaveTypes: Array<{ id: string; grantCredits: Array<{ balanceMinutes: number }> }> }).leaveTypes.find((row) => row.id === leaveTypeId)?.grantCredits).toEqual([
      expect.objectContaining({ balanceMinutes: 120, expiresOn: dateOffset(today, 10) }),
    ]);

    const revoked = await request(`/hr/leave-grants/${batch.id}/revoke`, "POST", {});
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    const db = createDatabase(d1 as never);
    const ledger = await db.select({ entryKind: hrLeaveGrantLedger.entryKind, deltaMinutes: hrLeaveGrantLedger.deltaMinutes }).from(hrLeaveGrantLedger);
    expect(ledger).toEqual([{ entryKind: "grant", deltaMinutes: 120 }, { entryKind: "revocation", deltaMinutes: -120 }]);
  });
});
