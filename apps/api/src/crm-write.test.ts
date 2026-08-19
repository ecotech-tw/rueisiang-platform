import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { customerEvents, customers, userRoles, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

/**
 * 新增、編輯、封鎖。這裡最重要的一條是「先寫官網、成功了才寫本地」——
 * 反過來的話官網失敗時本地會留下一筆看起來同步過、實際上不存在的客戶。
 */

const SECRET = "test-secret";
let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

/** 把 CYBERBIZ 換成可控的替身，記下打了幾次、送了什麼。 */
function stubCyberbiz(responses: { status?: number; body?: unknown }[] = [{ body: { id: "cb-new" } }]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let index = 0;

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const spec = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    return new Response(JSON.stringify(spec.body ?? {}), { status: spec.status ?? 200 });
  });

  return calls;
}

async function seedUser(email: string, roleId: string) {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: "active" });
  await db().insert(userRoles).values({ userId: id, roleId });
  return id;
}

async function as(userId: string, email: string, path: string, init: RequestInit = {}) {
  const token = await signSession(
    newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }),
    SECRET,
  );
  return app.fetch(
    new Request(`https://platform.rueisiang.com${path}`, {
      ...init,
      headers: {
        Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    }),
    env as never,
  );
}

const NEW_CUSTOMER = JSON.stringify({
  phone: "0912345678",
  name: "王小明",
  email: "wang@example.com",
  address: "台北市大安區",
  tags: ["VIP"],
});

beforeEach(async () => {
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    CYBERBIZ_API_TOKEN: "token",
  };
  await syncSystemRoles(db());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("新增客戶", () => {
  it("先在官網建會員，再寫本地", async () => {
    const calls = stubCyberbiz([{ body: { id: "cb-new", mobile: "0912345678", name: "王小明" } }]);
    const id = await seedUser("staff@ecotech.tw", "role-staff");

    const response = await as(id, "staff@ecotech.tw", "/api/crm/customers", {
      method: "POST",
      body: NEW_CUSTOMER,
    });
    expect(response.status).toBe(201);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/v1/customers");

    const [row] = await db().select().from(customers);
    expect(row).toMatchObject({
      name: "王小明",
      cyberbizCustomerId: "cb-new",
      sourceChannel: "cyberbiz",
      syncStatus: "synced",
    });
  });

  it("官網失敗時本地什麼都不留", async () => {
    stubCyberbiz([{ status: 422, body: { errors: { mobile: ["已存在"] } } }]);
    const id = await seedUser("staff@ecotech.tw", "role-staff");

    const response = await as(id, "staff@ecotech.tw", "/api/crm/customers", {
      method: "POST",
      body: NEW_CUSTOMER,
    });

    expect(response.status).toBe(422);
    // 這是這個檔案最重要的一條：不要留下看起來同步過、實際上官網沒有的客戶。
    expect(await db().select().from(customers)).toHaveLength(0);
  });

  it("指定 manual 就只建本地，不碰官網", async () => {
    const calls = stubCyberbiz();
    const id = await seedUser("staff@ecotech.tw", "role-staff");

    await as(id, "staff@ecotech.tw", "/api/crm/customers", {
      method: "POST",
      body: JSON.stringify({ phone: "0912345678", name: "只在本地", sourceChannel: "manual" }),
    });

    expect(calls).toHaveLength(0);
    const [row] = await db().select().from(customers);
    expect(row).toMatchObject({ sourceChannel: "manual", syncStatus: "local_only" });
  });

  it("電話重複時擋下來", async () => {
    stubCyberbiz();
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    await as(id, "staff@ecotech.tw", "/api/crm/customers", { method: "POST", body: NEW_CUSTOMER });

    const second = await as(id, "staff@ecotech.tw", "/api/crm/customers", {
      method: "POST",
      body: JSON.stringify({ phone: "0912-345-678", name: "同一支電話" }),
    });
    expect(second.status).toBe(409);
  });

  it.each([
    ["沒填電話", { name: "沒有電話" }],
    ["電話太短", { phone: "0912" }],
  ])("擋下不合法的輸入（%s）", async (_label, payload) => {
    stubCyberbiz();
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const response = await as(id, "staff@ecotech.tw", "/api/crm/customers", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
  });

  it("檢視者不能新增", async () => {
    stubCyberbiz();
    const id = await seedUser("viewer@ecotech.tw", "role-viewer");
    const response = await as(id, "viewer@ecotech.tw", "/api/crm/customers", {
      method: "POST",
      body: NEW_CUSTOMER,
    });
    expect(response.status).toBe(403);
  });

  it("留下一筆帶操作者的紀錄", async () => {
    stubCyberbiz([{ body: { id: "cb-new" } }]);
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    await as(id, "staff@ecotech.tw", "/api/crm/customers", { method: "POST", body: NEW_CUSTOMER });

    const [event] = await db().select().from(customerEvents);
    expect(event?.eventType).toBe("customer_created");
    expect(event?.actorEmail).toBe("staff@ecotech.tw");
  });
});

describe("編輯客戶", () => {
  async function seedLinked() {
    await db().insert(customers).values({
      id: "c1",
      phone: "0912345678",
      normalizedPhone: "0912345678",
      name: "原本的名字",
      cyberbizCustomerId: "cb-1",
      sourceChannel: "cyberbiz",
    });
  }

  it("已連結官網的客戶會先推上去再改本地", async () => {
    const calls = stubCyberbiz([{ body: { id: "cb-1" } }]);
    await seedLinked();
    const id = await seedUser("staff@ecotech.tw", "role-staff");

    const response = await as(id, "staff@ecotech.tw", "/api/crm/customers/c1", {
      method: "PATCH",
      body: JSON.stringify({ phone: "0912345678", name: "改過的名字" }),
    });

    expect(response.status).toBe(200);
    expect(calls[0]?.method).toBe("PUT");
    const [row] = await db().select().from(customers).where(eq(customers.id, "c1"));
    expect(row?.name).toBe("改過的名字");
  });

  it("推不上官網就整筆不改", async () => {
    stubCyberbiz([{ status: 500, body: { error: "官網掛了" } }, { status: 500, body: { error: "官網掛了" } }, { status: 500, body: { error: "官網掛了" } }, { status: 500, body: { error: "官網掛了" } }]);
    await seedLinked();
    const id = await seedUser("staff@ecotech.tw", "role-staff");

    const response = await as(id, "staff@ecotech.tw", "/api/crm/customers/c1", {
      method: "PATCH",
      body: JSON.stringify({ phone: "0912345678", name: "改過的名字" }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    const [row] = await db().select().from(customers).where(eq(customers.id, "c1"));
    expect(row?.name).toBe("原本的名字");
  });

  it("沒有連結官網的客戶只改本地", async () => {
    const calls = stubCyberbiz();
    await db().insert(customers).values({
      id: "c2",
      phone: "0922333444",
      normalizedPhone: "0922333444",
      name: "本地客戶",
      sourceChannel: "manual",
    });
    const id = await seedUser("staff@ecotech.tw", "role-staff");

    await as(id, "staff@ecotech.tw", "/api/crm/customers/c2", {
      method: "PATCH",
      body: JSON.stringify({ phone: "0922333444", name: "改過了" }),
    });

    expect(calls).toHaveLength(0);
    const [row] = await db().select().from(customers).where(eq(customers.id, "c2"));
    expect(row?.name).toBe("改過了");
  });

  it("換成別人已經在用的電話會被擋下", async () => {
    stubCyberbiz();
    await seedLinked();
    await db().insert(customers).values({
      id: "c2",
      phone: "0922333444",
      normalizedPhone: "0922333444",
      name: "另一位",
    });
    const id = await seedUser("staff@ecotech.tw", "role-staff");

    const response = await as(id, "staff@ecotech.tw", "/api/crm/customers/c2", {
      method: "PATCH",
      body: JSON.stringify({ phone: "0912345678", name: "另一位" }),
    });
    expect(response.status).toBe(409);
  });

  it("找不到的客戶回 404", async () => {
    stubCyberbiz();
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const response = await as(id, "staff@ecotech.tw", "/api/crm/customers/不存在", {
      method: "PATCH",
      body: JSON.stringify({ phone: "0912345678" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("封鎖客戶", () => {
  beforeEach(async () => {
    await db().insert(customers).values({
      id: "c1",
      phone: "0912345678",
      normalizedPhone: "0912345678",
      name: "王小明",
      cyberbizCustomerId: "cb-1",
    });
  });

  it("封鎖會推到官網並記錄時間", async () => {
    const calls = stubCyberbiz([{ body: { id: "cb-1", blocked: true } }]);
    const id = await seedUser("manager@ecotech.tw", "role-manager");

    const response = await as(id, "manager@ecotech.tw", "/api/crm/customers/c1/block", {
      method: "POST",
      body: JSON.stringify({ blocked: true }),
    });

    expect(response.status).toBe(200);
    expect(calls[0]?.body).toEqual({ customer: { blocked: true } });
    const [row] = await db().select().from(customers).where(eq(customers.id, "c1"));
    expect(row?.status).toBe("blocked");
    expect(row?.blockedAt).toBeTruthy();
  });

  it("解除封鎖會把時間清掉", async () => {
    stubCyberbiz([{ body: { id: "cb-1" } }]);
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    await as(id, "manager@ecotech.tw", "/api/crm/customers/c1/block", {
      method: "POST",
      body: JSON.stringify({ blocked: true }),
    });
    await as(id, "manager@ecotech.tw", "/api/crm/customers/c1/block", {
      method: "POST",
      body: JSON.stringify({ blocked: false }),
    });

    const [row] = await db().select().from(customers).where(eq(customers.id, "c1"));
    expect(row?.status).toBe("active");
    expect(row?.blockedAt).toBeNull();
  });

  it("一般同仁沒有封鎖權限", async () => {
    stubCyberbiz();
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const response = await as(id, "staff@ecotech.tw", "/api/crm/customers/c1/block", {
      method: "POST",
      body: JSON.stringify({ blocked: true }),
    });
    expect(response.status).toBe(403);
  });
});
