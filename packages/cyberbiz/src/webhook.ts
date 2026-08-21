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

/**
 * 明確標成商品／庫存相關的事件。
 *
 * 跟 isCustomerTopic 一樣，unknown 不算。CYBERBIZ 常常不送 topic 標頭，所以這個
 * 判斷只是輔助——真正擋得住東西的是 classifyPayload（看 payload 自己的欄位）。
 */
export function isProductTopic(topic: string): boolean {
  if (!topic || topic === "unknown") return false;
  return /variant|product|inventory|stock/i.test(topic);
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
/**
 * 事件的內容可能被包在哪一層。
 *
 * CYBERBIZ 依觸發來源不同會把同一組欄位放在不同位置，所以每一層都要看過。
 * **這份清單要跟 parseProductEvent 挖的位置一致**——分類看得比解析淺的話，
 * 就會出現「解析得出來、但分類說認不出來」的事件：它會被送去會員那條路、
 * 記成 ignored、然後永遠不同步，而且過程中不會有任何錯誤。
 */
const CONTAINERS = ["customer", "member", "data", "variant", "product_variant", "product"];

export function classifyPayload(payload: unknown): PayloadKind {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

  const keys = new Set(Object.keys(record));
  for (const container of CONTAINERS) {
    const value = record[container];
    if (value && typeof value === "object") {
      for (const key of Object.keys(value as Record<string, unknown>)) keys.add(key);
    }
  }

  if (PRODUCT_MARKERS.some((marker) => keys.has(marker))) return "product";
  if (CUSTOMER_MARKERS.some((marker) => keys.has(marker))) return "customer";
  return "unknown";
}

/**
 * 商品／庫存事件裡的身分。
 *
 * CYBERBIZ 把同一組欄位放在好幾個不同的位置，看它是從哪個介面觸發的——有時在
 * 最上層、有時包在 `data` 裡、有時包在 `product_variant` 或 `variant` 裡。每個
 * 欄位都要把所有已知的位置找過一遍，少找一個就是整筆事件被當成「認不出來」。
 * 這份對照是舊系統跟正式站對打之後留下來的，不要照文件重寫。
 */
export interface CyberbizProductEvent {
  productId: string;
  variantId: string;
  sku: string;
  /** 事件自己說的數量。**只拿來記錄，不拿來寫庫存**——寫之前一律回官網重讀。 */
  quantity: number | null;
}

function textOf(...values: unknown[]): string {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
  }
  return "";
}

function intOf(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }
  return null;
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function parseProductEvent(payload: unknown): CyberbizProductEvent {
  const root = objectOf(payload);
  const data = objectOf(root.data);
  const variant = objectOf(
    root.product_variant ?? root.variant ?? data.product_variant ?? data.variant ?? data,
  );
  const product = objectOf(root.product ?? data.product);

  return {
    productId: textOf(root.product_id, data.product_id, variant.product_id, product.id),
    variantId: textOf(
      root.variant_id,
      root.product_variant_id,
      data.variant_id,
      data.product_variant_id,
      variant.id,
      // 最後才看 payload 自己的 id：variants/update 的最上層 id 就是款式 id。
      root.id,
    ),
    sku: textOf(root.sku, data.sku, variant.sku),
    quantity: intOf(
      root.inventory_quantity,
      root.quantity,
      data.inventory_quantity,
      data.quantity,
      variant.inventory_quantity,
      variant.quantity,
    ),
  };
}
