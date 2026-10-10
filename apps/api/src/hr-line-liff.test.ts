import { DEVICE_SESSION_COOKIE, SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { eq } from "drizzle-orm";
import { createDatabase, findUserByLineIdentity, linkLineAccount, replaceLineAccount, unlinkLineAccount, syncSystemRoles } from "@rueisiang/db";
import { authDeviceSessions, hrAttendanceLocations, hrClockEvents, hrEmployeeAttendanceLocations, hrEmployments, hrNotifications, hrOvertimeRequests, hrWorkerOvertimeRequests, userRoleAssignments, users } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";
import { createLineLinkIntentCookie, LINE_LIFF_INTENT_TTL_SECONDS } from "./line-liff.js";

const SECRET = "test-secret";
const CHANNEL_ID = "1234567890";
const HR_ORIGIN = "https://hr.rueisiang.com";
const VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
let d1: LocalD1;
let env: Record<string, unknown>;
let tokenSubjects: Map<string, string>;
let employeeSequence = 0;

const db = () => createDatabase(d1 as never);

async function seedEmployee(email: string) {
  const id = `user-${email}`;
  const employmentId = `employment-${++employeeSequence}`;
  await db().insert(users).values({ id, email, status: "active", displayName: "測試員工" });
  await db().insert(hrEmployments).values({
    id: employmentId,
    employeeUserId: id,
    employeeNumber: `E-${employeeSequence}`,
    legalName: "測試員工",
    position: "一般職員",
  });
  return { id, employmentId, email };
}

async function sessionCookie(userId: string, email: string) {
  const token = await signSession(newSessionClaims({ id: userId, email, name: "測試員工", pictureUrl: "" }), SECRET);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

function call(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`https://platform.rueisiang.com${path}`, init), env as never);
}

function setCookies(response: Response): string[] {
  return (response.headers.get("Set-Cookie") ?? "").split(/,\s*(?=[\w-]+=)/).filter(Boolean);
}

function cookieFrom(response: Response, name: string): string | undefined {
  return setCookies(response).find((value) => value.startsWith(`${name}=`));
}

function asCookie(setCookie: string | undefined): string {
  if (!setCookie) throw new Error("回應沒有預期的 cookie。");
  return setCookie.split(";")[0]!;
}

function requestHeaders(cookie?: string) {
  return {
    Origin: HR_ORIGIN,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

async function bootstrap(token: string, cookie?: string) {
  return call("/api/hr/me/liff-session", {
    method: "POST",
    headers: { ...requestHeaders(cookie), "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: token }),
  });
}

async function seedLocation(employmentId: string) {
  await db().insert(hrAttendanceLocations).values({
    id: "location-test",
    name: "測試辦公室",
    geolocationRequired: 0,
    latitudeE7: 250_000_000,
    longitudeE7: 1_215_000_000,
    radiusMeters: 80,
    active: 1,
  });
  await db().insert(hrEmployeeAttendanceLocations).values({
    id: "assignment-test",
    employmentId,
    locationId: "location-test",
    validFrom: "2020-01-01",
  });
}

async function seedPendingWorkerOvertime(createdBy: string) {
  await db().insert(hrEmployments).values({ id: "support-worker", personKind: "worker", employeeNumber: "W-REVIEW", legalName: "支援人員", position: "支援人員" });
  await db().insert(hrWorkerOvertimeRequests).values({
    id: "pending-worker-request", workerId: "support-worker", requestedStart: "2026-09-03 18:00:00", requestedEnd: "2026-09-03 20:00:00",
    settlementKind: "pay", createdBy,
  });
  return "pending-worker-request";
}

beforeEach(async () => {
  employeeSequence = 0;
  tokenSubjects = new Map([
    ["line-alice", "U-line-alice"],
    ["line-bob", "U-line-bob"],
    ["line-shared", "U-line-shared"],
    ["line-new", "U-line-new"],
  ]);
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    AUTH_COOKIE_DOMAIN: ".rueisiang.com",
    AUTH_APP_ORIGINS: `https://platform.rueisiang.com,${HR_ORIGIN}`,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    LINE_LIFF_CHANNEL_ID: CHANNEL_ID,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== VERIFY_URL) throw new Error(`Unexpected outbound request: ${String(input)}`);
    const values = new URLSearchParams(String(init?.body ?? ""));
    const subject = tokenSubjects.get(values.get("id_token") ?? "");
    if (!subject) return Response.json({ error: "invalid token" }, { status: 400 });
    return Response.json({
      iss: "https://access.line.me",
      sub: subject,
      aud: values.get("client_id"),
      exp: Math.floor(Date.now() / 1000) + 300,
    });
  });
  await syncSystemRoles(db());
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("HR LINE LIFF 登入與帳號綁定", () => {
  it("驗證 LINE ID token 後只發 HR 本人範圍的 LIFF 裝置 session", async () => {
    const employee = await seedEmployee("line-login@ecotech.tw");
    await linkLineAccount(db(), employee.id, { channelId: CHANNEL_ID, lineUserId: "U-line-alice" });

    const response = await bootstrap("line-alice");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ linked: true });
    const deviceSetCookie = cookieFrom(response, DEVICE_SESSION_COOKIE);
    expect(deviceSetCookie).toContain("Path=/api/hr/me;");
    expect(deviceSetCookie).not.toContain("Domain=");
    const deviceCookie = asCookie(deviceSetCookie);

    const session = await call("/api/hr/me/session", { headers: requestHeaders(deviceCookie) });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ id: employee.id, deviceRemembered: true, lineLiffAuthenticated: true });
    expect((await call("/api/auth/me", { headers: requestHeaders(deviceCookie) })).status).toBe(401);
    expect((await call("/api/hr/overview", { headers: requestHeaders(deviceCookie) })).status).toBe(401);
    expect((await call("/api/hr/me/payroll-history", { headers: requestHeaders(deviceCookie) })).status).toBe(200);
    expect((await call("/api/hr/me/notifications", { headers: requestHeaders(deviceCookie) })).status).toBe(200);
    expect((await db().select().from(authDeviceSessions)).map((row) => row.authMethod)).toEqual(["line_liff"]);
  });

  it("LINE 登入沿用本人 HR 讀取入口，但不能取得平台或管理端認證", async () => {
    const employee = await seedEmployee("line-self-service@ecotech.tw");
    await linkLineAccount(db(), employee.id, { channelId: CHANNEL_ID, lineUserId: "U-line-alice" });
    const deviceCookie = asCookie(cookieFrom(await bootstrap("line-alice"), DEVICE_SESSION_COOKIE));
    for (const path of ["", "/attendance-calendar", "/leave-types", "/leave-requests", "/overtime", "/form-requests"]) {
      expect((await call(`/api/hr/me${path}`, { headers: requestHeaders(deviceCookie) })).status).toBe(200);
    }
    expect((await call("/api/hr/liff/link", { headers: requestHeaders(deviceCookie) })).status).toBe(401);
    expect((await call("/api/hr/employees", { headers: requestHeaders(deviceCookie) })).status).toBe(401);
    expect((await call("/api/hr/me/device", { method: "POST", headers: requestHeaders(deviceCookie) })).status).toBe(200);
    expect((await db().select().from(authDeviceSessions)).map((row) => row.authMethod)).toEqual(["line_liff"]);
  });

  it("LINE 登入的通知、薪資與申請仍以伺服器身分為準，不能讀寫他人的資料", async () => {
    const alice = await seedEmployee("line-self-alice@ecotech.tw");
    const bob = await seedEmployee("line-self-bob@ecotech.tw");
    const supervisor = await seedEmployee("line-self-supervisor@ecotech.tw");
    await db().update(hrEmployments).set({ supervisorUserId: supervisor.id }).where(eq(hrEmployments.id, alice.employmentId));
    await linkLineAccount(db(), alice.id, { channelId: CHANNEL_ID, lineUserId: "U-line-alice" });
    await linkLineAccount(db(), bob.id, { channelId: CHANNEL_ID, lineUserId: "U-line-bob" });
    const aliceCookie = asCookie(cookieFrom(await bootstrap("line-alice"), DEVICE_SESSION_COOKIE));
    const bobCookie = asCookie(cookieFrom(await bootstrap("line-bob"), DEVICE_SESSION_COOKIE));
    await db().insert(hrNotifications).values({
      id: "alice-notification", userId: alice.id, sourceKey: "alice-source", kind: "request_reviewed",
      entityKind: "overtime", entityId: "example-request", title: "Alice 的通知", body: "本人通知內容",
    });
    const aliceNotifications = await call("/api/hr/me/notifications", { headers: requestHeaders(aliceCookie) });
    expect(await aliceNotifications.json()).toMatchObject({ unreadCount: 1, notifications: [{ id: "alice-notification" }] });
    const bobNotifications = await call(`/api/hr/me/notifications?userId=${encodeURIComponent(alice.id)}`, { headers: requestHeaders(bobCookie) });
    expect(await bobNotifications.json()).toEqual({ unreadCount: 0, notifications: [] });
    expect((await call("/api/hr/me/notifications/alice-notification/read", { method: "POST", headers: requestHeaders(bobCookie) })).status).toBe(404);
    expect((await call("/api/hr/me/notifications/alice-notification/read", { method: "POST", headers: requestHeaders(aliceCookie) })).status).toBe(200);
    expect((await call(`/api/hr/me/payroll-history/unknown-run/${alice.employmentId}`, { headers: requestHeaders(bobCookie) })).status).toBe(404);

    const created = await call("/api/hr/me/overtime", {
      method: "POST", headers: { ...requestHeaders(aliceCookie), "Content-Type": "application/json" },
      body: JSON.stringify({ employeeUserId: bob.id, requestedStart: "2026-09-03 18:00", requestedEnd: "2026-09-03 20:00", settlementKind: "pay", reason: "LINE 手機申請" }),
    });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    const aliceRequests = await call("/api/hr/me/overtime", { headers: requestHeaders(aliceCookie) });
    expect(await aliceRequests.json()).toMatchObject({ requests: [{ request: { id }, employeeUserId: alice.id }] });
    const bobRequests = await call("/api/hr/me/overtime", { headers: requestHeaders(bobCookie) });
    expect(await bobRequests.json()).toMatchObject({ requests: [] });
    expect((await call(`/api/hr/me/overtime/${id}/cancel`, { method: "POST", headers: requestHeaders(bobCookie) })).status).toBe(404);
    expect((await call(`/api/hr/me/overtime/${id}/cancel`, { method: "POST", headers: requestHeaders(aliceCookie) })).status).toBe(200);
  });

  it.each(["approved", "rejected"] as const)("無審核權限的 LINE 員工不能 %s 支援人員加班；即時授權後才可操作", async (decision) => {
    const employee = await seedEmployee(`line-worker-review-${decision}@ecotech.tw`);
    const id = await seedPendingWorkerOvertime(employee.id);
    await linkLineAccount(db(), employee.id, { channelId: CHANNEL_ID, lineUserId: "U-line-alice" });
    const deviceCookie = asCookie(cookieFrom(await bootstrap("line-alice"), DEVICE_SESSION_COOKIE));
    const review = (path: string) => call(`/api/hr${path}/${id}/review`, {
      method: "POST", headers: { ...requestHeaders(deviceCookie), "Content-Type": "application/json" },
      body: JSON.stringify({ decision, comment: "支援人員審核測試" }),
    });
    expect((await review("/me/overtime")).status).toBe(404);
    expect((await db().select().from(hrWorkerOvertimeRequests))[0]).toMatchObject({ status: "pending", reviewedBy: null });
    await db().insert(userRoleAssignments).values({ userId: employee.id, roleId: "role-admin" });
    expect((await review("/me/overtime")).status).toBe(200);
    expect((await db().select().from(hrWorkerOvertimeRequests))[0]).toMatchObject({ status: decision, reviewedBy: employee.id });
    // 具備角色也不會讓 LINE device cookie 成為管理端的登入 session。
    expect((await review("/requests/overtime")).status).toBe(401);
    await db().insert(hrWorkerOvertimeRequests).values({
      id: "worker-request-after-role-change", workerId: "support-worker", requestedStart: "2026-09-04 18:00:00", requestedEnd: "2026-09-04 20:00:00",
      settlementKind: "pay", createdBy: employee.id,
    });
    await db().delete(userRoleAssignments).where(eq(userRoleAssignments.userId, employee.id));
    const revoked = await call("/api/hr/me/overtime/worker-request-after-role-change/review", {
      method: "POST", headers: { ...requestHeaders(deviceCookie), "Content-Type": "application/json" }, body: JSON.stringify({ decision, comment: "權限已撤銷" }),
    });
    expect(revoked.status).toBe(404);
    expect((await db().select().from(hrWorkerOvertimeRequests).where(eq(hrWorkerOvertimeRequests.id, "worker-request-after-role-change")))[0]).toMatchObject({ status: "pending", reviewedBy: null });
  });

  it("無 HR 全域審核權的 LINE 主管仍可審指定正式員工，但不能代審他人或自審", async () => {
    const supervisor = await seedEmployee("line-approver@ecotech.tw");
    const applicant = await seedEmployee("line-review-applicant@ecotech.tw");
    const other = await seedEmployee("line-review-other@ecotech.tw");
    await db().insert(hrOvertimeRequests).values([
      { id: "assigned-request", employmentId: applicant.employmentId, requestedStart: "2026-09-03 18:00:00", requestedEnd: "2026-09-03 20:00:00", settlementKind: "pay", approverUserId: supervisor.id, createdBy: applicant.id },
      { id: "unassigned-request", employmentId: other.employmentId, requestedStart: "2026-09-03 18:00:00", requestedEnd: "2026-09-03 20:00:00", settlementKind: "pay", approverUserId: applicant.id, createdBy: other.id },
      { id: "self-request", employmentId: supervisor.employmentId, requestedStart: "2026-09-03 18:00:00", requestedEnd: "2026-09-03 20:00:00", settlementKind: "pay", approverUserId: supervisor.id, createdBy: supervisor.id },
    ]);
    await linkLineAccount(db(), supervisor.id, { channelId: CHANNEL_ID, lineUserId: "U-line-alice" });
    const deviceCookie = asCookie(cookieFrom(await bootstrap("line-alice"), DEVICE_SESSION_COOKIE));
    const review = (id: string) => call(`/api/hr/me/overtime/${id}/review`, {
      method: "POST", headers: { ...requestHeaders(deviceCookie), "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approved" }),
    });
    expect((await review("unassigned-request")).status).toBe(404);
    expect((await review("self-request")).status).toBe(409);
    expect((await review("assigned-request")).status).toBe(200);
    expect((await db().select().from(hrOvertimeRequests).where(eq(hrOvertimeRequests.id, "assigned-request")))[0]).toMatchObject({ status: "approved", reviewedBy: supervisor.id });
  });

  it.each(["/requests/overtime", "/overtime"])("合法管理入口 %s 保留支援人員加班審核能力", async (path) => {
    const admin = await seedEmployee(`line-admin-worker-${path.replaceAll("/", "-")}@ecotech.tw`);
    await db().insert(userRoleAssignments).values({ userId: admin.id, roleId: "role-admin" });
    const id = await seedPendingWorkerOvertime(admin.id);
    const response = await call(`/api/hr${path}/${id}/review`, {
      method: "POST", headers: { ...requestHeaders(await sessionCookie(admin.id, admin.email)), "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(response.status).toBe(200);
    expect((await db().select().from(hrWorkerOvertimeRequests))[0]).toMatchObject({ status: "approved", reviewedBy: admin.id });
  });

  it.each(["same", "different", "expired"] as const)("已有 LINE 關聯且 intent 為 %s 時，伺服器準確回報是否需要替換", async (kind) => {
    const employee = await seedEmployee(`line-replace-hint-${kind}@ecotech.tw`);
    await linkLineAccount(db(), employee.id, { channelId: CHANNEL_ID, lineUserId: "U-line-alice" });
    const intent = await createLineLinkIntentCookie({ channelId: CHANNEL_ID, lineUserId: kind === "different" ? "U-line-new" : "U-line-alice" }, SECRET,
      kind === "expired" ? Date.now() - LINE_LIFF_INTENT_TTL_SECONDS * 1000 - 1000 : Date.now());
    const response = await call("/api/hr/liff/link", { headers: requestHeaders(`${await sessionCookie(employee.id, employee.email)}; ${asCookie(intent)}`) });
    expect(await response.json()).toEqual({ linked: true, pending: kind !== "expired", replaceRequired: kind === "different" });
  });

  it("未綁定時保存短效、簽章的身分意圖；必須用平台 session 明確確認後才建立關聯", async () => {
    const employee = await seedEmployee("line-link@ecotech.tw");
    const platformSession = await sessionCookie(employee.id, employee.email);

    const bootstrapResponse = await bootstrap("line-alice");
    expect(await bootstrapResponse.json()).toEqual({ linked: false });
    const intent = cookieFrom(bootstrapResponse, "rueisiang_hr_line_intent");
    expect(intent).toContain("Path=/api/hr/liff/link;");
    expect(cookieFrom(bootstrapResponse, DEVICE_SESSION_COOKIE)).toContain("Max-Age=0");

    const status = await call("/api/hr/liff/link", { headers: requestHeaders(`${platformSession}; ${asCookie(intent)}`) });
    expect(await status.json()).toEqual({ linked: false, pending: true, replaceRequired: false });

    const unauthorized = await call("/api/hr/liff/link", {
      method: "POST",
      headers: { ...requestHeaders(asCookie(intent)), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(unauthorized.status).toBe(401);

    const linked = await call("/api/hr/liff/link", {
      method: "POST",
      headers: { ...requestHeaders(`${platformSession}; ${asCookie(intent)}`), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(linked.status).toBe(201);
    expect(await linked.json()).toEqual({ linked: true });
    expect(cookieFrom(linked, "rueisiang_hr_line_intent")).toContain("Max-Age=0");
    expect(await findUserByLineIdentity(db(), { channelId: CHANNEL_ID, lineUserId: "U-line-alice" })).toBe(employee.id);

    const deviceCookie = asCookie(cookieFrom(linked, DEVICE_SESSION_COOKIE));
    const session = await call("/api/hr/me/session", { headers: requestHeaders(`${platformSession}; ${deviceCookie}`) });
    expect(await session.json()).toMatchObject({ id: employee.id, lineLiffAuthenticated: true });
    expect((await db().select().from(authDeviceSessions)).map((row) => row.authMethod)).toEqual(["line_liff"]);
  });

  it("綁定回應遺失後冪等重試仍交付 LIFF session，不只清除意圖", async () => {
    const employee = await seedEmployee("line-link-retry@ecotech.tw");
    const platformSession = await sessionCookie(employee.id, employee.email);
    const intentResponse = await bootstrap("line-alice");
    const intent = asCookie(cookieFrom(intentResponse, "rueisiang_hr_line_intent"));
    const confirm = () => call("/api/hr/liff/link", {
      method: "POST",
      headers: { ...requestHeaders(`${platformSession}; ${intent}`), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect((await confirm()).status).toBe(201);
    // 不採用第一次回應的裝置 cookie，模擬 DB 已寫入但回應遺失。
    const retry = await confirm();
    expect(retry.status).toBe(200);
    expect(cookieFrom(retry, "rueisiang_hr_line_intent")).toContain("Max-Age=0");
    const deviceCookie = asCookie(cookieFrom(retry, DEVICE_SESSION_COOKIE));
    const session = await call("/api/hr/me/session", { headers: requestHeaders(`${platformSession}; ${deviceCookie}`) });
    expect(await session.json()).toMatchObject({ id: employee.id, lineLiffAuthenticated: true });
    expect((await call("/api/hr/me/payroll-history", { headers: requestHeaders(deviceCookie) })).status).toBe(200);
  });

  it("不接受 LINE 驗證回傳的錯誤 audience，也不會由前端 body 指定 LINE UID", async () => {
    const employee = await seedEmployee("line-invalid@ecotech.tw");
    tokenSubjects.set("line-bad-audience", "U-line-alice");
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const values = new URLSearchParams(String(init?.body ?? ""));
      return Response.json({
        iss: "https://access.line.me",
        sub: tokenSubjects.get(values.get("id_token") ?? ""),
        aud: "another-channel",
        exp: Math.floor(Date.now() / 1000) + 300,
      });
    });

    const response = await call("/api/hr/me/liff-session", {
      method: "POST",
      headers: { ...requestHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "line-bad-audience", lineUserId: "U-line-alice" }),
    });
    expect(response.status).toBe(401);
    expect(cookieFrom(response, DEVICE_SESSION_COOKIE)).toBeUndefined();
    expect(await findUserByLineIdentity(db(), { channelId: CHANNEL_ID, lineUserId: "U-line-alice" })).toBeNull();
    expect(await db().select().from(users)).toHaveLength(1);
    expect((await db().select().from(hrEmployments)).find((row) => row.employeeUserId === employee.id)).toBeTruthy();
  });

  it("LIFF 本人 session 不會擴大成 HR 管理權；而 LIFF 打卡強制 GPS 並留下 line 來源", async () => {
    const employee = await seedEmployee("line-clock@ecotech.tw");
    await seedLocation(employee.employmentId);
    await linkLineAccount(db(), employee.id, { channelId: CHANNEL_ID, lineUserId: "U-line-alice" });
    const login = await bootstrap("line-alice");
    const deviceCookie = asCookie(cookieFrom(login, DEVICE_SESSION_COOKIE));

    const clockStatus = await call("/api/hr/me/clock-events", { headers: requestHeaders(deviceCookie) });
    expect(await clockStatus.json()).toMatchObject({ canClock: true, geolocationRequired: true });

    const locationCheck = await call("/api/hr/me/attendance-location/check", {
      method: "POST",
      headers: { ...requestHeaders(deviceCookie), "Content-Type": "application/json" },
      body: JSON.stringify({ latitude: 25, longitude: 121.5 }),
    });
    expect(await locationCheck.json()).toMatchObject({ available: true, geolocationRequired: true, withinRadius: true });

    const missingCoordinates = await call("/api/hr/me/clock-events", {
      method: "POST",
      headers: { ...requestHeaders(deviceCookie), "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "line-no-gps" }),
    });
    expect(missingCoordinates.status).toBe(400);

    const clock = await call("/api/hr/me/clock-events", {
      method: "POST",
      headers: { ...requestHeaders(deviceCookie), "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "line-with-gps", latitude: 25, longitude: 121.5 }),
    });
    expect(clock.status).toBe(201);
    const events = await db().select().from(hrClockEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sourceKind: "line", latitudeE7: 250_000_000, longitudeE7: 1_215_000_000 });
  });

  it("LINE 身分與平台帳號皆為唯一關聯；不能把同一 LINE UID 綁到另一位員工", async () => {
    const alice = await seedEmployee("line-alice-owner@ecotech.tw");
    const bob = await seedEmployee("line-bob-owner@ecotech.tw");
    await linkLineAccount(db(), alice.id, { channelId: CHANNEL_ID, lineUserId: "U-line-alice" });

    const response = await call("/api/hr/liff/link", {
      method: "POST",
      headers: { ...requestHeaders(await sessionCookie(bob.id, bob.email)), "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "line-alice" }),
    });
    expect(response.status).toBe(409);
    expect(await findUserByLineIdentity(db(), { channelId: CHANNEL_ID, lineUserId: "U-line-alice" })).toBe(alice.id);
    expect(await db().select().from(authDeviceSessions)).toHaveLength(0);
  });

  it("替換 LINE 綁定時保留舊關聯；若新 LINE 已屬於他人則不變更", async () => {
    const alice = await seedEmployee("line-replace-alice@ecotech.tw");
    const other = await seedEmployee("line-replace-other@ecotech.tw");
    const aliceSession = await sessionCookie(alice.id, alice.email);
    await linkLineAccount(db(), alice.id, { channelId: CHANNEL_ID, lineUserId: "U-line-alice" });
    await bootstrap("line-alice");

    const conflictingIntent = await bootstrap("line-shared");
    await linkLineAccount(db(), other.id, { channelId: CHANNEL_ID, lineUserId: "U-line-shared" });
    const conflict = await call("/api/hr/liff/link", {
      method: "POST",
      headers: { ...requestHeaders(`${aliceSession}; ${asCookie(cookieFrom(conflictingIntent, "rueisiang_hr_line_intent"))}`), "Content-Type": "application/json" },
      body: JSON.stringify({ replaceExisting: true }),
    });
    expect(conflict.status).toBe(409);
    expect(await findUserByLineIdentity(db(), { channelId: CHANNEL_ID, lineUserId: "U-line-alice" })).toBe(alice.id);
    expect(await findUserByLineIdentity(db(), { channelId: CHANNEL_ID, lineUserId: "U-line-shared" })).toBe(other.id);
    expect((await db().select().from(authDeviceSessions)).some((row) => row.revokedAt)).toBe(false);

    const replacementIntent = await bootstrap("line-new");
    const replacement = await call("/api/hr/liff/link", {
      method: "POST",
      headers: { ...requestHeaders(`${aliceSession}; ${asCookie(cookieFrom(replacementIntent, "rueisiang_hr_line_intent"))}`), "Content-Type": "application/json" },
      body: JSON.stringify({ replaceExisting: true }),
    });
    expect(replacement.status).toBe(200);
    expect(await findUserByLineIdentity(db(), { channelId: CHANNEL_ID, lineUserId: "U-line-alice" })).toBeNull();
    expect(await findUserByLineIdentity(db(), { channelId: CHANNEL_ID, lineUserId: "U-line-new" })).toBe(alice.id);
    const sessions = await db().select().from(authDeviceSessions);
    expect(sessions.filter((row) => row.revokedAt)).toHaveLength(1);
    expect(sessions.filter((row) => !row.revokedAt)).toHaveLength(1);
  });

  it("員工可解除自己的 LINE 關聯，並撤銷所有 LINE 裝置 session", async () => {
    const employee = await seedEmployee("line-unlink@ecotech.tw");
    await linkLineAccount(db(), employee.id, { channelId: CHANNEL_ID, lineUserId: "U-line-alice" });
    const login = await bootstrap("line-alice");
    const deviceCookie = asCookie(cookieFrom(login, DEVICE_SESSION_COOKIE));

    const response = await call("/api/hr/me/liff-link", { method: "DELETE", headers: requestHeaders(deviceCookie) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unlinked: true });
    expect(cookieFrom(response, DEVICE_SESSION_COOKIE)).toContain("Max-Age=0");
    expect(await findUserByLineIdentity(db(), { channelId: CHANNEL_ID, lineUserId: "U-line-alice" })).toBeNull();
    expect((await db().select().from(authDeviceSessions))[0]?.revokedAt).toBeTruthy();
    expect((await call("/api/hr/me/session", { headers: requestHeaders(deviceCookie) })).status).toBe(401);
  });

  it.each(["unlink", "replace"] as const)("%s 完成後，先前已查到舊身分的 bootstrap 不能補發 session", async (operation) => {
    const employee = await seedEmployee(`line-race-${operation}@ecotech.tw`);
    const platformSession = await sessionCookie(employee.id, employee.email);
    await linkLineAccount(db(), employee.id, { channelId: CHANNEL_ID, lineUserId: "U-line-alice" });
    let reachedInsert!: () => void;
    let resumeInsert!: () => void;
    const reached = new Promise<void>((resolve) => { reachedInsert = resolve; });
    const resumed = new Promise<void>((resolve) => { resumeInsert = resolve; });
    const prepare = d1.prepare.bind(d1);
    let paused = false;
    vi.spyOn(d1, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      if (!paused && /INSERT INTO auth_device_sessions[\s\S]*SELECT/i.test(query)) {
        paused = true;
        const bind = statement.bind.bind(statement);
        vi.spyOn(statement, "bind").mockImplementation((...values) => {
          const bound = bind(...values);
          const all = bound.all.bind(bound);
          vi.spyOn(bound, "all").mockImplementation(async () => {
            reachedInsert();
            await resumed;
            return all();
          });
          return bound;
        });
      }
      return statement;
    });
    const oldLogin = bootstrap("line-alice");
    await reached;
    try {
      const mutation = operation === "unlink"
        ? await call("/api/hr/me/liff-link", { method: "DELETE", headers: requestHeaders(platformSession) })
        : await call("/api/hr/liff/link", {
          method: "POST", headers: { ...requestHeaders(platformSession), "Content-Type": "application/json" },
          body: JSON.stringify({ idToken: "line-bob", replaceExisting: true }),
        });
      expect(mutation.status).toBe(200);
    } finally {
      resumeInsert();
    }
    const response = await oldLogin;
    expect(response.status).toBe(409);
    expect(cookieFrom(response, DEVICE_SESSION_COOKIE)).toBeUndefined();
    expect(await findUserByLineIdentity(db(), { channelId: CHANNEL_ID, lineUserId: "U-line-alice" })).toBeNull();
    const sessions = await db().select().from(authDeviceSessions);
    expect(sessions.filter((row) => !row.revokedAt)).toHaveLength(operation === "replace" ? 1 : 0);
  });

  it.each(["unlink", "replace"] as const)("%s 的 session 撤銷失敗時同一 transaction 回滾關聯變更", async (operation) => {
    const employee = await seedEmployee(`line-rollback-${operation}@ecotech.tw`);
    await linkLineAccount(db(), employee.id, { channelId: CHANNEL_ID, lineUserId: "U-line-alice" });
    await bootstrap("line-alice");
    d1.sqlite.exec(`CREATE TRIGGER fail_line_revoke BEFORE UPDATE OF revoked_at ON auth_device_sessions
      WHEN NEW.auth_method = 'line_liff' BEGIN SELECT RAISE(ABORT, 'simulated revoke failure'); END`);
    await expect(operation === "unlink"
      ? unlinkLineAccount(db(), employee.id)
      : replaceLineAccount(db(), employee.id, { channelId: CHANNEL_ID, lineUserId: "U-line-bob" })).rejects.toThrow();
    expect(await findUserByLineIdentity(db(), { channelId: CHANNEL_ID, lineUserId: "U-line-alice" })).toBe(employee.id);
    expect((await db().select().from(authDeviceSessions))[0]?.revokedAt).toBeNull();
  });

  it("過期 intent 不能建立綁定或 session", async () => {
    const employee = await seedEmployee("line-expired-intent@ecotech.tw");
    const cookie = await createLineLinkIntentCookie({ channelId: CHANNEL_ID, lineUserId: "U-line-alice" }, SECRET,
      Date.now() - LINE_LIFF_INTENT_TTL_SECONDS * 1000 - 1000);
    const response = await call("/api/hr/liff/link", {
      method: "POST", headers: { ...requestHeaders(`${await sessionCookie(employee.id, employee.email)}; ${asCookie(cookie)}`), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(await findUserByLineIdentity(db(), { channelId: CHANNEL_ID, lineUserId: "U-line-alice" })).toBeNull();
    expect(await db().select().from(authDeviceSessions)).toHaveLength(0);
  });

  it("取得 LIFF session 後封存員工，下一次請求被拒絕且撤銷装置", async () => {
    const employee = await seedEmployee("line-archive-after-login@ecotech.tw");
    await linkLineAccount(db(), employee.id, { channelId: CHANNEL_ID, lineUserId: "U-line-alice" });
    const deviceCookie = asCookie(cookieFrom(await bootstrap("line-alice"), DEVICE_SESSION_COOKIE));
    await db().update(hrEmployments).set({ archivedAt: new Date().toISOString() }).where(eq(hrEmployments.id, employee.employmentId));
    const response = await call("/api/hr/me/session", { headers: requestHeaders(deviceCookie) });
    expect(response.status).toBe(403);
    expect(cookieFrom(response, DEVICE_SESSION_COOKIE)).toContain("Max-Age=0");
    expect((await db().select().from(authDeviceSessions))[0]?.revokedAt).toBeTruthy();
    expect((await call("/api/hr/me/clock-events", { headers: requestHeaders(deviceCookie) })).status).toBe(401);
  });

  it("綁定到非在職員工的 LINE 身分不能換取 HR session", async () => {
    const user = await seedEmployee("line-inactive@ecotech.tw");
    await db().update(hrEmployments).set({ archivedAt: new Date().toISOString() }).where(eq(hrEmployments.id, user.employmentId));
    await linkLineAccount(db(), user.id, { channelId: CHANNEL_ID, lineUserId: "U-line-alice" });

    const response = await bootstrap("line-alice");
    expect(response.status).toBe(403);
    expect(cookieFrom(response, DEVICE_SESSION_COOKIE)).toContain("Max-Age=0");
    expect(await db().select().from(authDeviceSessions)).toHaveLength(0);
  });
});
