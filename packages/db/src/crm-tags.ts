import { and, asc, eq, like, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { activityEvents } from "./schema/activity.js";
import { customerTagCatalog, customers } from "./schema/crm.js";

/**
 * 標籤。
 *
 * 標籤有兩個來源，這是理解這個檔案的關鍵：
 *   1. customer_tag_catalog —— 我們自己維護的字典，可以先建好一個還沒有人用的標籤
 *   2. customers.cyberbiz_tags_json —— 客戶身上實際掛著的標籤，從 CYBERBIZ 同步進來
 *
 * 官網那邊隨時可能冒出字典裡沒有的標籤，所以列表是兩者的聯集。
 */

export interface TagRow {
  name: string;
  /** 字典裡有沒有這一筆。沒有的話代表它只存在於客戶身上。 */
  inCatalog: boolean;
  customerCount: number;
  /** 其中有幾位已經連到 CYBERBIZ 會員——改名時需要推回官網的就是這些。 */
  linkedCount: number;
}

/**
 * 用 json_each 在 SQL 裡聚合，不要把客戶全部撈出來在記憶體裡數。
 * 舊 CRM 是後者，一萬多筆客戶會直接撐爆 Worker。
 */
export async function listTags(db: Database): Promise<TagRow[]> {
  const [catalog, counts] = await Promise.all([
    db.select({ name: customerTagCatalog.name }).from(customerTagCatalog).orderBy(asc(customerTagCatalog.name)),
    db.all<{ tag: string; customer_count: number; linked_count: number }>(sql`
      select
        json_each.value as tag,
        count(*) as customer_count,
        sum(case when ${customers.cyberbizCustomerId} is not null then 1 else 0 end) as linked_count
      from ${customers}, json_each(${customers.cyberbizTagsJson})
      group by json_each.value
    `),
  ]);

  const byName = new Map<string, TagRow>();
  for (const row of catalog) {
    byName.set(row.name, { name: row.name, inCatalog: true, customerCount: 0, linkedCount: 0 });
  }
  for (const row of counts) {
    const existing = byName.get(row.tag);
    if (existing) {
      existing.customerCount = Number(row.customer_count);
      existing.linkedCount = Number(row.linked_count);
    } else {
      byName.set(row.tag, {
        name: row.tag,
        inCatalog: false,
        customerCount: Number(row.customer_count),
        linkedCount: Number(row.linked_count),
      });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
}

export async function createTag(db: Database, name: string): Promise<"created" | "duplicate"> {
  const trimmed = name.trim();
  const [existing] = await db
    .select({ name: customerTagCatalog.name })
    .from(customerTagCatalog)
    .where(eq(customerTagCatalog.name, trimmed))
    .limit(1);
  if (existing) return "duplicate";

  await db.insert(customerTagCatalog).values({ id: crypto.randomUUID(), name: trimmed });
  return "created";
}

export interface TagChangeResult {
  /** 這一輪處理了幾位客戶。 */
  processed: number;
  /** 其中有幾位需要推回 CYBERBIZ。 */
  linked: number;
  /** 還有沒有客戶等著處理——有的話再呼叫一次。 */
  hasMore: boolean;
  failures: { customerId: string; error: string }[];
}

export interface TagChangeOptions {
  /** null 代表刪除這個標籤。 */
  nextName: string | null;
  actor: { actorType: string; actorId: string | null; actorEmail: string | null };
  /** 一輪最多處理幾位客戶。每位都要打一次官網 API，所以不能無上限。 */
  limit?: number;
  /** 把標籤推回 CYBERBIZ。沒給就只改本地。 */
  pushTags?: (externalId: string, tags: string[]) => Promise<void>;
}

function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 把某個標籤改名或移除，一次處理一批客戶。
 *
 * 為什麼要分批：每位有連到 CYBERBIZ 的客戶都要打一次官網 API。一個標籤掛在
 * 幾百位客戶身上就是幾百次呼叫，一口氣做完會撞上 Worker 的時間與請求上限。
 * 回傳 hasMore 讓呼叫端接著跑，跟全量同步同一個模式。
 *
 * 用 LIKE 先在 SQL 裡篩出可能相關的客戶，再在記憶體裡精確比對——JSON 字串的
 * LIKE 可能誤中（例如找「VIP」會連「VIP2」一起撈出來），所以那一層還是要比。
 */
export async function applyTagChange(
  db: Database,
  originalName: string,
  options: TagChangeOptions,
): Promise<TagChangeResult> {
  const limit = options.limit ?? 50;
  const needle = `%${JSON.stringify(originalName).slice(1, -1)}%`;

  const candidates = await db
    .select({
      id: customers.id,
      // 操作紀錄要存客戶當下的名字，所以這裡一起撈。
      name: customers.name,
      cyberbizCustomerId: customers.cyberbizCustomerId,
      tags: customers.cyberbizTagsJson,
      syncStatus: customers.syncStatus,
    })
    .from(customers)
    .where(and(like(customers.cyberbizTagsJson, needle)))
    .limit(limit + 1);

  const affected = candidates
    .filter((customer) => parseTags(customer.tags).includes(originalName))
    .slice(0, limit);
  const hasMore = candidates.length > limit;

  const failures: TagChangeResult["failures"] = [];
  let linked = 0;

  for (const customer of affected) {
    const before = parseTags(customer.tags);
    const after = [
      ...new Set(
        before.flatMap((tag) =>
          tag === originalName ? (options.nextName ? [options.nextName] : []) : [tag],
        ),
      ),
    ];

    if (customer.cyberbizCustomerId && options.pushTags) {
      try {
        await options.pushTags(customer.cyberbizCustomerId, after);
        linked += 1;
      } catch (error) {
        // 推不上去就先不要改本地，兩邊才不會不一致。
        failures.push({
          customerId: customer.id,
          error: error instanceof Error ? error.message : "推送標籤到 CYBERBIZ 失敗",
        });
        continue;
      }
    }

    await db.batch([
      db
        .update(customers)
        .set({ cyberbizTagsJson: JSON.stringify(after), updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(customers.id, customer.id)),
      db.insert(activityEvents).values(
        activityRow({
          entityType: "customer",
          entityId: customer.id,
          entityLabel: customer.name,
          eventType: options.nextName ? "tag_renamed" : "tag_removed",
          summary: options.nextName
            ? `標籤「${originalName}」改名為「${options.nextName}」`
            : `移除標籤「${originalName}」`,
          payload: { before, after },
          actor: { id: options.actor.actorId, email: options.actor.actorEmail },
          source: "crm",
        }),
      ),
    ]);
  }

  return { processed: affected.length, linked, hasMore, failures };
}

/** 字典本身的改名／刪除。客戶身上的標籤由 applyTagChange 處理。 */
export async function renameTagInCatalog(db: Database, from: string, to: string): Promise<void> {
  await db.delete(customerTagCatalog).where(eq(customerTagCatalog.name, from));
  await db
    .insert(customerTagCatalog)
    .values({ id: crypto.randomUUID(), name: to })
    .onConflictDoNothing();
}

export async function deleteTagFromCatalog(db: Database, name: string): Promise<void> {
  await db.delete(customerTagCatalog).where(eq(customerTagCatalog.name, name));
}
