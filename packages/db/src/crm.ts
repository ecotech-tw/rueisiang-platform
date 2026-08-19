import { and, asc, count, desc, eq, like, or, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import { normalizePhone } from "./phone.js";
import { customers } from "./schema/crm.js";

/**
 * 客戶列表的查詢。行為沿用舊 CRM 的 app/api/customers/route.ts：
 * 同一組搜尋、篩選、排序與分頁，這樣兩邊可以逐項比對結果。
 */

/** 可以拿來排序的欄位。白名單化，避免呼叫端把任意字串塞進 order by。 */
const SORT_COLUMNS = {
  name: customers.name,
  phone: customers.phone,
  sourceChannel: customers.sourceChannel,
  status: customers.status,
  createdAt: customers.createdAt,
  updatedAt: customers.updatedAt,
} as const;

export type CustomerSortField = keyof typeof SORT_COLUMNS;
export const CUSTOMER_SORT_FIELDS = Object.keys(SORT_COLUMNS) as CustomerSortField[];
export const CUSTOMER_PAGE_SIZES = [10, 25, 50, 100] as const;

export interface CustomerQuery {
  search: string;
  /** all／manual／cyberbiz */
  channel: string;
  /** all／active／blocked */
  status: string;
  /** all 或某個標籤名稱 */
  tag: string;
  page: number;
  pageSize: number;
  sortField: CustomerSortField;
  sortDirection: "asc" | "desc";
}

export interface CustomerListResult {
  customers: (typeof customers.$inferSelect)[];
  total: number;
  page: number;
  pageSize: number;
  stats: { total: number; active: number; blocked: number; incomplete: number };
}

export function defaultCustomerQuery(): CustomerQuery {
  return {
    search: "",
    channel: "all",
    status: "all",
    tag: "all",
    page: 1,
    pageSize: 10,
    sortField: "updatedAt",
    sortDirection: "desc",
  };
}

function buildWhere(query: CustomerQuery): SQL | undefined {
  const conditions: SQL[] = [];

  if (query.search) {
    const term = `%${query.search}%`;
    /*
     * 電話比對兩種形式。使用者打「0912345678」，但資料可能存成「0912 345 678」
     * ——那是 CYBERBIZ 帶進來的原樣。只比對 phone 的話這種搜尋一定落空，
     * 所以把搜尋字串也正規化一次，去跟 normalized_phone 比。
     *
     * 標籤存成 JSON 字串，也一併掃過去——使用者不會知道標籤跟其他欄位存法不同。
     */
    const digits = normalizePhone(query.search);
    conditions.push(
      or(
        like(customers.phone, term),
        ...(digits ? [like(customers.normalizedPhone, `%${digits}%`)] : []),
        like(customers.name, term),
        like(customers.email, term),
        like(customers.address, term),
        like(customers.cyberbizTagsJson, term),
      )!,
    );
  }

  if (query.channel === "manual" || query.channel === "cyberbiz") {
    conditions.push(eq(customers.sourceChannel, query.channel));
  }
  if (query.status === "active" || query.status === "blocked") {
    conditions.push(eq(customers.status, query.status));
  }
  if (query.tag && query.tag !== "all") {
    // 用 JSON.stringify 再去掉頭尾引號，讓標籤裡的引號與反斜線被正確跳脫。
    conditions.push(like(customers.cyberbizTagsJson, `%${JSON.stringify(query.tag).slice(1, -1)}%`));
  }

  return conditions.length ? and(...conditions) : undefined;
}

export async function listCustomers(db: Database, query: CustomerQuery): Promise<CustomerListResult> {
  const where = buildWhere(query);
  const sortColumn = SORT_COLUMNS[query.sortField] ?? customers.updatedAt;

  const [rows, [totalRow], [allRow], [activeRow], [blockedRow], [incompleteRow]] = await Promise.all([
    db
      .select()
      .from(customers)
      .where(where)
      // 第二個排序鍵是 id：不加的話同值的列在分頁之間順序會飄，同一筆可能出現兩次。
      .orderBy(query.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn), desc(customers.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(customers).where(where),
    db.select({ value: count() }).from(customers),
    db.select({ value: count() }).from(customers).where(eq(customers.status, "active")),
    db.select({ value: count() }).from(customers).where(eq(customers.status, "blocked")),
    // 「資料不完整」＝沒填姓名或沒填地址，出貨時會卡住的那些。
    db
      .select({ value: count() })
      .from(customers)
      .where(or(eq(customers.name, ""), eq(customers.address, ""))),
  ]);

  return {
    customers: rows,
    total: totalRow?.value ?? 0,
    page: query.page,
    pageSize: query.pageSize,
    stats: {
      total: allRow?.value ?? 0,
      active: activeRow?.value ?? 0,
      blocked: blockedRow?.value ?? 0,
      incomplete: incompleteRow?.value ?? 0,
    },
  };
}
