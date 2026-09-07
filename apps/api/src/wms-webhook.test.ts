import { createDatabase, retryFailedProductWebhooks, syncSystemRoles } from "@rueisiang/db";
import {
  activityEvents,
  cyberbizProductCatalog,
  cyberbizWebhookEvents,
  crmCustomers,
  items,
  wmsCategories,
  wmsItems,
} from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

/**
 * CYBERBIZ 的商品庫存 webhook。
 *
 * 這條路存在的理由：沒有它的話，官網改了數量要等人按「同步到庫存」平台才知道。
 * 倉庫的人看到的是一個安靜地過期的數字——比看到錯誤還糟，因為沒有任何跡象說
 * 它舊了。
 *
 * 這裡釘的重點是「**事件說的數量不算數**」：一律回官網重讀。不然簽章驗過的
 * 事件就等於可以直接寫庫存，那三條不變條件（款式在不在、product_id 對不對、
 * SKU 對不對）就全部形同虛設。
 */

const SECRET = "webhook-secret";
const TOKEN = "api-token";
const BASE = "https://api.example.test";

let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

/** 官網對 /v1/products/{id} 回的形狀。注意：**沒有 id**，那是真的行為。 */
function product(overrides: { quantity?: number; safety?: number; sku?: string; variantId?: number } = {}) {
  return {
    title: "干貝XO醬",
    published: true,
    pos_shop: null,
    product_variants: [
      {
        id: overrides.variantId ?? 68463869,
        name: "干貝XO醬 -",
        sku: overrides.sku ?? "BPK24004",
        inventory_quantity: overrides.quantity ?? 200,
        safety_inventory_quantity: overrides.safety ?? 24,
        inventory_management: true,
      },
    ],
  };
}

/** 記錄官網被打了幾次、打了什麼。回應用完就重複最後一筆。 */
function stubCyberbiz(...responses: { status?: number; body?: unknown }[]) {
  const calls: string[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    const spec = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    return new Response(spec.body === undefined ? "{}" : JSON.stringify(spec.body), {
      status: spec.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return calls;
}

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

async function post(payload: unknown, init: { topic?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-cyberbiz-hmac-sha256": await hmac(init.secret ?? SECRET, body),
  };
  if (init.topic !== undefined) headers["x-cyberbiz-topic"] = init.topic;

  const response = await app.fetch(
    new Request("https://platform.rueisiang.com/api/webhooks/cyberbiz", {
      method: "POST",
      headers,
      body,
    }),
    env as never,
  );
  return { response, json: (await response.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: "test-secret",
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    CYBERBIZ_WEBHOOK_SECRET: SECRET,
    CYBERBIZ_API_TOKEN: TOKEN,
    CYBERBIZ_API_BASE_URL: BASE,
  };
  await syncSystemRoles(db());
  await db().insert(wmsCategories).values({ id: "cat-1", name: "醬菜類", color: "sky", active: 1 });
  await db().insert(items).values({ id: "item-1", source: "cyberbiz", kind: "sellable", sku: "BPK24004", name: "干貝XO醬", active: 1 });
  await db().insert(wmsItems).values({
    itemId: "item-1", wmsCategoryId: "cat-1", quantity: 178, minStock: 24, unit: "件", notes: "",
  });
  await db().insert(cyberbizProductCatalog).values({
    itemId: "item-1",
    cyberbizProductId: "56750193",
    cyberbizVariantId: "68463869",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("驗證", () => {
  it("簽章不對就 401，而且什麼都不落地", async () => {
    stubCyberbiz();
    const { response } = await post({ product_id: "56750193" }, { secret: "wrong" });
    expect(response.status).toBe(401);
    expect(await db().select().from(cyberbizWebhookEvents)).toHaveLength(0);
  });

  it("沒設密鑰就一律不收", async () => {
    stubCyberbiz();
    env.CYBERBIZ_WEBHOOK_SECRET = "";
    const { response } = await post({ product_id: "56750193" });
    expect(response.status).toBe(401);
  });

  it("探測點看得出密鑰有沒有設", async () => {
    const response = await app.fetch(
      new Request("https://platform.rueisiang.com/api/webhooks/cyberbiz"),
      env as never,
    );
    expect(await response.json()).toMatchObject({ ok: true, configured: true });
  });
});

describe("處理", () => {
  it("官網的數量寫進 WMS，並留下一筆「系統」的紀錄", async () => {
    const calls = stubCyberbiz({ body: product({ quantity: 200 }) });

    const { json } = await post(
      { product_id: "56750193", variant_id: "68463869", sku: "BPK24004", inventory_quantity: 200 },
      { topic: "variants/update" },
    );

    expect(json).toMatchObject({
      status: "processed",
      productId: "56750193",
      sync: { updated: 1, unchanged: 0, failed: 0, linked: 1 },
    });

    const [item] = await db().select().from(wmsItems);
    expect(item?.quantity).toBe(200);

    const [event] = await db()
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.eventType, "cyberbiz_synced"));
    expect(event?.oldValue).toBe("178");
    expect(event?.newValue).toBe("200");
    // 沒有人按這一下，所以是系統做的——操作紀錄那一頁會顯示「系統」。
    expect(event?.actorType).toBe("system");

    // 只打官網一次，而且是重讀那個商品。
    expect(calls).toEqual([`${BASE}/v1/products/56750193`]);
  });

  /*
   * 這是整個檔案最重要的一條。
   *
   * 事件是簽章驗過的，但簽章只證明「是 CYBERBIZ 送的」，不證明「這個數字現在
   * 還是對的」——事件可能延遲、可能亂序。採信它等於讓事件自己證明自己。
   */
  it("**不採信 payload 的數量**：寫進去的是官網重讀回來的那個", async () => {
    stubCyberbiz({ body: product({ quantity: 200 }) });

    await post(
      // 事件說 999，官網說 200。
      { product_id: "56750193", variant_id: "68463869", sku: "BPK24004", inventory_quantity: 999 },
      { topic: "variants/update" },
    );

    const [item] = await db().select().from(wmsItems);
    expect(item?.quantity).toBe(200);
  });

  it("安全庫存也跟著官網走", async () => {
    stubCyberbiz({ body: product({ quantity: 200, safety: 50 }) });
    await post({ product_id: "56750193" }, { topic: "variants/update" });
    const [item] = await db().select().from(wmsItems);
    expect(item?.minStock).toBe(50);
  });

  it("只帶款式 id 時，從連結反查出商品 id", async () => {
    const calls = stubCyberbiz({ body: product({ quantity: 200 }) });
    // variants/update 的最上層 id 就是款式 id，沒有 product_id。
    const { json } = await post({ id: 68463869, sku: "BPK24004", inventory_quantity: 200 });

    expect(json).toMatchObject({ status: "processed", productId: "56750193" });
    expect(calls).toEqual([`${BASE}/v1/products/56750193`]);
    const [item] = await db().select().from(wmsItems);
    expect(item?.quantity).toBe(200);
  });

  it("數量沒變就不寫商品，但會留下最後同步時間", async () => {
    stubCyberbiz({ body: product({ quantity: 178, safety: 24 }) });
    const { json } = await post({ product_id: "56750193" }, { topic: "variants/update" });

    expect(json).toMatchObject({ sync: { updated: 0, unchanged: 1, failed: 0 } });
    const [event] = await db().select().from(activityEvents);
    expect(event).toMatchObject({ eventType: "cyberbiz_synced", field: "sync", source: "cyberbiz_sync" });
  });

  it("SKU 對不上時連結標成失敗，數量一動也不動", async () => {
    stubCyberbiz({ body: product({ quantity: 200, sku: "換過了" }) });
    const { json } = await post({ product_id: "56750193" }, { topic: "variants/update" });

    expect(json).toMatchObject({ status: "failed", sync: { updated: 0, failed: 1 } });
    const [event] = await db().select().from(cyberbizWebhookEvents);
    expect(event?.status).toBe("failed");
    const [item] = await db().select().from(wmsItems);
    expect(item?.quantity).toBe(178);
    const [activityEvent] = await db().select().from(activityEvents).where(eq(activityEvents.eventType, "cyberbiz_sync_failed"));
    expect(activityEvent?.status).toBe("failed");
  });
});

describe("不處理的", () => {
  it("沒連結到 WMS 的商品就跳過——官網幾千個商品絕大多數跟倉儲無關", async () => {
    const calls = stubCyberbiz({ body: product() });
    const { json } = await post({ product_id: "99999999" }, { topic: "variants/update" });

    expect(json).toMatchObject({ status: "ignored" });
    // 沒連結就連問都不必問官網。
    expect(calls).toHaveLength(0);
  });

  it("沒連結的款式 id 也一樣跳過", async () => {
    stubCyberbiz({ body: product() });
    const { json } = await post({ id: 111, sku: "沒看過" });
    expect(json).toMatchObject({ status: "ignored" });
  });

  it("認不出是哪個商品就記下來、不處理", async () => {
    stubCyberbiz();
    const { json } = await post({ sku: "只有 SKU", inventory_quantity: 5 });
    expect(json).toMatchObject({ status: "ignored" });
    expect(String(json.reason)).toContain("認不出");
  });

  /*
   * 這一條的期待反過來了。
   *
   * 以前商品與會員是兩個網址，會員事件打到商品那條就是打錯了，要擋下來。現在
   * 只有一個網址，兩種事件本來就都從這裡進來——會員事件要被**分派過去處理**，
   * 擋掉才是錯的。
   */
  it("會員事件從同一個網址進來時，分派到會員那條路", async () => {
    stubCyberbiz();
    const { json } = await post({ id: 7, mobile: "0912345678", name: "王小明" });

    expect(json).toMatchObject({ kind: "customer" });
    // 真的走完會員那條路：客戶建出來了，而且事件仍留在共用表。
    expect(await db().select().from(crmCustomers)).toHaveLength(1);
    const [event] = await db().select().from(cyberbizWebhookEvents);
    expect(event?.entityType).toBe("customer");
  });

  it("同一筆事件送兩次只處理一次", async () => {
    stubCyberbiz({ body: product({ quantity: 200 }) });
    const payload = { product_id: "56750193", variant_id: "68463869" };

    const first = await post(payload, { topic: "variants/update" });
    const second = await post(payload, { topic: "variants/update" });

    expect(first.json).toMatchObject({ status: "processed" });
    expect(second.json).toMatchObject({ status: "duplicate" });
    // 只有第一次留下紀錄。
    expect(await db().select().from(activityEvents)).toHaveLength(1);
  });
});

describe("失敗與補跑", () => {
  // 5xx 會重試三次（真的退避），所以這個案例慢——留一個就夠了，其他用 4xx。
  it("官網掛掉時記成 failed，但仍然回 200——不能讓 CYBERBIZ 用完重送次數", { timeout: 20_000 }, async () => {
    stubCyberbiz({ status: 500, body: { error: "系統有誤" } });
    const { response, json } = await post({ product_id: "56750193" }, { topic: "variants/update" });

    expect(response.status).toBe(200);
    expect(json).toMatchObject({ status: "failed" });

    const [row] = await db().select().from(cyberbizWebhookEvents);
    expect(row?.status).toBe("failed");
    expect(row?.entityType).toBe("product");
    expect(JSON.parse(row?.payloadJson ?? "{}").product_id).toBe("56750193");

    // 數量沒被亂寫。
    const [item] = await db().select().from(wmsItems);
    expect(item?.quantity).toBe(178);
  });

  it("補跑會把失敗的重新同步一次", async () => {
    // 用 401（token 過期）而不是 500：4xx 不重試，測試不必真的等退避的秒數。
    stubCyberbiz({ status: 401, body: { error: "token 過期" } });
    await post({ product_id: "56750193" }, { topic: "variants/update" });

    // 官網恢復了。
    vi.unstubAllGlobals();
    stubCyberbiz({ body: product({ quantity: 200 }) });

    const result = await retryFailedProductWebhooks(db(), {
      client: (await import("@rueisiang/cyberbiz")).createInventoryClient({
        apiToken: TOKEN,
        baseUrl: BASE,
      }),
    });

    expect(result).toMatchObject({ attempted: 1, processed: 1, failed: 0 });
    const [item] = await db().select().from(wmsItems);
    expect(item?.quantity).toBe(200);
    const [row] = await db().select().from(cyberbizWebhookEvents);
    expect(row?.status).toBe("processed");
    // 補跑算第二次嘗試。
    expect(row?.attempts).toBe(2);
  });

  it("補跑還是失敗就留在 failed，次數往上加", async () => {
    stubCyberbiz({ status: 401, body: { error: "token 過期" } });
    await post({ product_id: "56750193" }, { topic: "variants/update" });

    const result = await retryFailedProductWebhooks(db(), {
      client: (await import("@rueisiang/cyberbiz")).createInventoryClient({
        apiToken: TOKEN,
        baseUrl: BASE,
      }),
    });

    expect(result).toMatchObject({ attempted: 1, processed: 0, failed: 1 });
    const [row] = await db().select().from(cyberbizWebhookEvents);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(2);
  });

  it("沒有要補跑的時候什麼都不做", async () => {
    const result = await retryFailedProductWebhooks(db(), {});
    expect(result).toEqual({ attempted: 0, processed: 0, failed: 0 });
  });
});

/*
 * 一個網址收全部的事件，進來之後靠 payload 分派。
 *
 * 這一段釘的是「分派本身」：同一個網址、同一組驗證，兩種事件各自走到對的地方。
 * 分錯的後果很難看出來——商品事件被寫成客戶（真的發生過，建出一位叫
 * 「★潤白養膚小皂」的客人），或者庫存事件被安靜地忽略。
 */
describe("一個網址的分派", () => {
  /** 舊網址也送一次，兩邊的行為必須一模一樣。 */
  async function postTo(path: string, payload: unknown) {
    const body = JSON.stringify(payload);
    const response = await app.fetch(
      new Request(`https://platform.rueisiang.com${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cyberbiz-hmac-sha256": await hmac(SECRET, body),
        },
        body,
      }),
      env as never,
    );
    return { response, json: (await response.json()) as Record<string, unknown> };
  }

  it("商品事件走商品那條", async () => {
    stubCyberbiz({ body: product({ quantity: 200 }) });
    const { json } = await postTo("/api/webhooks/cyberbiz", {
      product_id: "56750193",
      inventory_quantity: 200,
    });

    expect(json).toMatchObject({ kind: "product", status: "processed" });
    const [item] = await db().select().from(wmsItems);
    expect(item?.quantity).toBe(200);
  });

  it("會員事件走會員那條", async () => {
    stubCyberbiz();
    const { json } = await postTo("/api/webhooks/cyberbiz", {
      id: 7,
      mobile: "0912345678",
      name: "王小明",
    });

    expect(json).toMatchObject({ kind: "customer" });
    expect(await db().select().from(crmCustomers)).toHaveLength(1);
  });

  /*
   * 舊網址不能斷。後台改設定與程式部署不可能同一秒發生，中間那段時間事件還是
   * 會從舊網址進來——掉在地上的話沒有任何跡象，只會安靜地不同步。
   */
  it("舊的 /cyberbiz/customers 仍然收，而且一樣會分派商品事件", async () => {
    stubCyberbiz({ body: product({ quantity: 200 }) });
    const { json } = await postTo("/api/webhooks/cyberbiz/customers", {
      product_id: "56750193",
      inventory_quantity: 200,
    });

    expect(json).toMatchObject({ kind: "product", status: "processed" });
    const [item] = await db().select().from(wmsItems);
    expect(item?.quantity).toBe(200);
  });

  /*
   * payload 看不出來的時候才看 topic。
   *
   * 只有 id 的事件兩邊的欄位都對不上，這時 variants/update 這個標頭是唯一的線索。
   * 反過來不成立：有 topic 但 payload 明確是會員的，以 payload 為準。
   */
  it("payload 看不出來時，topic 說是商品就走商品那條", async () => {
    stubCyberbiz({ body: product({ quantity: 200 }) });
    const body = JSON.stringify({ id: 68463869 });
    const response = await app.fetch(
      new Request("https://platform.rueisiang.com/api/webhooks/cyberbiz", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cyberbiz-topic": "variants/update",
          "x-cyberbiz-hmac-sha256": await hmac(SECRET, body),
        },
        body,
      }),
      env as never,
    );

    expect(await response.json()).toMatchObject({ kind: "product", status: "processed" });
  });

  it("壞掉的 JSON 回 400，不是 500——那是對方送錯，不是我們壞了", async () => {
    const body = "{ 這不是 JSON";
    const response = await app.fetch(
      new Request("https://platform.rueisiang.com/api/webhooks/cyberbiz", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cyberbiz-hmac-sha256": await hmac(SECRET, body),
        },
        body,
      }),
      env as never,
    );

    expect(response.status).toBe(400);
  });

  it("探測點兩個網址都活著", async () => {
    for (const path of ["/api/webhooks/cyberbiz", "/api/webhooks/cyberbiz/customers"]) {
      const response = await app.fetch(
        new Request(`https://platform.rueisiang.com${path}`),
        env as never,
      );
      expect(await response.json()).toMatchObject({ ok: true, configured: true });
    }
  });
});

/*
 * Codex review 抓到的三件事，各自釘一條。
 *
 * 三件的共通點是「安靜地壞掉」：事件收到了、回 200、看起來一切正常，但資料
 * 沒同步或畫面上的數字是舊的。沒有測試的話下次改到附近不會有人發現。
 */
describe("review 抓到的回歸", () => {
  it("包在 data 裡的商品事件不會被誤送到會員那條路", async () => {
    stubCyberbiz({ body: product({ quantity: 200 }) });
    // 沒有 topic 標頭，欄位全部包在 data 裡——修正前這會被判成認不出來。
    const { json } = await post({ data: { product_id: "56750193", inventory_quantity: 200 } });

    expect(json).toMatchObject({ kind: "product", status: "processed" });
    const [item] = await db().select().from(wmsItems);
    expect(item?.quantity).toBe(200);
  });

  it("包在 product_variant 裡的也一樣", async () => {
    stubCyberbiz({ body: product({ quantity: 200 }) });
    const { json } = await post({
      product_variant: { id: 68463869, sku: "BPK24004", inventory_quantity: 200 },
    });

    expect(json).toMatchObject({ kind: "product", status: "processed" });
    const [item] = await db().select().from(wmsItems);
    expect(item?.quantity).toBe(200);
  });

  /*
   * 只帶款式 id 的事件也要完整落在共用表；即使第一次重讀失敗，原始 payload
   * 仍然保留，Cron 補跑時可以再用 variant id 反查商品。
   */
  it("只帶款式 id 又重讀失敗時，事件仍保留可補跑的 payload", async () => {
    stubCyberbiz({ status: 401, body: { error: "token 過期" } });
    const { json } = await post({ id: 68463869, sku: "BPK24004", inventory_quantity: 200 });

    expect(json).toMatchObject({ status: "failed" });
    const [row] = await db().select().from(cyberbizWebhookEvents);
    expect(row?.entityType).toBe("product");
    expect(JSON.parse(row?.payloadJson ?? "{}").id).toBe(68463869);
  });

  it("所以補跑救得回來", async () => {
    stubCyberbiz({ status: 401, body: { error: "token 過期" } });
    await post({ id: 68463869, sku: "BPK24004", inventory_quantity: 200 });

    vi.unstubAllGlobals();
    stubCyberbiz({ body: product({ quantity: 200 }) });
    const result = await retryFailedProductWebhooks(db(), {
      client: (await import("@rueisiang/cyberbiz")).createInventoryClient({
        apiToken: TOKEN,
        baseUrl: BASE,
      }),
    });

    expect(result).toMatchObject({ attempted: 1, processed: 1, failed: 0 });
    const [item] = await db().select().from(wmsItems);
    expect(item?.quantity).toBe(200);
  });

  /*
   * 目錄快取列的是官網公司倉的**全部**商品，不是只有連到 WMS 的那些。
   * 所以只在 processed 時清快取不夠——沒連結所以 ignored 的事件同樣代表
   * 某個快取數字過期了，而快取的 TTL 是一整天。
   */
  describe("目錄快取要清掉", () => {
    const REDIS = "https://redis.example.test";

    /** 攔下所有請求，把送去 Upstash 的指令記下來。 */
    function stubAll(productBody: unknown) {
      const redis: unknown[] = [];
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (String(url).startsWith(REDIS)) {
          redis.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ result: 1 }), { status: 200 });
        }
        return new Response(JSON.stringify(productBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      return redis;
    }

    beforeEach(() => {
      env.UPSTASH_REDIS_REST_URL = REDIS;
      env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
    });

    it("有寫進庫存時會清", async () => {
      const redis = stubAll(product({ quantity: 200 }));
      await post({ product_id: "56750193" }, { topic: "variants/update" });
      expect(redis).toContainEqual(["DEL", "cyberbiz:catalog:company"]);
    });

    it("**沒連結所以 ignored 也要清**——那一頁列的是官網全部的商品", async () => {
      const redis = stubAll(product());
      const { json } = await post({ product_id: "99999999" }, { topic: "variants/update" });

      expect(json).toMatchObject({ status: "ignored" });
      expect(redis).toContainEqual(["DEL", "cyberbiz:catalog:company"]);
    });

    it("同一筆送第二次不用再清一次", async () => {
      stubAll(product({ quantity: 200 }));
      await post({ product_id: "56750193" }, { topic: "variants/update" });

      const redis = stubAll(product({ quantity: 200 }));
      const { json } = await post({ product_id: "56750193" }, { topic: "variants/update" });

      expect(json).toMatchObject({ status: "duplicate" });
      expect(redis).toHaveLength(0);
    });

    it("會員事件不會去動商品的快取", async () => {
      const redis = stubAll({});
      await post({ id: 7, mobile: "0912345678", name: "王小明" });
      expect(redis).toHaveLength(0);
    });
  });

  it("processing lease 逾時的商品事件會重新進入補跑", async () => {
    await db().insert(cyberbizWebhookEvents).values({
      id: "stale-event",
      topic: "variants/update",
      entityType: "product",
      externalEntityId: "68463869",
      payloadJson: JSON.stringify({ id: 68463869, sku: "BPK24004", inventory_quantity: 200 }),
      status: "processing",
      updatedAt: "2000-01-01 00:00:00",
    });
    stubCyberbiz({ body: product({ quantity: 200 }) });

    const result = await retryFailedProductWebhooks(db(), {
      client: (await import("@rueisiang/cyberbiz")).createInventoryClient({
        apiToken: TOKEN,
        baseUrl: BASE,
      }),
    });

    expect(result).toMatchObject({ processed: 1, failed: 0 });
    const [row] = await db().select().from(cyberbizWebhookEvents);
    expect(row?.status).toBe("processed");
  });

  it("共用事件表的商品 payload 可以補跑", async () => {
    await db().insert(cyberbizWebhookEvents).values({
      id: "old-event",
      topic: "variants/update",
      entityType: "product",
      externalEntityId: "68463869",
      payloadJson: JSON.stringify({ id: 68463869, sku: "BPK24004", inventory_quantity: 200 }),
      status: "failed",
    });
    stubCyberbiz({ body: product({ quantity: 200 }) });

    const result = await retryFailedProductWebhooks(db(), {
      client: (await import("@rueisiang/cyberbiz")).createInventoryClient({
        apiToken: TOKEN,
        baseUrl: BASE,
      }),
    });

    expect(result).toMatchObject({ processed: 1, failed: 0 });
    const [item] = await db().select().from(wmsItems);
    expect(item?.quantity).toBe(200);
    const [row] = await db().select().from(cyberbizWebhookEvents);
    expect(row?.status).toBe("processed");
  });
});
