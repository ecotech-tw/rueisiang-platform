import type { CyberbizInventoryClient } from "@rueisiang/cyberbiz";
import { classifyPayload, createWebhookEventId, parseProductEvent } from "@rueisiang/cyberbiz";
import { eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { cyberbizProductLinks, cyberbizProductWebhooks } from "./schema/wms.js";
import { applySyncPlan, buildSyncPlan, listCompanyLinks, type SyncOutcome } from "./wms-sync.js";

/**
 * CYBERBIZ 的商品／庫存 webhook。
 *
 * 沒有這條路的時候，官網改了數量，平台要等人按「同步到庫存」才知道。倉庫的人
 * 看到的是一個安靜地過期的數字——比看到錯誤還糟，因為沒有任何跡象說它舊了。
 *
 * 兩個跟會員那條路一樣的原則：
 *
 * 1. **先落地再處理。** 處理失敗只回 5xx 讓 CYBERBIZ 重送的話，重送次數用完
 *    事件就永遠消失了。存下來之後失敗的可以事後補跑，也看得出「到底有沒有收到」。
 * 2. **不採信 payload 的數量，回官網重讀。** 事件只用來知道「哪個商品動了」。
 *    這樣 buildSyncPlan 的三條不變條件（款式在不在、product_id 對不對、SKU 對
 *    不對）才有意義——拿事件自己說的數字去寫，等於讓事件自己證明自己。
 */

export interface ProductWebhookOutcome {
  eventId: string;
  topic: string;
  status: "processed" | "ignored" | "failed" | "duplicate";
  productId?: string | null;
  variantId?: string | null;
  reason?: string;
  error?: string;
  sync?: SyncOutcome & { linked: number };
}

export interface ProcessProductWebhookInput {
  rawBody: string;
  topic: string;
  /** 沒有 client 就沒辦法重讀，只能記下來等補跑。 */
  client?: CyberbizInventoryClient;
}

/** 把事件的處理結果寫回去。result 存 JSON，之後查「那次到底做了什麼」用。 */
async function markEvent(
  db: Database,
  eventId: string,
  input: { status: string; result?: unknown; error?: string },
): Promise<void> {
  await db
    .update(cyberbizProductWebhooks)
    .set({
      status: input.status,
      result: input.result === undefined ? "" : JSON.stringify(input.result),
      lastError: input.error ?? "",
      processedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(cyberbizProductWebhooks.id, eventId));
}

export async function processProductWebhook(
  db: Database,
  input: ProcessProductWebhookInput,
): Promise<ProductWebhookOutcome> {
  const { rawBody, topic, client } = input;

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw new Error("webhook 內容不是有效的 JSON");
  }

  const eventId = await createWebhookEventId(topic, rawBody);
  const event = parseProductEvent(payload);

  const [duplicate] = await db
    .select({ status: cyberbizProductWebhooks.status })
    .from(cyberbizProductWebhooks)
    .where(eq(cyberbizProductWebhooks.id, eventId))
    .limit(1);
  if (duplicate) return { eventId, topic, status: "duplicate", reason: duplicate.status };

  await db.insert(cyberbizProductWebhooks).values({
    id: eventId,
    topic,
    productId: event.productId || null,
    variantId: event.variantId || null,
    sku: event.sku,
    quantity: event.quantity,
    payloadHash: eventId,
    status: "processing",
  });

  try {
    /*
     * 這條路只收商品事件。
     *
     * 不看 topic：CYBERBIZ 不一定送 topic 標頭，沒送就是 unknown——舊系統的作法
     * 是「沒有標頭就當成 variants/update」，那等於根本沒在檢查。改看 payload
     * 自己的欄位，那是實際擋得住東西的那一層。會員事件打錯到這條路要擋下來，
     * 不然它會被記成一筆認不出身分的商品事件。
     */
    if (classifyPayload(payload) === "customer") {
      const reason = "這是會員事件，不是商品／庫存（請改送 /api/webhooks/cyberbiz/customers）";
      await markEvent(db, eventId, { status: "ignored", result: { reason } });
      return { eventId, topic, status: "ignored", reason };
    }

    if (!event.productId && !event.variantId) {
      const reason = "認不出是哪個商品：payload 裡沒有 product_id 也沒有 variant_id";
      await markEvent(db, eventId, { status: "ignored", result: { reason } });
      return { eventId, topic, status: "ignored", reason };
    }

    /*
     * 只帶款式 id 的事件也要能處理。
     *
     * 重讀要的是 product_id（官網只有 /v1/products/{id} 這個端點），所以從連結
     * 反查一次。查不到就代表這個款式根本沒連到 WMS——那不是錯誤，官網有幾千個
     * 商品，絕大多數本來就跟倉儲無關。
     */
    let productId = event.productId;
    if (!productId) {
      const [link] = await db
        .select({ productId: cyberbizProductLinks.cyberbizProductId })
        .from(cyberbizProductLinks)
        .where(eq(cyberbizProductLinks.cyberbizVariantId, event.variantId))
        .limit(1);
      if (!link) {
        const reason = "這個款式沒有連結到 WMS 的商品";
        await markEvent(db, eventId, { status: "ignored", result: { reason } });
        return { eventId, topic, status: "ignored", reason, variantId: event.variantId };
      }
      productId = link.productId;

      /*
       * 反查到就立刻寫回去。
       *
       * 這一列是在解析完就插進去的，那時候只有 variant_id——如果接下來重讀官網
       * 失敗，這一列會以 product_id = null 留在 failed。補跑是靠 product_id 重新
       * 同步的，讀到 null 就直接放棄，於是這種事件**永遠救不回來**，而且沒有任何
       * 跡象。（補跑那邊另外也加了用 variant_id 反查的退路，處理這次修正之前就
       * 已經卡在那裡的舊資料。）
       */
      await db
        .update(cyberbizProductWebhooks)
        .set({ productId, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(cyberbizProductWebhooks.id, eventId));
    }

    const links = await listCompanyLinks(db, productId);
    if (!links.length) {
      const reason = "這個商品沒有連結到 WMS 的商品";
      await markEvent(db, eventId, { status: "ignored", result: { reason, productId } });
      return { eventId, topic, status: "ignored", reason, productId, variantId: event.variantId || null };
    }

    if (!client) throw new Error("尚未設定 CYBERBIZ_API_TOKEN，無法回官網重讀數量");

    // 回官網重讀。事件說的數量只進 webhook 那張表，不進庫存。
    const remotes = await client.fetchProduct(productId);
    /*
     * actor 給 null：這不是任何人按的。activityRow 會把它記成 system，
     * 操作紀錄那一頁顯示「系統」。
     */
    const outcome = await applySyncPlan(db, buildSyncPlan(links, remotes), null);
    const sync = { ...outcome, linked: links.length };

    await markEvent(db, eventId, { status: "processed", result: { productId, sync } });
    return {
      eventId,
      topic,
      status: "processed",
      productId,
      variantId: event.variantId || null,
      sync,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "處理商品 webhook 時失敗";
    await markEvent(db, eventId, { status: "failed", error: message });
    return {
      eventId,
      topic,
      status: "failed",
      productId: event.productId || null,
      variantId: event.variantId || null,
      error: message,
    };
  }
}

/** 一次補跑幾筆。Worker 有執行時間上限，而每一筆都要去官網讀一次。 */
const MAX_RETRIES_PER_RUN = 10;

/**
 * 補跑失敗的商品 webhook。cron 每 15 分叫一次。
 *
 * 失敗的多半是「官網當下不通」這種會自己好的狀況。CYBERBIZ 的重送次數有限，
 * 用完就沒了，所以補跑這一步是「事件收到了但沒處理成功」的最後一道網。
 */
export async function retryFailedProductWebhooks(
  db: Database,
  input: { client?: CyberbizInventoryClient } = {},
): Promise<{ attempted: number; processed: number; failed: number }> {
  const pending = await db
    .select({
      id: cyberbizProductWebhooks.id,
      topic: cyberbizProductWebhooks.topic,
      productId: cyberbizProductWebhooks.productId,
      variantId: cyberbizProductWebhooks.variantId,
    })
    .from(cyberbizProductWebhooks)
    .where(eq(cyberbizProductWebhooks.status, "failed"))
    .limit(MAX_RETRIES_PER_RUN);

  let processed = 0;
  let failed = 0;

  for (const row of pending) {
    /*
     * 補跑不重放原本的 payload——那份已經舊了，而且我們本來就不採信它的數量。
     * 直接拿 product_id 重新同步一次，結果一樣而且用的是當下的數字。
     */
    try {
      if (!input.client) throw new Error("尚未設定 CYBERBIZ_API_TOKEN");

      /*
       * product_id 可能是空的：只帶款式 id 的事件在反查之前就先落地了。正常情況
       * 反查完會寫回去，但在那之前失敗的舊資料還留著 null——用 variant_id 再查
       * 一次就救得回來。
       */
      let productId = row.productId;
      if (!productId && row.variantId) {
        const [link] = await db
          .select({ productId: cyberbizProductLinks.cyberbizProductId })
          .from(cyberbizProductLinks)
          .where(eq(cyberbizProductLinks.cyberbizVariantId, row.variantId))
          .limit(1);
        productId = link?.productId ?? null;
      }
      if (!productId) throw new Error("這筆事件沒有 product_id，補跑不了");

      const links = await listCompanyLinks(db, productId);
      if (links.length) {
        const remotes = await input.client.fetchProduct(productId);
        await applySyncPlan(db, buildSyncPlan(links, remotes), null);
      }
      await db
        .update(cyberbizProductWebhooks)
        .set({
          status: "processed",
          productId,
          attempts: sql`${cyberbizProductWebhooks.attempts} + 1`,
          lastError: "",
          processedAt: sql`CURRENT_TIMESTAMP`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(cyberbizProductWebhooks.id, row.id));
      processed += 1;
    } catch (error) {
      failed += 1;
      await db
        .update(cyberbizProductWebhooks)
        .set({
          attempts: sql`${cyberbizProductWebhooks.attempts} + 1`,
          lastError: error instanceof Error ? error.message : "補跑失敗",
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(cyberbizProductWebhooks.id, row.id));
    }
  }

  return { attempted: pending.length, processed, failed };
}
