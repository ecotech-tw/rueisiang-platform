import { describe, expect, it } from "vitest";
import {
  createPiCodexVPCFetch,
  isPiAssistantModel,
  piAssistantModel,
  piCodexModel,
  piGeminiModel,
  resolvePiAssistantModelId,
} from "./pi-agent-models.js";

describe("Pi Codex model catalog", () => {
  it("預設低延遲模型存在於安裝版本的 openai-codex catalog", () => {
    expect(piCodexModel("gpt-6-luna")).toMatchObject({
      id: "gpt-6-luna",
      provider: "openai-codex",
      api: "openai-codex-responses",
    });
  });

  it.each([
    ["gpt-6-astra", "openai-codex"], ["gpt-6-luna", "openai-codex"], ["gpt-6.1-sol", "openai-codex"],
    ["gemini-3.8-flash", "google"], ["gemini-flash-latest", "google"], ["gemini-3.1-pro-preview", "google"],
  ])("新模型 %s 使用 catalog 的真正 ID 與 provider", (id, provider) => {
    expect(isPiAssistantModel(id)).toBe(true);
    expect(piAssistantModel(id)).toMatchObject({ id, provider });
  });

  it.each([
    "gemini-3.1-flash-lite-image", "gemini-3.1-flash-live-preview", "gemini-2.5-computer-use-preview-10-2025",
    "deep-research-preview-04-2026", "gemini-embedding-1", "gpt-6-not-a-model", "gpt-5.4", "gpt-5.4-mini",
  ])("非一般文字對話或未知模型 %s 不進小香執行目錄", (id) => {
    expect(isPiAssistantModel(id)).toBe(false);
    expect(resolvePiAssistantModelId(id, "gpt-6-luna")).toBe("gpt-6-luna");
    expect(() => piAssistantModel(id)).toThrow("不支援模型");
  });

  it("拒絕 catalog 以外的模型", () => {
    expect(() => piCodexModel("not-a-model")).toThrow("不支援模型 not-a-model");
  });

  it("同一個 Pi runtime 可解析 Codex 與 Gemini provider", () => {
    expect(piAssistantModel("gpt-6-luna").provider).toBe("openai-codex");
    expect(piGeminiModel("gemini-3.6-flash")).toMatchObject({
      id: "gemini-3.6-flash",
      provider: "google",
    });
    expect(piAssistantModel("gemini-3.6-flash").provider).toBe("google");
  });

  it("provider-neutral resolver 只接受目前 catalog 內的模型", () => {
    expect(isPiAssistantModel("gpt-6-luna")).toBe(true);
    expect(isPiAssistantModel("gemini-3.6-flash")).toBe(true);
    expect(isPiAssistantModel("removed-model")).toBe(false);
    expect(resolvePiAssistantModelId(" gemini-3.6-flash ", "gpt-6-luna")).toBe("gemini-3.6-flash");
    expect(resolvePiAssistantModelId("removed-model", "gpt-6-luna")).toBe("gpt-6-luna");
  });

  it("VPC egress 保留 Codex SSE request，且只允許固定 ChatGPT endpoint", async () => {
    let observed: Request | undefined;
    const vpcFetch = createPiCodexVPCFetch(async (input) => {
      observed = input instanceof Request ? input : new Request(input);
      return new Response("ok", { status: 200 });
    });

    const response = await vpcFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers: { authorization: "Bearer oauth-token", "content-type": "application/json" },
      body: "{\"stream\":true}",
    });

    expect(response.status).toBe(200);
    expect(observed?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(observed?.headers.get("authorization")).toBe("Bearer oauth-token");
    expect(await observed?.text()).toBe("{\"stream\":true}");
    await expect(vpcFetch("https://example.test/backend-api/codex/responses")).rejects.toThrow("只允許連線至 chatgpt.com");
  });

});
