import {
  CUSTOMER_PAGE_SIZES,
  CUSTOMER_SORT_FIELDS,
  EVENT_PAGE_SIZES,
  defaultEventQuery,
  listCustomerEvents,
  defaultCustomerQuery,
  listCustomers,
  deleteEmptyCyberbizCustomers,
  readSyncStatus,
  retryFailedWebhooks,
  upsertCyberbizCustomers,
  type CustomerQuery,
  type CustomerSortField,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cyberbizClient } from "../cyberbiz.js";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

/**
 * 一次手動同步最多拉幾頁。
 *
 * Worker 有執行時間上限，全量拉一次可能拉不完，所以分批：回報還有沒有下一頁，
 * 讓人再按一次，Cron 也會自己往下接。與其冒著跑到一半被砍掉、狀態不明的風險，
 * 不如每次都在可預期的範圍內結束。
 */
const MAX_PAGES_PER_RUN = 10;
const PAGE_SIZE = 50;

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
  })

  /** 操作紀錄。分頁用「多抓一筆」判斷還有沒有下一頁，不做全表 count。 */
  .get("/events", requirePermission("crm:activity:read"), async (c) => {
    const url = new URL(c.req.url);
    const defaults = defaultEventQuery();
    const pageSize = Number(url.searchParams.get("pageSize"));
    const page = Number(url.searchParams.get("page"));

    const result = await listCustomerEvents(c.get("db"), {
      search: url.searchParams.get("search")?.trim() ?? defaults.search,
      source: url.searchParams.get("source") ?? defaults.source,
      customerId: url.searchParams.get("customerId")?.trim() ?? defaults.customerId,
      page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : defaults.page,
      pageSize: (EVENT_PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : defaults.pageSize,
    });
    return c.json(result);
  })

  .get("/sync/status", requirePermission("crm:sync:read"), async (c) => {
    return c.json({
      ...(await readSyncStatus(c.get("db"))),
      configured: Boolean(c.env.CYBERBIZ_API_TOKEN),
      webhookConfigured: Boolean(c.env.CYBERBIZ_WEBHOOK_SECRET),
    });
  })

  /** 手動把官網的會員拉一輪進來。從第幾頁開始由呼叫端指定，方便接著上次拉完的地方。 */
  .post("/sync", requirePermission("crm:sync:trigger"), async (c) => {
    const client = cyberbizClient(c.env);
    if (!client) throw new HTTPException(409, { message: "尚未設定 CYBERBIZ_API_TOKEN。" });

    const startPage = Math.max(1, Number(new URL(c.req.url).searchParams.get("page") || 1));
    const totals = { received: 0, written: 0, skipped: 0 };
    let totalPages = 1;
    // 最後一頁「實際拉到的」頁碼。下一輪要從這個數字 +1 開始，
    // 記成「準備要拉的下一頁」的話，接續時會整頁被跳過。
    let lastFetchedPage = startPage - 1;
    let failure: string | undefined;

    for (let index = 0; index < MAX_PAGES_PER_RUN; index += 1) {
      const page = startPage + index;

      /*
       * 某一頁失敗不該把整輪的成果丟掉。
       *
       * 一萬多筆會員要打兩百多次 API，中途碰到 429 或短暫的 5xx 是正常的。
       * 原本整個往上丟，畫面只會看到「伺服器發生錯誤」，前面幾百筆有沒有寫進去
       * 完全不知道，也不知道該從哪一頁接。改成停在失敗的那一頁、把已完成的
       * 回報出去，並告訴呼叫端從哪裡重來。
       */
      let result;
      try {
        result = await client.fetchPage(page, PAGE_SIZE);
      } catch (error) {
        failure = error instanceof Error ? error.message : "讀取 CYBERBIZ 會員失敗";
        break;
      }

      totalPages = result.totalPages;
      lastFetchedPage = page;

      const summary = await upsertCyberbizCustomers(c.get("db"), result.customers);
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += summary[key];

      if (!result.customers.length || page >= totalPages) break;
    }

    return c.json({
      ...totals,
      fromPage: startPage,
      toPage: lastFetchedPage,
      nextPage: lastFetchedPage + 1,
      totalPages,
      // 失敗時 hasMore 仍然是 true，讓前端知道還沒拉完、可以從 nextPage 接。
      hasMore: Boolean(failure) || lastFetchedPage < totalPages,
      error: failure,
    });
  })

  /** 補跑處理失敗的 webhook。Cron 也會做同一件事，這條是給人手動催的。 */
  .post("/sync/retry", requirePermission("crm:sync:trigger"), async (c) => {
    return c.json(await retryFailedWebhooks(c.get("db"), { client: cyberbizClient(c.env) }));
  })

  /** 清掉只有 CYBERBIZ ID、其餘全空的客戶（上一版 webhook 判斷太鬆造成的）。 */
  .post("/sync/cleanup-empty", requirePermission("crm:sync:trigger"), async (c) => {
    const result = await deleteEmptyCyberbizCustomers(c.get("db"));
    return c.json({ deleted: result.deleted });
  });
