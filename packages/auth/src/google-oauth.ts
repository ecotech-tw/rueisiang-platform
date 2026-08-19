import { decodeBase64Url, decodeTextBase64Url, encodeBase64Url, utf8 } from "./base64url.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface GoogleIdentity {
  subject: string;
  email: string;
  name: string;
  pictureUrl: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** PKCE：授權碼被攔截也沒用，因為換 token 時要出示只有我們知道的 verifier。 */
export async function createPkce(): Promise<PkcePair> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = encodeBase64Url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", utf8(verifier));
  return { verifier, challenge: encodeBase64Url(new Uint8Array(digest)) };
}

export function randomToken(bytes = 24): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", options.state);
  url.searchParams.set("nonce", options.nonce);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // 只作為身分提供者，不需要離線存取，所以不要 refresh token。
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeCode(options: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ idToken: string; accessToken: string }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: options.code,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      grant_type: "authorization_code",
      code_verifier: options.codeVerifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`Google 授權碼交換失敗（${response.status}）。`);
  }
  const body = (await response.json()) as { id_token?: string; access_token?: string };
  if (!body.id_token) throw new Error("Google 沒有回傳 id_token。");
  // access token 只拿來補頭像（見 fetchGoogleAvatar），不存也不傳給前端。
  return { idToken: body.id_token, accessToken: body.access_token ?? "" };
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

let jwksCache: { keys: Jwk[]; expiresAt: number } | null = null;

async function fetchJwks(now: number): Promise<Jwk[]> {
  if (jwksCache && jwksCache.expiresAt > now) return jwksCache.keys;

  const response = await fetch(JWKS_URL);
  if (!response.ok) throw new Error(`取得 Google 公鑰失敗（${response.status}）。`);
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];

  // 依 Cache-Control 決定快取多久，拿不到就保守用 10 分鐘。
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1]);
  jwksCache = {
    keys,
    expiresAt: now + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 600) * 1000,
  };
  return keys;
}

interface IdTokenPayload {
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

/**
 * 驗證 Google 簽發的 ID token。
 *
 * 這裡自己對 JWKS 驗簽，而不是拿 access token 去打 userinfo 端點：
 * 驗簽是離線的、少一次往返，而且能一併檢查 nonce 有沒有對上，
 * 擋掉重放先前那次登入拿到的 token。
 */
export async function verifyIdToken(
  idToken: string,
  options: { clientId: string; nonce: string },
  now = Date.now(),
): Promise<GoogleIdentity> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token 格式不正確。");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = JSON.parse(decodeTextBase64Url(headerPart)) as { kid?: string; alg?: string };
  if (header.alg !== "RS256") throw new Error(`不支援的簽章演算法：${header.alg}`);

  const jwks = await fetchJwks(now);
  const jwk = jwks.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("找不到對應的 Google 公鑰。");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64Url(signaturePart),
    utf8(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new Error("id_token 簽章驗證失敗。");

  const payload = JSON.parse(decodeTextBase64Url(payloadPart)) as IdTokenPayload;

  if (!payload.iss || !ISSUERS.has(payload.iss)) throw new Error("id_token 的簽發者不正確。");
  if (payload.aud !== options.clientId) throw new Error("id_token 不是發給這個應用程式的。");
  if (!payload.exp || payload.exp * 1000 <= now) throw new Error("id_token 已過期。");
  if (payload.nonce !== options.nonce) throw new Error("nonce 對不上，可能是重放攻擊。");
  if (!payload.sub) throw new Error("id_token 沒有 sub。");
  if (!payload.email) throw new Error("id_token 沒有 email。");
  if (payload.email_verified !== true) throw new Error("這個 Google 帳號的 email 尚未驗證。");

  return {
    subject: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name ?? "",
    pictureUrl: payload.picture ?? "",
  };
}

/** 測試用：清掉 JWKS 快取。 */
export function resetJwksCache(): void {
  jwksCache = null;
}

const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

/**
 * 補一次頭像網址。
 *
 * ID token 的 picture 欄位不是每次都有——Workspace 帳號尤其常常沒有，即使
 * 使用者有設大頭照。舊 CRM 是打 userinfo 端點拿的，所以它一直都有頭像。
 *
 * 這裡當成「有更好、沒有也不影響登入」：任何失敗都回空字串，不要讓拿頭像
 * 這種裝飾性的事擋住登入流程。
 */
export async function fetchGoogleAvatar(accessToken: string): Promise<string> {
  if (!accessToken) return "";

  try {
    const response = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return "";

    const body = (await response.json()) as { picture?: string };
    return typeof body.picture === "string" ? body.picture : "";
  } catch {
    return "";
  }
}
