import { and, desc, eq, like, or, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityEvents } from "./schema/activity.js";
import { crmCustomers } from "./schema/crm.js";

/**
 * CRM 的操作紀錄。
 *
 * 資料來源是共用的 activity_events，這裡只是把它篩成「客戶」那一種再補上電話。
 * webhook 進來的異動、手動的新增與編輯，都會寫一筆；全量同步刻意不寫（一次匯入
 * 上萬筆等於灌雜訊），所以這裡看到的是「有人或有事件真的動到某個客戶」的紀錄。
 */

export interface EventQuery {
  search: string;
  /** all／crm／cyberbiz_webhook／cyberbiz_sync */
  source: string;
  /** 只看某一個客戶的紀錄 */
  customerId: string;
  page: number;
  pageSize: number;
}

export interface EventRow {
  id: string;
  customerId: string;
  customerName: string;
  /** 客戶已經被刪掉時是 null——名字仍然讀得到（存的是快照），電話讀不到。 */
  customerPhone: string | null;
  eventType: string;
  summary: string;
  actorType: string;
  actorEmail: string | null;
  source: string;
  status: string;
  error: string | null;
  createdAt: string;
}

export const EVENT_PAGE_SIZES = [25, 50, 100] as const;

export function defaultEventQuery(): EventQuery {
  return { search: "", source: "all", customerId: "", page: 1, pageSize: 25 };
}

function buildWhere(query: EventQuery): SQL | undefined {
  const conditions: SQL[] = [];

  // 這一頁只看客戶。WMS 的紀錄寫在同一張表，不篩的話會混進來。
  conditions.push(eq(activityEvents.entityType, "customer"));
  if (query.customerId) conditions.push(eq(activityEvents.entityId, query.customerId));
  if (query.source !== "all") conditions.push(eq(activityEvents.source, query.source));

  if (query.search) {
    const term = `%${query.search}%`;
    /*
     * 搜尋橫跨紀錄本身與客戶——找「某個人身上發生過什麼」是最常見的用法。
     * 名字比對 entityLabel（紀錄當下的快照）而不是 crmCustomers.name：客戶改名之後
     * 用舊名字仍然找得到那段歷史，客戶被刪掉也還找得到。
     */
    conditions.push(
      or(
        like(activityEvents.summary, term),
        like(activityEvents.eventType, term),
        like(activityEvents.actorEmail, term),
        like(activityEvents.entityLabel, term),
        like(crmCustomers.phone, term),
      )!,
    );
  }

  return conditions.length ? and(...conditions) : undefined;
}

export async function listCustomerEvents(
  db: Database,
  query: EventQuery,
): Promise<{ events: EventRow[]; page: number; pageSize: number; hasMore: boolean }> {
  const where = buildWhere(query);

  /*
   * 多抓一筆來判斷還有沒有下一頁，而不是另外跑一次 count。
   * 操作紀錄會長到幾十萬筆，每次翻頁都全表 count 太貴，而這一頁只需要知道
   * 「後面還有沒有」，不需要知道總共幾筆。
   */
  const rows = await db
    .select({
      id: activityEvents.id,
      customerId: activityEvents.entityId,
      // 名字讀快照，不讀 customers——客戶被刪掉之後這一頁仍然讀得懂。
      customerName: activityEvents.entityLabel,
      customerPhone: crmCustomers.phone,
      eventType: activityEvents.eventType,
      summary: activityEvents.summary,
      actorType: activityEvents.actorType,
      actorEmail: activityEvents.actorEmail,
      source: activityEvents.source,
      status: activityEvents.status,
      error: activityEvents.error,
      createdAt: activityEvents.createdAt,
    })
    .from(activityEvents)
    /*
     * leftJoin 而不是 innerJoin。電話沒有快照（改號碼是常態，存快照反而會顯示
     * 過時的），所以還是要 join；但用 inner 的話客戶一刪，他的操作紀錄就整批從
     * 畫面上消失——連「刪掉這個客戶」這件事本身都查不到。
     */
    .leftJoin(crmCustomers, eq(crmCustomers.id, activityEvents.entityId))
    .where(where)
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
