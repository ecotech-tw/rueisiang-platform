import {
  EVENT_PAGE_SIZES,
  applyTagChange,
  createCustomer,
  createSavedView,
  createTag,
  deleteSavedView,
  listSavedViews,
  normalizeCustomerQuery,
  findCustomer,
  findCustomerByPhone,
  setCustomerBlocked,
  updateCustomer,
  validatePhone,
  defaultEventQuery,
  deleteTagFromCatalog,
  listTags,
  renameTagInCatalog,
  listCustomerEvents,
  customerStats,
  listCustomers,
  deleteEmptyCyberbizCustomers,
  readSyncStatus,
  retryFailedWebhooks,
  upsertCyberbizCustomers,
  type CustomerQuery,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createCrmCache, forgetCrmStats } from "../crm-cache.js";
import { cyberbizClient } from "../cyberbiz.js";
import { cacheClient } from "../upstash.js";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { body, requireString } from "../request.js";

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
 * 為此回 400 只會讓畫面壞掉。收斂的規則跟儲存的視圖共用同一份
 * （packages/db 的 normalizeCustomerQuery），兩邊才不會各自認得不同的值。
 */
function parseQuery(url: URL): CustomerQuery {
  return normalizeCustomerQuery(Object.fromEntries(url.searchParams));
}

/** 讀出並檢查客戶欄位。電話是唯一必填——它是辨識客戶的主要依據。 */
function readCustomerFields(input: Record<string, unknown>) {
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  const phoneError = validatePhone(phone);
  if (phoneError) throw new HTTPException(400, { message: phoneError });

  const text = (field: string) => (typeof input[field] === "string" ? (input[field] as string).trim() : "");
  const tags = Array.isArray(input.tags)
    ? [
        ...new Set(
          input.tags
            .filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim()))
            .map((tag) => tag.trim()),
        ),
      ]
    : [];

  return {
    phone,
    name: text("name"),
    email: text("email"),
    address: text("address"),
    // 官網的地址是拆開的欄位，只給一整串的話縣市與區域會留白。
    city: text("city"),
    district: text("district"),
    addressLine: text("addressLine"),
    tags,
  };
}

export const crm = new Hono<AppEnv>()
  .use("*", requireAuth)

  .get("/customers", requirePermission("crm:customer:read"), async (c) => {
    const cache = createCrmCache(cacheClient(c.env));
    const [page, stats] = await Promise.all([
      listCustomers(c.get("db"), parseQuery(new URL(c.req.url))),
      // 統計跟篩選無關，所以 key 不帶任何查詢參數：翻頁與搜尋都不會讓它重算。
      cache.read("customers:stats", () => customerStats(c.get("db"))),
    ]);
    c.header("X-Cache", stats.status);
    return c.json({ ...page, stats: stats.value });
  })

  /**
   * 讀出並檢查客戶欄位。電話是唯一必填——它是辨識客戶的主要依據。
   */
  .post("/customers", requirePermission("crm:customer:write"), async (c) => {
    const input = await body(c);
    const fields = readCustomerFields(input);

    const duplicate = await findCustomerByPhone(c.get("db"), fields.phone);
    if (duplicate) throw new HTTPException(409, { message: "這支電話已經建立過客戶資料。" });

    /*
     * 先在官網建會員，成功了才寫本地。
     *
     * 反過來的話，官網失敗時本地會留下一筆「看起來同步過」的客戶，實際上
     * 官網根本沒有這個人。沿用舊 CRM 的順序，理由一樣。
     */
    const client = cyberbizClient(c.env);
    const wantsCyberbiz = input.sourceChannel !== "manual";
    let remote;

    if (wantsCyberbiz) {
      if (!client) throw new HTTPException(409, { message: "尚未設定 CYBERBIZ_API_TOKEN，只能建立本地客戶。" });
      const created = await client.create(fields);
      if (!created.externalId) {
        throw new HTTPException(502, { message: "CYBERBIZ 已建立會員但沒有回傳會員 ID，請重新同步確認。" });
      }
      remote = {
        externalId: created.externalId,
        uid: created.uid,
        tags: created.tags,
        raw: created.raw,
        blocked: created.blocked,
      };
    }

    const user = c.get("user");
    const result = await createCustomer(c.get("db"), {
      ...fields,
      remote,
      actor: { id: user.id, email: user.email },
    });
    await forgetCrmStats(cacheClient(c.env));
    return c.json({ id: result.id, linked: Boolean(remote) }, 201);
  })

  .patch("/customers/:id", requirePermission("crm:customer:write"), async (c) => {
    const id = c.req.param("id");
    const existing = await findCustomer(c.get("db"), id);
    if (!existing) throw new HTTPException(404, { message: "找不到這筆客戶資料。" });

    const fields = readCustomerFields(await body(c));

    // 電話換成別人已經在用的，會讓兩筆資料指向同一個人。
    const duplicate = await findCustomerByPhone(c.get("db"), fields.phone);
    if (duplicate && duplicate.id !== id) {
      throw new HTTPException(409, { message: "這支電話已經是另一位客戶的資料。" });
    }

    const client = cyberbizClient(c.env);
    if (existing.cyberbizCustomerId) {
      if (!client) throw new HTTPException(409, { message: "尚未設定 CYBERBIZ_API_TOKEN，無法更新已連結官網的客戶。" });
      await client.update(existing.cyberbizCustomerId, fields);
    }

    const user = c.get("user");
    await updateCustomer(c.get("db"), id, {
      ...fields,
      syncedToRemote: Boolean(existing.cyberbizCustomerId),
      actor: { id: user.id, email: user.email },
    });
    await forgetCrmStats(cacheClient(c.env));
    return c.json({ id });
  })

  .post("/customers/:id/block", requirePermission("crm:customer:block"), async (c) => {
    const id = c.req.param("id");
    const existing = await findCustomer(c.get("db"), id);
    if (!existing) throw new HTTPException(404, { message: "找不到這筆客戶資料。" });

    const input = await body(c);
    const blocked = input.blocked !== false;

    const client = cyberbizClient(c.env);
    if (existing.cyberbizCustomerId && client) {
      await client.setBlocked(existing.cyberbizCustomerId, blocked);
    }

    const user = c.get("user");
    await setCustomerBlocked(c.get("db"), id, blocked, { id: user.id, email: user.email });
    await forgetCrmStats(cacheClient(c.env));
    return c.json({ id, blocked });
  })

  /*
   * 儲存的視圖是全公司共用的一組篩選條件，不是個人設定。
   *
   * 所以讀取只要看得到客戶就行，但建立與刪除要另外的權限——共用的東西被
   * 任何人隨手刪掉，其他人只會看到自己常用的視圖突然不見。
   */
  .get("/views", requirePermission("crm:customer:read"), async (c) => {
    return c.json({ views: await listSavedViews(c.get("db")) });
  })

  .post("/views", requirePermission("crm:view:write"), async (c) => {
    const input = await body(c);
    const name = requireString(input, "name", "視圖名稱");
    if (name.length > 40) throw new HTTPException(400, { message: "視圖名稱不能超過 40 個字。" });

    const result = await createSavedView(c.get("db"), {
      ...input,
      name,
      createdByEmail: c.get("user").email,
    });
    if (result === "duplicate") throw new HTTPException(409, { message: "已經有同名的視圖了。" });
    return c.json({ id: result.id, name }, 201);
  })

  .delete("/views/:id", requirePermission("crm:view:write"), async (c) => {
    const deleted = await deleteSavedView(c.get("db"), c.req.param("id"));
    if (!deleted) throw new HTTPException(404, { message: "找不到這個視圖。" });
    return c.json({ ok: true });
  })

  .get("/tags", requirePermission("crm:tag:read"), async (c) => {
    // json_each 展開之後要讀三倍於客戶數的列，而標籤清單一分鐘內不會變。
    const tags = await createCrmCache(cacheClient(c.env)).read("tags", () => listTags(c.get("db")));
    c.header("X-Cache", tags.status);
    return c.json({ tags: tags.value });
  })

  .post("/tags", requirePermission("crm:tag:write"), async (c) => {
    const input = await body(c);
    const name = requireString(input, "name", "標籤名稱");
    if (name.length > 40) throw new HTTPException(400, { message: "標籤名稱不能超過 40 個字。" });

    const result = await createTag(c.get("db"), name);
    if (result === "duplicate") throw new HTTPException(409, { message: "這個標籤已經存在。" });
    return c.json({ name }, 201);
  })

  /**
   * 改名或刪除一個標籤。
   *
   * 一輪只處理一批客戶（每位有連到官網的都要打一次 API），回傳 hasMore 讓呼叫端
   * 接著跑——跟全量同步同一個模式。第一輪才動字典，之後幾輪只處理剩下的客戶。
   */
  .patch("/tags/:name", requirePermission("crm:tag:write"), async (c) => {
    const original = decodeURIComponent(c.req.param("name"));
    const input = await body(c);
    const nextName = input.name === null ? null : requireString(input, "name", "標籤名稱");
    if (nextName === original) return c.json({ processed: 0, linked: 0, hasMore: false, failures: [] });

    const client = cyberbizClient(c.env);
    const user = c.get("user");
    const result = await applyTagChange(c.get("db"), original, {
      nextName,
      actor: { actorType: "user", actorId: user.id, actorEmail: user.email },
      pushTags: client ? (externalId, tags) => client.updateTags(externalId, tags).then(() => undefined) : undefined,
    });

    // 字典只在第一輪動一次，後面幾輪是在收尾剩下的客戶。
    if (new URL(c.req.url).searchParams.get("continue") !== "1") {
      if (nextName) await renameTagInCatalog(c.get("db"), original, nextName);
      else await deleteTagFromCatalog(c.get("db"), original);
    }

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

    await forgetCrmStats(cacheClient(c.env));
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
    const result = await retryFailedWebhooks(c.get("db"), { client: cyberbizClient(c.env) });
    await forgetCrmStats(cacheClient(c.env));
    return c.json(result);
  })

  /** 清掉只有 CYBERBIZ ID、其餘全空的客戶（上一版 webhook 判斷太鬆造成的）。 */
  .post("/sync/cleanup-empty", requirePermission("crm:sync:trigger"), async (c) => {
    const result = await deleteEmptyCyberbizCustomers(c.get("db"));
    await forgetCrmStats(cacheClient(c.env));
    return c.json({ deleted: result.deleted });
  });
