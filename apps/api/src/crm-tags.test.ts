import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { activityEvents, customerTagCatalog, customers, userRoles, users } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "test-secret";
let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

async function seedUser(email: string, roleId: string) {
  const id = `user-${email}`;
  await db().insert(users).values({ id, email, status: "active" });
  await db().insert(userRoles).values({ userId: id, roleId });
  return id;
}

async function seedCustomer(id: string, tags: string[], cyberbizId: string | null = null) {
  await db().insert(customers).values({
    id,
    phone: `09${id.padStart(8, "0")}`,
    normalizedPhone: `09${id.padStart(8, "0")}`,
    name: `客戶${id}`,
    cyberbizTagsJson: JSON.stringify(tags),
    cyberbizCustomerId: cyberbizId,
  });
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

async function tagsOf(customerId: string): Promise<string[]> {
  const [row] = await db().select().from(customers).where(eq(customers.id, customerId));
  return JSON.parse(row?.cyberbizTagsJson ?? "[]") as string[];
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("標籤列表", () => {
  it("字典與客戶身上的標籤取聯集", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    await db().insert(customerTagCatalog).values({ id: "t1", name: "還沒人用的標籤" });
    await seedCustomer("1", ["VIP", "熟客"], "cb-1");
    await seedCustomer("2", ["VIP"]);

    const body = (await (await as(id, "staff@ecotech.tw", "/api/crm/tags")).json()) as {
      tags: { name: string; inCatalog: boolean; customerCount: number; linkedCount: number }[];
    };

    const byName = Object.fromEntries(body.tags.map((tag) => [tag.name, tag]));
    expect(byName["VIP"]).toMatchObject({ inCatalog: false, customerCount: 2, linkedCount: 1 });
    expect(byName["熟客"]).toMatchObject({ customerCount: 1, linkedCount: 1 });
    expect(byName["還沒人用的標籤"]).toMatchObject({ inCatalog: true, customerCount: 0 });
  });

  it("沒有 crm:tag:read 的人被擋下", async () => {
    const id = "user-none@ecotech.tw";
    await db().insert(users).values({ id, email: "none@ecotech.tw", status: "active" });
    expect((await as(id, "none@ecotech.tw", "/api/crm/tags")).status).toBe(403);
  });
});

describe("新增標籤", () => {
  it("檢視者不能新增", async () => {
    const id = await seedUser("viewer@ecotech.tw", "role-viewer");
    const response = await as(id, "viewer@ecotech.tw", "/api/crm/tags", {
      method: "POST",
      body: JSON.stringify({ name: "新標籤" }),
    });
    expect(response.status).toBe(403);
  });

  it("同名的標籤不會建立兩次", async () => {
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const payload = JSON.stringify({ name: "重複" });
    expect((await as(id, "manager@ecotech.tw", "/api/crm/tags", { method: "POST", body: payload })).status).toBe(201);
    expect((await as(id, "manager@ecotech.tw", "/api/crm/tags", { method: "POST", body: payload })).status).toBe(409);
  });
});

describe("改名與移除", () => {
  beforeEach(async () => {
    await db().insert(customerTagCatalog).values({ id: "t1", name: "VIP" });
    await seedCustomer("1", ["VIP", "熟客"]);
    await seedCustomer("2", ["VIP"]);
    await seedCustomer("3", ["其他"]);
    // 名字包含 VIP 但不相等——LIKE 會撈到它，精確比對必須把它排除。
    await seedCustomer("4", ["VIP2"]);
  });

  it("改名只動到真的掛著那個標籤的客戶", async () => {
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    const response = await as(id, "manager@ecotech.tw", "/api/crm/tags/VIP", {
      method: "PATCH",
      body: JSON.stringify({ name: "貴賓" }),
    });

    expect(response.status).toBe(200);
    expect(await tagsOf("1")).toEqual(["貴賓", "熟客"]);
    expect(await tagsOf("2")).toEqual(["貴賓"]);
    expect(await tagsOf("3")).toEqual(["其他"]);
    // VIP2 不是 VIP，不能被一起改掉。
    expect(await tagsOf("4")).toEqual(["VIP2"]);
  });

  it("改名會同步更新字典", async () => {
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    await as(id, "manager@ecotech.tw", "/api/crm/tags/VIP", {
      method: "PATCH",
      body: JSON.stringify({ name: "貴賓" }),
    });

    const catalog = await db().select().from(customerTagCatalog);
    expect(catalog.map((tag) => tag.name)).toEqual(["貴賓"]);
  });

  it("移除會從客戶身上拿掉，其他標籤留著", async () => {
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    await as(id, "manager@ecotech.tw", "/api/crm/tags/VIP", {
      method: "PATCH",
      body: JSON.stringify({ name: null }),
    });

    expect(await tagsOf("1")).toEqual(["熟客"]);
    expect(await tagsOf("2")).toEqual([]);
    expect(await db().select().from(customerTagCatalog)).toHaveLength(0);
  });

  it("每個被改到的客戶都留下一筆操作紀錄", async () => {
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    await as(id, "manager@ecotech.tw", "/api/crm/tags/VIP", {
      method: "PATCH",
      body: JSON.stringify({ name: "貴賓" }),
    });

    const events = await db().select().from(activityEvents);
    expect(events).toHaveLength(2);
    expect(events[0]?.eventType).toBe("tag_renamed");
    // 紀錄要留下是誰改的，人離職之後仍然查得到。
    expect(events[0]?.actorEmail).toBe("manager@ecotech.tw");
  });

  it("推不上 CYBERBIZ 的客戶不會被改掉本地，兩邊才不會不一致", async () => {
    const id = await seedUser("manager@ecotech.tw", "role-manager");
    await db()
      .update(customers)
      .set({ cyberbizCustomerId: "cb-1" })
      .where(eq(customers.id, "1"));

    env = { ...env, CYBERBIZ_API_TOKEN: "token" };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "不給改" }), { status: 422 }));

    const response = await as(id, "manager@ecotech.tw", "/api/crm/tags/VIP", {
      method: "PATCH",
      body: JSON.stringify({ name: "貴賓" }),
    });
    const result = (await response.json()) as { failures: { error: string }[] };

    expect(result.failures).toHaveLength(1);
    expect(await tagsOf("1")).toEqual(["VIP", "熟客"]);
    // 沒有連到官網的那位不受影響，照樣改。
    expect(await tagsOf("2")).toEqual(["貴賓"]);
  });

  it("檢視者不能改名", async () => {
    const id = await seedUser("viewer@ecotech.tw", "role-viewer");
    const response = await as(id, "viewer@ecotech.tw", "/api/crm/tags/VIP", {
      method: "PATCH",
      body: JSON.stringify({ name: "貴賓" }),
    });
    expect(response.status).toBe(403);
  });
});
