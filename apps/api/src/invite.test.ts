import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { users, userRoleAssignments } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

/**
 * 邀請連結與帳密登入。
 *
 * 這條路上每一個「應該擋下來」都值得一個測試：它是唯一不經過 Google 就能拿到
 * session 的入口，破了就等於整個系統沒有門。
 */

const SECRET = "test-secret";
const PASSWORD = "hunter2hunter2";
let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

function call(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`https://platform.rueisiang.com${path}`, init), env as never);
}

function json(path: string, method: string, payload?: unknown, cookie?: string) {
  return call(path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

async function adminCookie() {
  const id = "user-admin";
  await db().insert(users).values({ id, email: "admin@ecotech.tw", status: "active" });
  await db().insert(userRoleAssignments).values({ userId: id, roleId: "role-admin" });
  const token = await signSession(
    newSessionClaims({ id, email: "admin@ecotech.tw", name: "管理者", pictureUrl: "" }),
    SECRET,
  );
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

/** 邀請一個人，順便把後台拿到的那條連結拆出 token。 */
async function invite(cookie: string, email = "newbie@ecotech.tw") {
  const response = await json("/api/admin/users", "POST", { email }, cookie);
  const body = (await response.json()) as { id: string; inviteUrl: string };
  return { id: body.id, url: body.inviteUrl, token: body.inviteUrl.split("/invite/")[1] ?? "" };
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

describe("邀請連結", () => {
  it("邀請時回傳一條可用的連結", async () => {
    const cookie = await adminCookie();
    const { url, token } = await invite(cookie);

    expect(url).toContain("/invite/");
    const check = await call(`/api/auth/invite/${token}`);
    expect(check.status).toBe(200);
    expect(await check.json()).toEqual({ email: "newbie@ecotech.tw" });
  });

  it("資料庫只存雜湊，不存明文 token", async () => {
    const cookie = await adminCookie();
    const { id, token } = await invite(cookie);

    const [row] = await db()
      .select({ hash: users.invitationTokenHash })
      .from(users)
      .where(eq(users.id, id));
    expect(row?.hash).toBeTruthy();
    expect(row?.hash).not.toBe(token);
  });

  it("設完密碼直接拿到 session，不用再回登入頁輸入一次", async () => {
    const cookie = await adminCookie();
    const { token } = await invite(cookie);

    const response = await json(`/api/auth/invite/${token}`, "POST", {
      password: PASSWORD,
      confirmPassword: PASSWORD,
      displayName: "新來的",
    });
    expect(response.status).toBe(200);

    const issued = response.headers.get("Set-Cookie") ?? "";
    expect(issued).toContain(SESSION_COOKIE);

    const me = await call("/api/auth/me", { headers: { Cookie: issued.split(";")[0] ?? "" } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe("newbie@ecotech.tw");
  });

  it("設完密碼帳號就變成啟用", async () => {
    const cookie = await adminCookie();
    const { id, token } = await invite(cookie);
    await json(`/api/auth/invite/${token}`, "POST", { password: PASSWORD, confirmPassword: PASSWORD });

    const [row] = await db().select({ status: users.status }).from(users).where(eq(users.id, id));
    expect(row?.status).toBe("active");
  });

  it("一條連結只能用一次", async () => {
    const cookie = await adminCookie();
    const { token } = await invite(cookie);
    await json(`/api/auth/invite/${token}`, "POST", { password: PASSWORD, confirmPassword: PASSWORD });

    expect((await call(`/api/auth/invite/${token}`)).status).toBe(404);

    const reuse = await json(`/api/auth/invite/${token}`, "POST", {
      password: "different-password",
      confirmPassword: "different-password",
    });
    expect(reuse.status).toBe(404);
  });

  it("過期的連結不能用", async () => {
    const cookie = await adminCookie();
    const { id, token } = await invite(cookie);
    await db()
      .update(users)
      .set({ invitationExpiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(users.id, id));

    expect((await call(`/api/auth/invite/${token}`)).status).toBe(404);
  });

  it("停用的帳號連結不能用", async () => {
    const cookie = await adminCookie();
    const { id, token } = await invite(cookie);
    await db().update(users).set({ status: "disabled" }).where(eq(users.id, id));

    expect((await call(`/api/auth/invite/${token}`)).status).toBe(404);
  });

  it("亂猜的 token 回 404", async () => {
    expect((await call("/api/auth/invite/not-a-real-token")).status).toBe(404);
  });

  it.each([
    ["密碼太短", { password: "short", confirmPassword: "short" }, "8"],
    ["兩次不一致", { password: PASSWORD, confirmPassword: "something-else" }, "不一致"],
  ])("擋下 %s", async (_label, payload, expected) => {
    const cookie = await adminCookie();
    const { token } = await invite(cookie);

    const response = await json(`/api/auth/invite/${token}`, "POST", payload);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(expected);
  });

  it("被擋下來時 token 還留著，可以重填一次", async () => {
    const cookie = await adminCookie();
    const { token } = await invite(cookie);
    await json(`/api/auth/invite/${token}`, "POST", { password: "short", confirmPassword: "short" });

    expect((await call(`/api/auth/invite/${token}`)).status).toBe(200);
  });
});

describe("重發邀請連結", () => {
  it("換一條新的，舊的立刻失效", async () => {
    const cookie = await adminCookie();
    const { id, token: first } = await invite(cookie);

    const response = await json(`/api/admin/users/${id}/invite`, "POST", undefined, cookie);
    expect(response.status).toBe(200);
    const second = ((await response.json()) as { inviteUrl: string }).inviteUrl.split("/invite/")[1] ?? "";

    expect(second).not.toBe(first);
    expect((await call(`/api/auth/invite/${first}`)).status).toBe(404);
    expect((await call(`/api/auth/invite/${second}`)).status).toBe(200);
  });

  it("已經啟用的帳號不給重發——那等於一個不必驗證就能改密碼的後門", async () => {
    const cookie = await adminCookie();
    const { id, token } = await invite(cookie);
    await json(`/api/auth/invite/${token}`, "POST", { password: PASSWORD, confirmPassword: PASSWORD });

    const response = await json(`/api/admin/users/${id}/invite`, "POST", undefined, cookie);
    expect(response.status).toBe(409);
  });

  it("沒有登入的人不能重發", async () => {
    const cookie = await adminCookie();
    const { id } = await invite(cookie);

    expect((await json(`/api/admin/users/${id}/invite`, "POST")).status).toBe(401);
  });
});

describe("後台看得到帳密使用者的資訊", () => {
  /*
   * 這兩件事之前都壞掉，而且只壞在帳密那條路——Google 那條有 recordLogin 撐著。
   * 症狀是後台把天天在用的人顯示成「（尚未登入過）」、最後登入永遠是「—」。
   */
  it("設定密碼時填的顯示名稱，後台看得到", async () => {
    const cookie = await adminCookie();
    const { token } = await invite(cookie);
    await json(`/api/auth/invite/${token}`, "POST", {
      password: PASSWORD,
      confirmPassword: PASSWORD,
      displayName: "新來的同事",
    });

    const list = (await (await call("/api/admin/users", { headers: { Cookie: cookie } })).json()) as {
      users: { email: string; name: string }[];
    };
    expect(list.users.find((user) => user.email === "newbie@ecotech.tw")?.name).toBe("新來的同事");
  });

  it("走邀請連結設完密碼就算登入過一次", async () => {
    const cookie = await adminCookie();
    const { token } = await invite(cookie);
    await json(`/api/auth/invite/${token}`, "POST", { password: PASSWORD, confirmPassword: PASSWORD });

    const list = (await (await call("/api/admin/users", { headers: { Cookie: cookie } })).json()) as {
      users: { email: string; lastLoginAt: string | null }[];
    };
    expect(list.users.find((user) => user.email === "newbie@ecotech.tw")?.lastLoginAt).toBeTruthy();
  });

  it("用帳密登入會更新最後登入時間", async () => {
    const cookie = await adminCookie();
    const { token } = await invite(cookie);
    await json(`/api/auth/invite/${token}`, "POST", { password: PASSWORD, confirmPassword: PASSWORD });

    const read = async () => {
      const body = (await (await call("/api/admin/users", { headers: { Cookie: cookie } })).json()) as {
        users: { email: string; lastLoginAt: string | null }[];
      };
      return body.users.find((user) => user.email === "newbie@ecotech.tw")?.lastLoginAt;
    };
    const before = await read();

    // 同一毫秒內寫入會看不出差別，等一下再登入。
    await new Promise((resolve) => setTimeout(resolve, 5));
    await json("/api/auth/password", "POST", { email: "newbie@ecotech.tw", password: PASSWORD });

    expect(await read()).not.toBe(before);
  });
});

describe("帳密登入", () => {
  async function inviteAndSetPassword(email = "newbie@ecotech.tw") {
    const cookie = await adminCookie();
    const { id, token } = await invite(cookie, email);
    await json(`/api/auth/invite/${token}`, "POST", { password: PASSWORD, confirmPassword: PASSWORD });
    return id;
  }

  it("設過密碼就能登入", async () => {
    await inviteAndSetPassword();
    const response = await json("/api/auth/password", "POST", {
      email: "newbie@ecotech.tw",
      password: PASSWORD,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain(SESSION_COOKIE);
  });

  it("email 大小寫不影響登入", async () => {
    await inviteAndSetPassword();
    const response = await json("/api/auth/password", "POST", {
      email: "NewBie@EcoTech.TW",
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
  });

  /*
   * 三種失敗回同一句、同一個狀態碼。分開講等於送人一支帳號列舉工具：
   * 試一個 email 就知道公司有沒有這個人。
   */
  it.each([
    ["密碼錯", { email: "newbie@ecotech.tw", password: "wrong-password" }],
    ["查無此人", { email: "nobody@example.com", password: PASSWORD }],
    ["什麼都沒填", { email: "", password: "" }],
  ])("擋下 %s，而且不透露是哪一種", async (_label, payload) => {
    await inviteAndSetPassword();
    const response = await json("/api/auth/password", "POST", payload);

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Email 或密碼不正確，或這個帳號還沒完成啟用。",
    );
  });

  it("還沒設過密碼的帳號登不進來", async () => {
    const cookie = await adminCookie();
    await invite(cookie);

    const response = await json("/api/auth/password", "POST", {
      email: "newbie@ecotech.tw",
      password: PASSWORD,
    });
    expect(response.status).toBe(401);
  });

  it("停用之後就登不進來了", async () => {
    const id = await inviteAndSetPassword();
    await db().update(users).set({ status: "disabled" }).where(eq(users.id, id));

    const response = await json("/api/auth/password", "POST", {
      email: "newbie@ecotech.tw",
      password: PASSWORD,
    });
    expect(response.status).toBe(401);
  });
});
