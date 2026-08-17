import { ensureBootstrapAdmin, syncSystemRoles } from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";

/**
 * 部署後的初始化。做兩件事，都是冪等的：
 *   1. 把 permissions.ts 定義的角色與權限同步進資料庫
 *   2. 系統完全沒有管理者時，建立第一位
 *
 * 為什麼需要這條路由：全新的 D1 只有 migration 建出來的空表，roles 是空的、
 * users 也是空的——沒有人拿得到任何權限，也沒有人能登入去邀請別人。
 * 這是先有雞還是先有蛋的問題，只能從資料庫外面打破。
 *
 * 為什麼用 token 而不是登入權限：能呼叫這條的時候，還沒有任何帳號可以登入。
 * SETUP_TOKEN 沒設定就等於這條路由不存在，正式環境跑完第一次之後可以直接刪掉
 * 那個 secret；之後改了 permissions.ts 要重新同步時再設回來。
 */

/** 逐字元比對到底，不因為第一個位元組就提早回傳。 */
function tokenMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export const setup = new Hono<AppEnv>().post("/", async (c) => {
  const expected = c.env.SETUP_TOKEN;
  // 沒設定就當作這條路由不存在，不要洩漏「這裡有個初始化端點」。
  if (!expected) throw new HTTPException(404, { message: "Not found" });

  const provided = c.req.header("X-Setup-Token") ?? "";
  if (!tokenMatches(provided, expected)) {
    throw new HTTPException(401, { message: "初始化憑證不正確。" });
  }

  await syncSystemRoles(c.get("db"));

  const email = c.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  const bootstrap = email ? await ensureBootstrapAdmin(c.get("db"), email) : "skipped";

  return c.json({ roles: "synced", bootstrap });
});
