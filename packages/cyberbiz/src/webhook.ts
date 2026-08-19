/**
 * CYBERBIZ webhook 的驗證與識別。
 *
 * 搬自 CRM 的 lib/cyberbiz-webhook.ts。兩種驗證方式擇一通過即可，因為
 * CYBERBIZ 後台不一定讓你設自訂標頭：
 *
 *   1. 共用密鑰：網址的 ?token= 或 Authorization: Bearer
 *   2. HMAC-SHA256 簽章：用密鑰對 raw body 簽，比對簽章標頭
 *
 * 簽章比較安全（密鑰不會出現在網址與各種 log 裡），能設就用它。
 */

const SIGNATURE_HEADERS = [
  "x-cyberbiz-hmac-sha256",
  "x-cyberbiz-hmac-sha-256",
  "x-cyberbiz-signature",
  "x-hub-signature-256",
];

/**
 * 逐字元比到底，不因為第一個字不同就提早回傳。
 * 提早回傳會讓「猜對幾個字」變成可以從回應時間量出來的資訊。
 */
function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function hmacSha256(secret: string, body: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
}

export async function verifyCyberbizWebhook(
  request: Request,
  rawBody: string,
  secret: string,
): Promise<boolean> {
  // 沒設密鑰時一律不通過。開著一條誰都能打的寫入端點比擋掉真事件糟得多。
  if (!secret) return false;

  const urlToken = new URL(request.url).searchParams.get("token") || "";
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (urlToken && constantTimeEqual(urlToken, secret)) return true;
  if (bearer && constantTimeEqual(bearer, secret)) return true;

  const signature = SIGNATURE_HEADERS.map((header) => request.headers.get(header))
    .find(Boolean)
    ?.replace(/^sha256=/i, "")
    .trim();
  if (!signature) return false;

  // 三種編碼都比對過：不同來源送 hex、base64、base64url 的都有。
  const digest = await hmacSha256(secret, rawBody);
  const candidates = [
    toHex(digest),
    toBase64(digest),
    toBase64(digest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  ];
  return candidates.some((candidate) => constantTimeEqual(candidate, signature));
}

/**
 * 事件類型。標頭優先，其次看 body，都沒有就是 unknown。
 *
 * 先前的預設值是 "customers/update"——「猜不出來就當成會員更新」。實際上
 * CYBERBIZ 的商品庫存事件不帶 topic 標頭，於是整批商品被當成會員寫進客戶表，
 * 客戶列表裡出現一位叫「★潤白養膚小皂」的客人。預設值必須是「不知道」，
 * 而不知道就不要處理。
 */
export function readCyberbizTopic(request: Request, payload: unknown): string {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const header =
    request.headers.get("x-cyberbiz-topic") ||
    request.headers.get("x-webhook-event") ||
    request.headers.get("x-event-topic");
  const body = [record.topic, record.event, record.event_type, record.type].find(
    (value) => typeof value === "string",
  );
  return (header || body || "unknown").toString().trim().toLowerCase();
}

/**
 * 事件的識別碼＝topic 與原始 body 的雜湊。
 *
 * CYBERBIZ 不保證帶唯一 ID，而重送是正常行為（我們回 5xx 時它會再送）。
 * 用內容做識別碼，同一個事件重送幾次都只會處理一次。
 */
export async function createWebhookEventId(topic: string, rawBody: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${topic}\n${rawBody}`)),
  );
  return toHex(bytes);
}

/** 明確標成會員相關的事件。unknown 不算——那是「沒有標」，不是「是會員」。 */
export function isCustomerTopic(topic: string): boolean {
  if (!topic || topic === "unknown") return false;
  return /customer|member|uid|tag/i.test(topic);
}

/** 只有商品／庫存事件才有的欄位。出現任何一個就確定不是會員。 */
const PRODUCT_MARKERS = [
  "product_id",
  "variant_id",
  "sku",
  "inventory_quantity",
  "inventory_policy",
  "inventory_management",
  "compare_at_price",
];

/** 只有會員才有的欄位。 */
const CUSTOMER_MARKERS = [
  "mobile",
  "email",
  "uid_providers",
  "accepts_marketing",
  "accepts_email_notification",
  "bonus_remain",
];

export type PayloadKind = "customer" | "product" | "unknown";

/**
 * 用 payload 自己的欄位判斷這是什麼事件。
 *
 * CYBERBIZ 不一定送 topic 標頭，所以不能只靠 topic。商品事件的辨識特別重要——
 * 它同樣有 id 與 name，光看那兩個欄位跟會員長得一模一樣。
 */
export function classifyPayload(payload: unknown): PayloadKind {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const nested =
    (record.customer as Record<string, unknown> | undefined) ??
    (record.member as Record<string, unknown> | undefined) ??
    record;
  const keys = new Set([...Object.keys(record), ...Object.keys(nested ?? {})]);

  if (PRODUCT_MARKERS.some((marker) => keys.has(marker))) return "product";
  if (CUSTOMER_MARKERS.some((marker) => keys.has(marker))) return "customer";
  return "unknown";
}
