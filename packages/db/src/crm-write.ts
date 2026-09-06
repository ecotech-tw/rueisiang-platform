import { eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { normalizePhone } from "./phone.js";
import { activityRow } from "./activity.js";
import { customerTagNames, replaceCustomerTags } from "./crm-tags.js";
import { activityEvents } from "./schema/activity.js";
import { crmCustomerTags, crmTags, customers } from "./schema/crm.js";

/**
 * 客戶的寫入操作：新增、編輯、封鎖。
 *
 * 貫穿這個檔案的一條規則：**先寫官網，成功了才寫本地**。
 *
 * 反過來的話，官網那一步失敗時本地已經留下一筆「看起來同步過」的資料，
 * 而實際上官網根本沒有這個人或沒有這次修改。寧可整個操作失敗讓人重試，
 * 也不要留下兩邊不一致又沒人知道的狀態。
 */

export interface Actor {
  id: string;
  email: string;
}

export interface CustomerInput {
  phone: string;
  name: string;
  email: string;
  address: string;
  tags: string[];
}

/**
 * 回傳查詢本身（不是 Promise），這樣才能跟客戶的寫入放進同一個 db.batch。
 * 所以這裡用 activityRow() 而不是 recordActivity()——後者會自己 await。
 */
function writeEvent(
  db: Database,
  input: {
    customerId: string;
    /** 客戶當下的名字。存快照，客戶被刪掉之後這筆紀錄還看得懂。 */
    customerName: string;
    eventType: string;
    summary: string;
    payload: unknown;
    actor: Actor;
  },
) {
  return db.insert(activityEvents).values(
    activityRow({
      entityType: "customer",
      entityId: input.customerId,
      entityLabel: input.customerName,
      eventType: input.eventType,
      summary: input.summary,
      payload: input.payload,
      // email 跟著存：人離職、帳號被刪之後，紀錄仍然看得出當初是誰做的。
      actor: input.actor,
      source: "crm",
    }),
  );
}

export async function findCustomerByPhone(db: Database, phone: string) {
  const [row] = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(eq(customers.normalizedPhone, normalizePhone(phone)))
    .limit(1);
  return row ?? null;
}

export async function findCustomer(db: Database, id: string): Promise<any | null> {
  const [row] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  if (!row) return null;
  const tags = await db
    .select({ name: crmTags.name })
    .from(crmCustomerTags)
    .innerJoin(crmTags, eq(crmTags.id, crmCustomerTags.crmTagId))
    .where(eq(crmCustomerTags.customerId, id));
  return { ...row, tags: tags.map((tag) => tag.name) };
}

/**
 * 建立客戶。
 *
 * 呼叫端先在官網建立會員，這裡只負責把成功回傳的會員落地；
 * 因此新客戶一定有 cyberbizCustomerId，歷史本地資料才可能是 NULL。
 */
export async function createCustomer(
  db: Database,
  input: CustomerInput & {
    remote: { externalId: string; uid: string; tags: string[]; raw: unknown; blocked: boolean };
    actor: Actor;
  },
): Promise<{ id: string }> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const linked = input.remote;

  await db.batch([
    db.insert(customers).values({
      id,
      phone: input.phone,
      normalizedPhone: normalizePhone(input.phone),
      name: input.name,
      email: input.email,
      address: input.address,
      status: linked.blocked ? "blocked" : "active",
      cyberbizCustomerId: linked.externalId,
      cyberbizUid: linked.uid || null,
      rawJson: JSON.stringify(linked.raw),
      syncStatus: "synced",
      syncedAt: now,
      blockedAt: linked.blocked ? now : null,
    }),
    writeEvent(db, {
      customerId: id,
      customerName: input.name,
      eventType: "customer_created",
      summary: "新增客戶並同步到 CYBERBIZ",
      payload: { phone: input.phone, name: input.name, linked: true },
      actor: input.actor,
    }),
  ]);
  await replaceCustomerTags(db, id, linked.tags);

  return { id };
}

export async function updateCustomer(
  db: Database,
  id: string,
  input: CustomerInput & { actor: Actor; syncedToRemote: boolean },
): Promise<void> {
  const before = await findCustomer(db, id);
  if (!before) throw new Error("找不到這筆客戶資料");

  const changed = (
    ["phone", "name", "email", "address"] as const
  ).filter((field) => before[field] !== input[field]);
  const beforeTags = await customerTagNames(db, id);
  const nextTags = [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))].sort();
  const tagsChanged = beforeTags.join("\u0000") !== nextTags.join("\u0000");

  await db.batch([
    db
      .update(customers)
      .set({
        phone: input.phone,
        normalizedPhone: normalizePhone(input.phone),
        name: input.name,
        email: input.email,
        address: input.address,
        ...(input.syncedToRemote ? { syncStatus: "synced", syncedAt: new Date().toISOString() } : {}),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(customers.id, id)),
    writeEvent(db, {
      customerId: id,
      customerName: input.name,
      eventType: "customer_updated",
      summary: "編輯客戶資料",
      payload: {
        changedFields: [...changed, ...(tagsChanged ? ["tags"] : [])],
        before: { phone: before.phone, name: before.name, email: before.email, address: before.address },
        after: { phone: input.phone, name: input.name, email: input.email, address: input.address },
      },
      actor: input.actor,
    }),
  ]);
  await replaceCustomerTags(db, id, input.tags);
}

export async function setCustomerBlocked(
  db: Database,
  id: string,
  blocked: boolean,
  actor: Actor,
): Promise<void> {
  // 先讀名字：紀錄要存當下的客戶名，客戶被刪掉之後那一筆才看得懂。
  const before = await findCustomer(db, id);
  if (!before) throw new Error("找不到這筆客戶資料");

  await db.batch([
    db
      .update(customers)
      .set({
        status: blocked ? "blocked" : "active",
        blockedAt: blocked ? sql`CURRENT_TIMESTAMP` : null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(customers.id, id)),
    writeEvent(db, {
      customerId: id,
      customerName: before.name,
      eventType: blocked ? "customer_blocked" : "customer_unblocked",
      summary: blocked ? "封鎖客戶" : "解除封鎖",
      payload: { changedFields: ["status"], after: { status: blocked ? "blocked" : "active" } },
      actor,
    }),
  ]);
}
