import { DEVICE_SESSION_COOKIE, SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { eq } from "drizzle-orm";
import { createDatabase, findUserByLineIdentity, linkLineAccount, syncSystemRoles } from "@rueisiang/db";
import { authDeviceSessions, hrAttendanceLocations, hrClockEvents, hrEmployeeAttendanceLocations, hrEmployments, users } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

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

afterEach(() => vi.unstubAllGlobals());

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
    expect((await call("/api/hr/me/payroll-history", { headers: requestHeaders(deviceCookie) })).status).toBe(403);
    expect((await call("/api/hr/me/notifications", { headers: requestHeaders(deviceCookie) })).status).toBe(403);
    expect((await db().select().from(authDeviceSessions)).map((row) => row.authMethod)).toEqual(["line_liff"]);
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
    expect(await status.json()).toEqual({ linked: false, pending: true });

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
