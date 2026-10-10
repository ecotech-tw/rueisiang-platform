import { and, count, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError } from "./hr-people.js";
import { HR_NOTIFICATION_BODY_LIMIT, hrNotifications } from "./schema/hr-requests.js";

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

const OVERTIME_BATCH_SOURCE_PREFIX = "overtime-batch:";

/** 整批加班的通知鍵。`entityId` 這時放的是批次鍵而不是申請 ID，讀取端靠這個前綴分辨（見 listHrNotifications 的 entityScope）。 */
export function overtimeBatchSourceKey(batchId: string, event: "submitted" | "approved" | "cancelled") {
  return `${OVERTIME_BATCH_SOURCE_PREFIX}${batchId}:${event}`;
}

/** 截斷時開頭要放「…」與換行，一行最多只能用到這麼長，整行才留得住。 */
const NOTIFICATION_LINE_LIMIT = HR_NOTIFICATION_BODY_LIMIT - 2;

/**
 * 組出附加式通知的一行：前綴（哪一天、什麼結果）一定完整，放不下時截的是後面的說明文字。
 * 沒有這一步的話，一則很長的審核意見會把日期擠掉，收件人看不出是在講哪一天。
 */
export function notificationLine(prefix: string, detail: string) {
  const room = NOTIFICATION_LINE_LIMIT - [...prefix].length;
  const characters = [...detail];
  return `${prefix}${characters.length > room ? `${characters.slice(0, room - 1).join("")}…` : detail}`;
}

/**
 * 超過上限時丟掉最舊的幾行、留下最新的：附加式通知最新的一行在最後面，那才是收件人還沒看過的。
 * 從換行切，不留半行——沒有日期的意見殘段會被看成下一筆的意見。
 * 在 SQL 裡算是因為 SQLite 的 length／substr 以字元計，JS 的 slice 會把 emoji 切成半個。
 */
function clampBody(body: SQL) {
  const limit = sql.raw(String(HR_NOTIFICATION_BODY_LIMIT));
  const tail = sql`substr(${body}, -${sql.raw(String(NOTIFICATION_LINE_LIMIT))})`;
  return sql`CASE
    WHEN length(${body}) <= ${limit} THEN ${body}
    WHEN instr(${tail}, char(10)) > 0 THEN '…' || char(10) || substr(${tail}, instr(${tail}, char(10)) + 1)
    ELSE '…' || substr(${body}, -(${limit} - 1))
  END`;
}

/**
 * 申請狀態變更和業務資料要在同一個 D1 batch 寫入；回傳帶 RETURNING 的 SQL，
 * 讓呼叫端可以把通知和原始 mutation 放進同一個 writeHrMutation。
 */
export function insertHrNotification(input: HrNotificationInsert) {
  return sql`INSERT INTO hr_notifications
    (id, user_id, source_key, kind, entity_kind, entity_id, title, body)
    VALUES (${crypto.randomUUID()}, ${input.userId}, ${input.sourceKey}, ${input.kind}, ${input.entityKind}, ${input.entityId}, ${input.title}, ${clampBody(sql`${input.body}`)})
    RETURNING id`;
}

/**
 * 同一個 sourceKey 只留一則：已經有的話把這次的內文接在後面一行，並重新標成未讀。
 * 給「同一批申請被逐筆處理」用——逐筆各發一則會把收件人的通知洗掉。
 *
 * 用附加而不是「先查目前狀態再重組內文」：附加在同一句 SQL 裡完成，兩個人同時處理同一批時
 * 不會互相蓋掉，先前每一筆的日期與意見也都留著。
 */
export function appendHrNotification(input: HrNotificationInsert) {
  return sql`INSERT INTO hr_notifications
    (id, user_id, source_key, kind, entity_kind, entity_id, title, body)
    VALUES (${crypto.randomUUID()}, ${input.userId}, ${input.sourceKey}, ${input.kind}, ${input.entityKind}, ${input.entityId}, ${input.title}, ${clampBody(sql`${input.body}`)})
    ON CONFLICT(source_key) DO UPDATE SET
      body=${clampBody(sql`hr_notifications.body || char(10) || excluded.body`)}, read_at=NULL, created_at=CURRENT_TIMESTAMP
    RETURNING id`;
}

export async function listHrNotifications(db: Database, userId: string, limit = 50) {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const [notifications, [unread]] = await Promise.all([
    db.select({
      id: hrNotifications.id,
      // 整批加班的通知 entityId 是批次鍵；前端要導到整批而不是把它當申請 ID 查。
      entityScope: sql<"request" | "batch">`CASE WHEN ${hrNotifications.sourceKey} LIKE ${`${OVERTIME_BATCH_SOURCE_PREFIX}%`} THEN 'batch' ELSE 'request' END`,
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
