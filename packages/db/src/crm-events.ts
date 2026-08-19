import { and, desc, eq, like, or, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import { customerEvents, customers } from "./schema/crm.js";

/**
 * 操作紀錄。
 *
 * 資料來源是 customer_events：webhook 進來的異動、手動的新增與編輯，都會寫一筆。
 * 全量同步刻意不寫（一次匯入上萬筆等於灌雜訊），所以這裡看到的是「有人或有事件
 * 真的動到某個客戶」的紀錄。
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
  customerPhone: string;
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

  if (query.customerId) conditions.push(eq(customerEvents.customerId, query.customerId));
  if (query.source !== "all") conditions.push(eq(customerEvents.source, query.source));

  if (query.search) {
    const term = `%${query.search}%`;
    // 搜尋橫跨紀錄本身與客戶——找「某個人身上發生過什麼」是最常見的用法。
    conditions.push(
      or(
        like(customerEvents.summary, term),
        like(customerEvents.eventType, term),
        like(customerEvents.actorEmail, term),
        like(customers.name, term),
        like(customers.phone, term),
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
      id: customerEvents.id,
      customerId: customerEvents.customerId,
      customerName: customers.name,
      customerPhone: customers.phone,
      eventType: customerEvents.eventType,
      summary: customerEvents.summary,
      actorType: customerEvents.actorType,
      actorEmail: customerEvents.actorEmail,
      source: customerEvents.source,
      status: customerEvents.status,
      error: customerEvents.error,
      createdAt: customerEvents.createdAt,
    })
    .from(customerEvents)
    .innerJoin(customers, eq(customers.id, customerEvents.customerId))
    .where(where)
    .orderBy(desc(customerEvents.createdAt), desc(customerEvents.id))
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
