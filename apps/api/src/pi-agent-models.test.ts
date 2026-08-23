import { describe, expect, it } from "vitest";
import {
  createPiCodexRelayFetch,
  piAssistantModel,
  piCodexModel,
  piGeminiModel,
} from "./pi-agent-models.js";

describe("Pi Codex model catalog", () => {
  it("預設低延遲模型存在於安裝版本的 openai-codex catalog", () => {
    expect(piCodexModel("gpt-5.4-mini")).toMatchObject({
      id: "gpt-5.4-mini",
      provider: "openai-codex",
      api: "openai-codex-responses",
    });
  });

  it("拒絕 catalog 以外的模型", () => {
    expect(() => piCodexModel("not-a-model")).toThrow("不支援模型 not-a-model");
  });

  it("同一個 Pi runtime 可解析 Codex 與 Gemini provider", () => {
    expect(piAssistantModel("gpt-5.4-mini").provider).toBe("openai-codex");
    expect(piGeminiModel("gemini-3.6-flash")).toMatchObject({
      id: "gemini-3.6-flash",
      provider: "google",
    });
    expect(piAssistantModel("gemini-3.6-flash").provider).toBe("google");
  });

  it("只把 Codex SSE 請求改送到固定 relay path 並加入 relay token", async () => {
    let observed: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const relayFetch = createPiCodexRelayFetch(
      { baseUrl: "https://relay.example.test", token: "relay-secret" },
      async (input, init) => {
        observed = { input, init };
        return new Response("ok", { status: 200 });
      },
    );

    const response = await relayFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer upstream-token",
        "content-type": "application/json",
      },
      body: "{\"stream\":true}",
    });

    expect(response.status).toBe(200);
    expect(observed?.input.toString()).toBe("https://relay.example.test/codex/responses");
    expect(new Headers(observed?.init?.headers).get("authorization")).toBe("Bearer upstream-token");
    expect(new Headers(observed?.init?.headers).get("x-codex-relay-token")).toBe("relay-secret");
  });

  it("拒絕非 HTTPS 或非 chatgpt.com 的 relay 目的地", async () => {
    expect(() => createPiCodexRelayFetch({
      baseUrl: "http://relay.example.test",
      token: "relay-secret",
    })).toThrow("必須使用 HTTPS");

    const relayFetch = createPiCodexRelayFetch({
      baseUrl: "https://relay.example.test",
      token: "relay-secret",
    }, async () => new Response("ok"));
    await expect(relayFetch("https://example.test/codex/responses")).rejects.toThrow("只允許");
  });
});
