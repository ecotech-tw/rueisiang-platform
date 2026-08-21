import type { CyberbizInventoryClient, CyberbizInventoryItem } from "@rueisiang/cyberbiz";
import { MAX_PAGE_SIZE, isCompanyProduct } from "@rueisiang/cyberbiz";
import type { CacheClient } from "./upstash.js";

/**
 * CYBERBIZ 公司倉的商品目錄。
 *
 * 「CYBERBIZ 庫存」那一頁要能搜尋、篩選、翻頁，而官網的 API 沒有這些——它只能
 * 一頁一頁給商品。所以把整份目錄拉下來、快取起來，之後的篩選都在記憶體裡做。
 *
 * **快取壞掉時退回直接問官網，不是整頁壞掉。** 快取是加速用的；沒有它該慢慢跑。
 * 這一點在 Upstash 沒設定、或它剛好掛掉時都適用。
 */

const CATALOG_KEY = "cyberbiz:catalog:company";
/** 一天。庫存數量會被 webhook 與盤點即時更新，目錄本身（品名、SKU）沒那麼常變。 */
const TTL_SECONDS = 86_400;

/** 一次同步最多翻幾頁。Worker 有執行時間上限，翻不完就先給已經拿到的。 */
const MAX_PAGES = 30;

export interface Catalog {
  items: CyberbizInventoryItem[];
  /** 這份目錄是什麼時候拉的。畫面上要讓人看得到新鮮度。 */
  fetchedAt: string;
  /** 讀快取還是現拉的。 */
  cached: boolean;
  /** 官網還有沒有沒翻完的頁。 */
  truncated: boolean;
}

/** 從官網翻完整份公司倉目錄。 */
async function fetchCatalog(client: CyberbizInventoryClient): Promise<Omit<Catalog, "cached">> {
  const items: CyberbizInventoryItem[] = [];
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await client.fetchPage({ page, perPage: MAX_PAGE_SIZE });
    // 門市的庫存不歸 WMS 管，濾掉——不濾的話同一個 SKU 會出現好幾筆而且數量互不相同。
    items.push(...batch.filter(isCompanyProduct));

    // 拿到的比一頁少就是最後一頁了。
    if (batch.length < MAX_PAGE_SIZE) return { items, fetchedAt: new Date().toISOString(), truncated: false };
    if (page === MAX_PAGES) truncated = true;
  }

  return { items, fetchedAt: new Date().toISOString(), truncated };
}

/**
 * 拿目錄。有快取就用快取，沒有就現拉並寫回去。
 *
 * `refresh` 為真時跳過快取——「重新整理」按鈕用的。
 */
export async function loadCatalog(
  client: CyberbizInventoryClient,
  cache: CacheClient | undefined,
  refresh = false,
): Promise<Catalog> {
  if (cache && !refresh) {
    try {
      const raw = await cache.get(CATALOG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Omit<Catalog, "cached">;
        if (Array.isArray(parsed.items)) return { ...parsed, cached: true };
      }
    } catch {
      // 快取讀不到或內容壞了都不是致命的——重拉一次就好。
    }
  }

  const fresh = await fetchCatalog(client);

  if (cache) {
    try {
      await cache.set(CATALOG_KEY, JSON.stringify(fresh), TTL_SECONDS);
    } catch {
      /*
       * 寫不進快取不影響這一次的結果——資料已經在手上了。下次再試。
       * 這裡吞掉例外是刻意的：讓一次快取寫入失敗把整頁變成錯誤畫面沒有道理。
       */
    }
  }

  return { ...fresh, cached: false };
}

export interface CatalogQuery {
  search: string;
  /** all／linked／unlinked：有沒有連到 WMS 的品項。 */
  link: string;
  /** all／available／low／zero */
  stock: string;
  page: number;
  pageSize: number;
}

export interface CatalogPage {
  items: (CyberbizInventoryItem & { linkedItemId: string | null })[];
  total: number;
  page: number;
  pageSize: number;
  fetchedAt: string;
  cached: boolean;
  truncated: boolean;
}

/**
 * 篩選、排序、分頁。全部在記憶體裡做——官網的 API 給不了這些。
 *
 * linkedBy 是「款式 id → WMS 品項 id」，讓畫面看得出哪些已經連結。
 */
export function selectPage(
  catalog: Catalog,
  linkedBy: Map<string, string>,
  query: CatalogQuery,
): CatalogPage {
  const term = query.search.trim().toLowerCase();

  const filtered = catalog.items.filter((item) => {
    const linked = linkedBy.has(item.variantId);
    if (query.link === "linked" && !linked) return false;
    if (query.link === "unlinked" && linked) return false;

    if (query.stock === "zero" && item.quantity !== 0) return false;
    if (query.stock === "low" && !(item.quantity > 0 && item.quantity <= item.safetyQuantity)) return false;
    if (query.stock === "available" && item.quantity <= 0) return false;

    if (!term) return true;
    return [item.productName, item.variantName, item.sku].some((value) =>
      value.toLowerCase().includes(term),
    );
  });

  // 沒有 SKU 的排最後：那些多半是還沒建好的商品，不是在找的東西。
  const sorted = [...filtered].sort((a, b) => {
    if (!a.sku || !b.sku) return a.sku ? -1 : b.sku ? 1 : 0;
    return a.sku.localeCompare(b.sku);
  });

  const start = (query.page - 1) * query.pageSize;
  return {
    items: sorted.slice(start, start + query.pageSize).map((item) => ({
      ...item,
      linkedItemId: linkedBy.get(item.variantId) ?? null,
    })),
    total: sorted.length,
    page: query.page,
    pageSize: query.pageSize,
    fetchedAt: catalog.fetchedAt,
    cached: catalog.cached,
    truncated: catalog.truncated,
  };
}
