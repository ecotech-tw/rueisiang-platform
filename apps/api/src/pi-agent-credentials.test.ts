import { describe, expect, it } from "vitest";
import { parseOpenAICodexCredentialSeed } from "./pi-agent-credentials.js";

function jwtWithExpiry(expiresAtSeconds: number): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
  return `${encode({ alg: "none" })}.${encode({ exp: expiresAtSeconds })}.signature`;
}

describe("OpenAI Codex OAuth credential", () => {
  it("接受 Pi auth.json 的 openai-codex provider 格式", () => {
    expect(parseOpenAICodexCredentialSeed(JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "pi-access",
        refresh: "pi-refresh",
        expires: 1_900_000_000_000,
      },
    }))).toEqual({
      access: "pi-access",
      refresh: "pi-refresh",
      expires: 1_900_000_000_000,
    });
  });

  it("接受 Codex CLI auth.json，並從 access token 取得到期時間", () => {
    const expiresAtSeconds = 1_900_000_000;
    expect(parseOpenAICodexCredentialSeed(JSON.stringify({
      tokens: {
        access_token: jwtWithExpiry(expiresAtSeconds),
        refresh_token: "codex-refresh",
      },
    }))).toMatchObject({
      refresh: "codex-refresh",
      expires: expiresAtSeconds * 1_000,
    });
  });

  it("拒絕缺少 refresh token 的設定", () => {
    expect(() => parseOpenAICodexCredentialSeed(JSON.stringify({
      access: "access-only",
      expires: 1_900_000_000_000,
    }))).toThrow("缺少 access、refresh");
  });
});
