import { signPayload, verifyPayload, type Expiring } from "./signed.js";

/**
 * Session 內容。
 *
 * 刻意**不放角色與權限**。舊系統的 cookie 裡有 role 欄位卻從不採信
 * （每次請求都回 DB 重讀），那個欄位只會誤導人以為它是授權依據。
 * 這裡直接不放：授權一律以資料庫當下的狀態為準，停權才能即時生效。
 */
export interface SessionClaims extends Expiring {
  userId: string;
  email: string;
  name: string;
  pictureUrl: string;
  issuedAt: number;
}

export const SESSION_COOKIE = "rueisiang_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  return signPayload(claims, secret);
}

export async function verifySession(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<SessionClaims | null> {
  const claims = await verifyPayload<SessionClaims>(token, secret, now);
  if (!claims || typeof claims.userId !== "string" || !claims.userId) return null;
  return claims;
}

export function newSessionClaims(
  user: { id: string; email: string; name: string; pictureUrl: string },
  now = Date.now(),
): SessionClaims {
  const issuedAt = Math.floor(now / 1000);
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    pictureUrl: user.pictureUrl,
    issuedAt,
    expiresAt: issuedAt + SESSION_TTL_SECONDS,
  };
}
