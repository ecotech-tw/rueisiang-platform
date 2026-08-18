import { afterEach, describe, expect, it, vi } from "vitest";
import { CyberbizApiError, cyberbizRequest, readErrorMessage } from "./http.js";
import { createCustomerClient, parseCyberbizCustomer } from "./customers.js";

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
  it("建立會員送到 POST /v1/customers", async () => {
    const calls = stubFetch({ body: { customer: { id: 7, mobile: "0912345678" } } });
    const client = createCustomerClient(config, { sleep: noSleep });

    const created = await client.create({
      phone: "0912345678",
      name: "王小明",
      email: "wang@example.com",
      address: "台北市大安區",
      tags: ["VIP"],
    });

    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.example.test/v1/customers");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      customer: { mobile: "0912345678", name: "王小明", tags: ["VIP"] },
    });
    expect(created.externalId).toBe("7");
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

  it("封鎖只送 blocked，不會順手覆寫其他欄位", async () => {
    const calls = stubFetch({ body: { id: 1, blocked: true } });
    await createCustomerClient(config).setBlocked("1", true);

    expect(calls[0]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ customer: { blocked: true } });
  });

  it("改標籤只送 tags", async () => {
    const calls = stubFetch({ body: { id: 1 } });
    await createCustomerClient(config).updateTags("1", ["熟客"]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ customer: { tags: ["熟客"] } });
  });
});
