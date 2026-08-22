import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { appendAssistantSandboxMessage, createDatabase, syncSystemRoles } from "@rueisiang/db";
import { activityEvents, customerTagCatalog, customers, inventoryItems, layoutElements, userRoles, users } from "@rueisiang/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "assistant-test-secret";
let d1: LocalD1;
let env: Record<string, unknown>;

function db() {
  return createDatabase(d1 as never);
}

async function seedUser(id: string, email: string, roleId: string) {
  await db().insert(users).values({ id, email, name: email, status: "active" });
  await db().insert(userRoles).values({ userId: id, roleId });
}

async function cookieFor(id: string, email: string) {
  const token = await signSession(
    newSessionClaims({ id, email, name: "測試管理者", pictureUrl: "" }),
    SECRET,
  );
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

async function call(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`https://platform.rueisiang.com${path}`, init), env as never);
}

async function as(id: string, email: string, path: string, init: RequestInit = {}) {
  return call(path, {
    ...init,
    headers: { Cookie: await cookieFor(id, email), "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

beforeEach(async () => {
  d1 = createLocalD1();
  env = {
    DB: d1,
    AUTH_SESSION_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    GEMINI_API_KEY: "test-key",
    CYBERBIZ_API_TOKEN: "cyberbiz-test-token",
  };
  await syncSystemRoles(db());
  vi.restoreAllMocks();
});

describe("AI 助理 Sandbox", () => {
  it("需要登入與 Sandbox 權限", async () => {
    expect((await call("/api/assistant/sandbox/config")).status).toBe(401);

    await seedUser("staff", "staff@ecotech.tw", "role-staff");
    expect((await as("staff", "staff@ecotech.tw", "/api/assistant/sandbox/config")).status).toBe(403);
  });

  it("回傳模型、tool 與預設 prompt", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config");
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      configured: boolean;
      activeModel: string;
      models: Array<{ id: string }>;
      tools: Array<{ key: string; status: string }>;
      activePrompt: { revision: number; isActive: boolean };
    };
    expect(result.configured).toBe(true);
    expect(result.activeModel).toBe("gemini-3.6-flash");
    expect(result.models.some((model) => model.id === "gemini-3.6-flash")).toBe(true);
    expect(result.tools.map((tool) => tool.key)).toEqual([
      "weather_open_meteo",
      "wms_list_inventory",
      "wms_search_warehouse",
      "wms_get_inventory_item",
      "wms_list_low_stock_items",
      "wms_get_activity",
      "crm_search_customers",
      "crm_get_customer",
      "crm_get_orders",
    ]);
    expect(result.tools.find((tool) => tool.key === "wms_search_warehouse")).toMatchObject({
      label: "WMS 搜尋倉庫位置",
      status: "development",
      surfaces: ["sandbox", "line", "mcp"],
      requiredPermissions: ["wms:inventory:read", "wms:map:read"],
    });
    expect(result.tools.find((tool) => tool.key === "crm_search_customers")).toMatchObject({
      label: "CRM 搜尋客戶",
      status: "development",
      surfaces: ["sandbox", "line", "mcp"],
      requiredPermissions: ["crm:customer:read"],
    });
    expect(result.tools.find((tool) => tool.key === "crm_get_orders")).toMatchObject({
      status: "development",
      surfaces: ["sandbox", "mcp"],
      requiredPermissions: ["crm:order:read"],
    });
    expect(result.activePrompt).toMatchObject({ revision: 1, isActive: true });
  });

  it("儲存 prompt 時建立 revision 並立即啟用", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/prompts", {
      method: "POST",
      body: JSON.stringify({ systemPrompt: "你是新的測試 prompt。" }),
    });
    expect(response.status).toBe(201);

    const config = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config");
    const result = (await config.json()) as { activePrompt: { revision: number; systemPrompt: string; isActive: boolean } };
    expect(result.activePrompt).toMatchObject({ revision: 2, systemPrompt: "你是新的測試 prompt。", isActive: true });
  });

  it("儲存 active model 後，小香的後續執行會使用新模型", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const saved = await as("admin", "admin@ecotech.tw", "/api/assistant/config", {
      method: "PATCH",
      body: JSON.stringify({ model: "gemini-3.1-flash-lite" }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ activeModel: "gemini-3.1-flash-lite" });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "已使用新模型。" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ toolKeys: [], input: "測試 active model" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: "gemini-3.1-flash-lite", text: "已使用新模型。" });
  });

  it("可以從小香設定更新 tool 狀態", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/tools/weather_open_meteo", {
      method: "PATCH",
      body: JSON.stringify({ status: "enabled" }),
    });
    expect(response.status).toBe(200);

    const config = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config");
    const result = (await config.json()) as { tools: Array<{ key: string; status: string }> };
    expect(result.tools.find((tool) => tool.key === "weather_open_meteo")).toMatchObject({
      key: "weather_open_meteo",
      label: "Open-Meteo 天氣查詢",
      status: "enabled",
    });
  });

  it("Sandbox 可以透過共用 registry 搜尋 WMS 商品與位置", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    await db().insert(inventoryItems).values({
      id: "wms-item-1",
      sku: "BOX-001",
      name: "紙箱",
      category: "一般備品",
      quantity: 3,
      minStock: 5,
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      const hasToolResult = JSON.stringify(body.contents).includes("wms-item-1");
      if (hasToolResult) expect(JSON.stringify(body.contents)).toContain("call-wms-1");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: hasToolResult
          ? [{ text: "紙箱目前有 3 件，低於安全庫存 5 件。" }]
          : [{ functionCall: { id: "call-wms-1", name: "wms_search_warehouse", args: { query: "紙箱", scope: "inventory", limit: "10" } } }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", toolKeys: ["wms_search_warehouse"], input: "查詢紙箱庫存" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "紙箱目前有 3 件，低於安全庫存 5 件。",
      toolCalls: [{ toolKey: "wms_search_warehouse", status: "success" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Sandbox 可以透過 WMS list tool 取得商品清單做 mapping", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    await db().insert(inventoryItems).values([
      { id: "mapping-1", sku: "BOX-001", name: "紙箱", category: "一般備品", quantity: 3, minStock: 5 },
      { id: "mapping-2", sku: "TAPE-001", name: "封箱膠帶", category: "一般備品", quantity: 8, minStock: 5 },
    ]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      const hasToolResult = JSON.stringify(body.contents).includes("mapping-1")
        && JSON.stringify(body.contents).includes("mapping-2");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: hasToolResult
          ? [{ text: "已取得 2 筆商品，可繼續做 SKU mapping。" }]
          : [{ functionCall: { name: "wms_list_inventory", args: { page: "1", pageSize: "100" } } }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", toolKeys: ["wms_list_inventory"], input: "列出所有商品" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "已取得 2 筆商品，可繼續做 SKU mapping。",
      toolCalls: [{ toolKey: "wms_list_inventory", status: "success" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Sandbox 可以查詢 WMS 地圖標籤與相對位置", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    await db().insert(layoutElements).values([
      {
        id: "map-label-1",
        label: "冷藏區",
        color: "sky",
        x: 12,
        y: 18,
        width: 20,
        height: 10,
      },
      {
        id: "map-label-2",
        label: "大門入口",
        color: "rose",
        x: 40,
        y: 18,
        width: 12,
        height: 10,
      },
    ]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      const hasToolResult = JSON.stringify(body.contents).includes("map-label-1")
        && JSON.stringify(body.contents).includes("右側");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: hasToolResult
          ? [{ text: "冷藏區在大門入口的左側。" }]
          : [{ functionCall: { name: "wms_search_warehouse", args: { query: "冷藏", scope: "map" } } }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", toolKeys: ["wms_search_warehouse"], input: "冷藏區入口在哪裡？" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "冷藏區在大門入口的左側。",
      toolCalls: [{ toolKey: "wms_search_warehouse", status: "success" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Sandbox 可以透過共用 registry 查詢 CRM 客戶與背景", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    await db().insert(customers).values({
      id: "crm-customer-1",
      phone: "0912-345-678",
      normalizedPhone: "0912345678",
      name: "王小明",
      email: "ming@example.com",
      address: "台北市中山區測試路 1 號",
      cyberbizCustomerId: "cyberbiz-1",
      cyberbizTagsJson: JSON.stringify(["VIP", "北區"]),
      cyberbizRawJson: JSON.stringify({ secret: "should-not-leak" }),
      syncStatus: "synced",
      createdAt: "2026-08-20 16:30:00",
      updatedAt: "2026-08-20 16:30:00",
    });
    await db().insert(customers).values({
      id: "crm-customer-2",
      phone: "0922-345-678",
      normalizedPhone: "0922345678",
      name: "陳小華",
      createdAt: "2026-08-20 15:59:59",
      updatedAt: "2026-08-20 15:59:59",
    });
    await db().insert(customerTagCatalog).values({ id: "tag-vip", name: "VIP" });
    await db().insert(activityEvents).values({
      id: "crm-event-1",
      entityType: "customer",
      entityId: "crm-customer-1",
      entityLabel: "王小明",
      eventType: "customer_updated",
      summary: "更新客戶資料",
      actorType: "user",
      actorEmail: "admin@ecotech.tw",
      source: "crm",
    });

    const requestBodies: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[]; systemInstruction?: unknown };
      const contents = JSON.stringify(body.contents);
      requestBodies.push(contents);
      if (requestBodies.length === 1) {
        expect(JSON.stringify(body.systemInstruction)).toContain("Asia/Taipei");
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_search_customers",
            args: { search: "", date: "2026-08-21", dateField: "createdAt", limit: "10" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (requestBodies.length === 2) {
        expect(contents).toContain("crm-customer-1");
        expect(contents).not.toContain("crm-customer-2");
        expect(contents).not.toContain("should-not-leak");
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_get_customer",
            args: { customerId: "crm-customer-1", include: "events,tags", eventLimit: "5" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      expect(contents).toContain("更新客戶資料");
      expect(contents).not.toContain("should-not-leak");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "找到王小明，CRM 顯示他是 VIP 客戶，最近有更新資料紀錄。" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["crm_search_customers", "crm_get_customer"],
        input: "請查詢王小明最近的 CRM 狀態",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "找到王小明，CRM 顯示他是 VIP 客戶，最近有更新資料紀錄。",
      toolCalls: [
        { toolKey: "crm_search_customers", status: "success" },
        { toolKey: "crm_get_customer", status: "success" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("Sandbox 可以即時查詢 CYBERBIZ 客戶訂單並只回傳整理後的資料", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    await db().insert(customers).values({
      id: "crm-customer-order-1",
      phone: "0912-345-678",
      normalizedPhone: "0912345678",
      name: "王小明",
      email: "ming@example.com",
      cyberbizCustomerId: "cyberbiz-7",
      cyberbizRawJson: JSON.stringify({ secret: "should-not-leak" }),
      createdAt: "2026-08-20 16:30:00",
      updatedAt: "2026-08-20 16:30:00",
    });

    let geminiCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/orders")) {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer cyberbiz-test-token");
        return new Response(JSON.stringify([{
          id: 99,
          order_number: "R-00099",
          created_at: "2026-08-21 10:20:30",
          customer: { id: "cyberbiz-7", name: "王小明", email: "ming@example.com", mobile: "0912345678" },
          prices: { total_price: 1_280 },
          statuses: { financial_status: "paid", fulfillment_status: "fulfilled" },
          line_items: [{ title: "測試商品", sku: "SKU-1", quantity: 2, price: 640 }],
        }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      geminiCalls += 1;
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      if (geminiCalls === 1) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_get_orders",
            args: { customerId: "crm-customer-order-1", fromDate: "2026-08-21", toDate: "2026-08-21" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      expect(JSON.stringify(body.contents)).toContain("R-00099");
      expect(JSON.stringify(body.contents)).not.toContain("should-not-leak");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "王小明今天有 1 筆已付款訂單，金額為 1,280 元。" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["crm_get_orders"],
        input: "請查詢王小明今天的消費紀錄",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "王小明今天有 1 筆已付款訂單，金額為 1,280 元。",
      toolCalls: [{ toolKey: "crm_get_orders", status: "success" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("沒有搜尋條件時使用 CYBERBIZ customer orders endpoint 並套用 limit", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    await db().insert(customers).values({
      id: "crm-customer-order-direct-1",
      phone: "0912-345-678",
      normalizedPhone: "0912345678",
      name: "王小明",
      email: "ming@example.com",
      cyberbizCustomerId: "cyberbiz-direct-7",
      createdAt: "2026-08-20 16:30:00",
      updatedAt: "2026-08-20 16:30:00",
    });

    let geminiCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/customers/cyberbiz-direct-7/orders")) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("per_page")).toBe("5");
        expect(parsed.searchParams.get("offset")).toBe("0");
        return new Response(JSON.stringify([{
          id: 100,
          order_number: "R-00100",
          created_at: "2026-08-21 10:20:30",
          customer: { id: "cyberbiz-direct-7", name: "王小明" },
          prices: { total_price: 1_280 },
        }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      geminiCalls += 1;
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      if (geminiCalls === 1) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_get_orders",
            args: { customerId: "crm-customer-order-direct-1", limit: "5" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      expect(JSON.stringify(body.contents)).toContain("R-00100");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "王小明最近有 1 筆訂單。" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["crm_get_orders"],
        input: "請查詢王小明最近五筆訂單",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "王小明最近有 1 筆訂單。",
      toolCalls: [{ toolKey: "crm_get_orders", status: "success" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("可以用 orderIds 直接取得多筆 CYBERBIZ 訂單明細", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");

    let geminiCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/orders/")) {
        const orderId = url.endsWith("/201") ? "201" : "202";
        return new Response(JSON.stringify({ order: {
          id: orderId,
          order_number: `R-${orderId}`,
          created_at: orderId === "201" ? "2026-08-20 10:00:00" : "2026-08-21 10:00:00",
          prices: { total_price: orderId === "201" ? 100 : 200 },
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      geminiCalls += 1;
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      if (geminiCalls === 1) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_get_orders",
            args: { orderIds: "201,202", sortBy: "orderNumber", sortDirection: "asc" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      expect(JSON.stringify(body.contents)).toContain("R-201");
      expect(JSON.stringify(body.contents)).toContain("R-202");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "已取得兩筆訂單明細。" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["crm_get_orders"],
        input: "查詢訂單 201 與 202",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "已取得兩筆訂單明細。",
      toolCalls: [{ toolKey: "crm_get_orders", status: "success" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("可以用使用者看到的訂單編號先 mapping 再取得訂單明細", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");

    let geminiCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/orders/get_order_id")) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("order_numbers")).toBe("56714");
        return new Response(JSON.stringify([{ order_number: 56714, order_id: 301 }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/v1/orders/56714")) {
        return new Response(JSON.stringify({ error: "找不到訂單 ID" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/v1/orders/301")) {
        return new Response(JSON.stringify({ order: {
          id: 301,
          order_number: 56714,
          order_name: "56714",
          created_at: "2026-08-21 10:00:00",
          customer: { id: 7, name: "許櫻齡", email: "ying@example.com" },
          prices: { total_price: 1_680 },
          line_items: [{ title: "測試商品", quantity: 1, price: 1_680 }],
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      geminiCalls += 1;
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      if (geminiCalls === 1) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_get_orders",
            args: { orderId: "56714" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      expect(JSON.stringify(body.contents)).toContain("許櫻齡");
      expect(JSON.stringify(body.contents)).toContain("56714");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "訂單 #56714 由許櫻齡購買，金額為 1,680 元。" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["crm_get_orders"],
        input: "#56714 這筆訂單內容是什麼？誰購買的？",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "訂單 #56714 由許櫻齡購買，金額為 1,680 元。",
      toolCalls: [{ toolKey: "crm_get_orders", status: "success" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("訂單編號 mapping 後仍找不到時不暴露 CYBERBIZ internal order ID", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");

    let geminiCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/orders/get_order_id")) {
        const parsed = new URL(url);
        if (parsed.searchParams.get("order_numbers") === "56714") {
          return new Response(JSON.stringify([{ order_number: 56714, order_id: 301 }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/v1/orders/301")) {
        return new Response(JSON.stringify({ error: "找不到訂單" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      geminiCalls += 1;
      if (geminiCalls === 1) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_get_orders",
            args: { orderNumber: "#56714" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      const contents = JSON.stringify(body.contents);
      expect(contents).toContain("notFoundOrderNumbers");
      expect(contents).toContain("56714");
      expect(contents).not.toContain("notFoundOrderIds");
      expect(contents).not.toContain("301");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "找不到訂單 #56714。" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["crm_get_orders"],
        input: "查詢訂單 #56714",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "找不到訂單 #56714。",
      toolCalls: [{ toolKey: "crm_get_orders", status: "success" }],
    });
    expect(geminiCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("工具失敗時不會再讓 Gemini 重複呼叫而觸發第二輪格式錯誤", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");

    let geminiCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/v1/orders/301")) {
        return new Response(JSON.stringify({ error: "權限不足" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      geminiCalls += 1;
      if (geminiCalls === 1) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: {
            name: "crm_get_orders",
            args: { orderId: "301" },
          } }] } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "不應該進入第二輪。" }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        toolKeys: ["crm_get_orders"],
        input: "查詢訂單 301",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "我目前無法完成這次資料查詢，請稍後再試或確認查詢條件。",
      toolCalls: [{ toolKey: "crm_get_orders", status: "failed", errorMessage: "CYBERBIZ API 401: 權限不足" }],
    });
    expect(geminiCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("使用選定 prompt 與模型執行 Gemini，並記錄可用量資訊", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "這是 Gemini 的測試回覆。" }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", toolKeys: [], input: "請回覆測試內容" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "這是 Gemini 的測試回覆。",
      model: "gemini-3.6-flash",
      usage: { promptTokens: 12, candidateTokens: 8, totalTokens: 20 },
      toolCalls: [],
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("Gemma 4 Sandbox 將 thought channel 與正式回答分開", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [
        { text: "這是模型的內部思考", thought: true },
        { text: "這是給使用者的正式回答" },
      ] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gemma-4-31b-it", toolKeys: [], input: "請回答測試問題" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "這是給使用者的正式回答",
      thoughts: "這是模型的內部思考",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string; includeThoughts?: boolean } };
    };
    expect(body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true } });
  });

  it("Sandbox session 會保留多輪對話，關閉後不能繼續執行", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const configResponse = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config");
    const config = await configResponse.json() as { activePrompt: { id: string } };
    const createdResponse = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { session: { id: string; status: string; messages: unknown[] } };
    expect(created.session).toMatchObject({ status: "open", messages: [] });

    const geminiBodies: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      geminiBodies.push(typeof init?.body === "string" ? init.body : "");
      const text = geminiBodies.length === 1 ? "第一輪回答" : "第二輪回答";
      const parts = geminiBodies.length === 1
        ? [{ text: "第一輪 thinking", thought: true }, { text }]
        : [{ text }];
      return new Response(JSON.stringify({
        candidates: [{ content: { parts } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const firstRun = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.session.id, model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id, toolKeys: [], input: "第一輪問題" }),
    });
    expect(firstRun.status).toBe(200);
    expect(await firstRun.json()).toMatchObject({ sessionId: created.session.id, text: "第一輪回答", thoughts: "第一輪 thinking" });

    const secondRun = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.session.id, model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id, toolKeys: [], input: "第二輪問題" }),
    });
    expect(secondRun.status).toBe(200);
    expect(await secondRun.json()).toMatchObject({ sessionId: created.session.id, text: "第二輪回答" });
    expect(geminiBodies[1]).toContain("第一輪問題");
    expect(geminiBodies[1]).toContain("第一輪回答");

    const detail = await as("admin", "admin@ecotech.tw", `/api/assistant/sandbox/sessions/${created.session.id}`);
    const detailResult = await detail.json() as { session: { messages: Array<{ role: string; text: string; thoughts: string }> } };
    expect(detailResult.session.messages).toEqual([
      { role: "user", text: "第一輪問題", model: "", thoughts: "", toolCalls: [], durationMs: 0, id: expect.any(String), createdAt: expect.any(String) },
      { role: "model", text: "第一輪回答", model: "gemini-3.6-flash", thoughts: "第一輪 thinking", toolCalls: [], durationMs: expect.any(Number), id: expect.any(String), createdAt: expect.any(String) },
      { role: "user", text: "第二輪問題", model: "", thoughts: "", toolCalls: [], durationMs: 0, id: expect.any(String), createdAt: expect.any(String) },
      { role: "model", text: "第二輪回答", model: "gemini-3.6-flash", thoughts: "", toolCalls: [], durationMs: expect.any(Number), id: expect.any(String), createdAt: expect.any(String) },
    ]);

    const closed = await as("admin", "admin@ecotech.tw", `/api/assistant/sandbox/sessions/${created.session.id}/close`, { method: "POST" });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ session: { status: "closed" } });

    const rejected = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.session.id, model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id, toolKeys: [], input: "不應該送出" }),
    });
    expect(rejected.status).toBe(409);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("同一個 Sandbox session 可以在每一輪切換模型，並記錄每則回答的實際模型", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const config = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config")).json() as { activePrompt: { id: string } };
    const created = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id }),
    })).json() as { session: { id: string } };
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "回答 " + urls.length }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const first = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.session.id, model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id, toolKeys: [], input: "先用 Flash" }),
    });
    const second = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.session.id, model: "gemma-4-31b-it", promptRevisionId: config.activePrompt.id, toolKeys: [], input: "改用 Gemma" }),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(urls[0]).toContain("/gemini-3.6-flash:");
    expect(urls[1]).toContain("/gemma-4-31b-it:");

    const detail = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions/" + created.session.id);
    const result = await detail.json() as { session: { model: string; messages: Array<{ model: string }> } };
    expect(result.session.model).toBe("gemma-4-31b-it");
    expect(result.session.messages.map((message) => message.model)).toEqual(["", "gemini-3.6-flash", "", "gemma-4-31b-it"]);
  });

  it("同一個 Sandbox session 可以套用新 prompt revision", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const config = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config")).json() as { activePrompt: { id: string } };
    const created = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id }),
    })).json() as { session: { id: string } };
    const revision = await (await as("admin", "admin@ecotech.tw", "/api/assistant/prompts", {
      method: "POST",
      body: JSON.stringify({ systemPrompt: "這是新的 session prompt。" }),
    })).json() as { revision: { id: string } };
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "使用新 prompt 回覆" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.session.id, model: "gemini-3.6-flash", promptRevisionId: revision.revision.id, toolKeys: [], input: "套用新 prompt" }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(requests[0]?.systemInstruction)).toContain("這是新的 session prompt。");

    const detail = await as("admin", "admin@ecotech.tw", `/api/assistant/sandbox/sessions/${created.session.id}`);
    expect(await detail.json()).toMatchObject({ session: { promptRevisionId: revision.revision.id } });
  });

  it("Sandbox session 超過 100 則訊息時仍取最近的對話", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const config = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config")).json() as { activePrompt: { id: string } };
    const created = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id }),
    })).json() as { session: { id: string } };
    for (let index = 0; index < 51; index += 1) {
      await appendAssistantSandboxMessage(db(), { sessionId: created.session.id, role: "user", text: `歷史問題 ${index}` });
      await appendAssistantSandboxMessage(db(), { sessionId: created.session.id, role: "model", text: `歷史回答 ${index}`, model: "gemini-3.6-flash" });
    }
    let requestBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "最新回答" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ sessionId: created.session.id, model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id, toolKeys: [], input: "最新問題" }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(requestBody?.contents)).toContain("歷史問題 50");
  });

  it("長對話會保留完整歷史，並在送出前自動建立 rolling summary", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    const config = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/config")).json() as { activePrompt: { id: string } };
    const created = await (await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", promptRevisionId: config.activePrompt.id }),
    })).json() as { session: { id: string } };
    const requests: Array<{ body: Record<string, unknown>; summary: boolean }> = [];
    let mainCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const systemPrompt = JSON.stringify(body.systemInstruction);
      const summary = systemPrompt.includes("Summarize the supplied conversation");
      requests.push({ body, summary });
      const text = summary ? "已更新摘要" : "長對話回答 " + ++mainCount;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const longQuestion = "問題".repeat(3_500);
    for (let index = 0; index < 6; index += 1) {
      const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
        method: "POST",
        body: JSON.stringify({
          sessionId: created.session.id,
          model: "gemini-3.6-flash",
          promptRevisionId: config.activePrompt.id,
          toolKeys: [],
          input: longQuestion + index,
        }),
      });
      expect(response.status).toBe(200);
    }

    expect(requests.some((request) => request.summary)).toBe(true);
    const lastMainRequest = requests.filter((request) => !request.summary).at(-1);
    expect(JSON.stringify(lastMainRequest?.body.contents)).toContain("已更新摘要");
    expect(JSON.stringify(lastMainRequest?.body.contents)).not.toContain(longQuestion + "0");

    const detail = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/sessions/" + created.session.id);
    const result = await detail.json() as {
      session: { contextSummaryMessageCount: number; messages: unknown[] };
    };
    expect(result.session.contextSummaryMessageCount).toBeGreaterThan(0);
    expect(result.session.messages).toHaveLength(12);
  });
});
