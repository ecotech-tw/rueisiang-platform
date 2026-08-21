import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { userRoles, users } from "@rueisiang/db/schema";
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
      models: Array<{ id: string }>;
      tools: Array<{ key: string; status: string }>;
      activePrompt: { revision: number; isActive: boolean };
    };
    expect(result.configured).toBe(true);
    expect(result.models.some((model) => model.id === "gemini-3.6-flash")).toBe(true);
    expect(result.tools).toEqual([{ key: "weather_open_meteo", label: "Open-Meteo 天氣查詢", description: expect.any(String), status: "development" }]);
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
});
