import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { rolePermissions, userRoles, users } from "@rueisiang/db/schema";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "test-secret";
let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

async function seedUser(email: string, roleId: string | null, options: { status?: string } = {}) {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: options.status ?? "active" });
  if (roleId) await db().insert(userRoles).values({ userId: id, roleId });
  return id;
}

async function cookieFor(userId: string, email: string) {
  const token = await signSession(
    newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }),
    SECRET,
  );
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

function call(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`https://platform.rueisiang.com${path}`, init), env as never);
}

/** 以某個帳號的身分發請求。管理端點的測試幾乎都需要這個形狀。 */
async function as(userId: string, email: string, path: string, init: RequestInit = {}) {
  const cookie = await cookieFor(userId, email);
  return call(path, {
    ...init,
    headers: { Cookie: cookie, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

beforeEach(async () => {
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  };
  await syncSystemRoles(db());
});

describe("權限管理端點的把關", () => {
  it.each([
    ["GET", "/api/admin/users"],
    ["GET", "/api/admin/roles"],
    ["POST", "/api/admin/users"],
    ["PATCH", "/api/admin/users/user-x"],
    ["POST", "/api/admin/users/user-x/roles"],
    ["DELETE", "/api/admin/users/user-x/roles?roleKey=admin"],
  ])("未登入時 %s %s 是 401", async (method, path) => {
    const response = await call(path, { method });
    expect(response.status).toBe(401);
  });

  it.each([
    ["GET", "/api/admin/users", undefined],
    ["POST", "/api/admin/users", JSON.stringify({ email: "new@ecotech.tw" })],
    ["PATCH", "/api/admin/users/user-x", JSON.stringify({ status: "disabled" })],
    ["POST", "/api/admin/users/user-x/roles", JSON.stringify({ roleKey: "admin" })],
  ])("一般同仁直接打 %s %s 會被 403 擋下", async (method, path, payload) => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const response = await as(id, "staff@ecotech.tw", path, { method, body: payload });
    expect(response.status).toBe(403);
  });

  it("檢視者有 crm 讀取權限，但仍然進不了帳號列表", async () => {
    const id = await seedUser("viewer@ecotech.tw", "role-viewer");
    const response = await as(id, "viewer@ecotech.tw", "/api/admin/users");
    expect(response.status).toBe(403);
  });
});

describe("邀請帳號", () => {
  it("建立出來是 invited，還不能用", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const response = await as(admin, "admin@ecotech.tw", "/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ email: "New.Person@Ecotech.TW" }),
    });
    expect(response.status).toBe(201);

    const [row] = await db().select().from(users).where(eq(users.email, "new.person@ecotech.tw"));
    expect(row?.status).toBe("invited");
    expect(row?.invitedBy).toBe(admin);
  });

  it("同一個信箱不會被邀請兩次", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const payload = JSON.stringify({ email: "dup@ecotech.tw" });
    await as(admin, "admin@ecotech.tw", "/api/admin/users", { method: "POST", body: payload });

    const second = await as(admin, "admin@ecotech.tw", "/api/admin/users", { method: "POST", body: payload });
    expect(second.status).toBe(409);
  });

  it("可以在邀請的同時指定角色", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const response = await as(admin, "admin@ecotech.tw", "/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ email: "store@ecotech.tw", roleKey: "staff" }),
    });
    expect(response.status).toBe(201);

    const list = (await (await as(admin, "admin@ecotech.tw", "/api/admin/users")).json()) as {
      users: { email: string; assignments: { roleKey: string; roleName: string }[] }[];
    };
    const invited = list.users.find((user) => user.email === "store@ecotech.tw");
    expect(invited?.assignments).toEqual([{ roleKey: "staff", roleName: "一般同仁" }]);
  });

  it.each([
    ["信箱空白", { email: "  " }],
    ["信箱格式錯誤", { email: "not-an-email" }],
    ["角色不存在", { email: "x@ecotech.tw", roleKey: "superuser" }],
  ])("擋下不合法的輸入（%s）", async (_label, payload) => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const response = await as(admin, "admin@ecotech.tw", "/api/admin/users", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
  });
});

describe("最後一位管理者的保護", () => {
  it("只剩一位管理者時不能停用他", async () => {
    const admin = await seedUser("only@ecotech.tw", "role-admin");
    const response = await as(admin, "only@ecotech.tw", `/api/admin/users/${admin}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(response.status).toBe(409);

    const [row] = await db().select().from(users).where(eq(users.id, admin));
    expect(row?.status).toBe("active");
  });

  it("只剩一位管理者時也不能收回他的管理者角色", async () => {
    const admin = await seedUser("only@ecotech.tw", "role-admin");
    const response = await as(
      admin,
      "only@ecotech.tw",
      `/api/admin/users/${admin}/roles?roleKey=admin`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(409);
  });

  it("另一位管理者只是 invited（沒登入過）不算數", async () => {
    const admin = await seedUser("active@ecotech.tw", "role-admin");
    await seedUser("pending@ecotech.tw", "role-admin", { status: "invited" });

    const response = await as(admin, "active@ecotech.tw", `/api/admin/users/${admin}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(response.status).toBe(409);
  });

  it("還有別的可用管理者時就放行", async () => {
    const first = await seedUser("first@ecotech.tw", "role-admin");
    const second = await seedUser("second@ecotech.tw", "role-admin");

    const response = await as(first, "first@ecotech.tw", `/api/admin/users/${second}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(response.status).toBe(200);

    const [row] = await db().select().from(users).where(eq(users.id, second));
    expect(row?.status).toBe("disabled");
  });

  it("被停用的管理者，下一個請求就進不來", async () => {
    const first = await seedUser("first@ecotech.tw", "role-admin");
    const second = await seedUser("second@ecotech.tw", "role-admin");

    await as(first, "first@ecotech.tw", `/api/admin/users/${second}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "disabled" }),
    });

    const response = await as(second, "second@ecotech.tw", "/api/admin/users");
    expect(response.status).toBe(403);
  });
});

describe("角色指派", () => {
  it("同一個人可以同時有多個角色", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const target = await seedUser("multi@ecotech.tw", null);

    for (const roleKey of ["manager", "viewer"]) {
      const response = await as(admin, "admin@ecotech.tw", `/api/admin/users/${target}/roles`, {
        method: "POST",
        body: JSON.stringify({ roleKey }),
      });
      expect(response.status).toBe(201);
    }

    const rows = await db().select().from(userRoles).where(eq(userRoles.userId, target));
    expect(rows).toHaveLength(2);
  });

  it("重複指派同一組不會爆炸，也不會變成兩列", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const target = await seedUser("dup@ecotech.tw", null);
    const payload = JSON.stringify({ roleKey: "staff" });

    for (let i = 0; i < 2; i += 1) {
      const response = await as(admin, "admin@ecotech.tw", `/api/admin/users/${target}/roles`, {
        method: "POST",
        body: payload,
      });
      expect(response.status).toBe(201);
    }

    const rows = await db().select().from(userRoles).where(eq(userRoles.userId, target));
    expect(rows).toHaveLength(1);
  });

  it("收回不存在的指派回 404", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const target = await seedUser("nobody@ecotech.tw", null);

    const response = await as(
      admin,
      "admin@ecotech.tw",
      `/api/admin/users/${target}/roles?roleKey=staff`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(404);
  });

  it("收回之後那個人就沒有那個角色了", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const target = await seedUser("revoked@ecotech.tw", "role-staff");

    const response = await as(
      admin,
      "admin@ecotech.tw",
      `/api/admin/users/${target}/roles?roleKey=staff`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
    expect(await db().select().from(userRoles).where(eq(userRoles.userId, target))).toHaveLength(0);
  });

  it("調完權限，對方下一個請求就吃到新權限", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const target = await seedUser("promote@ecotech.tw", "role-viewer");

    const before = await as(target, "promote@ecotech.tw", "/api/admin/users");
    expect(before.status).toBe(403);

    await as(admin, "admin@ecotech.tw", `/api/admin/users/${target}/roles`, {
      method: "POST",
      body: JSON.stringify({ roleKey: "admin" }),
    });

    const after = await as(target, "promote@ecotech.tw", "/api/admin/users");
    expect(after.status).toBe(200);
  });
});

describe("角色目錄", () => {
  it("回傳角色與權限說明", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const response = await as(admin, "admin@ecotech.tw", "/api/admin/roles");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      roles: { key: string; name: string; isSystem: boolean; permissions: string[] }[];
      permissions: Record<string, string>;
    };

    expect(body.roles.map((role) => role.key).sort()).toEqual(["admin", "manager", "staff", "viewer"]);
    expect(body.roles.find((role) => role.key === "viewer")?.permissions).not.toContain("admin:user:write");
    expect(body.permissions["admin:user:write"]).toBe("邀請與停用帳號");
  });
});

describe("重新同步角色權限", () => {
  it("一般同仁打不到", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const response = await as(id, "staff@ecotech.tw", "/api/admin/roles/sync", { method: "POST" });
    expect(response.status).toBe(403);
  });

  it("把資料庫裡被亂改的權限修回程式碼定義的樣子", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");

    // 模擬有人直接動資料庫：多塞一筆不存在的權限，再刪掉一筆該有的。
    await db().insert(rolePermissions).values({ roleId: "role-viewer", permission: "crm:customer:write" });
    await db()
      .delete(rolePermissions)
      .where(
        and(eq(rolePermissions.roleId, "role-viewer"), eq(rolePermissions.permission, "crm:customer:read")),
      );

    const response = await as(admin, "admin@ecotech.tw", "/api/admin/roles/sync", { method: "POST" });
    expect(response.status).toBe(200);

    const viewer = await db().select().from(rolePermissions).where(eq(rolePermissions.roleId, "role-viewer"));
    const permissions = viewer.map((row) => row.permission);
    expect(permissions).toContain("crm:customer:read");
    expect(permissions).not.toContain("crm:customer:write");
  });

  it("同步完當場就影響授權判定", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const viewer = await seedUser("viewer@ecotech.tw", "role-viewer");

    // 把 admin:user:read 塞給檢視者，他就看得到帳號列表了。
    await db().insert(rolePermissions).values({ roleId: "role-viewer", permission: "admin:user:read" });
    expect((await as(viewer, "viewer@ecotech.tw", "/api/admin/users")).status).toBe(200);

    await as(admin, "admin@ecotech.tw", "/api/admin/roles/sync", { method: "POST" });

    // 同步之後那筆多出來的權限被清掉，下一個請求就擋下來。
    expect((await as(viewer, "viewer@ecotech.tw", "/api/admin/users")).status).toBe(403);
  });
});

describe("帳號狀態", () => {
  it("沒登入過的帳號不能被手動設成啟用", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const pending = await seedUser("pending@ecotech.tw", null, { status: "invited" });

    const response = await as(admin, "admin@ecotech.tw", `/api/admin/users/${pending}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });
    expect(response.status).toBe(409);
  });

  it("停用後可以再啟用", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const target = await seedUser("back@ecotech.tw", "role-staff", { status: "disabled" });

    const response = await as(admin, "admin@ecotech.tw", `/api/admin/users/${target}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });
    expect(response.status).toBe(200);
  });

  it("對不存在的帳號操作回 404", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const response = await as(admin, "admin@ecotech.tw", "/api/admin/users/user-不存在", {
      method: "PATCH",
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("自訂角色", () => {
  /** 使用者要的形狀：只能碰營運工具的角色。 */
  const OPS_ONLY = ["tools:payout:run", "tools:payout:config"];

  async function createOpsRole(adminId: string) {
    const response = await as(adminId, "admin@ecotech.tw", "/api/admin/roles", {
      method: "POST",
      body: JSON.stringify({ name: "出金表操作員", description: "只跑出金表", permissions: OPS_ONLY }),
    });
    const body = (await response.json()) as { roles: { key: string; name: string; permissions: string[] }[] };
    return { response, roles: body.roles };
  }

  it("建立之後帶著指定的權限出現在角色清單", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const { response, roles } = await createOpsRole(admin);

    expect(response.status).toBe(201);
    const created = roles.find((role) => role.name === "出金表操作員");
    expect(created?.permissions.sort()).toEqual([...OPS_ONLY].sort());
  });

  it("自訂角色排在系統角色後面", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const { roles } = await createOpsRole(admin);
    expect(roles.at(-1)?.name).toBe("出金表操作員");
  });

  it("拿到自訂角色的人只能用清單裡的權限", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const { roles } = await createOpsRole(admin);
    const roleKey = roles.find((role) => role.name === "出金表操作員")!.key;

    const staff = await seedUser("ops@ecotech.tw", null);
    await as(admin, "admin@ecotech.tw", `/api/admin/users/${staff}/roles`, {
      method: "POST",
      body: JSON.stringify({ roleKey }),
    });

    // 給了的：出金表看得到。
    expect((await as(staff, "ops@ecotech.tw", "/api/tools/payout/stores")).status).toBe(200);
    // 沒給的：客戶列表擋下來。
    expect((await as(staff, "ops@ecotech.tw", "/api/crm/customers")).status).toBe(403);
  });

  it("改權限之後立刻生效，不用等 session 過期", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const { roles } = await createOpsRole(admin);
    const roleKey = roles.find((role) => role.name === "出金表操作員")!.key;

    const staff = await seedUser("ops@ecotech.tw", null);
    await as(admin, "admin@ecotech.tw", `/api/admin/users/${staff}/roles`, {
      method: "POST",
      body: JSON.stringify({ roleKey }),
    });
    expect((await as(staff, "ops@ecotech.tw", "/api/crm/customers")).status).toBe(403);

    await as(admin, "admin@ecotech.tw", `/api/admin/roles/${roleKey}`, {
      method: "PATCH",
      body: JSON.stringify({ permissions: [...OPS_ONLY, "crm:customer:read"] }),
    });

    expect((await as(staff, "ops@ecotech.tw", "/api/crm/customers")).status).toBe(200);
  });

  it("改名字不會動到權限", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const { roles } = await createOpsRole(admin);
    const roleKey = roles.at(-1)!.key;

    const response = await as(admin, "admin@ecotech.tw", `/api/admin/roles/${roleKey}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "出金表專員" }),
    });
    const body = (await response.json()) as { roles: { key: string; name: string; permissions: string[] }[] };
    const updated = body.roles.find((role) => role.key === roleKey);

    expect(updated?.name).toBe("出金表專員");
    expect(updated?.permissions.sort()).toEqual([...OPS_ONLY].sort());
  });

  it("不存在的權限鍵值會被擋下來", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const response = await as(admin, "admin@ecotech.tw", "/api/admin/roles", {
      method: "POST",
      body: JSON.stringify({ name: "亂寫", permissions: ["crm:customer:destroy"] }),
    });

    expect(response.status).toBe(400);
    expect((await response.json() as { error?: string }).error).toContain("crm:customer:destroy");
  });

  it("刪除之後持有它的人也一起失去那些權限", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const { roles } = await createOpsRole(admin);
    const roleKey = roles.at(-1)!.key;

    const staff = await seedUser("ops@ecotech.tw", null);
    await as(admin, "admin@ecotech.tw", `/api/admin/users/${staff}/roles`, {
      method: "POST",
      body: JSON.stringify({ roleKey }),
    });
    expect((await as(staff, "ops@ecotech.tw", "/api/tools/payout/stores")).status).toBe(200);

    const response = await as(admin, "admin@ecotech.tw", `/api/admin/roles/${roleKey}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect((await as(staff, "ops@ecotech.tw", "/api/tools/payout/stores")).status).toBe(403);
  });

  it("角色清單帶著每個角色的持有人數", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const response = await as(admin, "admin@ecotech.tw", "/api/admin/roles");
    const body = (await response.json()) as { holders: Record<string, number> };
    expect(body.holders.admin).toBe(1);
  });

  it.each([
    ["PATCH", JSON.stringify({ name: "改名" })],
    ["DELETE", undefined],
  ])("系統角色擋下 %s", async (method, payload) => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const response = await as(admin, "admin@ecotech.tw", "/api/admin/roles/manager", {
      method,
      ...(payload ? { body: payload } : {}),
    });

    expect(response.status).toBe(400);
    expect((await response.json() as { error?: string }).error).toContain("系統角色");
  });

  it("重新同步不會洗掉自訂角色", async () => {
    const admin = await seedUser("admin@ecotech.tw", "role-admin");
    const { roles } = await createOpsRole(admin);
    const roleKey = roles.at(-1)!.key;

    await as(admin, "admin@ecotech.tw", "/api/admin/roles/sync", { method: "POST" });

    const after = (await (await as(admin, "admin@ecotech.tw", "/api/admin/roles")).json()) as {
      roles: { key: string; permissions: string[] }[];
    };
    expect(after.roles.find((role) => role.key === roleKey)?.permissions.sort()).toEqual(
      [...OPS_ONLY].sort(),
    );
  });

  it("一般同仁不能建角色", async () => {
    const staff = await seedUser("staff@ecotech.tw", "role-staff");
    const response = await as(staff, "staff@ecotech.tw", "/api/admin/roles", {
      method: "POST",
      body: JSON.stringify({ name: "自己加的", permissions: [] }),
    });
    expect(response.status).toBe(403);
  });
});
