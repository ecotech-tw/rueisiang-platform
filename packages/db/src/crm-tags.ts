import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { activityEvents } from "./schema/activity.js";
import { crmCustomerTags, crmTags, customers } from "./schema/crm.js";

/** 標籤字典與客戶身上的使用情形。客戶標籤只存在 crm_customer_tags。 */
export interface TagRow {
  name: string;
  customerCount: number;
  /** 其中有幾位已經連到 CYBERBIZ 會員。 */
  linkedCount: number;
}

export async function listTags(db: Database): Promise<TagRow[]> {
  const rows = await db
    .select({
      name: crmTags.name,
      customerCount: count(crmCustomerTags.customerId),
      linkedCount: sql<number>`sum(case when ${customers.cyberbizCustomerId} is not null then 1 else 0 end)`,
    })
    .from(crmTags)
    .leftJoin(crmCustomerTags, eq(crmCustomerTags.crmTagId, crmTags.id))
    .leftJoin(customers, eq(customers.id, crmCustomerTags.customerId))
    .groupBy(crmTags.id, crmTags.name)
    .orderBy(asc(crmTags.name));

  return rows.map((row) => ({
    name: row.name,
    customerCount: Number(row.customerCount),
    linkedCount: Number(row.linkedCount),
  }));
}

export async function createTag(db: Database, name: string): Promise<"created" | "duplicate"> {
  const trimmed = name.trim();
  const [existing] = await db
    .select({ name: crmTags.name })
    .from(crmTags)
    .where(eq(crmTags.name, trimmed))
    .limit(1);
  if (existing) return "duplicate";

  await db.insert(crmTags).values({ id: crypto.randomUUID(), name: trimmed });
  return "created";
}

/** 以 relation 表取代一位客戶的完整標籤集合。空集合代表清空。 */
export async function replaceCustomerTags(db: Database, customerId: string, names: string[]): Promise<void> {
  const uniqueNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  for (const name of uniqueNames) {
    await db.insert(crmTags).values({ id: crypto.randomUUID(), name }).onConflictDoNothing();
  }
  const tags = uniqueNames.length
    ? await db.select({ id: crmTags.id }).from(crmTags).where(inArray(crmTags.name, uniqueNames))
    : [];
  await db.delete(crmCustomerTags).where(eq(crmCustomerTags.customerId, customerId));
  if (tags.length) {
    await db.insert(crmCustomerTags)
      .values(tags.map((tag) => ({ customerId, crmTagId: tag.id })))
      .onConflictDoNothing();
  }
}

export async function customerTagNames(db: Database, customerId: string): Promise<string[]> {
  const rows = await db
    .select({ name: crmTags.name })
    .from(crmCustomerTags)
    .innerJoin(crmTags, eq(crmTags.id, crmCustomerTags.crmTagId))
    .where(eq(crmCustomerTags.customerId, customerId));
  return rows.map((row) => row.name).sort();
}

export interface TagChangeResult {
  processed: number;
  linked: number;
  hasMore: boolean;
  failures: { customerId: string; error: string }[];
}

export interface TagChangeOptions {
  /** null 代表刪除這個標籤。 */
  nextName: string | null;
  actor: { actorType: string; actorId: string | null; actorEmail: string | null };
  limit?: number;
  pushTags?: (externalId: string, tags: string[]) => Promise<void>;
}

/**
 * 把某個標籤改名或移除，一次處理一批客戶。
 *
 * 改名時先建立新字典項目，逐批搬移 relation，最後由 API route 刪掉舊字典項目。
 * 這樣即使某一位客戶推送失敗，也不會因為刪除舊 tag 而把他的本地標籤弄丟。
 */
export async function applyTagChange(
  db: Database,
  originalName: string,
  options: TagChangeOptions,
): Promise<TagChangeResult> {
  const limit = options.limit ?? 50;
  const [originalTag] = await db
    .select({ id: crmTags.id })
    .from(crmTags)
    .where(eq(crmTags.name, originalName))
    .limit(1);
  if (!originalTag) return { processed: 0, linked: 0, hasMore: false, failures: [] };

  let nextTagId: string | null = null;
  if (options.nextName) {
    await db
      .insert(crmTags)
      .values({ id: crypto.randomUUID(), name: options.nextName.trim() })
      .onConflictDoNothing();
    const [nextTag] = await db
      .select({ id: crmTags.id })
      .from(crmTags)
      .where(eq(crmTags.name, options.nextName.trim()))
      .limit(1);
    nextTagId = nextTag?.id ?? null;
  }

  const candidates = await db
    .select({
      id: customers.id,
      name: customers.name,
      cyberbizCustomerId: customers.cyberbizCustomerId,
    })
    .from(crmCustomerTags)
    .innerJoin(customers, eq(customers.id, crmCustomerTags.customerId))
    .where(eq(crmCustomerTags.crmTagId, originalTag.id))
    .orderBy(asc(customers.id))
    .limit(limit + 1);

  const affected = candidates.slice(0, limit);
  const hasMore = candidates.length > limit;
  const allTags = affected.length
    ? await db
      .select({ customerId: crmCustomerTags.customerId, name: crmTags.name })
      .from(crmCustomerTags)
      .innerJoin(crmTags, eq(crmTags.id, crmCustomerTags.crmTagId))
      .where(inArray(crmCustomerTags.customerId, affected.map((customer) => customer.id)))
    : [];
  const tagsByCustomer = new Map<string, string[]>();
  for (const row of allTags) {
    const tags = tagsByCustomer.get(row.customerId) ?? [];
    tags.push(row.name);
    tagsByCustomer.set(row.customerId, tags);
  }

  const failures: TagChangeResult["failures"] = [];
  let linked = 0;

  for (const customer of affected) {
    const before = tagsByCustomer.get(customer.id) ?? [originalName];
    const after = [
      ...new Set(
        before.flatMap((tag) => tag === originalName ? (options.nextName ? [options.nextName] : []) : [tag]),
      ),
    ];

    if (customer.cyberbizCustomerId && options.pushTags) {
      try {
        await options.pushTags(customer.cyberbizCustomerId, after);
        linked += 1;
      } catch (error) {
        failures.push({
          customerId: customer.id,
          error: error instanceof Error ? error.message : "推送標籤到 CYBERBIZ 失敗",
        });
        continue;
      }
    }

    await db.batch([
      db.delete(crmCustomerTags).where(and(
        eq(crmCustomerTags.customerId, customer.id),
        eq(crmCustomerTags.crmTagId, originalTag.id),
      )),
      ...(nextTagId
        ? [db.insert(crmCustomerTags).values({ customerId: customer.id, crmTagId: nextTagId }).onConflictDoNothing()]
        : []),
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

/** 改名／刪除的字典收尾。客戶身上的 relation 由 applyTagChange 處理。 */
export async function renameTagInCatalog(db: Database, from: string, to: string): Promise<void> {
  await db.delete(crmTags).where(eq(crmTags.name, from));
  await db
    .insert(crmTags)
    .values({ id: crypto.randomUUID(), name: to.trim() })
    .onConflictDoNothing();
}

export async function deleteTagFromCatalog(db: Database, name: string): Promise<void> {
  await db.delete(crmTags).where(eq(crmTags.name, name));
}
