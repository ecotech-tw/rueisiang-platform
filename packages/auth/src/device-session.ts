import { encodeBase64Url, utf8 } from "./base64url.js";
import { randomToken } from "./google-oauth.js";

/**
 * HR app 的「記住這台手機」。
 *
 * 跟 session cookie 分開發，因為兩者給的東西不一樣：session 是 12 小時、
 * `.rueisiang.com` 共用、能開整個後台；這張只給員工本人入口
 * （見 apps/api 的 requireSelfAuth），掉了手機也開不了後台。
 *
 * 內容是 `<id>.<secret>`，資料庫只存 secret 的雜湊。不用簽章 cookie 的理由：
 * 簽章 cookie 沒辦法單獨撤銷一台裝置，而長效憑證一定要能撤。
 */
export const DEVICE_SESSION_COOKIE = "rueisiang_hr_device";

/** 閒置多久要重新登入。每天打卡的人會一直被延長，永遠不用重登。 */
export const DEVICE_SESSION_IDLE_SECONDS = 7 * 24 * 60 * 60;

/** 多久換一次 secret。每個請求都換的話，每次打 API 都要寫 D1。 */
export const DEVICE_SESSION_ROTATE_SECONDS = 24 * 60 * 60;

/**
 * 換 secret 之後，舊值還能用多久。
 *
 * 同一頁常常同時發好幾個請求：第一個換掉 secret 時，其他幾個帶的還是舊值。
 * 沒有這段緩衝，它們會被當成「舊 token 被偷去用」而把整台裝置踢掉。
 */
export const DEVICE_SESSION_REUSE_GRACE_SECONDS = 2 * 60;

export interface DeviceToken {
  id: string;
  secret: string;
}

export function newDeviceToken(): DeviceToken {
  return { id: randomToken(16), secret: randomToken(32) };
}

export function serializeDeviceToken(token: DeviceToken): string {
  return `${token.id}.${token.secret}`;
}

/** base64url 不含 `.`，所以用第一個點切開不會切錯。 */
export function parseDeviceToken(value: string | undefined): DeviceToken | null {
  if (!value) return null;
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1) return null;
  return { id: value.slice(0, separator), secret: value.slice(separator + 1) };
}

/** secret 本身是 32 bytes 亂數，跟邀請 token 一樣用 SHA-256 就夠，不需要慢雜湊。 */
export async function hashDeviceSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(secret));
  return encodeBase64Url(new Uint8Array(digest));
}
