import { PERMISSIONS, type UserStatus } from "@rueisiang/auth";
import {
  assignRole,
  countOtherActiveAdmins,
  findUser,
  hasRole,
  inviteUser,
  listRoles,
  listUsers,
  revokeRole,
  setUserStatus,
  syncSystemRoles,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { body, requireString } from "../request.js";

const ADMIN_ROLE = "admin";

/**
 * 帳號與權限管理。
 *
 * 這裡的每一條都自己宣告需要的權限——前端有沒有把「權限管理」這一項畫出來
 * 完全不影響這裡，直接對端點發請求一樣會被擋下。
 */

/** 內部系統只收公司信箱以外也可能有的一般格式，所以只做最基本的形狀檢查。 */
function parseEmail(input: Record<string, unknown>): string {
  const email = requireString(input, "email", "電子信箱").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HTTPException(400, { message: "電子信箱格式不正確。" });
  }
  return email;
}

export const admin = new Hono<AppEnv>()
  .use("*", requireAuth)

  .get("/users", requirePermission("admin:user:read"), async (c) => {
    return c.json({ users: await listUsers(c.get("db")) });
  })

  /** 角色與權限目錄。權限的說明文字來自程式碼，資料庫只存「角色有哪些鍵值」。 */
  .get("/roles", requirePermission("admin:user:read"), async (c) => {
    return c.json({ roles: await listRoles(c.get("db")), permissions: PERMISSIONS });
  })

  /**
   * 把 permissions.ts 定義的角色權限重新寫進資料庫。改過那個檔案並部署之後跑一次。
   *
   * 這件事本來是靠一條用共用憑證保護的 /api/setup。系統有管理者之後就不需要了——
   * 誰能調權限本來就該由 RBAC 自己回答，不必再多一組要記得刪掉的 secret。
   */
  .post("/roles/sync", requirePermission("admin:role:write"), async (c) => {
    await syncSystemRoles(c.get("db"));
    return c.json({ roles: await listRoles(c.get("db")) });
  })

  /** 邀請。帳號建立時是 invited，對方用 Google 登入過才會變成 active。 */
  .post("/users", requirePermission("admin:user:write"), async (c) => {
    const input = await body(c);
    const email = parseEmail(input);

    const result = await inviteUser(c.get("db"), { email, invitedBy: c.get("user").id });
    if (result.kind === "duplicate") {
      throw new HTTPException(409, { message: "這個信箱已經在名單裡了。" });
    }

    // 邀請時可以順便給一個角色，省掉「先建帳號再回來指派」這一步。
    if (input.roleKey !== undefined) {
      const roleKey = requireString(input, "roleKey", "角色");
      const assigned = await assignRole(c.get("db"), {
        userId: result.id,
        roleKey,
        grantedBy: c.get("user").id,
      });
      if (assigned === "unknown-role") {
        throw new HTTPException(400, { message: `不認得的角色：${roleKey}` });
      }
    }

    return c.json({ id: result.id, email }, 201);
  })

  /**
   * 啟用／停用帳號。
   *
   * 沿用 CRM 的保護：不准停用最後一位管理者，否則沒有人能再進這一頁。
   * 這一條在 API 而不是前端——前端把按鈕藏起來擋不住直接打端點的人。
   */
  .patch("/users/:id", requirePermission("admin:user:write"), async (c) => {
    const input = await body(c);
    const status = input.status;
    if (status !== "active" && status !== "disabled") {
      throw new HTTPException(400, { message: "狀態只能是 active 或 disabled。" });
    }

    const id = c.req.param("id");
    const target = await findUser(c.get("db"), id);
    if (!target) throw new HTTPException(404, { message: "找不到這個帳號。" });

    if (status === "disabled" && target.status === "active" && (await hasRole(c.get("db"), id, ADMIN_ROLE))) {
      if ((await countOtherActiveAdmins(c.get("db"), id)) === 0) {
        throw new HTTPException(409, { message: "這是最後一位可用的管理者，不能停用。" });
      }
    }

    // invited 的帳號沒登入過，硬設成 active 只會讓列表顯示與事實不符。
    if (status === "active" && target.status === "invited") {
      throw new HTTPException(409, { message: "這個帳號還沒登入過，登入後會自動變成啟用。" });
    }

    await setUserStatus(c.get("db"), id, status as UserStatus);
    return c.json({ id, status });
  })

  .post("/users/:id/roles", requirePermission("admin:role:write"), async (c) => {
    const input = await body(c);
    const roleKey = requireString(input, "roleKey", "角色");

    const id = c.req.param("id");
    if (!(await findUser(c.get("db"), id))) {
      throw new HTTPException(404, { message: "找不到這個帳號。" });
    }

    const result = await assignRole(c.get("db"), {
      userId: id,
      roleKey,
      grantedBy: c.get("user").id,
    });
    if (result === "unknown-role") {
      throw new HTTPException(400, { message: `不認得的角色：${roleKey}` });
    }
    return c.json({ id, roleKey }, 201);
  })

  /**
   * 收回角色。用 query string 而不是 request body——DELETE 帶 body 在不少
   * HTTP 客戶端與快取層是未定義行為。
   */
  .delete("/users/:id/roles", requirePermission("admin:role:write"), async (c) => {
    const roleKey = c.req.query("roleKey");
    if (!roleKey) throw new HTTPException(400, { message: "請指定要收回的角色。" });

    const id = c.req.param("id");
    const target = await findUser(c.get("db"), id);
    if (!target) throw new HTTPException(404, { message: "找不到這個帳號。" });

    // 與停用同一條規則：收回最後一位管理者的 admin 角色等同於把自己鎖在門外。
    if (roleKey === ADMIN_ROLE && target.status === "active") {
      if ((await countOtherActiveAdmins(c.get("db"), id)) === 0) {
        throw new HTTPException(409, { message: "這是最後一位可用的管理者，不能收回管理者角色。" });
      }
    }

    const removed = await revokeRole(c.get("db"), { userId: id, roleKey });
    if (!removed) throw new HTTPException(404, { message: "找不到這一筆角色指派。" });
    return c.json({ ok: true });
  });
