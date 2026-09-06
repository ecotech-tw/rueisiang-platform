import type { CyberbizCustomer } from "@rueisiang/cyberbiz";
import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { replaceCustomerTags } from "./crm-tags.js";
import { normalizePhone } from "./phone.js";
import { activityEvents } from "./schema/activity.js";
import { customers } from "./schema/crm.js";

/**
 * 把 CYBERBIZ 的會員資料寫進本地客戶表。
 *
 * 這段是整個同步最容易寫錯的地方，所以幾個不變條件先講清楚——都是舊系統
 * 用註解特別標出來的，代表是踩過才學到的：
 *
 *  1. **只有 CYBERBIZ 會員 ID 能對應既有的客戶。** 電話與 Email 都不是穩定的
 *     身分：兩個會員可以共用同一支公司電話。拿它們去比對會把不同的人併成一筆。
 *  2. **沒有會員 ID 的事件一律不寫。** 寧可留下一筆 ignored 的紀錄讓人去查，
 *     也不要生出一個對不到官網的幽靈客戶。
 *  3. **來源只由 cyberbiz_customer_id 判斷。** 不再維護第二份 source_channel 真相；
 *     沒有會員 ID 的歷史本地資料不會被電話或 Email 猜測合併。
 *  4. **空值不覆蓋既有資料**（電話除外，見下方註解）。官網那邊沒填不代表
 *     我們這邊要清掉。
 */

export type CyberbizSyncAction = "created" | "updated" | "unchanged" | "ignored";

export interface CyberbizSyncResult {
  action: CyberbizSyncAction;
  customerId: string | null;
  reason?: string;
}

export interface SyncContext {
  topic: string;
  /** 有值代表這次是 webhook 觸發的，活動紀錄事件名稱會不一樣。 */
  eventId?: string;
}

export async function syncCyberbizCustomer(
  db: Database,
  incoming: CyberbizCustomer,
  context: SyncContext,
): Promise<CyberbizSyncResult> {
  if (!incoming.externalId) {
    return {
      action: "ignored",
      customerId: null,
      reason: "CYBERBIZ 事件沒有會員 ID，已停止寫入以避免重複客戶",
    };
  }

  const now = new Date().toISOString();
  const fromWebhook = Boolean(context.eventId);
  const [existing] = await db
    .select()
    .from(customers)
    .where(eq(customers.cyberbizCustomerId, incoming.externalId))
    .limit(1);

  if (!existing) {
    const customerId = crypto.randomUUID();
    await db
      .insert(customers)
      .values({
        id: customerId,
        phone: incoming.phone,
        normalizedPhone: normalizePhone(incoming.phone),
        name: incoming.name,
        email: incoming.email,
        address: incoming.address,
        status: incoming.blocked ? "blocked" : "active",
        cyberbizCustomerId: incoming.externalId,
        cyberbizUid: incoming.uid || null,
        cyberbizUpdatedAt: incoming.updatedAt || null,
        rawJson: JSON.stringify(incoming.raw),
        syncStatus: "synced",
        syncedAt: now,
        blockedAt: incoming.blocked ? now : null,
        createdAt: incoming.createdAt || now,
        updatedAt: incoming.updatedAt || incoming.createdAt || now,
      })
      .onConflictDoNothing();

    const [stored] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.cyberbizCustomerId, incoming.externalId))
      .limit(1);
    if (!stored) throw new Error("CYBERBIZ 會員 ID 寫入失敗");

    if (stored.id !== customerId) {
      // 剛才那一刻有另一個寫入搶先建立了同一個會員（webhook 與手動同步撞在一起）。
      // 重跑一次會走到下面的更新路徑，而不是生出第二筆本地資料。
      return syncCyberbizCustomer(db, incoming, context);
    }

    await replaceCustomerTags(db, customerId, incoming.tags);
    await db.insert(activityEvents).values({
      ...activityRow({
        entityType: "customer",
        entityId: customerId,
        entityLabel: incoming.name ?? "",
        eventType: fromWebhook ? "cyberbiz_webhook_created" : "cyberbiz_imported",
        summary: fromWebhook ? "由 CYBERBIZ webhook 建立客戶" : "由 CYBERBIZ 匯入客戶",
        payload: {
          topic: context.topic,
          eventId: context.eventId,
          cyberbizCustomerId: incoming.externalId,
        },
        source: fromWebhook ? "cyberbiz_webhook" : "cyberbiz_sync",
      }),
      // 同步是批次跑的，時間要跟這一輪的其他寫入一致，不用各自取當下。
      createdAt: now,
    });

    return { action: "created", customerId };
  }

  const next = {
    // 電話是唯一會被空值覆蓋的欄位：會員本人的 mobile 才算數，早期的同步曾經
    // 把收件人電話寫進來，官網清空時我們這邊也該跟著清掉。
    phone: incoming.phone,
    normalizedPhone: normalizePhone(incoming.phone),
    name: incoming.name || existing.name,
    email: incoming.email || existing.email,
    address: incoming.address || existing.address,
    // 官網解除封鎖不會自動解除我們這邊的封鎖——那是店裡自己的決定。
    status: incoming.blocked ? "blocked" : existing.status,
    cyberbizCustomerId: incoming.externalId || existing.cyberbizCustomerId,
    cyberbizUid: incoming.uid || existing.cyberbizUid,
    cyberbizUpdatedAt: incoming.updatedAt || existing.cyberbizUpdatedAt,
    rawJson: JSON.stringify(incoming.raw),
    syncStatus: "synced",
    blockedAt: incoming.blocked ? existing.blockedAt || now : existing.blockedAt,
    createdAt: incoming.createdAt || existing.createdAt,
    updatedAt: incoming.updatedAt || existing.updatedAt,
  };

  const changed = Object.entries(next as Record<string, unknown>).some(
    ([key, value]) => value !== (existing as Record<string, unknown>)[key],
  );

  if (!changed) {
    // 沒有實質變化就只更新「什麼時候確認過」，不要在操作紀錄裡灌一堆雜訊。
    await db
      .update(customers)
      .set({ syncedAt: now })
      .where(eq(customers.id, existing.id));
    if (incoming.tags.length) await replaceCustomerTags(db, existing.id, incoming.tags);
    return { action: "unchanged", customerId: existing.id };
  }

  await db.batch([
    db
      .update(customers)
      .set({ ...next, syncedAt: now })
      .where(eq(customers.id, existing.id)),
    db.insert(activityEvents).values({
      ...activityRow({
        entityType: "customer",
        entityId: existing.id,
        entityLabel: incoming.name ?? existing.name,
        eventType: fromWebhook ? "cyberbiz_webhook_updated" : "cyberbiz_refreshed",
        summary: fromWebhook ? "CYBERBIZ webhook 更新客戶資料" : "重新讀取 CYBERBIZ 客戶資料",
        payload: {
          topic: context.topic,
          eventId: context.eventId,
          cyberbizCustomerId: incoming.externalId,
        },
        source: fromWebhook ? "cyberbiz_webhook" : "cyberbiz_sync",
      }),
      createdAt: now,
    }),
  ]);
  if (incoming.tags.length) await replaceCustomerTags(db, existing.id, incoming.tags);

  return { action: "updated", customerId: existing.id };
}

export interface BatchSyncSummary {
  received: number;
  created: number;
  updated: number;
  unchanged: number;
  ignored: number;
}

/**
 * 一整批（通常是一頁）會員。
 *
 * 逐筆走 syncCyberbizCustomer 而不是像舊系統那樣另外寫一段批次 upsert SQL。
 * 舊系統那兩條路徑的合併規則其實不一致——批次那條是
 * `name = excluded.name`，官網把姓名清空時會連本地的一起洗掉，
 * 單筆那條則會保留既有值。與其維護兩套規則，不如只留一套。
 */
export async function syncCyberbizCustomers(
  db: Database,
  incoming: CyberbizCustomer[],
  context: SyncContext,
): Promise<BatchSyncSummary> {
  const summary: BatchSyncSummary = {
    received: incoming.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    ignored: 0,
  };

  for (const customer of incoming) {
    const result = await syncCyberbizCustomer(db, customer, context);
    summary[result.action] += 1;
  }

  return summary;
}

export interface BulkSyncSummary {
  received: number;
  written: number;
  skipped: number;
}

/**
 * 全量同步用的批次寫入。
 *
 * 為什麼跟 syncCyberbizCustomer 分開：逐筆走那條，每個會員要一次 select 加一到
 * 兩次寫入，一頁 50 筆就是上百次 D1 呼叫。一萬多名會員跑下來，光是往返次數就
 * 會撞上 Worker 對單次請求的限制——實際跑起來就是同步跑到一半回「伺服器發生錯誤」。
 *
 * 舊 CRM 的 cyberbiz-initial-sync.ts 用的是 d1.batch()：一頁一次呼叫。這裡照做，
 * 但把合併規則寫進 ON CONFLICT，讓兩條路徑的行為一致（舊版批次那條會用空值
 * 蓋掉既有的姓名地址，那是它跟單筆版本不一致的地方）。
 *
 * 差別只有一個：批次不寫 customer_events。一次匯入一萬多筆等於灌一萬多筆紀錄，
 * 那是雜訊不是紀錄；舊系統的批次路徑也沒有寫。webhook 進來的異動仍然逐筆記。
 */
export async function upsertCyberbizCustomers(
  db: Database,
  incoming: CyberbizCustomer[],
): Promise<BulkSyncSummary> {
  const usable = incoming.filter((customer) => customer.externalId);
  if (!usable.length) {
    return { received: incoming.length, written: 0, skipped: incoming.length };
  }

  const now = new Date().toISOString();
  const statements = usable.map((customer) => {
    const createdAt = customer.createdAt || now;
    return db
      .insert(customers)
      .values({
        id: crypto.randomUUID(),
        phone: customer.phone,
        normalizedPhone: normalizePhone(customer.phone),
        name: customer.name,
        email: customer.email,
        address: customer.address,
        status: customer.blocked ? "blocked" : "active",
        cyberbizCustomerId: customer.externalId,
        cyberbizUid: customer.uid || null,
        cyberbizUpdatedAt: customer.updatedAt || null,
        rawJson: JSON.stringify(customer.raw),
        syncStatus: "synced",
        syncedAt: now,
        blockedAt: customer.blocked ? now : null,
        createdAt,
        updatedAt: customer.updatedAt || createdAt,
      })
      .onConflictDoUpdate({
        target: customers.cyberbizCustomerId,
        set: {
          // 電話以官網的 mobile 為準，空值也照寫（會員本人沒填就是沒填）。
          phone: sql`excluded.phone`,
          normalizedPhone: sql`excluded.normalized_phone`,
          // 其餘欄位空值不覆蓋，跟單筆路徑同一套規則。
          name: sql`coalesce(nullif(excluded.name, ''), ${customers.name})`,
          email: sql`coalesce(nullif(excluded.email, ''), ${customers.email})`,
          address: sql`coalesce(nullif(excluded.address, ''), ${customers.address})`,
          // 官網解除封鎖不會自動解除本地封鎖。
          status: sql`case when excluded.status = 'blocked' then 'blocked' else ${customers.status} end`,
          cyberbizUid: sql`coalesce(nullif(excluded.cyberbiz_uid, ''), ${customers.cyberbizUid})`,
          cyberbizUpdatedAt: sql`coalesce(nullif(excluded.cyberbiz_updated_at, ''), ${customers.cyberbizUpdatedAt})`,
          rawJson: sql`excluded.raw_json`,
          syncStatus: sql`'synced'`,
          syncedAt: sql`excluded.synced_at`,
          blockedAt: sql`case when excluded.status = 'blocked' then coalesce(${customers.blockedAt}, excluded.blocked_at) else ${customers.blockedAt} end`,
          createdAt: sql`coalesce(nullif(excluded.created_at, ''), ${customers.createdAt})`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  });

  // 一頁一次 D1 呼叫。逐筆送的話光往返次數就會撞上 Worker 的限制。
  await db.batch(statements as [typeof statements[number], ...typeof statements]);

  const stored = await db
    .select({ id: customers.id, cyberbizCustomerId: customers.cyberbizCustomerId })
    .from(customers)
    .where(inArray(customers.cyberbizCustomerId, usable.map((customer) => customer.externalId)));
  const storedByExternalId = new Map(stored.map((customer) => [customer.cyberbizCustomerId, customer.id]));
  for (const customer of usable) {
    const customerId = storedByExternalId.get(customer.externalId);
    if (customerId && customer.tags.length) await replaceCustomerTags(db, customerId, customer.tags);
  }

  return {
    received: incoming.length,
    written: usable.length,
    skipped: incoming.length - usable.length,
  };
}
