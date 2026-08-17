import { createDatabase } from "@rueisiang/db";
import { roles, rolePermissions, userRoles, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTestD1, type TestD1 } from "./test-support/d1.js";

const TOKEN = "setup-token";
let d1: TestD1;

/** 這一組測試刻意每次自己組 env——重點就是「某個環境變數有沒有設」。 */
function envWith(overrides: Record<string, unknown> = {}) {
  return {
    DB: d1,
    AUTH_SESSION_SECRET: "test-secret",
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    ...overrides,
  };
}

function call(env: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("https://tools.rueisiang.com/api/setup", { method: "POST", headers }),
    env as never,
  );
}

beforeEach(() => {
  d1 = createTestD1();
});

describe("/api/setup", () => {
  it("沒設定 SETUP_TOKEN 時等同不存在", async () => {
    const response = await call(envWith(), { "X-Setup-Token": "anything" });
    expect(response.status).toBe(404);
  });

  it.each([
    ["完全沒帶", {}],
    ["帶錯的", { "X-Setup-Token": "wrong-token" }],
    ["長度一樣但內容不同", { "X-Setup-Token": "setup-tokeX" }],
  ])("憑證不對就進不去（%s）", async (_label, headers) => {
    const response = await call(envWith({ SETUP_TOKEN: TOKEN }), headers);
    expect(response.status).toBe(401);
  });

  it("把程式碼裡的角色與權限同步進空的資料庫", async () => {
    const response = await call(envWith({ SETUP_TOKEN: TOKEN }), { "X-Setup-Token": TOKEN });
    expect(response.status).toBe(200);

    const db = createDatabase(d1 as never);
    expect((await db.select().from(roles)).map((role) => role.key).sort()).toEqual([
      "admin",
      "manager",
      "staff",
      "viewer",
    ]);

    const adminPermissions = await db
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, "role-admin"));
    expect(adminPermissions.map((row) => row.permission)).toContain("admin:role:write");
  });

  it("設了 BOOTSTRAP_ADMIN_EMAIL 就建立第一位管理者", async () => {
    const env = envWith({ SETUP_TOKEN: TOKEN, BOOTSTRAP_ADMIN_EMAIL: "First@Ecotech.TW" });
    const response = await call(env, { "X-Setup-Token": TOKEN });
    expect(await response.json()).toMatchObject({ bootstrap: "created" });

    const db = createDatabase(d1 as never);
    const [user] = await db.select().from(users).where(eq(users.email, "first@ecotech.tw"));
    expect(user?.status).toBe("invited");

    const assignments = await db.select().from(userRoles).where(eq(userRoles.userId, user!.id));
    expect(assignments.map((row) => row.roleId)).toEqual(["role-admin"]);
  });

  it("重跑不會出事，也不會多出第二個管理者", async () => {
    const env = envWith({ SETUP_TOKEN: TOKEN, BOOTSTRAP_ADMIN_EMAIL: "first@ecotech.tw" });
    await call(env, { "X-Setup-Token": TOKEN });

    const second = await call(
      envWith({ SETUP_TOKEN: TOKEN, BOOTSTRAP_ADMIN_EMAIL: "someone.else@ecotech.tw" }),
      { "X-Setup-Token": TOKEN },
    );
    expect(await second.json()).toMatchObject({ bootstrap: "skipped" });

    const db = createDatabase(d1 as never);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(userRoles)).toHaveLength(1);
  });

  it("GET 不通——這是會寫資料的操作", async () => {
    const response = await app.fetch(
      new Request("https://tools.rueisiang.com/api/setup", {
        headers: { "X-Setup-Token": TOKEN },
      }),
      envWith({ SETUP_TOKEN: TOKEN }) as never,
    );
    expect(response.status).toBe(404);
  });
});
