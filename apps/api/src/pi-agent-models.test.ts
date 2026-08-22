import { describe, expect, it } from "vitest";
import { piCodexModel } from "./pi-agent-models.js";

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
});
