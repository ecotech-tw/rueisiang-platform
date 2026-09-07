import type { CyberbizCustomerClient } from "@rueisiang/cyberbiz";
import {
  classifyPayload,
  createWebhookEventId,
  isCustomerTopic,
  parseCyberbizCustomer,
} from "@rueisiang/cyberbiz";
import { and, desc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { syncCyberbizCustomer, type CyberbizSyncResult } from "./crm-sync.js";
import { crmCustomers, cyberbizWebhookEvents } from "./schema/crm.js";

/**
 * 收到的 webhook 先落地再處理。
 *
 * 為什麼要落地：處理失敗時如果只回 5xx 讓 CYBERBIZ 重送，重送次數用完事件就
 * 永遠消失了。存下來之後，失敗的可以事後補跑，也看得出「到底有沒有收到」。
 */

export interface WebhookOutcome {
  eventId: string;
  topic: string;
  status: "processed" | "ignored" | "failed" | "duplicate";
  action?: CyberbizSyncResult["action"];
  customerId?: string | null;
  reason?: string;
  /** status 是 failed 時，處理當下的錯誤訊息。 */
  error?: string;
}

/**
 * 這份資料除了 ID 以外還有沒有真的內容。
 * 只有 ID 的話寫進去就是一筆空殼客戶，不如記成失敗讓人看得見。
 */
function hasUsableProfile(customer: { phone: string; name: string; email: string; address: string }): boolean {
  return Boolean(customer.phone || customer.name || customer.email || customer.address);
}

export interface ProcessWebhookInput {
  rawBody: string;
  topic: string;
  /** 沒有 client 時就只用 payload 本身的內容，不去官網重新讀。 */
  client?: CyberbizCustomerClient;
  /** Cron 已經 claim 的事件；一般 webhook 不傳，會由 insert 取得 claim。 */
  eventId?: string;
  processingToken?: string;
}

export async function processCustomerWebhook(
  db: Database,
  input: ProcessWebhookInput,
): Promise<WebhookOutcome> {
  const { rawBody, topic, client } = input;

  let payload: unknown;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw new Error("webhook 內容不是有效的 JSON");
  }

  const eventId = input.eventId ?? await createWebhookEventId(topic, rawBody);
  const processingToken = input.processingToken ?? crypto.randomUUID();
  let incoming = parseCyberbizCustomer(payload);

  if (input.processingToken) {
    const [claimed] = await db
      .select({ id: cyberbizWebhookEvents.id })
      .from(cyberbizWebhookEvents)
      .where(and(
        eq(cyberbizWebhookEvents.id, eventId),
        eq(cyberbizWebhookEvents.processingToken, processingToken),
        eq(cyberbizWebhookEvents.status, "processing"),
      ))
      .limit(1);
    if (!claimed) return { eventId, topic, status: "duplicate", reason: "claim_lost" };
  } else {
    const inserted = await db.insert(cyberbizWebhookEvents).values({
      id: eventId,
      topic,
      status: "processing",
      // entityType 是目標形狀（會員與商品事件共用一張表）的分辨欄位。商品那邊還在
      // cyberbiz_product_webhooks，但這裡先寫對，那一欄才有可信度。
      entityType: "customer",
      externalEntityId: incoming.externalId || null,
      cyberbizCustomerId: incoming.externalId || null,
      payloadJson: rawBody,
      processingToken,
    }).onConflictDoNothing();

    /*
     * 兩個相同 webhook 可能同時抵達：先查再 insert 不是 claim，兩邊都可能在查詢
     * 時看不到資料，接著其中一邊會撞 primary key。用 SQLite 的 affected-row 數量
     * 把 insert 本身當成 claim；只有成功插入的那一邊可以繼續處理，另一邊正常回報
     * duplicate，不讓 CYBERBIZ 或 Workers Logs 收到假的 500。
     */
    if ((inserted.meta?.changes ?? 0) === 0) {
      const [duplicate] = await db
        .select({ status: cyberbizWebhookEvents.status })
        .from(cyberbizWebhookEvents)
        .where(eq(cyberbizWebhookEvents.id, eventId))
        .limit(1);
      if (!duplicate) throw new Error("webhook 去重後找不到既有事件。");
      return { eventId, topic, status: "duplicate", reason: duplicate.status };
    }
  }

  try {
    /*
     * 判斷這到底是不是會員事件。
     *
     * 兩件事都要看，而且預設是「不處理」：
     *   - topic：CYBERBIZ 不一定送標頭，沒送就是 unknown，不能當成會員
     *   - payload 的欄位：商品事件同樣有 id 與 name，光看那兩個欄位跟會員
     *     長得一模一樣。要靠 product_id／sku／inventory_quantity 這些
     *     只有商品才有的欄位才分得出來
     *
     * 先前兩層都是「猜不出來就當會員」，結果整批商品庫存事件被寫成客戶。
     */
    const kind = classifyPayload(payload);
    if (kind === "product") {
      const reason = "商品／庫存事件，不是會員（Phase 4 才會用到）";
      await markEvent(db, eventId, processingToken, { status: "ignored", result: { reason } });
      return { eventId, topic, status: "ignored", reason };
    }
    if (!isCustomerTopic(topic) && kind !== "customer") {
      const reason = "無法判斷是不是會員事件，不處理";
      await markEvent(db, eventId, processingToken, { status: "ignored", result: { reason } });
      return { eventId, topic, status: "ignored", reason };
    }

    /*
     * webhook 的內容可能只有會員 ID，所以寫入前一律回官網讀一次完整資料。
     *
     * 兩個保護：ID 不是真的會員時這一步會失敗，事件記成 failed 而不是生出
     * 幽靈客戶；重讀回來的資料如果認不出 ID（某些單筆回應的包法不同），
     * 就用 webhook 原本那份——它的身分是簽章驗證過的，比一筆沒有 ID 的
     * 資料可信。
     */
    let refetchError: string | undefined;
    if (incoming.externalId && client) {
      const fromWebhook = incoming;
      try {
        const refreshed = await client.fetchOne(incoming.externalId);
        incoming = refreshed.externalId ? refreshed : fromWebhook;
      } catch (error) {
        /*
         * 重讀失敗時，只有在 webhook 自己帶了可用的個資時才往下寫。
         *
         * 上一版放寬成「有會員 ID 就寫」，結果製造出一批姓名、電話、Email
         * 全空的客戶——因為那些事件只帶了一個 ID，而那個 ID 用單筆查詢
         * 是 404（實測：列表拿到的 ID 查得到，webhook 帶的那些查不到，
         * 所以它根本不是會員 ID）。
         *
         * 空殼客戶比一筆紅色的 failed 糟得多：failed 看得到、補得回來，
         * 空殼卻會混進客戶列表，看起來像真的資料。
         */
        refetchError = error instanceof Error ? error.message : "重讀會員資料失敗";
        if (!hasUsableProfile(fromWebhook)) {
          throw new Error(`${refetchError}（事件只帶了 ID，沒有可用的會員資料）`);
        }
        incoming = fromWebhook;
      }
    }

    const result = await syncCyberbizCustomer(db, incoming, { topic, eventId });
    await markEvent(db, eventId, processingToken, {
      status: result.action === "ignored" ? "ignored" : "processed",
      customerId: result.customerId,
      cyberbizCustomerId: incoming.externalId || null,
      result: { ...result, refetchError },
      // 重讀失敗但仍然寫成功時，把原因留在事件上——狀態是「已處理」，
      // 但看得出這一筆用的是 webhook 自己帶的資料。
      ...(refetchError ? { error: refetchError } : {}),
    });

    return {
      eventId,
      topic,
      status: result.action === "ignored" ? "ignored" : "processed",
      action: result.action,
      customerId: result.customerId,
      reason: result.reason,
      ...(refetchError ? { error: refetchError } : {}),
    };
  } catch (error) {
    /*
     * 處理失敗時仍然回「收到了」，不往上丟。
     *
     * 直覺會想回 5xx 讓 CYBERBIZ 重送，但那在這裡沒有用：事件的識別碼是內容的
     * 雜湊，重送進來會走到上面那條 duplicate 判斷，直接回 200 而不會重新處理。
     * 也就是說 5xx 只換來一連串沒有效果的重送，還讓對方的後台一直亮紅燈。
     *
     * 真正會重試的是我們自己的 Cron（每 15 分鐘撿 failed 或卡住的事件補跑）。所以這裡
     * 誠實地說「收到了、但還沒處理成功」，把錯誤留在事件上讓同步頁看得到。
     */
    const message = error instanceof Error ? error.message : "webhook 處理失敗";
    await markEvent(db, eventId, processingToken, { status: "failed", error: message });
    return { eventId, topic, status: "failed", error: message };
  }
}

async function markEvent(
  db: Database,
  eventId: string,
  processingToken: string,
  update: {
    status: string;
    customerId?: string | null;
    cyberbizCustomerId?: string | null;
    result?: unknown;
    error?: string;
  },
): Promise<void> {
  await db
    .update(cyberbizWebhookEvents)
    .set({
      status: update.status,
      ...(update.customerId !== undefined ? { customerId: update.customerId } : {}),
      ...(update.cyberbizCustomerId !== undefined
        ? { cyberbizCustomerId: update.cyberbizCustomerId }
        : {}),
      ...(update.result !== undefined ? { resultJson: JSON.stringify(update.result) } : {}),
      ...(update.error !== undefined ? { lastError: update.error } : {}),
      processingToken: null,
      processedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(and(
      eq(cyberbizWebhookEvents.id, eventId),
      eq(cyberbizWebhookEvents.processingToken, processingToken),
    ));
}

/**
 * 補跑失敗或卡住的事件。
 *
 * 這條取代舊 CRM 那個「前端每 15 秒打一次 drain」的輪詢——那個作法要有人
 * 開著分頁才會動，關掉瀏覽器同步就停了。現在由 Cron 定時跑。
 *
 * processing 不能只靠狀態判斷：Worker 可能在落地事件後就被中止。超過 lease
 * 時間的 processing 事件會被重新 claim；claim token 讓舊 Worker 完成時不能覆寫
 * 新一輪的結果。
 */
const WEBHOOK_PROCESSING_LEASE_MINUTES = 15;

export async function retryFailedWebhooks(
  db: Database,
  options: { limit?: number; client?: CyberbizCustomerClient } = {},
): Promise<{ attempted: number; recovered: number; stillFailing: number }> {
  const limit = options.limit ?? 20;
  const staleProcessing = lt(
    cyberbizWebhookEvents.updatedAt,
    sql`datetime('now', '-${sql.raw(String(WEBHOOK_PROCESSING_LEASE_MINUTES))} minutes')`,
  );
  const retryable = or(
    eq(cyberbizWebhookEvents.status, "failed"),
    and(eq(cyberbizWebhookEvents.status, "processing"), staleProcessing),
  );
  const pending = await db
    .select({
      id: cyberbizWebhookEvents.id,
      topic: cyberbizWebhookEvents.topic,
      payloadJson: cyberbizWebhookEvents.payloadJson,
    })
    .from(cyberbizWebhookEvents)
    .where(retryable)
    .orderBy(desc(cyberbizWebhookEvents.receivedAt))
    .limit(limit);

  let attempted = 0;
  let recovered = 0;
  for (const event of pending) {
    const processingToken = crypto.randomUUID();
    const claimed = await db
      .update(cyberbizWebhookEvents)
      .set({
        status: "processing",
        processingToken,
        attempts: sql`${cyberbizWebhookEvents.attempts} + 1`,
        lastError: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(and(
        eq(cyberbizWebhookEvents.id, event.id),
        retryable,
      ));
    if ((claimed.meta?.changes ?? 0) === 0) continue;
    attempted += 1;

    try {
      const outcome = await processCustomerWebhook(db, {
        rawBody: event.payloadJson,
        topic: event.topic,
        client: options.client,
        eventId: event.id,
        processingToken,
      });
      if (outcome.status === "processed" || outcome.status === "ignored") recovered += 1;
    } catch {
      // processCustomerWebhook 已經把狀態寫回 failed，這裡不用再做什麼。
    }
  }

  return { attempted, recovered, stillFailing: attempted - recovered };
}

export interface SyncStatus {
  customers: { total: number; synced: number; failed: number };
  syncedAt: string | null;
  webhooks: { processed: number; failed: number; ignored: number; lastReceivedAt: string | null };
  recent: {
    id: string;
    topic: string;
    status: string;
    cyberbizCustomerId: string | null;
    lastError: string | null;
    receivedAt: string;
    /** 原始事件內容。查「這個 ID 到底是什麼」時沒有它就只能猜。 */
    payloadJson: string;
  }[];
}

export async function readSyncStatus(db: Database): Promise<SyncStatus> {
  const [customerCounts, lastSynced, webhookCounts, recent] = await Promise.all([
    db
      .select({ status: crmCustomers.syncStatus, value: sql<number>`count(*)` })
      .from(crmCustomers)
      .groupBy(crmCustomers.syncStatus),
    db
      .select({ value: sql<string | null>`max(${crmCustomers.syncedAt})` })
      .from(crmCustomers),
    db
      .select({ status: cyberbizWebhookEvents.status, value: sql<number>`count(*)` })
      .from(cyberbizWebhookEvents)
      .groupBy(cyberbizWebhookEvents.status),
    db
      .select({
        id: cyberbizWebhookEvents.id,
        topic: cyberbizWebhookEvents.topic,
        status: cyberbizWebhookEvents.status,
        cyberbizCustomerId: cyberbizWebhookEvents.cyberbizCustomerId,
        lastError: cyberbizWebhookEvents.lastError,
        receivedAt: cyberbizWebhookEvents.receivedAt,
        payloadJson: cyberbizWebhookEvents.payloadJson,
      })
      .from(cyberbizWebhookEvents)
      .orderBy(desc(cyberbizWebhookEvents.receivedAt))
      .limit(20),
  ]);

  const bySync = Object.fromEntries(customerCounts.map((row) => [row.status, Number(row.value)]));
  const byWebhook = Object.fromEntries(webhookCounts.map((row) => [row.status, Number(row.value)]));

  return {
    customers: {
      total: customerCounts.reduce((sum, row) => sum + Number(row.value), 0),
      synced: bySync.synced ?? 0,
      failed: bySync.failed ?? 0,
    },
    syncedAt: lastSynced[0]?.value ?? null,
    webhooks: {
      processed: byWebhook.processed ?? 0,
      failed: byWebhook.failed ?? 0,
      ignored: byWebhook.ignored ?? 0,
      lastReceivedAt: recent[0]?.receivedAt ?? null,
    },
    recent,
  };
}

/**
 * 清掉「只有 CYBERBIZ ID、其餘全空」的客戶。
 *
 * 這些是上一版 webhook 放寬判斷時製造出來的：事件只帶一個 ID，重讀又失敗，
 * 卻仍然建了一列。判斷條件刻意收得很窄——姓名、電話、Email、地址全空，
 * 而且沒有任何人在本地編輯過（沒有對應的操作紀錄）。
 */
export async function deleteEmptyCyberbizCustomers(
  db: Database,
): Promise<{ deleted: number; ids: string[] }> {
  const suspicious = await db
    .select({ id: crmCustomers.id, raw: crmCustomers.rawJson })
    .from(crmCustomers)
    .where(
      and(
        isNotNull(crmCustomers.cyberbizCustomerId),
        eq(crmCustomers.email, ""),
        eq(crmCustomers.phone, ""),
        eq(crmCustomers.address, ""),
      ),
    );

  /*
   * 兩種要清掉的東西，共通點是「沒有 Email、沒有電話、沒有地址」：
   *   1. 只有 ID 的空殼（連姓名都沒有）
   *   2. 被當成會員寫進來的商品——它有名字（商品名），所以光看空白判斷不到，
   *      要看原始 payload 裡有沒有 product_id / sku / inventory_quantity
   *
   * 真的會員不會三個聯絡欄位全空又帶著商品欄位，所以這個條件不會誤刪。
   */
  const ids = suspicious
    .filter((row) => !row.raw || row.raw === "{}" || /"(product_id|sku|inventory_quantity|variant_id)"/.test(row.raw))
    .map((row) => row.id);
  for (const id of ids) {
    // customer_events 有 on delete cascade，紀錄會跟著走。
    await db.delete(crmCustomers).where(eq(crmCustomers.id, id));
  }

  return { deleted: ids.length, ids };
}

/** 處理完的 webhook 事件保留幾天。失敗的不算在內——那是還沒解決的問題。 */
export const WEBHOOK_EVENT_RETENTION_DAYS = 30;

/**
 * 清掉處理完的 webhook 事件。
 *
 * 這張表只進不出：官網每改一次會員或商品就多一列，正式庫已經四千多列，而它的
 * 用途只有「這一筆處理過了嗎」與「失敗或卡住的要補跑」，兩者都只看得到最近的資料。
 *
 * ⚠️ 只刪 processed 與 ignored。failed 的留著——那是還沒解決的問題，刪掉就再也
 * 沒有人會發現它；processing 也留著，lease 會負責判斷它是不是仍在跑。
 */
export async function purgeSettledWebhookEvents(
  db: Database,
  options: { retentionDays?: number } = {},
): Promise<{ deleted: number }> {
  const days = Math.max(1, Math.trunc(options.retentionDays ?? WEBHOOK_EVENT_RETENTION_DAYS));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const stale = await db.select({ id: cyberbizWebhookEvents.id })
    .from(cyberbizWebhookEvents)
    .where(and(
      inArray(cyberbizWebhookEvents.status, ["processed", "ignored"]),
      lt(cyberbizWebhookEvents.receivedAt, cutoff),
    ));
  if (!stale.length) return { deleted: 0 };
  // 一次刪一批，不要用 IN (幾千個 id)：D1 對單一語句的參數量有上限。
  for (let offset = 0; offset < stale.length; offset += 100) {
    const batch = stale.slice(offset, offset + 100).map((row) => row.id);
    await db.delete(cyberbizWebhookEvents).where(inArray(cyberbizWebhookEvents.id, batch));
  }
  return { deleted: stale.length };
}

