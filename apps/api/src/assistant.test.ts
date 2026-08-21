import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { appendAssistantSandboxMessage, createDatabase, syncSystemRoles } from "@rueisiang/db";
import { inventoryItems, layoutElements, userRoles, users } from "@rueisiang/db/schema";
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
      "wms_search_inventory",
      "wms_list_map_labels",
      "wms_get_inventory_item",
      "wms_list_low_stock_items",
      "wms_get_activity",
    ]);
    expect(result.tools.find((tool) => tool.key === "wms_search_inventory")).toMatchObject({
      label: "WMS 搜尋庫存",
      status: "development",
      surfaces: ["sandbox", "line", "mcp"],
      requiredPermissions: ["wms:inventory:read"],
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

  it("Sandbox 可以透過共用 registry 執行 WMS 唯讀工具", async () => {
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
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: hasToolResult
          ? [{ text: "紙箱目前有 3 件，低於安全庫存 5 件。" }]
          : [{ functionCall: { name: "wms_search_inventory", args: { query: "紙箱", limit: "10" } } }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", toolKeys: ["wms_search_inventory"], input: "查詢紙箱庫存" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "紙箱目前有 3 件，低於安全庫存 5 件。",
      toolCalls: [{ toolKey: "wms_search_inventory", status: "success" }],
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

  it("Sandbox 可以查詢 WMS 地圖上的標籤", async () => {
    await seedUser("admin", "admin@ecotech.tw", "role-admin");
    await db().insert(layoutElements).values({
      id: "map-label-1",
      label: "冷藏區入口",
      color: "sky",
      x: 12,
      y: 18,
      width: 20,
      height: 10,
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { contents?: unknown[] };
      const hasToolResult = JSON.stringify(body.contents).includes("map-label-1");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: hasToolResult
          ? [{ text: "冷藏區入口位於地圖 x=12、y=18。" }]
          : [{ functionCall: { name: "wms_list_map_labels", args: { query: "冷藏" } } }] } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const response = await as("admin", "admin@ecotech.tw", "/api/assistant/sandbox/run", {
      method: "POST",
      body: JSON.stringify({ model: "gemini-3.6-flash", toolKeys: ["wms_list_map_labels"], input: "冷藏區入口在哪裡？" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: "冷藏區入口位於地圖 x=12、y=18。",
      toolCalls: [{ toolKey: "wms_list_map_labels", status: "success" }],
    });
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
    expect(body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "high", includeThoughts: true } });
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
      { role: "user", text: "第一輪問題", model: "", thoughts: "", toolCalls: [], id: expect.any(String), createdAt: expect.any(String) },
      { role: "model", text: "第一輪回答", model: "gemini-3.6-flash", thoughts: "第一輪 thinking", toolCalls: [], id: expect.any(String), createdAt: expect.any(String) },
      { role: "user", text: "第二輪問題", model: "", thoughts: "", toolCalls: [], id: expect.any(String), createdAt: expect.any(String) },
      { role: "model", text: "第二輪回答", model: "gemini-3.6-flash", thoughts: "", toolCalls: [], id: expect.any(String), createdAt: expect.any(String) },
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
    expect(JSON.stringify(requests[0]?.system_instruction)).toContain("這是新的 session prompt。");

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
      const systemPrompt = JSON.stringify(body.system_instruction);
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
