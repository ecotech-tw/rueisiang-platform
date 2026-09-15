import { SESSION_COOKIE, newSessionClaims, readCookie, signSession, verifyPayload } from "@rueisiang/auth";
import { createDatabase, recordLogin, syncSystemRoles } from "@rueisiang/db";
import { users, userRoleAssignments } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "test-secret";
let d1: LocalD1;
let env: Record<string, unknown>;

async function seedUser(email: string, roleId: string) {
  const db = createDatabase(d1 as never);
  const id = `user-${email}`;
  await db.insert(users).values({ id, email, status: "active" });
  await db.insert(userRoleAssignments).values({ userId: id, roleId });
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
  d1 = createLocalD1();
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

  it("允許 HR app 的跨來源預檢請求", async () => {
    const response = await call("/api/auth/me", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5176",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5176");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("拒絕未列入設定的跨來源請求", async () => {
    const response = await call("/api/auth/me", {
      headers: { Origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });

  it("正式環境的 session 寫入請求必須帶來源", async () => {
    env = {
      ...env,
      AUTH_COOKIE_DOMAIN: ".rueisiang.com",
      AUTH_APP_ORIGINS: "https://platform.rueisiang.com,https://hr.rueisiang.com",
    };
    const response = await call("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: await sessionCookie("user-csrf", "csrf@ecotech.tw") },
    });
    expect(response.status).toBe(403);
  });

  it("OAuth returnTo 會拒絕瀏覽器可正規化成外部網址的反斜線路徑", async () => {
    const response = await call(`/api/auth/google/start?returnTo=${encodeURIComponent("/\\\\evil")}`);
    const transaction = await verifyPayload<{ returnTo: string; expiresAt: number }>(
      readCookie(response.headers.get("Set-Cookie"), "rueisiang_oauth"),
      SECRET,
    );
    expect(response.status).toBe(302);
    expect(transaction?.returnTo).toBe("/");
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

    const body = (await response.json()) as { email: string; permissions: string[]; isHrAdministrator: boolean };
    expect(body.email).toBe("admin@ecotech.tw");
    expect(body.isHrAdministrator).toBe(true);
    expect(body.permissions).toContain("admin:user:write");
    expect(body.permissions).toContain("wms:inventory:count");
  });

  it("檢視者拿不到寫入權限", async () => {
    const id = await seedUser("viewer@ecotech.tw", "role-viewer");
    const response = await call("/api/auth/me", {
      headers: { Cookie: await sessionCookie(id, "viewer@ecotech.tw") },
    });

    const body = (await response.json()) as { permissions: string[]; isHrAdministrator: boolean };
    expect(body.isHrAdministrator).toBe(false);
    expect(body.permissions).toContain("crm:customer:read");
    expect(body.permissions).not.toContain("crm:customer:write");
    expect(body.permissions).not.toContain("admin:user:write");
  });

  it("角色以鍵值回報，前端據此顯示身分", async () => {
    const id = await seedUser("store@ecotech.tw", "role-staff");
    const response = await call("/api/auth/me", {
      headers: { Cookie: await sessionCookie(id, "store@ecotech.tw") },
    });

    const body = (await response.json()) as { roles: string[] };
    expect(body.roles).toEqual(["staff"]);
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
      .update(userRoleAssignments)
      .set({ roleId: "role-admin" })
      .where(eq(userRoleAssignments.userId, id));

    const after = (await (await call("/api/auth/me", { headers: { Cookie: cookie } })).json()) as {
      permissions: string[];
    };
    expect(after.permissions).toContain("admin:user:write");
  });
});

describe("個人資料", () => {
  async function patch(userId: string, email: string, body: string) {
    return call("/api/auth/profile", {
      method: "PATCH",
      headers: { Cookie: await sessionCookie(userId, email), "Content-Type": "application/json" },
      body,
    });
  }

  it("未登入不能改", async () => {
    const response = await call("/api/auth/profile", {
      method: "PATCH",
      body: JSON.stringify({ displayName: "駭客" }),
    });
    expect(response.status).toBe(401);
  });

  it("設定顯示名稱之後，/me 回傳的就是它", async () => {
    const id = await seedUser("who@ecotech.tw", "role-staff");
    await createDatabase(d1 as never).update(users).set({ googleName: "Google 上的姓名" }).where(eq(users.id, id));

    expect((await patch(id, "who@ecotech.tw", JSON.stringify({ displayName: "  小林  " }))).status).toBe(200);

    const me = (await (
      await call("/api/auth/me", { headers: { Cookie: await sessionCookie(id, "who@ecotech.tw") } })
    ).json()) as { name: string; googleName: string; email: string };
    expect(me.name).toBe("小林");
    // Google 那邊的姓名要原封不動留著，個人資料頁靠它顯示「你原本叫什麼」。
    expect(me.googleName).toBe("Google 上的姓名");
    expect(me.email).toBe("who@ecotech.tw");
  });

  it("清空就退回 Google 帳號上的姓名", async () => {
    const id = await seedUser("back@ecotech.tw", "role-staff");
    await createDatabase(d1 as never).update(users).set({ googleName: "Google 姓名" }).where(eq(users.id, id));

    await patch(id, "back@ecotech.tw", JSON.stringify({ displayName: "暫時的" }));
    await patch(id, "back@ecotech.tw", JSON.stringify({ displayName: "" }));

    const me = (await (
      await call("/api/auth/me", { headers: { Cookie: await sessionCookie(id, "back@ecotech.tw") } })
    ).json()) as { name: string };
    expect(me.name).toBe("Google 姓名");
  });

  it("下次 Google 登入不會蓋掉自己設的名字", async () => {
    const db = createDatabase(d1 as never);
    const id = await seedUser("keep@ecotech.tw", "role-staff");
    await patch(id, "keep@ecotech.tw", JSON.stringify({ displayName: "我自己取的" }));

    // 模擬再登入一次：recordLogin 會覆寫 Google 那邊的姓名與頭像。
    await recordLogin(db, id, { googleSubject: "sub-1", name: "Google 姓名", pictureUrl: "https://x/y.png" });

    const me = (await (
      await call("/api/auth/me", { headers: { Cookie: await sessionCookie(id, "keep@ecotech.tw") } })
    ).json()) as { name: string; pictureUrl: string };
    expect(me.name).toBe("我自己取的");
    expect(me.pictureUrl).toBe("https://x/y.png");
  });

  it("改名字動不到 email——授權與紀錄都認它", async () => {
    const id = await seedUser("stable@ecotech.tw", "role-staff");
    await patch(id, "stable@ecotech.tw", JSON.stringify({ displayName: "改過了" }));

    const [row] = await createDatabase(d1 as never).select().from(users).where(eq(users.id, id));
    expect(row?.email).toBe("stable@ecotech.tw");
  });

  it.each([
    ["不是字串", JSON.stringify({ displayName: 123 })],
    ["沒帶欄位", JSON.stringify({})],
    ["超過 40 個字", JSON.stringify({ displayName: "字".repeat(41) })],
    ["不是 JSON", "not-json"],
  ])("擋下不合法的輸入（%s）", async (_label, body) => {
    const id = await seedUser("bad@ecotech.tw", "role-staff");
    expect((await patch(id, "bad@ecotech.tw", body)).status).toBe(400);
  });
});
