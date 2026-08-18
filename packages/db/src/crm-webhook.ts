import type { CyberbizCustomerClient } from "@rueisiang/cyberbiz";
import { createWebhookEventId, isCustomerTopic, parseCyberbizCustomer } from "@rueisiang/cyberbiz";
import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { syncCyberbizCustomer, type CyberbizSyncResult } from "./crm-sync.js";
import { customers, cyberbizCustomerWebhooks } from "./schema/crm.js";

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

export interface ProcessWebhookInput {
  rawBody: string;
  topic: string;
  /** 沒有 client 時就只用 payload 本身的內容，不去官網重新讀。 */
  client?: CyberbizCustomerClient;
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

  const eventId = await createWebhookEventId(topic, rawBody);

  const [duplicate] = await db
    .select({ status: cyberbizCustomerWebhooks.status })
    .from(cyberbizCustomerWebhooks)
    .where(eq(cyberbizCustomerWebhooks.id, eventId))
    .limit(1);
  if (duplicate) return { eventId, topic, status: "duplicate", reason: duplicate.status };

  let incoming = parseCyberbizCustomer(payload);
  await db.insert(cyberbizCustomerWebhooks).values({
    id: eventId,
    topic,
    status: "processing",
    cyberbizCustomerId: incoming.externalId || null,
    payloadJson: rawBody,
  });

  try {
    if (!isCustomerTopic(topic)) {
      await markEvent(db, eventId, { status: "ignored", result: { reason: "非會員事件" } });
      return { eventId, topic, status: "ignored", reason: "非會員事件" };
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
         * 重讀失敗不等於這個事件沒有用。
         *
         * 實際跑起來才看到：官網對某些會員的單筆查詢會回 404「無此資源」，
         * 但那些 ID 是簽章驗證過的 webhook 送來的，會員本身確實存在
         * （之後的全量同步也拉得到）。原本的作法是整個事件標成失敗，
         * 結果就是一堆紅色的 failed，而我們手上其實有可用的資料。
         *
         * 所以改成：有會員 ID 就用 webhook 自己那份往下寫，把重讀的錯誤
         * 記在結果裡。資料可能比官網舊一點，但下一次同步就會補正。
         * 沒有會員 ID 的情況仍然照舊擋下來，那才是會生出幽靈客戶的那種。
         */
        refetchError = error instanceof Error ? error.message : "重讀會員資料失敗";
        incoming = fromWebhook;
      }
    }

    const result = await syncCyberbizCustomer(db, incoming, { topic, eventId });
    await markEvent(db, eventId, {
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
     * 真正會重試的是我們自己的 Cron（每 15 分鐘撿 failed 的來補跑）。所以這裡
     * 誠實地說「收到了、但還沒處理成功」，把錯誤留在事件上讓同步頁看得到。
     */
    const message = error instanceof Error ? error.message : "webhook 處理失敗";
    await markEvent(db, eventId, { status: "failed", error: message });
    return { eventId, topic, status: "failed", error: message };
  }
}

async function markEvent(
  db: Database,
  eventId: string,
  update: {
    status: string;
    customerId?: string | null;
    cyberbizCustomerId?: string | null;
    result?: unknown;
    error?: string;
  },
): Promise<void> {
  await db
    .update(cyberbizCustomerWebhooks)
    .set({
      status: update.status,
      ...(update.customerId !== undefined ? { customerId: update.customerId } : {}),
      ...(update.cyberbizCustomerId !== undefined
        ? { cyberbizCustomerId: update.cyberbizCustomerId }
        : {}),
      ...(update.result !== undefined ? { resultJson: JSON.stringify(update.result) } : {}),
      ...(update.error !== undefined ? { lastError: update.error } : {}),
      processedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(cyberbizCustomerWebhooks.id, eventId));
}

/**
 * 補跑失敗的事件。
 *
 * 這條取代舊 CRM 那個「前端每 15 秒打一次 drain」的輪詢——那個作法要有人
 * 開著分頁才會動，關掉瀏覽器同步就停了。現在由 Cron 定時跑。
 */
export async function retryFailedWebhooks(
  db: Database,
  options: { limit?: number; client?: CyberbizCustomerClient } = {},
): Promise<{ attempted: number; recovered: number; stillFailing: number }> {
  const limit = options.limit ?? 20;

  const pending = await db
    .select({ id: cyberbizCustomerWebhooks.id, topic: cyberbizCustomerWebhooks.topic, payloadJson: cyberbizCustomerWebhooks.payloadJson })
    .from(cyberbizCustomerWebhooks)
    .where(eq(cyberbizCustomerWebhooks.status, "failed"))
    .orderBy(desc(cyberbizCustomerWebhooks.receivedAt))
    .limit(limit);

  let recovered = 0;
  for (const event of pending) {
    try {
      // 刪掉舊那筆再重跑，讓它走一模一樣的路徑（識別碼是內容雜湊，會是同一個）。
      await db.delete(cyberbizCustomerWebhooks).where(eq(cyberbizCustomerWebhooks.id, event.id));
      const outcome = await processCustomerWebhook(db, {
        rawBody: event.payloadJson,
        topic: event.topic,
        client: options.client,
      });
      if (outcome.status === "processed" || outcome.status === "ignored") recovered += 1;
    } catch {
      // processCustomerWebhook 已經把狀態寫回 failed，這裡不用再做什麼。
    }
  }

  return { attempted: pending.length, recovered, stillFailing: pending.length - recovered };
}

export interface SyncStatus {
  customers: { total: number; synced: number; localOnly: number; failed: number };
  lastSyncedAt: string | null;
  webhooks: { processed: number; failed: number; ignored: number; lastReceivedAt: string | null };
  recent: {
    id: string;
    topic: string;
    status: string;
    cyberbizCustomerId: string | null;
    lastError: string | null;
    receivedAt: string;
  }[];
}

export async function readSyncStatus(db: Database): Promise<SyncStatus> {
  const [customerCounts, lastSynced, webhookCounts, recent] = await Promise.all([
    db
      .select({ status: customers.syncStatus, value: sql<number>`count(*)` })
      .from(customers)
      .groupBy(customers.syncStatus),
    db
      .select({ value: sql<string | null>`max(${customers.lastSyncedAt})` })
      .from(customers),
    db
      .select({ status: cyberbizCustomerWebhooks.status, value: sql<number>`count(*)` })
      .from(cyberbizCustomerWebhooks)
      .groupBy(cyberbizCustomerWebhooks.status),
    db
      .select({
        id: cyberbizCustomerWebhooks.id,
        topic: cyberbizCustomerWebhooks.topic,
        status: cyberbizCustomerWebhooks.status,
        cyberbizCustomerId: cyberbizCustomerWebhooks.cyberbizCustomerId,
        lastError: cyberbizCustomerWebhooks.lastError,
        receivedAt: cyberbizCustomerWebhooks.receivedAt,
      })
      .from(cyberbizCustomerWebhooks)
      .orderBy(desc(cyberbizCustomerWebhooks.receivedAt))
      .limit(20),
  ]);

  const bySync = Object.fromEntries(customerCounts.map((row) => [row.status, Number(row.value)]));
  const byWebhook = Object.fromEntries(webhookCounts.map((row) => [row.status, Number(row.value)]));

  return {
    customers: {
      total: customerCounts.reduce((sum, row) => sum + Number(row.value), 0),
      synced: bySync.synced ?? 0,
      localOnly: bySync.local_only ?? 0,
      failed: bySync.failed ?? 0,
    },
    lastSyncedAt: lastSynced[0]?.value ?? null,
    webhooks: {
      processed: byWebhook.processed ?? 0,
      failed: byWebhook.failed ?? 0,
      ignored: byWebhook.ignored ?? 0,
      lastReceivedAt: recent[0]?.receivedAt ?? null,
    },
    recent,
  };
}
