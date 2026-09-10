import { and, desc, eq, like, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityEvents } from "./schema/activity.js";

/** HR 稽核只回傳操作摘要，不把人事明細、payload 或欄位新舊值送進一般管理畫面。 */
export interface HrAuditRow {
  id: string;
  entityType: string;
  entityId: string;
  eventType: string;
  summary: string;
  actorType: string;
  actorEmail: string | null;
  status: string;
  error: string | null;
  createdAt: string;
}

export interface HrAuditResult {
  events: HrAuditRow[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export async function listHrActivity(
  db: Database,
  query: { search: string; page: number; pageSize: number },
): Promise<HrAuditResult> {
  const conditions: SQL[] = [eq(activityEvents.source, "hr")];
  const search = query.search.trim();
  if (search) {
    const term = `%${search}%`;
    const matches = or(
      like(activityEvents.summary, term),
      like(activityEvents.eventType, term),
      like(activityEvents.entityId, term),
      like(activityEvents.actorEmail, term),
    );
    if (matches) conditions.push(matches);
  }

  const rows = await db.select({
    id: activityEvents.id,
    entityType: activityEvents.entityType,
    entityId: activityEvents.entityId,
    eventType: activityEvents.eventType,
    summary: activityEvents.summary,
    actorType: activityEvents.actorType,
    actorEmail: activityEvents.actorEmail,
    status: activityEvents.status,
    error: activityEvents.error,
    createdAt: activityEvents.createdAt,
  }).from(activityEvents)
    .where(and(...conditions))
    // 與共用操作紀錄使用相同的穩定排序，避免同秒寫入在翻頁時重複或遺漏。
    .orderBy(desc(sql`julianday(${activityEvents.createdAt})`), desc(sql`rowid`))
    .limit(query.pageSize + 1)
    .offset((query.page - 1) * query.pageSize);

  const hasMore = rows.length > query.pageSize;
  return { events: hasMore ? rows.slice(0, query.pageSize) : rows, page: query.page, pageSize: query.pageSize, hasMore };
}
