import {
  DEVICE_SESSION_COOKIE,
  DEVICE_SESSION_IDLE_SECONDS,
  SESSION_COOKIE,
  can,
  clearCookie,
  readCookie,
  serializeCookie,
  serializeDeviceToken,
  verifySession,
  type DeviceToken,
  type Permission,
} from "@rueisiang/auth";
import { loadAuthUser, useDeviceSession } from "@rueisiang/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";

/**
 * 這是整個系統唯一真正把關的地方。
 *
 * 前端（sidebar 顯示哪些項目、按鈕出不出現）純粹是外觀——SPA 的 JavaScript
 * 全在使用者手上，藏起來的按鈕不是安全機制。任何會讀寫資料的路由都必須
 * 自己掛上 requireAuth / requirePermission，不能靠前端沒有提供入口。
 */
async function signInAs(c: Context<AppEnv>, userId: string): Promise<void> {
  // 每次請求都回資料庫重讀，不採信 cookie 內容：
  // 停權或調整權限才能即時生效，而不是等 session 過期。
  const user = await loadAuthUser(c.get("db"), { id: userId });
  if (!user) {
    throw new HTTPException(401, { message: "帳號不存在。" });
  }
  if (user.status !== "active") {
    throw new HTTPException(403, { message: "這個帳號已停用。" });
  }
  c.set("user", user);
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = readCookie(c.req.header("Cookie"), SESSION_COOKIE);
  const claims = await verifySession(token, c.env.AUTH_SESSION_SECRET);
  if (!claims) {
    throw new HTTPException(401, { message: "請先登入。" });
  }
  await signInAs(c, claims.userId);
  c.set("deviceSession", false);
  await next();
});

/**
 * 裝置 cookie 只送到這個路徑底下。
 *
 * 靠瀏覽器的 Path 規則而不是只靠 middleware：cookie 根本不會出現在後台 API 的請求裡，
 * 平台頁面也就不會因為「裝置認得、session 已過期」而顯示成已登入卻每個 API 都 401。
 */
export const DEVICE_COOKIE_PATH = "/api/hr/me";

/** 不帶 Domain：只有發 cookie 的 API 主機收得到，不跟著 `.rueisiang.com` 散出去。 */
export function deviceCookie(token: DeviceToken): string {
  return serializeCookie(DEVICE_SESSION_COOKIE, serializeDeviceToken(token), {
    maxAge: DEVICE_SESSION_IDLE_SECONDS,
    path: DEVICE_COOKIE_PATH,
  });
}

export function clearDeviceCookie(): string {
  return clearCookie(DEVICE_SESSION_COOKIE, DEVICE_COOKIE_PATH);
}

/**
 * 員工本人入口（`/api/hr/me/*`）用：「記住這台手機」或 12 小時 session 都認。
 *
 * 裝置優先，有在用才會一直延長；裝置失效但 session 還有效時退回 session，
 * 前端再從 `deviceRemembered: false` 知道要重新記住。
 */
export const requireSelfAuth = createMiddleware<AppEnv>(async (c, next) => {
  const device = await useDeviceSession(c.get("db"), readCookie(c.req.header("Cookie"), DEVICE_SESSION_COOKIE));
  if (device) {
    if (device.renewed) c.header("Set-Cookie", deviceCookie(device.renewed), { append: true });
    await signInAs(c, device.userId);
    c.set("deviceSession", true);
    return next();
  }
  return requireAuth(c, next);
});

/** 要求特定權限。 */
export function requirePermission(permission: Permission) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!can(c.get("user"), permission)) {
      throw new HTTPException(403, { message: "沒有這項操作的權限。" });
    }
    await next();
  });
}

/** 某些共用讀取路由由多個功能頁使用，只要具備其中一項讀取權限即可。 */
export function requireAnyPermission(...permissions: Permission[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!permissions.some((permission) => can(c.get("user"), permission))) {
      throw new HTTPException(403, { message: "沒有這項操作的權限。" });
    }
    await next();
  });
}
