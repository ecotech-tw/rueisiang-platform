import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { customers, cyberbizCustomerWebhooks } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "webhook-secret";
let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

const member = {
  id: "cb-1",
  mobile: "0912345678",
  name: "王小明",
  email: "wang@example.com",
  updated_at: "2026-08-18 10:00:00",
};

async function hmac(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function post(body: string, init: { headers?: Record<string, string>; query?: string } = {}) {
  return app.fetch(
    new Request(`https://platform.rueisiang.com/api/webhooks/cyberbiz/customers${init.query ?? ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      body,
    }),
    env as never,
  );
}

beforeEach(async () => {
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: "test-secret",
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    CYBERBIZ_WEBHOOK_SECRET: SECRET,
  };
  await syncSystemRoles(db());
});

describe("webhook 的驗證", () => {
  const body = JSON.stringify({ topic: "customers/create", customer: member });

  it("沒帶任何憑證是 401", async () => {
    expect((await post(body)).status).toBe(401);
  });

  it("token 對就通過", async () => {
    expect((await post(body, { query: `?token=${SECRET}` })).status).toBe(200);
  });

  it("Bearer 對也通過", async () => {
    expect((await post(body, { headers: { Authorization: `Bearer ${SECRET}` } })).status).toBe(200);
  });

  it("HMAC 簽章對就通過", async () => {
    const signature = await hmac(SECRET, body);
    expect((await post(body, { headers: { "x-cyberbiz-hmac-sha256": signature } })).status).toBe(200);
  });

  it("簽章帶 sha256= 前綴也認得", async () => {
    const signature = await hmac(SECRET, body);
    const response = await post(body, { headers: { "x-hub-signature-256": `sha256=${signature}` } });
    expect(response.status).toBe(200);
  });

  it("簽章是別把密鑰算的就擋下來", async () => {
    const signature = await hmac("攻擊者的密鑰", body);
    expect((await post(body, { headers: { "x-cyberbiz-hmac-sha256": signature } })).status).toBe(401);
  });

  it("body 被改過之後簽章就對不上", async () => {
    const signature = await hmac(SECRET, body);
    const tampered = JSON.stringify({ topic: "customers/create", customer: { ...member, id: "cb-999" } });
    expect((await post(tampered, { headers: { "x-cyberbiz-hmac-sha256": signature } })).status).toBe(401);
  });

  it("伺服器沒設密鑰時一律不收——不能留一條誰都能寫的端點", async () => {
    env = { ...env, CYBERBIZ_WEBHOOK_SECRET: "" };
    expect((await post(body, { query: "?token=" })).status).toBe(401);
  });
});

describe("webhook 的處理", () => {
  const query = `?token=${SECRET}`;

  it("會員事件會建立客戶", async () => {
    const body = JSON.stringify({ topic: "customers/create", customer: member });
    const response = await post(body, { query });

    expect(await response.json()).toMatchObject({ status: "processed", action: "created" });
    const [row] = await db().select().from(customers).where(eq(customers.cyberbizCustomerId, "cb-1"));
    expect(row?.name).toBe("王小明");
  });

  it("同一個事件重送只會處理一次", async () => {
    const body = JSON.stringify({ topic: "customers/create", customer: member });
    await post(body, { query });
    const second = await post(body, { query });

    expect(await second.json()).toMatchObject({ status: "duplicate" });
    expect(await db().select().from(customers)).toHaveLength(1);
  });

  it("非會員事件會記錄但不處理", async () => {
    const body = JSON.stringify({ topic: "orders/create", order: { id: 1 } });
    const response = await post(body, { query });

    expect(await response.json()).toMatchObject({ status: "ignored" });
    expect(await db().select().from(customers)).toHaveLength(0);
    // 仍然留一筆紀錄，之後要查「到底有沒有收到」才有依據。
    expect(await db().select().from(cyberbizCustomerWebhooks)).toHaveLength(1);
  });

  it("沒有會員 ID 的事件不會生出幽靈客戶", async () => {
    const body = JSON.stringify({ topic: "customers/update", customer: { mobile: "0912345678" } });
    const response = await post(body, { query });

    expect(await response.json()).toMatchObject({ status: "ignored" });
    expect(await db().select().from(customers)).toHaveLength(0);
  });

  it("原始 payload 會存下來，事後補跑才有東西可跑", async () => {
    const body = JSON.stringify({ topic: "customers/create", customer: member });
    await post(body, { query });

    const [event] = await db().select().from(cyberbizCustomerWebhooks);
    expect(event?.payloadJson).toBe(body);
    expect(event?.status).toBe("processed");
    expect(event?.cyberbizCustomerId).toBe("cb-1");
  });

  it("內容不是 JSON 就 400", async () => {
    expect((await post("not-json", { query })).status).toBe(400);
  });

  it("GET 是探測點，會說明密鑰有沒有設", async () => {
    const response = await app.fetch(
      new Request("https://platform.rueisiang.com/api/webhooks/cyberbiz/customers"),
      env as never,
    );
    expect(await response.json()).toMatchObject({ ok: true, configured: true });
  });
});
