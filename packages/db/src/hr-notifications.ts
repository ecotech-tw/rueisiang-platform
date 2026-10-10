import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError } from "./hr-people.js";
import { hrNotifications } from "./schema/hr-requests.js";

export type HrNotificationKind = "request_submitted" | "request_reviewed" | "request_cancelled";
export type HrNotificationEntityKind = "leave" | "overtime" | "clock_correction";

export interface HrNotificationInsert {
  userId: string;
  sourceKey: string;
  kind: HrNotificationKind;
  entityKind: HrNotificationEntityKind;
  entityId: string;
  title: string;
  body: string;
}

/**
 * 申請狀態變更和業務資料要在同一個 D1 batch 寫入；回傳帶 RETURNING 的 SQL，
 * 讓呼叫端可以把通知和原始 mutation 放進同一個 writeHrMutation。
 */
export function insertHrNotification(input: HrNotificationInsert) {
  return sql`INSERT INTO hr_notifications
    (id, user_id, source_key, kind, entity_kind, entity_id, title, body)
    VALUES (${crypto.randomUUID()}, ${input.userId}, ${input.sourceKey}, ${input.kind}, ${input.entityKind}, ${input.entityId}, ${input.title}, ${input.body})
    RETURNING id`;
}

/**
 * 同一個 sourceKey 只留一則，後來的蓋掉先前的並重新標成未讀。
 * 給「同一批申請被逐筆處理」用：逐筆各發一則會把收件人的通知洗掉。
 */
export function upsertHrNotification(input: HrNotificationInsert) {
  return sql`INSERT INTO hr_notifications
    (id, user_id, source_key, kind, entity_kind, entity_id, title, body)
    VALUES (${crypto.randomUUID()}, ${input.userId}, ${input.sourceKey}, ${input.kind}, ${input.entityKind}, ${input.entityId}, ${input.title}, ${input.body})
    ON CONFLICT(source_key) DO UPDATE SET title=excluded.title, body=excluded.body, read_at=NULL, created_at=CURRENT_TIMESTAMP
    RETURNING id`;
}

export async function listHrNotifications(db: Database, userId: string, limit = 50) {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const [notifications, [unread]] = await Promise.all([
    db.select({
      id: hrNotifications.id,
      kind: hrNotifications.kind,
      entityKind: hrNotifications.entityKind,
      entityId: hrNotifications.entityId,
      title: hrNotifications.title,
      body: hrNotifications.body,
      readAt: hrNotifications.readAt,
      createdAt: hrNotifications.createdAt,
    }).from(hrNotifications)
      .where(eq(hrNotifications.userId, userId))
      .orderBy(desc(hrNotifications.createdAt), desc(hrNotifications.id))
      .limit(safeLimit),
    db.select({ count: count() }).from(hrNotifications)
      .where(and(eq(hrNotifications.userId, userId), isNull(hrNotifications.readAt))),
  ]);
  return { notifications, unreadCount: unread?.count ?? 0 };
}

export async function markHrNotificationRead(db: Database, id: string, userId: string) {
  const [updated] = await db.update(hrNotifications)
    .set({ readAt: sql`CURRENT_TIMESTAMP` })
    .where(and(eq(hrNotifications.id, id), eq(hrNotifications.userId, userId)))
    .returning({ id: hrNotifications.id });
  if (!updated) throw new HrError(404, "找不到這則通知。 ");
  return { id };
}

export async function markAllHrNotificationsRead(db: Database, userId: string) {
  await db.update(hrNotifications)
    .set({ readAt: sql`CURRENT_TIMESTAMP` })
    .where(and(eq(hrNotifications.userId, userId), isNull(hrNotifications.readAt)));
  return { ok: true };
}
