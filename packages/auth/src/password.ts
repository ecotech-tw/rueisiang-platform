import { decodeBase64Url, encodeBase64Url, utf8 } from "./base64url.js";
import { randomToken } from "./google-oauth.js";

/**
 * 密碼與邀請 token 的雜湊。
 *
 * 用 PBKDF2-SHA256 而不是 bcrypt/argon2：Worker 沒有原生模組，能用的只有
 * WebCrypto。作法與參數（120k 輪）沿用 rueisiang-crm 已經在跑的那一套，
 * 兩邊的雜湊字串格式一樣，之後真要搬帳號過來不用重設密碼。
 *
 * 雜湊字串把演算法與輪數一起存進去（pbkdf2-sha256$120000$salt$digest）。
 * 之後要調高輪數時，舊的雜湊照樣驗得過——驗證讀的是字串裡的輪數，不是常數。
 */

/**
 * 迭代次數。**這個值被 Cloudflare Workers 的上限釘死在 100,000。**
 *
 * Workers 為了防 DoS，把 PBKDF2 的迭代次數上限鎖在 100000，超過會直接丟
 * `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported`。
 *
 * 這裡原本抄 rueisiang-crm 的 120000——但 CRM 跑在 Node 上沒有這個限制，所以
 * 本機測試全過（vitest 也是 Node），一上 Worker 就 500。錯誤只會出現在正式站，
 * 這是最難發現的一種：測試綠燈、部署成功、使用者按下去才爆。
 *
 * 要調高只能等 Workers 放寬。不要為了「更安全」把它改上去——那不是更安全，
 * 是整條設密碼與登入的路都掛掉。
 *
 * 參考：https://github.com/cloudflare/workerd/issues/1346
 */
const ITERATIONS = 100_000;

/** 低於這個輪數的雜湊一律當作無效，避免有人塞一個 iterations=1 的字串進來。 */
const MIN_ITERATIONS = 100_000;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new Uint8Array(salt).buffer as ArrayBuffer, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return encodeBase64Url(new Uint8Array(bits));
}

/**
 * 密碼規則只管長度。
 *
 * 不強制大小寫與符號：那種規則實務上只會把人逼去用 Password1! 這種好猜的東西，
 * 真正有效的是長度。上限 128 是為了擋「送一個 10MB 的字串來把 CPU 燒掉」。
 */
export function validatePassword(password: string): string | null {
  if (password.length < 8) return "密碼至少要 8 個字元。";
  if (password.length > 128) return "密碼不能超過 128 個字元。";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomToken(16);
  const digest = await derive(password, decodeBase64Url(salt), ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${salt}$${digest}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsText, salt, expected] = encoded.split("$");
  const iterations = Number(iterationsText);
  if (
    algorithm !== "pbkdf2-sha256" ||
    !Number.isSafeInteger(iterations) ||
    iterations < MIN_ITERATIONS ||
    !salt ||
    !expected
  ) {
    return false;
  }

  try {
    const actual = await derive(password, decodeBase64Url(salt), iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    // salt 不是合法的 base64url 之類的畸形輸入。當作驗證失敗，不要往上丟。
    return false;
  }
}

/**
 * 定時比較。用 === 的話字串長度與第一個不同的位置會反映在耗時上，
 * 理論上能被拿來一個字元一個字元地猜。
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * 邀請 token 只存雜湊，跟密碼同一個道理：資料庫外洩時，拿到的那一串
 * 沒辦法拿去換帳號。這裡用單純的 SHA-256 而不是 PBKDF2——token 本身就是
 * 32 bytes 的亂數，沒有「被字典攻擊」的問題，不需要慢雜湊。
 */
export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(token));
  return encodeBase64Url(new Uint8Array(digest));
}

/** 產生一組邀請 token。32 bytes 的亂數，猜不到也列不完。 */
export function newInviteToken(): string {
  return randomToken(32);
}

/** 邀請連結的有效期。過期就請管理者重發，不做「自動延長」那種讓人搞不清楚狀態的事。 */
export const INVITE_TTL_DAYS = 7;

export function inviteExpiryFrom(now: Date): string {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
