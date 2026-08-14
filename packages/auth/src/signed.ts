import { decodeBase64Url, decodeTextBase64Url, encodeBase64Url, encodeTextBase64Url, utf8 } from "./base64url.js";

/** 所有簽章內容都必須帶到期時間（Unix 秒），沒有永久有效的東西。 */
export interface Expiring {
  expiresAt: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("簽章用的 secret 是空的。");
  return crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * 產生 `<payload>.<signature>`，兩段都是 base64url。
 *
 * 用於 session cookie 與 OAuth 交易狀態——兩者都是「發給瀏覽器保管、
 * 回來時要能確認沒被動過」的資料，不需要伺服器端狀態。
 */
export async function signPayload<T extends Expiring>(payload: T, secret: string): Promise<string> {
  const encoded = encodeTextBase64Url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(encoded));
  return `${encoded}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/**
 * 驗簽並解出內容。任何一步不對就回 null，不拋例外——呼叫端只需要分辨
 * 「有沒有有效內容」，不需要知道是簽章錯還是過期。
 *
 * 比對用 crypto.subtle.verify 而不是字串相等，避免時間差攻擊。
 */
export async function verifyPayload<T extends Expiring>(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<T | null> {
  if (!token) return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      decodeBase64Url(signature),
      utf8(encoded),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: T;
  try {
    payload = JSON.parse(decodeTextBase64Url(encoded)) as T;
  } catch {
    return null;
  }

  if (typeof payload?.expiresAt !== "number" || payload.expiresAt * 1000 <= now) return null;
  return payload;
}
