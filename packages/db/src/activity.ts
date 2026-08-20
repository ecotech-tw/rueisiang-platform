import { and, desc, eq, like, or, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityEvents } from "./schema/activity.js";

/**
 * 操作紀錄的寫入與查詢。
 *
 * 所有模組都走這裡，不要各自 insert 到 activity_events——entityType 是自由字串
 * （新模組不必先改 schema），所以型別把關只剩下這一層。繞過它就等於放棄那道關。
 */

/**
 * 目前有紀錄的東西。新模組搬進來時在這裡加一個值，其他地方不用動。
 *
 * 用 union 而不是 enum：它只是要讓打錯字在編譯時就爆掉，不需要執行期的值。
 */
export type ActivityEntityType =
  | "customer"
  | "zone"
  | "inventory_item"
  | "product_category"
  | "layout_element"
  /** 倉庫本身的設定（畫布尺寸）。只有一筆，entityId 固定是 main。 */
  | "warehouse";

/**
 * 哪裡寫的。前端的操作紀錄頁用它當篩選選項，所以值一改就要一起改那邊的下拉。
 *
 * cyberbiz 拆成 webhook 與 sync 兩種：一個是官網即時推過來的，一個是我們主動
 * 去拉的。排查「這筆資料怎麼變成這樣」時，這兩者的意義完全不同。
 */
export type ActivitySource = "crm" | "wms" | "cyberbiz_webhook" | "cyberbiz_sync";

export interface ActivityInput {
  entityType: ActivityEntityType;
  entityId: string;
  /** 當下那個東西叫什麼。存快照，東西被刪掉之後紀錄還看得懂。 */
  entityLabel?: string;
  eventType: string;
  summary: string;
  source?: ActivitySource;
  /** 欄位級的變更。WMS 用得多，CRM 通常留空。 */
  field?: string;
  oldValue?: string | null;
  newValue?: string | null;
  payload?: unknown;
  actor?: { id?: string | null; email?: string | null } | null;
  status?: "succeeded" | "failed";
  error?: string | null;
}

/** 組出一列紀錄。呼叫端可能要一次寫很多筆（批次匯入），所以拆出來給 values() 用。 */
export function activityRow(input: ActivityInput) {
  return {
    id: `evt-${crypto.randomUUID()}`,
    entityType: input.entityType,
    entityId: input.entityId,
    entityLabel: input.entityLabel ?? "",
    eventType: input.eventType,
    summary: input.summary,
    field: input.field ?? "",
    oldValue: input.oldValue ?? null,
    newValue: input.newValue ?? null,
    payloadJson: input.payload === undefined ? "{}" : JSON.stringify(input.payload),
    // 有 actor 就是人做的，沒有就是排程或同步自己跑的。
    actorType: input.actor?.id || input.actor?.email ? "user" : "system",
    actorId: input.actor?.id ?? null,
    actorEmail: input.actor?.email ?? null,
    source: input.source ?? "crm",
    status: input.status ?? "succeeded",
    error: input.error ?? null,
  };
}

export async function recordActivity(db: Database, input: ActivityInput): Promise<void> {
  await db.insert(activityEvents).values(activityRow(input));
}

export interface ActivityQuery {
  entityType?: ActivityEntityType;
  entityId?: string;
  source: ActivitySource | "all";
  search: string;
  page: number;
  pageSize: number;
}

export interface ActivityRow {
  id: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  eventType: string;
  summary: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  actorType: string;
  actorEmail: string | null;
  source: string;
  status: string;
  error: string | null;
  createdAt: string;
}

export interface ActivityResult {
  events: ActivityRow[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/**
 * 查詢紀錄。
 *
 * 沒有 join：entityLabel 存的是當下的名字，所以東西被刪掉之後這一頁仍然讀得懂。
 * 原本的 customer_events 是 innerJoin customers——客戶一刪，他的操作紀錄就跟著
 * 從畫面上消失，等於「刪掉一個客戶」這件事本身也查不到了。
 */
export async function listActivity(db: Database, query: ActivityQuery): Promise<ActivityResult> {
  const conditions: SQL[] = [];
  if (query.entityType) conditions.push(eq(activityEvents.entityType, query.entityType));
  if (query.entityId) conditions.push(eq(activityEvents.entityId, query.entityId));
  if (query.source !== "all") conditions.push(eq(activityEvents.source, query.source));

  const term = `%${query.search.trim()}%`;
  if (query.search.trim()) {
    const matches = or(
      like(activityEvents.summary, term),
      like(activityEvents.eventType, term),
      like(activityEvents.entityLabel, term),
      like(activityEvents.actorEmail, term),
    );
    if (matches) conditions.push(matches);
  }

  const where = conditions.length ? and(...conditions) : undefined;

  /*
   * 多抓一筆判斷還有沒有下一頁，而不是另外跑一次 count。操作紀錄會長到幾十萬筆，
   * 每次翻頁都全表 count 太貴，而這一頁只需要知道「後面還有沒有」。
   */
  const rows = await db
    .select({
      id: activityEvents.id,
      entityType: activityEvents.entityType,
      entityId: activityEvents.entityId,
      entityLabel: activityEvents.entityLabel,
      eventType: activityEvents.eventType,
      summary: activityEvents.summary,
      field: activityEvents.field,
      oldValue: activityEvents.oldValue,
      newValue: activityEvents.newValue,
      actorType: activityEvents.actorType,
      actorEmail: activityEvents.actorEmail,
      source: activityEvents.source,
      status: activityEvents.status,
      error: activityEvents.error,
      createdAt: activityEvents.createdAt,
    })
    .from(activityEvents)
    .where(where)
    // id 當第二排序鍵：同一秒寫入的多筆順序才穩定，翻頁不會重複或漏。
    .orderBy(desc(activityEvents.createdAt), desc(activityEvents.id))
    .limit(query.pageSize + 1)
    .offset((query.page - 1) * query.pageSize);

  const hasMore = rows.length > query.pageSize;
  return {
    events: hasMore ? rows.slice(0, query.pageSize) : rows,
    page: query.page,
    pageSize: query.pageSize,
    hasMore,
  };
}
