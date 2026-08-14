import {
  SESSION_COOKIE,
  can,
  readCookie,
  verifySession,
  type Permission,
  type Scope,
} from "@rueisiang/auth";
import { loadAuthUser } from "@rueisiang/db";
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
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = readCookie(c.req.header("Cookie"), SESSION_COOKIE);
  const claims = await verifySession(token, c.env.AUTH_SESSION_SECRET);
  if (!claims) {
    throw new HTTPException(401, { message: "請先登入。" });
  }

  // 每次請求都回資料庫重讀，不採信 cookie 內容：
  // 停權或調整權限才能即時生效，而不是等 12 小時後 session 過期。
  const user = await loadAuthUser(c.get("db"), { id: claims.userId });
  if (!user) {
    throw new HTTPException(401, { message: "帳號不存在。" });
  }
  if (user.status !== "active") {
    throw new HTTPException(403, { message: "這個帳號已停用。" });
  }

  c.set("user", user);
  await next();
});

/**
 * 要求特定權限。scope 省略時代表「在任何範圍內有這個權限即可」，
 * 適用於列表類端點——實際能看到哪些資料由查詢層的 scope 過濾決定。
 */
export function requirePermission(permission: Permission, scope?: Scope) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!can(c.get("user"), permission, scope)) {
      throw new HTTPException(403, { message: "沒有這項操作的權限。" });
    }
    await next();
  });
}
