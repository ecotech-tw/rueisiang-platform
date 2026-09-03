import type { Env } from "./env.js";
import { serializePiError } from "./pi-agent-diagnostics.js";

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const REFRESH_BEFORE_EXPIRY_MS = 10 * 60 * 1_000;
const INITIAL_ALARM_DELAY_MS = 60_000;
const MIN_ALARM_DELAY_MS = 60_000;
const REFRESH_RETRY_DELAY_MS = 5 * 60 * 1_000;
const REAUTH_RETRY_DELAY_MS = 60 * 60 * 1_000;

interface CodexCredential {
  access: string;
  refresh: string;
  expires: number;
}

interface EncryptedCredential {
  iv: string;
  ciphertext: string;
}

interface EncryptedCredentialRow extends Record<string, SqlStorageValue>, EncryptedCredential {
  seed_fingerprint: string;
}

interface CredentialStatusRow extends Record<string, SqlStorageValue> {
  status: string;
  last_error_code: string | null;
  last_error_at: number | null;
}

interface LoadedCredential {
  credential: CodexCredential;
  seedFingerprint: string;
}

export type PiCredentialStatus = "ready" | "needs_reauth";

export interface PiCredentialStatusResponse {
  configured: boolean;
  status: PiCredentialStatus;
  lastErrorAt: number | null;
}

export class PiCredentialRefreshError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`OpenAI Codex OAuth refresh 失敗（HTTP ${status}）。`);
    this.name = "PiCredentialRefreshError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  return atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
}

function jwtExpiry(accessToken: string): number | undefined {
  try {
    const payload = record(JSON.parse(decodeBase64Url(accessToken.split(".")[1] ?? "")));
    const expires = payload?.exp;
    return typeof expires === "number" && Number.isFinite(expires) ? expires * 1_000 : undefined;
  } catch {
    return undefined;
  }
}

/** 同時接受 Pi auth.json 的 provider 欄位、單一 Pi credential，以及 Codex CLI auth.json 的 tokens。 */
export function parseOpenAICodexCredentialSeed(value: string): CodexCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("PI_OPENAI_CODEX_CREDENTIAL 不是合法 JSON。", { cause: error });
  }
  const root = record(parsed);
  const providerCredential = record(root?.["openai-codex"]);
  const tokens = record(root?.tokens);
  const candidate = providerCredential ?? root;
  const access = text(candidate?.access) || text(tokens?.access_token);
  const refresh = text(candidate?.refresh) || text(tokens?.refresh_token);
  const configuredExpiry = candidate?.expires;
  const expires = typeof configuredExpiry === "number" && Number.isFinite(configuredExpiry)
    ? configuredExpiry
    : jwtExpiry(access);
  if (!access || !refresh || expires === undefined) {
    throw new Error("PI_OPENAI_CODEX_CREDENTIAL 缺少 access、refresh 或 access token 的 exp。");
  }
  return { access, refresh, expires };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("PI_CREDENTIAL_ENCRYPTION_KEY 至少需要 32 個字元。");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function credentialSeedFingerprint(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  return bytesToBase64(new Uint8Array(digest));
}

async function encryptCredential(secret: string, credential: CodexCredential): Promise<EncryptedCredential> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    new TextEncoder().encode(JSON.stringify(credential)),
  );
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

async function decryptCredential(secret: string, row: EncryptedCredential): Promise<CodexCredential> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(row.iv) },
      await encryptionKey(secret),
      base64ToBytes(row.ciphertext),
    );
    return parseOpenAICodexCredentialSeed(new TextDecoder().decode(plaintext));
  } catch (error) {
    throw new Error("無法解密 OpenAI Codex credential；請確認 encryption key 沒有被更換。", { cause: error });
  }
}

async function refreshCredential(credential: CodexCredential): Promise<CodexCredential> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
        client_id: OPENAI_CODEX_CLIENT_ID,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = record(await response.json().catch(() => null));
      const candidate = text(payload?.error);
      const code = /^[a-z0-9._-]{1,80}$/iu.test(candidate) ? candidate : undefined;
      throw new PiCredentialRefreshError(response.status, code);
    }
    const payload = record(await response.json());
    const access = text(payload?.access_token);
    const refresh = text(payload?.refresh_token);
    const expiresIn = payload?.expires_in;
    if (!access || !refresh || typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
      throw new Error("OpenAI Codex OAuth refresh 回傳缺少必要欄位。");
    }
    return { access, refresh, expires: Date.now() + expiresIn * 1_000 };
  } finally {
    clearTimeout(timeout);
  }
}

/** 全平台只建一個 instance；refresh token 旋轉必須集中串行，不能複製到每個 chat DO。 */
export class AssistantCredentialVault {
  private readonly sql: SqlStorage;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS assistant_credentials (
          provider_id TEXT PRIMARY KEY,
          iv TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          seed_fingerprint TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
        ;
        CREATE TABLE IF NOT EXISTS assistant_credential_status (
          provider_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          last_error_code TEXT,
          last_error_at INTEGER,
          updated_at INTEGER NOT NULL
        )
      `);
      if (this.env.PI_CREDENTIAL_ENCRYPTION_KEY?.trim() && this.env.PI_OPENAI_CODEX_CREDENTIAL?.trim()
        && await ctx.storage.getAlarm() === null) {
        await ctx.storage.setAlarm(Date.now() + INITIAL_ALARM_DELAY_MS);
      }
    });
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadCredential(): Promise<LoadedCredential> {
    const secret = this.env.PI_CREDENTIAL_ENCRYPTION_KEY?.trim();
    if (!secret) throw new Error("平台尚未設定 PI_CREDENTIAL_ENCRYPTION_KEY。");
    const stored = [...this.sql.exec<EncryptedCredentialRow>(
      "SELECT iv, ciphertext, seed_fingerprint FROM assistant_credentials WHERE provider_id = ? LIMIT 1",
      "openai-codex",
    )][0];
    const seed = this.env.PI_OPENAI_CODEX_CREDENTIAL?.trim();
    if (stored && !seed) {
      return { credential: await decryptCredential(secret, stored), seedFingerprint: stored.seed_fingerprint };
    }
    if (!seed) throw new Error("平台尚未設定 PI_OPENAI_CODEX_CREDENTIAL。");
    const seedFingerprint = await credentialSeedFingerprint(seed);
    if (stored && stored.seed_fingerprint === seedFingerprint) {
      return { credential: await decryptCredential(secret, stored), seedFingerprint };
    }
    const credential = parseOpenAICodexCredentialSeed(seed);
    await this.saveCredential(secret, credential, seedFingerprint);
    await this.markCredentialReady();
    return { credential, seedFingerprint };
  }

  private credentialStatus(): PiCredentialStatusResponse {
    const row = [...this.sql.exec<CredentialStatusRow>(
      "SELECT status, last_error_code, last_error_at FROM assistant_credential_status WHERE provider_id = ? LIMIT 1",
      "openai-codex",
    )][0];
    return {
      configured: true,
      status: row?.status === "needs_reauth" ? "needs_reauth" : "ready",
      lastErrorAt: typeof row?.last_error_at === "number" ? row.last_error_at : null,
    };
  }

  private async markCredentialReady(): Promise<void> {
    this.sql.exec(
      `INSERT INTO assistant_credential_status (provider_id, status, last_error_code, last_error_at, updated_at)
       VALUES (?, 'ready', NULL, NULL, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         status = 'ready',
         last_error_code = NULL,
         last_error_at = NULL,
         updated_at = excluded.updated_at`,
      "openai-codex",
      Date.now(),
    );
  }

  private async markCredentialNeedsReauth(error: PiCredentialRefreshError): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO assistant_credential_status (provider_id, status, last_error_code, last_error_at, updated_at)
       VALUES (?, 'needs_reauth', ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         status = 'needs_reauth',
         last_error_code = excluded.last_error_code,
         last_error_at = excluded.last_error_at,
         updated_at = excluded.updated_at`,
      "openai-codex",
      error.code ?? "http_401",
      now,
      now,
    );
  }

  private async scheduleAlarm(credential: CodexCredential): Promise<void> {
    const status = this.credentialStatus();
    const nextAt = status.status === "needs_reauth"
      ? Date.now() + REAUTH_RETRY_DELAY_MS
      : Math.max(Date.now() + MIN_ALARM_DELAY_MS, credential.expires - REFRESH_BEFORE_EXPIRY_MS);
    await this.ctx.storage.setAlarm(nextAt);
  }

  private async saveCredential(
    secret: string,
    credential: CodexCredential,
    seedFingerprint: string,
  ): Promise<void> {
    const encrypted = await encryptCredential(secret, credential);
    this.sql.exec(
      `INSERT INTO assistant_credentials (provider_id, iv, ciphertext, seed_fingerprint, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         iv = excluded.iv,
         ciphertext = excluded.ciphertext,
         seed_fingerprint = excluded.seed_fingerprint,
         updated_at = excluded.updated_at`,
      "openai-codex",
      encrypted.iv,
      encrypted.ciphertext,
      seedFingerprint,
      Date.now(),
    );
  }

  private async accessToken(): Promise<string> {
    const secret = this.env.PI_CREDENTIAL_ENCRYPTION_KEY?.trim();
    if (!secret) throw new Error("平台尚未設定 PI_CREDENTIAL_ENCRYPTION_KEY。");
    const loaded = await this.loadCredential();
    let credential = loaded.credential;
    if (Date.now() + REFRESH_BEFORE_EXPIRY_MS >= credential.expires) {
      try {
        credential = await refreshCredential(credential);
        await this.saveCredential(secret, credential, loaded.seedFingerprint);
        await this.markCredentialReady();
      } catch (error) {
        if (error instanceof PiCredentialRefreshError && error.status === 401) {
          await this.markCredentialNeedsReauth(error);
          await this.ctx.storage.setAlarm(Date.now() + REAUTH_RETRY_DELAY_MS);
        } else {
          await this.ctx.storage.setAlarm(Date.now() + REFRESH_RETRY_DELAY_MS);
        }
        throw error;
      }
    }
    await this.scheduleAlarm(credential);
    return credential.access;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    try {
      if (url.pathname === "/status") {
        const status = await this.serialized(async () => {
          const loaded = await this.loadCredential();
          await this.scheduleAlarm(loaded.credential);
          return this.credentialStatus();
        });
        return Response.json(status);
      }
      if (url.pathname !== "/access-token") {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      const accessToken = await this.serialized(() => this.accessToken());
      return Response.json({ accessToken });
    } catch (error) {
      if (url.pathname !== "/status") {
        console.error("Pi credential vault 無法提供 access token", { error: serializePiError(error) });
      }
      const message = error instanceof Error ? error.message : "OpenAI Codex credential 無法使用。";
      const needsReauth = error instanceof PiCredentialRefreshError && error.status === 401;
      return Response.json({
        error: message,
        ...(needsReauth ? { code: "reauth_required", status: "needs_reauth" } : {}),
      }, { status: needsReauth ? 401 : 503 });
    }
  }

  async alarm(): Promise<void> {
    await this.serialized(async () => {
      try {
        await this.accessToken();
        console.info("Pi credential vault 已完成 OAuth token 預先更新", { provider: "openai-codex" });
      } catch (error) {
        const nextRetryAt = Date.now()
          + (error instanceof PiCredentialRefreshError && error.status === 401
            ? REAUTH_RETRY_DELAY_MS
            : REFRESH_RETRY_DELAY_MS);
        await this.ctx.storage.setAlarm(nextRetryAt);
        console.error("Pi credential vault token 預先更新失敗", {
          provider: "openai-codex",
          nextRetryAt,
          error: serializePiError(error),
        });
      }
    });
  }
}
