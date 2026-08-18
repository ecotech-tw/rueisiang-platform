import {
  CUSTOMER_PAGE_SIZES,
  CUSTOMER_SORT_FIELDS,
  defaultCustomerQuery,
  listCustomers,
  type CustomerQuery,
  type CustomerSortField,
} from "@rueisiang/db";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

/**
 * 客戶關係管理。
 *
 * 查詢參數全部當成不可信輸入：不認得的排序欄位、超出白名單的每頁筆數、
 * 負數的頁碼，一律退回預設值而不是報錯——列表頁被人手動改網址是常態，
 * 為此回 400 只會讓畫面壞掉。
 */
function parseQuery(url: URL): CustomerQuery {
  const defaults = defaultCustomerQuery();
  const sortField = url.searchParams.get("sortField");
  const pageSize = Number(url.searchParams.get("pageSize"));
  const page = Number(url.searchParams.get("page"));

  return {
    search: url.searchParams.get("search")?.trim() ?? defaults.search,
    channel: url.searchParams.get("channel") ?? defaults.channel,
    status: url.searchParams.get("status") ?? defaults.status,
    tag: url.searchParams.get("tag")?.trim() ?? defaults.tag,
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : defaults.page,
    pageSize: (CUSTOMER_PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : defaults.pageSize,
    sortField: CUSTOMER_SORT_FIELDS.includes(sortField as CustomerSortField)
      ? (sortField as CustomerSortField)
      : defaults.sortField,
    sortDirection: url.searchParams.get("sortDirection") === "asc" ? "asc" : "desc",
  };
}

export const crm = new Hono<AppEnv>()
  .use("*", requireAuth)

  .get("/customers", requirePermission("crm:customer:read"), async (c) => {
    const result = await listCustomers(c.get("db"), parseQuery(new URL(c.req.url)));
    return c.json(result);
  });
