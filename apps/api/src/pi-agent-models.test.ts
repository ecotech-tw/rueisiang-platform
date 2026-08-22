import { describe, expect, it } from "vitest";
import { piAssistantModel, piCodexModel, piGeminiModel } from "./pi-agent-models.js";

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
});
