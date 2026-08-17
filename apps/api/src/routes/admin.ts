import { GLOBAL_SCOPE, PERMISSIONS, SCOPE_TYPES, type UserStatus } from "@rueisiang/auth";
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
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

const ADMIN_ROLE = "admin";

/**
 * 帳號與權限管理。
 *
 * 這裡的每一條都自己宣告需要的權限——前端有沒有把「權限管理」這一項畫出來
 * 完全不影響這裡，直接對端點發請求一樣會被擋下。
 */

/** 收下來的 JSON 一律當成不可信輸入。等 Phase 2 有真正複雜的 payload 再引入 zod。 */
async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HTTPException(400, { message: "請求內容格式不正確。" });
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: "請求內容不是有效的 JSON。" });
  }
}

function requireString(input: Record<string, unknown>, field: string, label: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new HTTPException(400, { message: `請填寫${label}。` });
  }
  return value.trim();
}

/** 內部系統只收公司信箱以外也可能有的一般格式，所以只做最基本的形狀檢查。 */
function parseEmail(input: Record<string, unknown>): string {
  const email = requireString(input, "email", "電子信箱").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HTTPException(400, { message: "電子信箱格式不正確。" });
  }
  return email;
}

/**
 * 資料範圍：兩個欄位要嘛都空（全域），要嘛都有值。
 * 只填一半代表呼叫端搞錯了，與其猜意圖不如直接擋下來。
 */
function parseScope(source: { scopeType?: unknown; scopeId?: unknown }): {
  scopeType: string;
  scopeId: string;
} {
  const scopeType = typeof source.scopeType === "string" ? source.scopeType.trim() : "";
  const scopeId = typeof source.scopeId === "string" ? source.scopeId.trim() : "";

  if (!scopeType && !scopeId) return { scopeType: GLOBAL_SCOPE, scopeId: GLOBAL_SCOPE };
  if (!scopeType || !scopeId) {
    throw new HTTPException(400, { message: "資料範圍的種類與名稱要一起填寫。" });
  }
  if (!(SCOPE_TYPES as readonly string[]).includes(scopeType)) {
    throw new HTTPException(400, { message: `不認得的資料範圍種類：${scopeType}` });
  }
  return { scopeType, scopeId };
}

export const admin = new Hono<AppEnv>()
  .use("*", requireAuth)

  .get("/users", requirePermission("admin:user:read"), async (c) => {
    return c.json({ users: await listUsers(c.get("db")) });
  })

  /** 角色與權限目錄。權限的說明文字來自程式碼，資料庫只存「角色有哪些鍵值」。 */
  .get("/roles", requirePermission("admin:user:read"), async (c) => {
    return c.json({
      roles: await listRoles(c.get("db")),
      permissions: PERMISSIONS,
      scopeTypes: SCOPE_TYPES,
    });
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
      const scope = parseScope(input);
      const assigned = await assignRole(c.get("db"), {
        userId: result.id,
        roleKey,
        ...scope,
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
    const scope = parseScope(input);

    const id = c.req.param("id");
    if (!(await findUser(c.get("db"), id))) {
      throw new HTTPException(404, { message: "找不到這個帳號。" });
    }

    const result = await assignRole(c.get("db"), {
      userId: id,
      roleKey,
      ...scope,
      grantedBy: c.get("user").id,
    });
    if (result === "unknown-role") {
      throw new HTTPException(400, { message: `不認得的角色：${roleKey}` });
    }
    return c.json({ id, roleKey, ...scope }, 201);
  })

  /**
   * 收回角色。用 query string 而不是 request body——DELETE 帶 body 在不少
   * HTTP 客戶端與快取層是未定義行為。
   */
  .delete("/users/:id/roles", requirePermission("admin:role:write"), async (c) => {
    const roleKey = c.req.query("roleKey");
    if (!roleKey) throw new HTTPException(400, { message: "請指定要收回的角色。" });
    const scope = parseScope({ scopeType: c.req.query("scopeType"), scopeId: c.req.query("scopeId") });

    const id = c.req.param("id");
    const target = await findUser(c.get("db"), id);
    if (!target) throw new HTTPException(404, { message: "找不到這個帳號。" });

    // 與停用同一條規則：收回最後一位管理者的 admin 角色等同於把自己鎖在門外。
    if (roleKey === ADMIN_ROLE && target.status === "active") {
      if ((await countOtherActiveAdmins(c.get("db"), id)) === 0) {
        throw new HTTPException(409, { message: "這是最後一位可用的管理者，不能收回管理者角色。" });
      }
    }

    const removed = await revokeRole(c.get("db"), { userId: id, roleKey, ...scope });
    if (!removed) throw new HTTPException(404, { message: "找不到這一筆角色指派。" });
    return c.json({ ok: true });
  });
