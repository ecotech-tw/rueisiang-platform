import type { CyberbizCustomer } from "@rueisiang/cyberbiz";
import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { normalizePhone } from "./phone.js";
import { customerEvents, customers } from "./schema/crm.js";

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
 *  3. **本地標成 manual 的客戶不會被改成 cyberbiz。** 那是人工建立的判斷，
 *     同步不該蓋掉。
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
  /** 有值代表這次是 webhook 觸發的，紀錄與時間戳會不一樣。 */
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
        sourceChannel: "cyberbiz",
        status: incoming.blocked ? "blocked" : "active",
        cyberbizCustomerId: incoming.externalId,
        cyberbizUid: incoming.uid || null,
        cyberbizTagsJson: JSON.stringify(incoming.tags),
        cyberbizUpdatedAt: incoming.updatedAt || null,
        cyberbizRawJson: JSON.stringify(incoming.raw),
        syncStatus: "synced",
        syncError: null,
        lastSyncedAt: now,
        lastWebhookAt: fromWebhook ? now : null,
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

    await db.insert(customerEvents).values({
      id: crypto.randomUUID(),
      customerId,
      eventType: fromWebhook ? "cyberbiz_webhook_created" : "cyberbiz_imported",
      summary: fromWebhook ? "由 CYBERBIZ webhook 建立客戶" : "由 CYBERBIZ 匯入客戶",
      payloadJson: JSON.stringify({
        topic: context.topic,
        eventId: context.eventId,
        cyberbizCustomerId: incoming.externalId,
      }),
      actorType: "system",
      source: fromWebhook ? "cyberbiz_webhook" : "cyberbiz_sync",
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
    sourceChannel: existing.sourceChannel === "manual" ? existing.sourceChannel : "cyberbiz",
    // 官網解除封鎖不會自動解除我們這邊的封鎖——那是店裡自己的決定。
    status: incoming.blocked ? "blocked" : existing.status,
    cyberbizCustomerId: incoming.externalId || existing.cyberbizCustomerId,
    cyberbizUid: incoming.uid || existing.cyberbizUid,
    cyberbizTagsJson: incoming.tags.length ? JSON.stringify(incoming.tags) : existing.cyberbizTagsJson,
    cyberbizUpdatedAt: incoming.updatedAt || existing.cyberbizUpdatedAt,
    cyberbizRawJson: JSON.stringify(incoming.raw),
    syncStatus: "synced",
    syncError: null,
    blockedAt: incoming.blocked ? existing.blockedAt || now : existing.blockedAt,
    createdAt: incoming.createdAt || existing.createdAt,
    updatedAt: incoming.updatedAt || existing.updatedAt,
  };

  const changed = Object.entries(next).some(
    ([key, value]) => value !== existing[key as keyof typeof existing],
  );

  if (!changed) {
    // 沒有實質變化就只更新「什麼時候確認過」，不要在操作紀錄裡灌一堆雜訊。
    await db
      .update(customers)
      .set({ lastSyncedAt: now, lastWebhookAt: fromWebhook ? now : existing.lastWebhookAt })
      .where(eq(customers.id, existing.id));
    return { action: "unchanged", customerId: existing.id };
  }

  await db.batch([
    db
      .update(customers)
      .set({ ...next, lastSyncedAt: now, lastWebhookAt: fromWebhook ? now : existing.lastWebhookAt })
      .where(eq(customers.id, existing.id)),
    db.insert(customerEvents).values({
      id: crypto.randomUUID(),
      customerId: existing.id,
      eventType: fromWebhook ? "cyberbiz_webhook_updated" : "cyberbiz_refreshed",
      summary: fromWebhook ? "CYBERBIZ webhook 更新客戶資料" : "重新讀取 CYBERBIZ 客戶資料",
      payloadJson: JSON.stringify({
        topic: context.topic,
        eventId: context.eventId,
        cyberbizCustomerId: incoming.externalId,
      }),
      actorType: "system",
      source: fromWebhook ? "cyberbiz_webhook" : "cyberbiz_sync",
      createdAt: now,
    }),
  ]);

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
