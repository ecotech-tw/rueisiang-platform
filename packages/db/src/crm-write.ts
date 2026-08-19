import { eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { normalizePhone } from "./phone.js";
import { customerEvents, customers } from "./schema/crm.js";

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

/** 回傳查詢本身（不是 Promise），這樣才能跟客戶的寫入放進同一個 db.batch。 */
function writeEvent(
  db: Database,
  input: {
    customerId: string;
    eventType: string;
    summary: string;
    payload: unknown;
    actor: Actor;
  },
) {
  return db.insert(customerEvents).values({
    id: crypto.randomUUID(),
    customerId: input.customerId,
    eventType: input.eventType,
    summary: input.summary,
    payloadJson: JSON.stringify(input.payload),
    actorType: "user",
    actorId: input.actor.id,
    // email 跟著存：人離職、帳號被刪之後，紀錄仍然看得出當初是誰做的。
    actorEmail: input.actor.email,
    source: "crm",
  });
}

export async function findCustomerByPhone(db: Database, phone: string) {
  const [row] = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(eq(customers.normalizedPhone, normalizePhone(phone)))
    .limit(1);
  return row ?? null;
}

export async function findCustomer(db: Database, id: string) {
  const [row] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  return row ?? null;
}

/**
 * 建立客戶。
 *
 * remote 有值代表這筆已經先在官網建好了（呼叫端負責），這裡只是把它落地。
 * 沒有的話就是純本地的客戶（sourceChannel = manual），之後可以再連結。
 */
export async function createCustomer(
  db: Database,
  input: CustomerInput & {
    remote?: { externalId: string; uid: string; tags: string[]; raw: unknown; blocked: boolean };
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
      sourceChannel: linked ? "cyberbiz" : "manual",
      status: linked?.blocked ? "blocked" : "active",
      cyberbizCustomerId: linked?.externalId ?? null,
      cyberbizUid: linked?.uid || null,
      cyberbizTagsJson: JSON.stringify(linked?.tags ?? input.tags),
      cyberbizRawJson: JSON.stringify(linked?.raw ?? {}),
      syncStatus: linked ? "synced" : "local_only",
      lastSyncedAt: linked ? now : null,
      blockedAt: linked?.blocked ? now : null,
    }),
    writeEvent(db, {
      customerId: id,
      eventType: "customer_created",
      summary: linked ? "新增客戶並同步到 CYBERBIZ" : "新增客戶（僅存在本地）",
      payload: { phone: input.phone, name: input.name, linked: Boolean(linked) },
      actor: input.actor,
    }),
  ]);

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
  const tagsChanged = before.cyberbizTagsJson !== JSON.stringify(input.tags);

  await db.batch([
    db
      .update(customers)
      .set({
        phone: input.phone,
        normalizedPhone: normalizePhone(input.phone),
        name: input.name,
        email: input.email,
        address: input.address,
        cyberbizTagsJson: JSON.stringify(input.tags),
        ...(input.syncedToRemote ? { syncStatus: "synced", syncError: null, lastSyncedAt: new Date().toISOString() } : {}),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(customers.id, id)),
    writeEvent(db, {
      customerId: id,
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
}

export async function setCustomerBlocked(
  db: Database,
  id: string,
  blocked: boolean,
  actor: Actor,
): Promise<void> {
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
      eventType: blocked ? "customer_blocked" : "customer_unblocked",
      summary: blocked ? "封鎖客戶" : "解除封鎖",
      payload: { changedFields: ["status"], after: { status: blocked ? "blocked" : "active" } },
      actor,
    }),
  ]);
}
