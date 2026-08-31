import { PERMISSIONS, type UserStatus } from "@rueisiang/auth";
import {
  assignRole,
  countOtherActiveAdmins,
  countRoleHolders,
  createRole,
  deleteRole,
  deleteUser,
  findUser,
  grantPermission,
  hasRole,
  inviteUser,
  listDirectPermissions,
  listRoles,
  listUsers,
  regenerateInvitation,
  revokePermission,
  revokeRole,
  setUserStatus,
  seedPayoutStores,
  syncSystemRoles,
  updateRole,
  type RoleWriteResult,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { body, optionalStringArray, requireString } from "../request.js";

const ADMIN_ROLE = "admin";

/**
 * 不准調整自己的角色與權限。
 *
 * 沒有這道守衛，任何拿到 admin:role:write 的人都能直接給自己 admin:*——
 * 那等於「能改權限」就自動等於「是管理者」，RBAC 的分層就沒有意義了。
 * 要升級自己的權限，得由另一個管理者動手，這樣至少有兩個人知道這件事發生過。
 *
 * 這條擋在 API 而不是前端：把按鈕變灰擋不住直接打端點的人。
 */
function refuseSelfEdit(c: { get: (key: "user") => { id: string } }, targetId: string): void {
  if (c.get("user").id === targetId) {
    throw new HTTPException(409, {
      message: "不能調整自己的角色與權限。請由另一位管理者操作。",
    });
  }
}

/**
 * 邀請連結的完整網址。從請求本身推導 origin 而不是要人維護一個環境變數——
 * 手寫的變數會忘記加 https://、會在綁自訂網域之後過期，而請求的 host 永遠是
 * 對方現在真的打得到的位置。
 */
function inviteUrl(requestUrl: string, token: string): string {
  return new URL(`/invite/${encodeURIComponent(token)}`, requestUrl).toString();
}

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

/** 角色寫入的失敗情形都對應到一個 HTTP 狀態碼，路由那邊就不必每條各寫一次。 */
function throwOnRoleWriteFailure(result: RoleWriteResult): void {
  switch (result.kind) {
    case "ok":
      return;
    case "not-found":
      throw new HTTPException(404, { message: "找不到這個角色。" });
    case "protected-role":
      throw new HTTPException(400, { message: "管理員角色受系統保護，不能修改或刪除。" });
    case "system-role":
      throw new HTTPException(400, {
        message: "系統內建角色不能刪除；除了管理員角色外，都可以直接調整。",
      });
    case "unknown-permission":
      throw new HTTPException(400, { message: `沒有這個權限：${result.permission}` });
  }
}

export const admin = new Hono<AppEnv>()
  .use("*", requireAuth)

  .get("/users", requirePermission("admin:user:read"), async (c) => {
    return c.json({
      users: await listUsers(c.get("db")),
      // 直接授予的權限。畫面要分得出「這個權限是角色帶來的」還是「單獨給的」。
      directPermissions: await listDirectPermissions(c.get("db")),
    });
  })

  /** 角色與權限目錄。權限的說明文字來自程式碼，資料庫只存「角色有哪些鍵值」。 */
  .get("/roles", requirePermission("admin:user:read"), async (c) => {
    return c.json({
      roles: await listRoles(c.get("db")),
      permissions: PERMISSIONS,
      // 帶上「每個角色幾個人在用」，刪除前的確認訊息才講得出數字。
      holders: await countRoleHolders(c.get("db")),
    });
  })

  /**
   * 建立缺少的系統角色並校正管理員角色。非管理員系統角色的現有設定會保留，
   * 讓管理者在 UI 調整的權限不會因為按同步而被覆蓋。
   *
   * 這件事本來是靠一條用共用憑證保護的 /api/setup。系統有管理者之後就不需要了——
   * 誰能調權限本來就該由 RBAC 自己回答，不必再多一組要記得刪掉的 secret。
   *
   * 兩者的語意刻意不同：角色同步只負責初始角色與管理員保護；出金表的店別是
   * 同仁自己維護的資料，只在完全空的時候塞一份起始清單，之後絕不覆蓋。
   */
  .post("/roles/sync", requirePermission("admin:role:write"), async (c) => {
    await syncSystemRoles(c.get("db"));
    await seedPayoutStores(c.get("db"));
    return c.json({ roles: await listRoles(c.get("db")) });
  })

  /**
   * ── 角色維護 ────────────────────────────────────────────────────────────
   *
   * 非管理員的系統角色可以直接調整；管理員角色維持不可修改、不可刪除。
   * 所有系統角色都保留不可刪除的保護，避免指派中的固定角色被意外移除。
   */
  .post("/roles", requirePermission("admin:role:write"), async (c) => {
    const input = await body(c);
    const result = await createRole(c.get("db"), {
      name: requireString(input, "name", "角色名稱"),
      description: typeof input.description === "string" ? input.description : "",
      permissions: optionalStringArray(input, "permissions", "權限清單") ?? [],
    });
    throwOnRoleWriteFailure(result);
    return c.json({ roles: await listRoles(c.get("db")) }, 201);
  })

  .patch("/roles/:key", requirePermission("admin:role:write"), async (c) => {
    const input = await body(c);
    const result = await updateRole(c.get("db"), c.req.param("key"), {
      // 三個欄位都可以單獨送。沒帶的欄位代表「這次不動它」，不是清空。
      ...(input.name !== undefined ? { name: requireString(input, "name", "角色名稱") } : {}),
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      ...(() => {
        const permissions = optionalStringArray(input, "permissions", "權限清單");
        return permissions ? { permissions } : {};
      })(),
    });
    throwOnRoleWriteFailure(result);
    return c.json({ roles: await listRoles(c.get("db")) });
  })

  .delete("/roles/:key", requirePermission("admin:role:write"), async (c) => {
    const result = await deleteRole(c.get("db"), c.req.param("key"));
    throwOnRoleWriteFailure(result);
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

    return c.json({ id: result.id, email, inviteUrl: inviteUrl(c.req.url, result.token) }, 201);
  })

  /**
   * 重發邀請連結。舊的立刻失效。
   *
   * 連結只在建立的當下拿得到一次（DB 只存雜湊），所以「弄丟了」的解法是重發，
   * 不是去資料庫翻。已經啟用的帳號不給重發：那條連結能設一組新密碼，
   * 等於一個不必驗證就能改密碼的後門。
   */
  .post("/users/:id/invite", requirePermission("admin:user:write"), async (c) => {
    const result = await regenerateInvitation(c.get("db"), c.req.param("id"));
    if (result.kind === "not-found") throw new HTTPException(404, { message: "找不到這個帳號。" });
    if (result.kind === "already-active") {
      throw new HTTPException(409, { message: "這個帳號已經啟用，不需要邀請連結。" });
    }
    return c.json({ inviteUrl: inviteUrl(c.req.url, result.token) });
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

  /**
   * 刪除帳號。**啟用中的不能刪**，已停用與還沒登入過的都可以，而且不能刪自己。
   *
   * 「先停用再刪」是刻意的兩步：停用可逆、刪除不可逆，中間那一步就是確認。
   * 不能刪自己則是為了避免一個很蠢但會發生的情境——刪完之後才想起來自己是
   * 唯一的管理者。（實際上停用最後一位管理者已經被擋，所以自己不可能是停用
   * 狀態；這條是保險，不是主要防線。）
   */
  .delete("/users/:id", requirePermission("admin:user:write"), async (c) => {
    const id = c.req.param("id");
    if (id === c.get("user").id) {
      throw new HTTPException(409, { message: "不能刪除自己的帳號。" });
    }

    const result = await deleteUser(c.get("db"), id);
    if (result === "not-found") throw new HTTPException(404, { message: "找不到這個帳號。" });
    if (result === "still-active") {
      throw new HTTPException(409, { message: "啟用中的帳號不能直接刪除。請先停用再刪。" });
    }
    return c.json({ id });
  })

  /**
   * 直接授予單一權限，繞過角色。
   *
   * 為什麼要有：實務上一定會出現例外——陳美玲是一般同仁，但這個月要幫忙跑
   * 出金表。為了一個人開一個新角色，角色清單很快就會長出十幾個只有一個人在用
   * 的東西，而那才是真正沒人看得懂「誰能做什麼」的開始。
   */
  .post("/users/:id/permissions", requirePermission("admin:role:write"), async (c) => {
    const id = c.req.param("id");
    refuseSelfEdit(c, id);
    if (!(await findUser(c.get("db"), id))) {
      throw new HTTPException(404, { message: "找不到這個帳號。" });
    }

    const input = await body(c);
    const permission = requireString(input, "permission", "權限");
    const result = await grantPermission(c.get("db"), {
      userId: id,
      permission,
      grantedBy: c.get("user").id,
    });
    if (result === "unknown-permission") {
      throw new HTTPException(400, { message: `沒有這個權限：${permission}` });
    }
    return c.json({ id, permission }, 201);
  })

  /** 收回直接授予。角色帶來的那一份收不回來，只能改角色。 */
  .delete("/users/:id/permissions", requirePermission("admin:role:write"), async (c) => {
    const id = c.req.param("id");
    refuseSelfEdit(c, id);
    const permission = c.req.query("permission");
    if (!permission) throw new HTTPException(400, { message: "請指定要收回的權限。" });

    const removed = await revokePermission(c.get("db"), { userId: id, permission });
    if (!removed) {
      throw new HTTPException(404, {
        message: "這個人沒有被單獨授予這項權限。如果他仍然做得到，代表權限來自角色。",
      });
    }
    return c.json({ id, permission });
  })

  .post("/users/:id/roles", requirePermission("admin:role:write"), async (c) => {
    const input = await body(c);
    const roleKey = requireString(input, "roleKey", "角色");

    const id = c.req.param("id");
    refuseSelfEdit(c, id);
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
    refuseSelfEdit(c, id);
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
