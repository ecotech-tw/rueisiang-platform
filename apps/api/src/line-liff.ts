import { randomToken, signPayload, verifyPayload, type Expiring } from "@rueisiang/auth";
import { clearCookie, serializeCookie } from "@rueisiang/auth";

const VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
export const LINE_LIFF_INTENT_COOKIE = "rueisiang_hr_line_intent";
export const LINE_LIFF_INTENT_PATH = "/api/hr/liff/link";
export const LINE_LIFF_INTENT_TTL_SECONDS = 10 * 60;

export class LineLiffError extends Error {
  constructor(readonly status: 401 | 503, message: string) {
    super(message);
    this.name = "LineLiffError";
  }
}

export interface VerifiedLineIdentity {
  channelId: string;
  lineUserId: string;
}

interface LineVerifyResponse {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  exp?: unknown;
}

export async function verifyLineIdToken(idToken: string, channelId: string, fetcher: typeof fetch = fetch): Promise<VerifiedLineIdentity> {
  if (!channelId.trim()) throw new LineLiffError(503, "LINE Login 尚未完成伺服器設定。");
  let response: Response;
  try {
    response = await fetcher(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new LineLiffError(503, "目前無法連線驗證 LINE 身分，請稍後再試。");
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 429) {
      throw new LineLiffError(503, "目前無法驗證 LINE 身分，請稍後再試。");
    }
    throw new LineLiffError(401, "LINE 登入憑證無效或已過期，請重新開啟 LINE 打卡頁。");
  }

  let claims: LineVerifyResponse;
  try {
    claims = await response.json() as LineVerifyResponse;
  } catch {
    throw new LineLiffError(401, "LINE 登入憑證格式無效。");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (claims.iss !== "https://access.line.me"
    || claims.aud !== channelId
    || typeof claims.sub !== "string"
    || claims.sub.length < 1
    || claims.sub.length > 255
    || claims.sub.trim() !== claims.sub
    || typeof claims.exp !== "number"
    || !Number.isFinite(claims.exp)
    || claims.exp <= nowSeconds) {
    throw new LineLiffError(401, "LINE 登入憑證與目前 LIFF 設定不符，請重新登入。");
  }
  return { channelId, lineUserId: claims.sub };
}

interface LineLinkIntent extends Expiring {
  channelId: string;
  lineUserId: string;
  nonce: string;
}

export async function createLineLinkIntentCookie(identity: VerifiedLineIdentity, secret: string, now = Date.now()): Promise<string> {
  const token = await signPayload<LineLinkIntent>({
    ...identity,
    nonce: randomToken(),
    expiresAt: Math.floor(now / 1000) + LINE_LIFF_INTENT_TTL_SECONDS,
  }, secret);
  return serializeCookie(LINE_LIFF_INTENT_COOKIE, token, {
    maxAge: LINE_LIFF_INTENT_TTL_SECONDS,
    path: LINE_LIFF_INTENT_PATH,
  });
}

export async function readLineLinkIntent(token: string | undefined, secret: string, expectedChannelId: string, now = Date.now()): Promise<VerifiedLineIdentity | null> {
  const intent = await verifyPayload<LineLinkIntent>(token, secret, now);
  if (!intent
    || intent.channelId !== expectedChannelId
    || typeof intent.lineUserId !== "string"
    || intent.lineUserId.length < 1
    || intent.lineUserId.length > 255
    || intent.lineUserId.trim() !== intent.lineUserId
    || typeof intent.nonce !== "string"
    || intent.nonce.length < 16) return null;
  return { channelId: intent.channelId, lineUserId: intent.lineUserId };
}

export function clearLineLinkIntentCookie(): string {
  return clearCookie(LINE_LIFF_INTENT_COOKIE, LINE_LIFF_INTENT_PATH);
}
