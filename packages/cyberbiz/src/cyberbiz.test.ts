import { afterEach, describe, expect, it, vi } from "vitest";
import { CyberbizApiError, cyberbizRequest, readErrorMessage } from "./http.js";
import { createCustomerClient, parseCyberbizCustomer } from "./customers.js";
import { createInventoryClient, flattenProducts, isCompanyProduct } from "./inventory.js";
import { classifyPayload, parseProductEvent } from "./webhook.js";

const config = { apiToken: "test-token", baseUrl: "https://api.example.test" };
/** 測試不要真的等指數退避的秒數。 */
const noSleep = async () => {};

function stubFetch(...responses: { status?: number; body?: unknown; headers?: Record<string, string> }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    // 回應用完就一直重複最後一筆，這樣「重試三次都失敗」只要寫一筆。
    const spec = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    return new Response(spec.body === undefined ? "" : JSON.stringify(spec.body), {
      status: spec.status ?? 200,
      headers: spec.headers,
    });
  });

  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("傳輸層", () => {
  it("帶上 Bearer token 與 Accept", async () => {
    const calls = stubFetch({ body: { ok: true } });
    await cyberbizRequest(config, "/v1/ping");

    expect(calls[0]?.url).toBe("https://api.example.test/v1/ping");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers.Accept).toBe("application/json");
  });

  it("沒有 token 就直接拒絕，不要送出一個註定失敗的請求", async () => {
    stubFetch({ body: {} });
    await expect(cyberbizRequest({ apiToken: "" }, "/v1/ping")).rejects.toThrow("尚未設定 CYBERBIZ_API_TOKEN");
  });

  it("baseUrl 結尾的斜線不會變成雙斜線", async () => {
    const calls = stubFetch({ body: {} });
    await cyberbizRequest({ apiToken: "t", baseUrl: "https://api.example.test/" }, "/v1/ping");
    expect(calls[0]?.url).toBe("https://api.example.test/v1/ping");
  });

  it("429 會重試，成功之後回結果", async () => {
    const calls = stubFetch({ status: 429, body: { error: "太快了" } }, { body: { ok: true } });
    const result = await cyberbizRequest(config, "/v1/ping", { sleep: noSleep });

    expect(calls).toHaveLength(2);
    expect(result.payload).toEqual({ ok: true });
  });

  it("5xx 重試到次數用完才丟出來", async () => {
    const calls = stubFetch({ status: 502, body: { error: "上游掛了" } });
    await expect(cyberbizRequest(config, "/v1/ping", { retries: 2, sleep: noSleep })).rejects.toThrow(
      "CYBERBIZ API 502",
    );
    expect(calls).toHaveLength(3);
  });

  it("4xx 不重試——送錯的東西再送幾次都一樣", async () => {
    const calls = stubFetch({ status: 422, body: { errors: { mobile: ["已存在"] } } });
    await expect(cyberbizRequest(config, "/v1/customers", { sleep: noSleep })).rejects.toThrow("已存在");
    expect(calls).toHaveLength(1);
  });

  it("錯誤帶得出 status 與是否值得重試", async () => {
    stubFetch({ status: 429, body: { error: "慢一點" } });
    const error = await cyberbizRequest(config, "/v1/ping", { retries: 0 }).catch((e) => e);

    expect(error).toBeInstanceOf(CyberbizApiError);
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
  });

  it("回應不是 JSON 時不會炸掉，內容留在訊息裡", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    await expect(cyberbizRequest(config, "/v1/ping", { retries: 0 })).rejects.toThrow("502 Bad Gateway");
  });
});

describe("錯誤訊息", () => {
  it.each([
    ["字串", { error: "電話重複" }, "電話重複"],
    ["陣列", { errors: ["電話重複", "信箱格式錯誤"] }, "電話重複、信箱格式錯誤"],
    ["欄位對應", { errors: { mobile: ["已存在"], email: ["格式錯誤"] } }, "已存在、格式錯誤"],
    ["撈不到", { something: 1 }, "請求失敗"],
  ])("看得懂 %s 形式", (_label, payload, expected) => {
    expect(readErrorMessage(payload)).toBe(expected);
  });

  it("重複的訊息只留一則", () => {
    expect(readErrorMessage({ error: "重複", message: "重複" })).toBe("重複");
  });
});

describe("會員資料解析", () => {
  it("包在 customer 底下也讀得到", () => {
    const parsed = parseCyberbizCustomer({ customer: { id: 42, mobile: "0912345678" } });
    expect(parsed.externalId).toBe("42");
    expect(parsed.phone).toBe("0912345678");
  });

  it("只認 mobile 當會員電話——address 裡那支是收件人的", () => {
    const parsed = parseCyberbizCustomer({
      id: 1,
      mobile: "0911111111",
      address: { phone: "0922222222", address1: "台北市" },
    });
    expect(parsed.phone).toBe("0911111111");
  });

  it("沒有 name 時用姓＋名組起來", () => {
    expect(parseCyberbizCustomer({ id: 1, last_name: "王", first_name: "小明" }).name).toBe("王小明");
  });

  it("「未命名會員」當成沒有名字", () => {
    expect(parseCyberbizCustomer({ id: 1, name: "未命名會員" }).name).toBe("");
  });

  it.each([
    ["逗號字串", { tags_text: "VIP, 熟客 ," }, ["VIP", "熟客"]],
    ["字串陣列", { tags: ["VIP", " 熟客 "] }, ["VIP", "熟客"]],
    ["物件陣列", { tags: [{ name: "VIP" }, { title: "熟客" }] }, ["VIP", "熟客"]],
    ["沒有標籤", { id: 1 }, []],
  ])("標籤可以是%s", (_label, payload, expected) => {
    expect(parseCyberbizCustomer({ id: 1, ...payload }).tags).toEqual(expected);
  });

  it.each([
    ["blocked 旗標", { blocked: true }],
    ["blacklisted 旗標", { blacklisted: true }],
    ["status 是 blocked", { status: "blocked" }],
    ["state 是 disabled", { state: "disabled" }],
  ])("封鎖判定認得%s", (_label, payload) => {
    expect(parseCyberbizCustomer({ id: 1, ...payload }).blocked).toBe(true);
  });

  it("沒有時區的時間當成台北時間，不是 UTC", () => {
    // 差八小時：當成 UTC 的話會變成 2026-08-18T10:30:00Z。
    const parsed = parseCyberbizCustomer({ id: 1, updated_at: "2026-08-18 10:30:00" });
    expect(parsed.updatedAt).toBe("2026-08-18T02:30:00.000Z");
  });

  it("已經帶時區的時間原樣換算", () => {
    const parsed = parseCyberbizCustomer({ id: 1, updated_at: "2026-08-18T10:30:00Z" });
    expect(parsed.updatedAt).toBe("2026-08-18T10:30:00.000Z");
  });

  it("地址把巢狀欄位串起來且不重複", () => {
    const parsed = parseCyberbizCustomer({
      id: 1,
      address: { detail_address: { zip: "106", city: "台北市", district: "大安區", address1: "忠孝東路四段 1 號" } },
    });
    expect(parsed.address).toBe("106 台北市 大安區 忠孝東路四段 1 號");
  });

  it("原始 payload 留著，欄位對不上時可以回頭查", () => {
    const parsed = parseCyberbizCustomer({ id: 1, weird_field: "?" });
    expect(parsed.raw.weird_field).toBe("?");
  });
});

describe("會員操作", () => {
  it("建立會員送到 POST /v1/customers，欄位在最上層", async () => {
    const calls = stubFetch({ body: { customer: { id: 7, mobile: "0912345678" } } });
    const client = createCustomerClient(config, { sleep: noSleep });

    const created = await client.create({
      phone: "0912345678",
      name: "王小明",
      email: "wang@example.com",
      address: "台北市大安區",
      city: "台北市",
      district: "大安區",
      addressLine: "忠孝東路四段 1 號",
      tags: ["VIP"],
    });

    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.example.test/v1/customers");
    const sent = JSON.parse(String(calls[0]?.init.body));
    // 包在 customer 底下的話 CYBERBIZ 一個欄位都讀不到，這是實際踩過的坑。
    expect(sent.customer).toBeUndefined();
    expect(sent).toMatchObject({
      mobile: "0912345678",
      name: "王小明",
      email: "wang@example.com",
      tags_text: "VIP",
      address: { phone: "0912345678", address1: "忠孝東路四段 1 號", city: "台北市", district: "大安區" },
    });
    expect(created.externalId).toBe("7");
  });

  it("建立時補上 CYBERBIZ 必填但這邊用不到的欄位", async () => {
    const calls = stubFetch({ body: { customer: { id: 7 } } });
    await createCustomerClient(config, { sleep: noSleep }).create({
      phone: "0900000002",
      name: "",
      email: "",
      address: "",
    });

    const sent = JSON.parse(String(calls[0]?.init.body));
    // 只填電話也要建得起來——這是這張表單唯一的必填欄位。
    expect(sent.name).toBe("未命名會員");
    expect(String(sent.password)).toMatch(/^Ruei!/);
    expect(sent.enable_cvs_pickup).toBe(false);
    expect(sent.accepts_marketing).toBe(false);
    // 沒填的不要送空字串過去，官網會判成「email 為空」。
    expect(sent.email).toBeUndefined();
  });

  it("更新時不會幫官網原本沒有電話的會員補上", async () => {
    const calls = stubFetch(
      { body: { customer: { id: 7, name: "王小明" } } },
      { body: { customer: { id: 7 } } },
    );
    await createCustomerClient(config, { sleep: noSleep }).update("7", {
      phone: "0912345678",
      name: "王小明",
      email: "",
      address: "台北市",
    });

    // 第一次是讀現況，第二次才是寫入。
    expect(calls[1]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[1]?.init.body)).mobile).toBeUndefined();
  });

  it("更新時官網已經有電話就照送", async () => {
    const calls = stubFetch(
      { body: { customer: { id: 7, mobile: "0912345678" } } },
      { body: { customer: { id: 7 } } },
    );
    await createCustomerClient(config, { sleep: noSleep }).update("7", {
      phone: "0987654321",
      name: "王小明",
      email: "",
      address: "台北市",
    });

    expect(JSON.parse(String(calls[1]?.init.body)).mobile).toBe("0987654321");
  });

  it("更新時建立用的欄位不會再送一次", async () => {
    const calls = stubFetch(
      { body: { customer: { id: 7, mobile: "09" } } },
      { body: { customer: { id: 7 } } },
    );
    await createCustomerClient(config, { sleep: noSleep }).update("7", {
      phone: "0912345678",
      name: "王小明",
      email: "",
      address: "台北市",
    });

    // 再送一次 password 等於把客戶的密碼改掉。
    expect(JSON.parse(String(calls[1]?.init.body)).password).toBeUndefined();
  });

  it("外部 ID 有做 URL 編碼", async () => {
    const calls = stubFetch({ body: { id: 1 } });
    await createCustomerClient(config).fetchOne("a/b?c");
    expect(calls[0]?.url).toBe("https://api.example.test/v1/customers/a%2Fb%3Fc");
  });

  it("分頁的總數優先看 header", async () => {
    stubFetch({
      body: { customers: [{ id: 1, mobile: "09" }] },
      headers: { "x-total-pages": "5", "x-total-count": "230" },
    });

    const page = await createCustomerClient(config).fetchPage(2, 50);
    expect(page.totalPages).toBe(5);
    expect(page.totalCustomers).toBe(230);
    expect(page.customers).toHaveLength(1);
  });

  it("header 沒帶就退回 body 或筆數，不要變成 0 頁", async () => {
    stubFetch({ body: { customers: [{ id: 1 }, { id: 2 }] } });
    const page = await createCustomerClient(config).fetchPage();
    expect(page.totalPages).toBe(1);
    expect(page.totalCustomers).toBe(2);
  });

  it("封鎖是改 status，不會順手覆寫其他欄位", async () => {
    const calls = stubFetch({ body: { id: 1, status: "disabled" } });
    await createCustomerClient(config).setBlocked("1", true);

    expect(calls[0]?.init.method).toBe("PUT");
    // 官網沒有 blocked 欄位，送它等於什麼都沒做。
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ status: "disabled" });
  });

  it("改標籤只送 tags_text，逗號分隔", async () => {
    const calls = stubFetch({ body: { id: 1 } });
    const updated = await createCustomerClient(config).updateTags("1", ["熟客", " 熟客 ", "VIP", ""]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ tags_text: "熟客,VIP" });
    // 去掉前後空白與重複之後才是實際存進去的內容。
    expect(updated.tags).toEqual(["熟客", "VIP"]);
  });
});

/*
 * 商品庫存。
 *
 * 這一段是真的把正式站打壞之後才補的：`/v1/products/{id}` 不回 `id`，
 * flattenProducts 就把整個商品丟掉，於是「盤點推上官網」與「官網同步回 WMS」
 * 兩條路一起死，錯誤訊息還說是 SKU 對不上。假資料當時每一筆都帶著 id——
 * 又一次照抄了自己的假設。
 */
describe("商品庫存", () => {
  /** 官網對 /v1/products/{id} 真正回的形狀：有 product_variants，但沒有 id。 */
  const PRODUCT_WITHOUT_ID = {
    title: "干貝XO醬",
    published: true,
    pos_shop: null,
    product_variants: [
      {
        id: 68463869,
        name: "干貝XO醬 -",
        sku: "BPK24004",
        inventory_quantity: 190,
        safety_inventory_quantity: 24,
        inventory_management: true,
      },
    ],
  };

  it("回應裡沒有 id 時，用問的時候就知道的那個補上", async () => {
    stubFetch({ body: PRODUCT_WITHOUT_ID });
    const items = await createInventoryClient(config).fetchProduct("56750193");

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      productId: "56750193",
      variantId: "68463869",
      sku: "BPK24004",
      quantity: 190,
      safetyQuantity: 24,
    });
    // pos_shop 是 null 代表公司倉，門市才會有值。
    expect(isCompanyProduct(items[0]!)).toBe(true);
  });

  it("官網真的回了 id 就以它為準", async () => {
    stubFetch({ body: { ...PRODUCT_WITHOUT_ID, id: 99 } });
    const [item] = await createInventoryClient(config).fetchProduct("56750193");
    expect(item?.productId).toBe("99");
  });

  it("被包在 product 底下也讀得到", async () => {
    stubFetch({ body: { product: PRODUCT_WITHOUT_ID } });
    const [item] = await createInventoryClient(config).fetchProduct("56750193");
    expect(item?.variantId).toBe("68463869");
  });

  it("盤點推得上去：讀現況、送差額、再讀一次驗證", async () => {
    const calls = stubFetch(
      { body: PRODUCT_WITHOUT_ID },
      { body: { ok: true } },
      { body: { ...PRODUCT_WITHOUT_ID, product_variants: [{ ...PRODUCT_WITHOUT_ID.product_variants[0], inventory_quantity: 200 }] } },
    );

    const result = await createInventoryClient(config).setCompanyQuantity({
      productId: "56750193",
      variantId: "68463869",
      sku: "BPK24004",
      targetQuantity: 200,
    });

    expect(result).toMatchObject({ previousQuantity: 190, quantity: 200, changed: true });
    // 官網收的是差額，不是「設成 200」。190 → 200 是 surplus 10。
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      pos_shop_id: 0,
      items: [{ sku: "BPK24004", quantity: 10, type: "surplus" }],
    });
  });

  it("數量一樣就不送調整，也不算動過", async () => {
    const calls = stubFetch({ body: PRODUCT_WITHOUT_ID });
    const result = await createInventoryClient(config).setCompanyQuantity({
      productId: "56750193",
      variantId: "68463869",
      sku: "BPK24004",
      targetQuantity: 190,
    });

    expect(result.changed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("送完之後對不上就丟錯，不留下「以為同步過了」的狀態", async () => {
    stubFetch(
      { body: PRODUCT_WITHOUT_ID },
      { body: { ok: true } },
      // 重讀還是 190：官網收了但沒真的照做。
      { body: PRODUCT_WITHOUT_ID },
    );

    await expect(
      createInventoryClient(config).setCompanyQuantity({
        productId: "56750193",
        variantId: "68463869",
        sku: "BPK24004",
        targetQuantity: 200,
      }),
    ).rejects.toThrow("重新讀取是 190");
  });

  it("SKU 真的對不上時才說連結失效", async () => {
    stubFetch({ body: PRODUCT_WITHOUT_ID });
    await expect(
      createInventoryClient(config).setCompanyQuantity({
        productId: "56750193",
        variantId: "68463869",
        sku: "換過了",
        targetQuantity: 200,
      }),
    ).rejects.toThrow("連結已失效");
  });

  it("列表端點：門市的商品濾得掉", () => {
    const items = flattenProducts([
      { id: 1, title: "公司倉", pos_shop: null, product_variants: [{ id: 11, sku: "A" }] },
      { id: 2, title: "門市", pos_shop: { id: 7, name: "中山店" }, product_variants: [{ id: 22, sku: "A" }] },
    ]);
    expect(items.filter(isCompanyProduct).map((item) => item.variantId)).toEqual(["11"]);
  });
});

/*
 * 分類要看得跟解析一樣深。
 *
 * Codex review 抓到的：parseProductEvent 會挖 data／variant／product_variant，
 * 但 classifyPayload 只看最上層。差在這一層的事件會被判成「認不出來」，送去
 * 會員那條路記成 ignored，然後永遠不同步——而且過程中不會有任何錯誤訊息。
 */
describe("事件分類的深度", () => {
  const variant = { id: 68463869, sku: "BPK24004", inventory_quantity: 200 };

  it("包在 data 裡的商品事件認得出來", () => {
    expect(classifyPayload({ data: { product_id: "56750193", ...variant } })).toBe("product");
  });

  it("包在 product_variant 裡的也認得出來", () => {
    expect(classifyPayload({ product_variant: variant })).toBe("product");
  });

  it("包在 variant 裡的也認得出來", () => {
    expect(classifyPayload({ variant })).toBe("product");
  });

  it("包在 product 裡的也認得出來", () => {
    expect(classifyPayload({ product: { id: 1, sku: "X" } })).toBe("product");
  });

  it("分類挖的位置跟 parseProductEvent 一致", () => {
    // 這一條是規則本身：解析得出款式 id 的，分類就不該說「認不出來」。
    for (const payload of [
      { data: { variant_id: 68463869, inventory_quantity: 1 } },
      { variant: { id: 68463869, sku: "A" } },
      { product_variant: { id: 68463869, sku: "A" } },
      { product: { id: 56750193 }, sku: "A" },
    ]) {
      expect(parseProductEvent(payload).variantId || parseProductEvent(payload).productId).toBeTruthy();
      expect(classifyPayload(payload)).toBe("product");
    }
  });

  it("包在 customer 裡的會員事件仍然認得出來", () => {
    expect(classifyPayload({ customer: { id: 7, mobile: "0912345678" } })).toBe("customer");
  });

  it("兩邊都對不上就是認不出來", () => {
    expect(classifyPayload({ id: 7, name: "看不出是什麼" })).toBe("unknown");
  });
});
