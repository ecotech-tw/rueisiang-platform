import { eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { normalizePhone } from "./phone.js";
import { activityRow } from "./activity.js";
import { customerTagNames, replaceCustomerTags } from "./crm-tags.js";
import { activityEvents } from "./schema/activity.js";
import { crmCustomerTags, crmTags, crmCustomers } from "./schema/crm.js";

/**
 * 客戶的寫入操作：新增、編輯、封鎖。
 *
 * 官網同步是最佳努力：能同步就先寫官網，失敗仍要把本地輸入保存下來，
 * 並用 syncStatus 說明這筆資料沒有和官網確認成功。這樣官網故障不會把 CRM
 * 表單鎖死，也不會把未連結的資料偽裝成已同步。
 */

export type CustomerSyncStatus = "synced" | "failed";

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
    .select({ id: crmCustomers.id, name: crmCustomers.name })
    .from(crmCustomers)
    .where(eq(crmCustomers.normalizedPhone, normalizePhone(phone)))
    .limit(1);
  return row ?? null;
}

export async function findCustomer(db: Database, id: string): Promise<any | null> {
  const [row] = await db.select().from(crmCustomers).where(eq(crmCustomers.id, id)).limit(1);
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
 * 呼叫端會先嘗試在官網建立可同步的會員；remote 缺席時仍建立一筆未連結的本地
 * 客戶，但必須帶著 failed 狀態，讓資料不會被誤認為已同步。
 */
export async function createCustomer(
  db: Database,
  input: CustomerInput & {
    remote?: { externalId: string; uid: string; tags: string[]; raw: unknown; blocked: boolean };
    syncStatus?: CustomerSyncStatus;
    actor: Actor;
  },
): Promise<{ id: string }> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const linked = input.remote;
  const syncStatus = input.syncStatus ?? (linked ? "synced" : "failed");
  const tags = linked?.tags ?? input.tags;

  await db.batch([
    db.insert(crmCustomers).values({
      id,
      phone: input.phone,
      normalizedPhone: normalizePhone(input.phone),
      name: input.name,
      email: input.email,
      address: input.address,
      status: linked?.blocked ? "blocked" : "active",
      cyberbizCustomerId: linked?.externalId ?? null,
      cyberbizUid: linked?.uid || null,
      rawJson: JSON.stringify(linked?.raw ?? {}),
      syncStatus,
      syncedAt: linked ? now : null,
      blockedAt: linked?.blocked ? now : null,
    }),
    writeEvent(db, {
      customerId: id,
      customerName: input.name,
      eventType: "customer_created",
      summary: linked ? "新增客戶並同步到 CYBERBIZ" : "新增本地客戶",
      payload: { phone: input.phone, name: input.name, linked: Boolean(linked), syncStatus },
      actor: input.actor,
    }),
  ]);
  await replaceCustomerTags(db, id, tags);

  return { id };
}

export async function updateCustomer(
  db: Database,
  id: string,
  input: CustomerInput & { actor: Actor; syncStatus: CustomerSyncStatus },
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
      .update(crmCustomers)
      .set({
        phone: input.phone,
        normalizedPhone: normalizePhone(input.phone),
        name: input.name,
        email: input.email,
        address: input.address,
        syncStatus: input.syncStatus,
        ...(input.syncStatus === "synced" ? { syncedAt: new Date().toISOString() } : {}),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(crmCustomers.id, id)),
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
      .update(crmCustomers)
      .set({
        status: blocked ? "blocked" : "active",
        blockedAt: blocked ? sql`CURRENT_TIMESTAMP` : null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(crmCustomers.id, id)),
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
