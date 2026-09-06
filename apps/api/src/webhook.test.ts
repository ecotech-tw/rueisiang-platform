import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { crmCustomers, cyberbizWebhookEvents, cyberbizProductWebhooks } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    new Request(`https://platform.rueisiang.com/api/webhooks/cyberbiz${init.query ?? ""}`, {
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
    const [row] = await db().select().from(crmCustomers).where(eq(crmCustomers.cyberbizCustomerId, "cb-1"));
    expect(row?.name).toBe("王小明");
  });

  it("同一個事件重送只會處理一次", async () => {
    const body = JSON.stringify({ topic: "customers/create", customer: member });
    await post(body, { query });
    const second = await post(body, { query });

    expect(await second.json()).toMatchObject({ status: "duplicate" });
    expect(await db().select().from(crmCustomers)).toHaveLength(1);
  });

  it("非會員事件會記錄但不處理", async () => {
    const body = JSON.stringify({ topic: "orders/create", order: { id: 1 } });
    const response = await post(body, { query });

    expect(await response.json()).toMatchObject({ status: "ignored" });
    expect(await db().select().from(crmCustomers)).toHaveLength(0);
    // 仍然留一筆紀錄，之後要查「到底有沒有收到」才有依據。
    expect(await db().select().from(cyberbizWebhookEvents)).toHaveLength(1);
  });

  it("沒有會員 ID 的事件不會生出幽靈客戶", async () => {
    const body = JSON.stringify({ topic: "customers/update", customer: { mobile: "0912345678" } });
    const response = await post(body, { query });

    expect(await response.json()).toMatchObject({ status: "ignored" });
    expect(await db().select().from(crmCustomers)).toHaveLength(0);
  });

  it("原始 payload 會存下來，事後補跑才有東西可跑", async () => {
    const body = JSON.stringify({ topic: "customers/create", customer: member });
    await post(body, { query });

    const [event] = await db().select().from(cyberbizWebhookEvents);
    expect(event?.payloadJson).toBe(body);
    expect(event?.status).toBe("processed");
    expect(event?.cyberbizCustomerId).toBe("cb-1");
  });

  it("內容不是 JSON 就 400", async () => {
    expect((await post("not-json", { query })).status).toBe(400);
  });

  it("GET 是探測點，會說明密鑰有沒有設", async () => {
    const response = await app.fetch(
      new Request("https://platform.rueisiang.com/api/webhooks/cyberbiz"),
      env as never,
    );
    expect(await response.json()).toMatchObject({ ok: true, configured: true });
  });
});

describe("處理失敗時", () => {
  const query = `?token=${SECRET}`;

  /**
   * 模擬「回官網重讀時查不到這個會員」。設了 API token 之後這是最常見的失敗：
   * ID 是假的、或 token 過期。回 404 而不是連線失敗，這樣不會觸發重試等待。
   */
  beforeEach(() => {
    env = { ...env, CYBERBIZ_API_TOKEN: "token" };
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: "Customer not found" }), { status: 404 }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("重讀失敗時改用 webhook 自己帶的資料，仍然寫得進去", async () => {
    // 官網對某些會員的單筆查詢會回 404，但那個 ID 是簽章驗證過的，
    // 會員也真的存在——手上已經有可用資料時不該整筆丟掉。
    const body = JSON.stringify({
      topic: "customers/update",
      customer: { id: "79797774", mobile: "0912000111", name: "官網查不到但事件有帶" },
    });
    const response = await post(body, { query });

    expect(response.status).toBe(200);
    const outcome = (await response.json()) as { status: string; action?: string; error?: string };
    expect(outcome.status).toBe("processed");
    expect(outcome.action).toBe("created");
    // 仍然把重讀失敗的原因留著，看得出這一筆用的不是官網最新資料。
    expect(outcome.error).toContain("404");

    const [row] = await db().select().from(crmCustomers).where(eq(crmCustomers.cyberbizCustomerId, "79797774"));
    expect(row?.name).toBe("官網查不到但事件有帶");
  });

  it("重讀失敗且事件沒有會員 ID 時才擋下來", async () => {
    const body = JSON.stringify({ topic: "customers/update", customer: { mobile: "0912000222" } });
    const outcome = (await (await post(body, { query })).json()) as { status: string };

    expect(outcome.status).toBe("ignored");
    expect(await db().select().from(crmCustomers)).toHaveLength(0);
  });

  it("沒有設 API token 時不重讀，直接用 payload 內容處理", async () => {
    vi.unstubAllGlobals();
    env = { ...env, CYBERBIZ_API_TOKEN: "" };
    const body = JSON.stringify({
      topic: "customers/update",
      customer: { id: "cb-9", mobile: "0900000000", name: "只靠 payload" },
    });

    const outcome = (await (await post(body, { query })).json()) as { status: string; action?: string };
    expect(outcome).toMatchObject({ status: "processed", action: "created" });
  });
});

describe("不是會員的事件", () => {
  const query = `?token=${SECRET}`;

  /** 這就是實際打進來的商品庫存事件，一字未改（只縮短了欄位）。 */
  const productEvent = {
    product_id: 62458755,
    name: "★潤白養膚小皂 - ",
    sku: "ASOT02002",
    inventory_quantity: 1098,
    inventory_policy: "continue",
    inventory_management: true,
    price: 88.0,
    updated_at: "2026-08-19 11:39:26",
    id: 75900635,
  };

  it("商品庫存事件不會被寫成客戶", async () => {
    const response = await post(JSON.stringify(productEvent), { query });

    const outcome = (await response.json()) as { status: string; reason?: string };
    expect(outcome.status).toBe("ignored");
    expect(outcome.reason).toContain("商品");
    // 先前這裡會建出一位叫「★潤白養膚小皂」的客人。
    expect(await db().select().from(crmCustomers)).toHaveLength(0);
  });

  /*
   * 這一條的斷言換過表。
   *
   * Phase 4 之前商品事件會被記進「會員 webhook」那張表並標成 ignored——當時沒有
   * 別的地方可以放。現在一個網址進來會分派，商品事件落在自己的表裡，不再借住。
   */
  it("商品事件記在商品那張表，不是會員那張", async () => {
    await post(JSON.stringify(productEvent), { query });

    expect(await db().select().from(cyberbizWebhookEvents)).toHaveLength(0);

    const [event] = await db().select().from(cyberbizProductWebhooks);
    expect(event?.variantId).toBe("75900635");
    expect(event?.status).toBe("ignored");
  });

  it("沒有 topic 標頭又看不出是什麼的事件不處理", async () => {
    // 先前預設值是 customers/update，等於「猜不出來就當會員」。
    const response = await post(JSON.stringify({ id: 123, name: "看不出是什麼" }), { query });

    const outcome = (await response.json()) as { status: string; topic: string; reason?: string };
    expect(outcome.topic).toBe("unknown");
    expect(outcome.status).toBe("ignored");
    expect(await db().select().from(crmCustomers)).toHaveLength(0);
  });

  it("payload 認得出是會員時，就算沒有 topic 標頭也會處理", async () => {
    const response = await post(
      JSON.stringify({ id: 35258347, mobile: "0912345678", name: "王小明", email: "w@example.com" }),
      { query },
    );

    const outcome = (await response.json()) as { status: string; action?: string };
    expect(outcome.status).toBe("processed");
    expect(outcome.action).toBe("created");
  });

  it("topic 明確標成會員時照樣處理", async () => {
    const response = await post(
      JSON.stringify({ topic: "customers/create", customer: { id: 999, mobile: "0900111222" } }),
      { query },
    );
    expect((await response.json()) as { status: string }).toMatchObject({ status: "processed" });
  });
});
