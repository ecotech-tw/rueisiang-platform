import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { users, userRoles } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTestD1, type TestD1 } from "./test-support/d1.js";

const SECRET = "test-secret";
let d1: TestD1;
let env: Record<string, unknown>;

async function seedUser(email: string, roleId: string, scope?: { type: string; id: string }) {
  const db = createDatabase(d1 as never);
  const id = `user-${email}`;
  await db.insert(users).values({ id, email, status: "active" });
  await db.insert(userRoles).values({
    userId: id,
    roleId,
    scopeType: scope?.type ?? "",
    scopeId: scope?.id ?? "",
  });
  return id;
}

async function sessionCookie(userId: string, email: string) {
  const token = await signSession(
    newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }),
    SECRET,
  );
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

function call(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`https://platform.rueisiang.com${path}`, init), env as never);
}

beforeEach(async () => {
  d1 = createTestD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  };
  await syncSystemRoles(createDatabase(d1 as never));
});

describe("/api/health", () => {
  it("會實際打一次 D1 確認綁定接上了", async () => {
    const response = await call("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", database: "ok" });
  });
});

describe("未登入", () => {
  it("沒有 cookie 就是 401", async () => {
    const response = await call("/api/auth/me");
    expect(response.status).toBe(401);
  });

  it.each([
    ["整段亂寫", "not-a-token"],
    ["有分隔點但簽章是假的", "eyJ1c2VySWQiOiJ4In0.fake-signature"],
    ["空字串", ""],
  ])("偽造的 cookie（%s）也是 401", async (_label, value) => {
    const response = await call("/api/auth/me", {
      headers: { Cookie: `${SESSION_COOKIE}=${value}` },
    });
    expect(response.status).toBe(401);
  });

  it("用別把 secret 簽的 session 不算數", async () => {
    const token = await signSession(
      newSessionClaims({ id: "user-x", email: "x@ecotech.tw", name: "", pictureUrl: "" }),
      "攻擊者自己的 secret",
    );
    const response = await call("/api/auth/me", {
      headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    });
    expect(response.status).toBe(401);
  });

  it("簽章有效但帳號不存在時是 401", async () => {
    const response = await call("/api/auth/me", {
      headers: { Cookie: await sessionCookie("user-鬼", "ghost@ecotech.tw") },
    });
    expect(response.status).toBe(401);
  });
});

describe("已登入", () => {
  it("管理者拿得到全部權限", async () => {
    const id = await seedUser("admin@ecotech.tw", "role-admin");
    const response = await call("/api/auth/me", {
      headers: { Cookie: await sessionCookie(id, "admin@ecotech.tw") },
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { email: string; permissions: string[] };
    expect(body.email).toBe("admin@ecotech.tw");
    expect(body.permissions).toContain("admin:user:write");
    expect(body.permissions).toContain("wms:inventory:count");
  });

  it("檢視者拿不到寫入權限", async () => {
    const id = await seedUser("viewer@ecotech.tw", "role-viewer");
    const response = await call("/api/auth/me", {
      headers: { Cookie: await sessionCookie(id, "viewer@ecotech.tw") },
    });

    const body = (await response.json()) as { permissions: string[] };
    expect(body.permissions).toContain("crm:customer:read");
    expect(body.permissions).not.toContain("crm:customer:write");
    expect(body.permissions).not.toContain("admin:user:write");
  });

  it("帶資料範圍的指派會原樣回報", async () => {
    const id = await seedUser("store@ecotech.tw", "role-staff", { type: "store", id: "誠品西門店3F" });
    const response = await call("/api/auth/me", {
      headers: { Cookie: await sessionCookie(id, "store@ecotech.tw") },
    });

    const body = (await response.json()) as { roles: { role: string; scopeType: string; scopeId: string }[] };
    expect(body.roles).toEqual([{ role: "staff", scopeType: "store", scopeId: "誠品西門店3F" }]);
  });

  it("停權後下一個請求就失效，不必等 session 過期", async () => {
    const id = await seedUser("bye@ecotech.tw", "role-admin");
    const cookie = await sessionCookie(id, "bye@ecotech.tw");
    expect((await call("/api/auth/me", { headers: { Cookie: cookie } })).status).toBe(200);

    // 同一個 cookie 仍然簽章有效，但帳號已經被停用。
    await createDatabase(d1 as never).update(users).set({ status: "disabled" }).where(eq(users.id, id));

    const response = await call("/api/auth/me", { headers: { Cookie: cookie } });
    expect(response.status).toBe(403);
  });

  it("調整角色也是下一個請求就生效", async () => {
    const id = await seedUser("promote@ecotech.tw", "role-viewer");
    const cookie = await sessionCookie(id, "promote@ecotech.tw");

    const before = (await (await call("/api/auth/me", { headers: { Cookie: cookie } })).json()) as {
      permissions: string[];
    };
    expect(before.permissions).not.toContain("admin:user:write");

    await createDatabase(d1 as never)
      .update(userRoles)
      .set({ roleId: "role-admin" })
      .where(eq(userRoles.userId, id));

    const after = (await (await call("/api/auth/me", { headers: { Cookie: cookie } })).json()) as {
      permissions: string[];
    };
    expect(after.permissions).toContain("admin:user:write");
  });
});

