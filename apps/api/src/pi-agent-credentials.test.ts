import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { AssistantCredentialVault, parseOpenAICodexCredentialSeed } from "./pi-agent-credentials.js";

const ENCRYPTION_SECRET = "assistant-credential-test-secret-32";

function credentialSeed(expires: number, suffix = "seed") {
  return JSON.stringify({
    "openai-codex": {
      access: `access-${suffix}`,
      refresh: `refresh-${suffix}`,
      expires,
    },
  });
}

function credentialVault(seed: string) {
  const sqlite = new DatabaseSync(":memory:");
  const environment: { PI_CREDENTIAL_ENCRYPTION_KEY: string; PI_OPENAI_CODEX_CREDENTIAL?: string } = {
    PI_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_SECRET,
    PI_OPENAI_CODEX_CREDENTIAL: seed,
  };
  let alarmAt: number | null = null;
  const storage = {
    sql: {
      exec: (query: string, ...bindings: unknown[]) => {
        if (!bindings.length && query.includes(";")) {
          sqlite.exec(query);
          return [];
        }
        return sqlite.prepare(query).all(...bindings as never[]);
      },
    },
    getAlarm: async () => alarmAt,
    setAlarm: async (at: number) => {
      alarmAt = at;
    },
    deleteAlarm: async () => {
      alarmAt = null;
    },
  };
  const state = {
    storage,
    blockConcurrencyWhile: (initialize: () => Promise<void>) => {
      void initialize();
    },
  };
  const vault = new AssistantCredentialVault(state as never, environment as never);
  return {
    vault,
    alarmAt: () => alarmAt,
    clearLegacySeed: () => delete environment.PI_OPENAI_CODEX_CREDENTIAL,
    close: () => sqlite.close(),
  };
}

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

  it("DO alarm 會在 access token 到期前自動旋轉 credential", async () => {
    const fixture = credentialVault(credentialSeed(1));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      access_token: "access-refreshed",
      refresh_token: "refresh-refreshed",
      expires_in: 3_600,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    try {
      await expect(fixture.vault.fetch(new Request("https://assistant-credential.internal/status", { method: "POST" })))
        .resolves.toHaveProperty("status", 200);
      await fixture.vault.alarm();

      const response = await fixture.vault.fetch(new Request("https://assistant-credential.internal/access-token", { method: "POST" }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accessToken: "access-refreshed" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fixture.alarmAt()).toBeGreaterThan(Date.now());

      const status = await fixture.vault.fetch(new Request("https://assistant-credential.internal/status", { method: "POST" }));
      expect(await status.json()).toMatchObject({ configured: true, status: "ready", lastErrorAt: null });
    } finally {
      vi.restoreAllMocks();
      fixture.close();
    }
  });

  it("OAuth 401 會留下需要重新授權的狀態，且不會把 token 寫進錯誤回應", async () => {
    const fixture = credentialVault(credentialSeed(1));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "refresh-token-secret-must-not-leak",
    }), { status: 401, headers: { "content-type": "application/json" } }));

    try {
      const response = await fixture.vault.fetch(new Request("https://assistant-credential.internal/access-token", { method: "POST" }));
      const payload = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(401);
      expect(payload).toMatchObject({ code: "reauth_required", status: "needs_reauth" });
      expect(JSON.stringify(payload)).not.toContain("refresh-token-secret-must-not-leak");

      const status = await fixture.vault.fetch(new Request("https://assistant-credential.internal/status", { method: "POST" }));
      expect(await status.json()).toMatchObject({ configured: true, status: "needs_reauth" });
      expect(fixture.alarmAt()).toBeGreaterThan(Date.now() + 30 * 60 * 1_000);
    } finally {
      vi.restoreAllMocks();
      fixture.close();
    }
  });

  it("匯入新 credential 後不會再被舊的 Worker secret 覆蓋", async () => {
    const fixture = credentialVault(credentialSeed(Date.now() + 3_600_000, "old"));
    const importedSeed = credentialSeed(Date.now() + 7_200_000, "imported");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    try {
      const imported = await fixture.vault.fetch(new Request("https://assistant-credential.internal/credential", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential: importedSeed }),
      }));
      expect(imported.status).toBe(200);
      expect(await imported.json()).toMatchObject({ configured: true, status: "ready" });

      const response = await fixture.vault.fetch(new Request("https://assistant-credential.internal/access-token", { method: "POST" }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accessToken: "access-imported" });
      fixture.clearLegacySeed();
      const afterSecretRemoved = await fixture.vault.fetch(new Request("https://assistant-credential.internal/access-token", { method: "POST" }));
      expect(afterSecretRemoved.status).toBe(200);
      expect(await afterSecretRemoved.json()).toEqual({ accessToken: "access-imported" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      fixture.close();
    }
  });
});
