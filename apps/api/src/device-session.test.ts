import { DEVICE_SESSION_COOKIE, SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, createDeviceSession, setUserStatus, syncSystemRoles, useDeviceSession } from "@rueisiang/db";
import { authDeviceSessions, users } from "@rueisiang/db/schema";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "test-secret";
const HR_ORIGIN = "https://hr.rueisiang.com";
const HOUR = 60 * 60 * 1000;
let d1: LocalD1;
let env: Record<string, unknown>;

const db = () => createDatabase(d1 as never);

async function seedUser(email: string) {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: "active" });
  return id;
}

async function sessionCookie(userId: string, email: string) {
  const token = await signSession(newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }), SECRET);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

function call(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`https://platform.rueisiang.com${path}`, init), env as never);
}

/** Worker 的 Headers 型別沒有 getSetCookie；多個 Set-Cookie 會被 get 用逗號接起來，我們不發 Expires，所以逗號切得開。 */
function setCookies(response: Response): string[] {
  return (response.headers.get("Set-Cookie") ?? "").split(/,\s*(?=[\w-]+=)/).filter(Boolean);
}

function deviceSetCookie(response: Response) {
  return setCookies(response).find((value) => value.startsWith(`${DEVICE_SESSION_COOKIE}=`));
}

/** 從 Set-Cookie 取出瀏覽器下次會帶回來的 `name=value`。 */
function asCookie(setCookie: string | undefined) {
  if (!setCookie) throw new Error("回應沒有發裝置 cookie。");
  return setCookie.split(";")[0]!;
}

async function rememberDevice(userId: string, email: string) {
  const response = await call("/api/hr/me/device", {
    method: "POST",
    headers: { Cookie: await sessionCookie(userId, email), Origin: HR_ORIGIN },
  });
  expect(response.status).toBe(201);
  return asCookie(deviceSetCookie(response));
}

beforeEach(async () => {
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    AUTH_COOKIE_DOMAIN: ".rueisiang.com",
    AUTH_APP_ORIGINS: `https://platform.rueisiang.com,${HR_ORIGIN}`,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  };
  await syncSystemRoles(db());
});

describe("HR app 記住這台手機", () => {
  it("用 session 記住之後，只帶裝置 cookie 也進得了本人入口", async () => {
    const id = await seedUser("phone@ecotech.tw");
    const response = await call("/api/hr/me/device", {
      method: "POST",
      headers: { Cookie: await sessionCookie(id, "phone@ecotech.tw"), Origin: HR_ORIGIN },
    });
    const setCookie = deviceSetCookie(response);
    // 只送到本人入口、只給 API 主機，不跟著 .rueisiang.com 散出去。
    expect(setCookie).toContain("Path=/api/hr/me;");
    expect(setCookie).not.toContain("Domain=");

    const session = await call("/api/hr/me/session", { headers: { Cookie: asCookie(setCookie), Origin: HR_ORIGIN } });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ id, deviceRemembered: true });
  });

  it("只有 session 時回報還沒記住，前端才知道要補發", async () => {
    const id = await seedUser("fresh@ecotech.tw");
    const session = await call("/api/hr/me/session", { headers: { Cookie: await sessionCookie(id, "fresh@ecotech.tw") } });
    expect(await session.json()).toMatchObject({ deviceRemembered: false });
  });

  it("裝置 cookie 開不了本人入口以外的 API", async () => {
    const id = await seedUser("lost@ecotech.tw");
    const cookie = await rememberDevice(id, "lost@ecotech.tw");
    expect((await call("/api/auth/me", { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await call("/api/hr/overview", { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await call("/api/hr/employees", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("裝置 cookie 不能替自己再發一台", async () => {
    const id = await seedUser("clone@ecotech.tw");
    const cookie = await rememberDevice(id, "clone@ecotech.tw");
    const response = await call("/api/hr/me/device", { method: "POST", headers: { Cookie: cookie, Origin: HR_ORIGIN } });
    expect(response.status).toBe(200);
    expect(deviceSetCookie(response)).toBeUndefined();
    expect(await db().select().from(authDeviceSessions)).toHaveLength(1);
  });

  it("帶裝置 cookie 的寫入請求也要有來源", async () => {
    const id = await seedUser("csrf-device@ecotech.tw");
    const cookie = await rememberDevice(id, "csrf-device@ecotech.tw");
    const response = await call("/api/hr/me/device", { method: "DELETE", headers: { Cookie: cookie } });
    expect(response.status).toBe(403);
  });

  it("登出會撤銷這台，也清掉 session", async () => {
    const id = await seedUser("bye@ecotech.tw");
    const cookie = await rememberDevice(id, "bye@ecotech.tw");
    const response = await call("/api/hr/me/device", { method: "DELETE", headers: { Cookie: cookie, Origin: HR_ORIGIN } });
    expect(response.status).toBe(200);
    expect(setCookies(response).some((value) => value.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);
    expect((await call("/api/hr/me/session", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("停權當下擋住，重新啟用後舊手機也不會復活", async () => {
    const id = await seedUser("off@ecotech.tw");
    const cookie = await rememberDevice(id, "off@ecotech.tw");
    await setUserStatus(db(), id, "disabled");
    expect((await call("/api/hr/me/session", { headers: { Cookie: cookie } })).status).toBe(401);
    await setUserStatus(db(), id, "active");
    expect((await call("/api/hr/me/session", { headers: { Cookie: cookie } })).status).toBe(401);
  });
});

describe("裝置 token 的延長與輪替", () => {
  const raw = (token: { id: string; secret: string }) => `${token.id}.${token.secret}`;

  it("一天內不換值；閒置超過七天就失效", async () => {
    const id = await seedUser("idle@ecotech.tw");
    const start = new Date("2026-09-01T00:00:00Z");
    const token = await createDeviceSession(db(), id, "", start);
    expect(await useDeviceSession(db(), raw(token), new Date(start.getTime() + 12 * HOUR))).toEqual({ userId: id, renewed: null });
    expect(await useDeviceSession(db(), raw(token), new Date(start.getTime() + 8 * 24 * HOUR))).toBeNull();
  });

  it("每天用就一直延長，不會在第七天被登出", async () => {
    const id = await seedUser("daily@ecotech.tw");
    let now = new Date("2026-09-01T00:00:00Z");
    let current = await createDeviceSession(db(), id, "", now);
    for (let day = 0; day < 30; day += 1) {
      now = new Date(now.getTime() + 25 * HOUR);
      const used = await useDeviceSession(db(), raw(current), now);
      expect(used?.renewed).toBeTruthy();
      current = used!.renewed!;
    }
  });

  it("換值後舊值在緩衝內還能用；超過緩衝拿舊值來就整台撤銷", async () => {
    const id = await seedUser("stolen@ecotech.tw");
    const start = new Date("2026-09-01T00:00:00Z");
    const original = await createDeviceSession(db(), id, "", start);
    const rotatedAt = new Date(start.getTime() + 25 * HOUR);

    const rotated = await useDeviceSession(db(), raw(original), rotatedAt);
    expect(rotated?.renewed).toBeTruthy();
    // 同一頁同時發出的請求：第二個不應該再換一次，也不應該被踢掉。
    expect(await useDeviceSession(db(), raw(original), new Date(rotatedAt.getTime() + 30_000))).toEqual({ userId: id, renewed: null });

    expect(await useDeviceSession(db(), raw(original), new Date(rotatedAt.getTime() + 10 * 60_000))).toBeNull();
    expect(await useDeviceSession(db(), raw(rotated!.renewed!), new Date(rotatedAt.getTime() + 11 * 60_000))).toBeNull();
  });

  it("格式不對或猜錯 secret 都不算數", async () => {
    const id = await seedUser("guess@ecotech.tw");
    const token = await createDeviceSession(db(), id, "");
    expect(await useDeviceSession(db(), "no-dot")).toBeNull();
    expect(await useDeviceSession(db(), `${token.id}.wrong`)).toBeNull();
  });
});
