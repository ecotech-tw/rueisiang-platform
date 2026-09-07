import type { CyberbizCustomerClient, CyberbizInventoryClient } from "@rueisiang/cyberbiz";
import {
  classifyPayload,
  createWebhookEventId,
  isProductTopic,
  parseCyberbizCustomer,
  parseProductEvent,
} from "@rueisiang/cyberbiz";
import type { Database } from "./client.js";
import { processCustomerWebhook, type WebhookOutcome } from "./crm-webhook.js";
import { processProductWebhook, type ProductWebhookOutcome } from "./wms-webhook.js";
import { claimCyberbizWebhookEvent } from "./webhook-events.js";

/**
 * CYBERBIZ 的 webhook 只有一個網址，進來之後在這裡分派。
 *
 * 為什麼是一個網址而不是每種事件一個：
 *
 * CYBERBIZ 後台的訂閱是人手動設的，每多一個網址就多一個「有沒有設到」的問題，
 * 而設漏了不會有任何錯誤訊息——只會安靜地不同步。一個網址的話，只要它通了就
 * 全部都通了。之後要接第三種事件（訂單？）也不必再回後台加一次。
 *
 * 代價是這裡要自己判斷「這是什麼事件」。那個判斷本來就跑不掉：CYBERBIZ 不一定
 * 送 topic 標頭，所以就算分成好幾個網址，每一條也還是得驗證自己收到的東西是不是
 * 該收的（會員事件打到商品那條要擋下來）。分派集中在這裡，那段邏輯只有一份。
 */

export interface DispatchInput {
  rawBody: string;
  topic: string;
  /** 會員事件要用它回官網重讀完整資料。 */
  customerClient?: CyberbizCustomerClient;
  /** 商品事件要用它回官網重讀庫存數量。 */
  inventoryClient?: CyberbizInventoryClient;
}

export type DispatchOutcome =
  | ({ kind: "customer" } & WebhookOutcome)
  | ({ kind: "product" } & ProductWebhookOutcome);

/**
 * 這是商品／庫存事件嗎？
 *
 * 兩層都看，而且 payload 優先：
 *
 * - `classifyPayload` 看的是只有商品才有的欄位（product_id、sku、
 *   inventory_quantity…）。那是實際擋得住東西的一層。
 * - topic 只在 payload 看不出來的時候當補充。舊系統的作法是「沒有 topic 標頭就
 *   當成 variants/update」，等於根本沒在檢查——這裡不那樣做。
 *
 * 判斷不出來就當成會員：`processCustomerWebhook` 自己還會再檢查一次，認不出來
 * 的它會記成 ignored 而不是硬寫進客戶表。那條路已經有完整的防線，不必在這裡
 * 再造一個。
 */
function looksLikeProduct(payload: unknown, topic: string): boolean {
  const kind = classifyPayload(payload);
  if (kind === "product") return true;
  if (kind === "customer") return false;
  return isProductTopic(topic);
}

export async function dispatchCyberbizWebhook(
  db: Database,
  input: DispatchInput,
): Promise<DispatchOutcome> {
  const { rawBody, topic } = input;

  /*
   * 這裡只為了分派而 parse，壞掉的 JSON 不在這裡報錯——交給下游的處理函式，
   * 它會把「收到一筆壞掉的東西」如實記下來。在這裡丟錯的話那筆事件不會落地，
   * 而「到底有沒有收到」正是事後最想知道的事。
   */
  let payload: unknown = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    /* 讓下游處理。 */
  }

  const eventId = await createWebhookEventId(topic, rawBody);
  if (looksLikeProduct(payload, topic)) {
    const event = parseProductEvent(payload);
    const claim = await claimCyberbizWebhookEvent(db, {
      id: eventId,
      topic,
      entityType: "product",
      externalEntityId: event.variantId || null,
      payloadJson: rawBody,
    });
    if (!claim.claimed) {
      return { kind: "product", eventId, topic, status: "duplicate", reason: claim.status };
    }

    const outcome = await processProductWebhook(db, {
      rawBody,
      topic,
      client: input.inventoryClient,
      eventId,
      claimed: true,
    });
    return { kind: "product", ...outcome };
  }

  const event = parseCyberbizCustomer(payload);
  const claim = await claimCyberbizWebhookEvent(db, {
    id: eventId,
    topic,
    entityType: "customer",
    externalEntityId: event.externalId || null,
    cyberbizCustomerId: event.externalId || null,
    payloadJson: rawBody,
  });
  if (!claim.claimed) {
    return { kind: "customer", eventId, topic, status: "duplicate", reason: claim.status };
  }

  const outcome = await processCustomerWebhook(db, {
    rawBody,
    topic,
    client: input.customerClient,
    eventId,
    claimed: true,
  });
  return { kind: "customer", ...outcome };
}
