import type { CacheClient } from "./upstash.js";

/** 報表查詢不是即時帳務；同一組條件快取一天即可。 */
export const REPORT_ANALYTICS_CACHE_TTL_SECONDS = 24 * 60 * 60;

/*
 * 資料管理列表的 key 基數大得多（篩選 × 排序 × 每一頁），而失效只是刪版本 key，
 * 舊 entry 會留到自己的 TTL 到期。用同樣的一天會讓每次匯入都疊一代垃圾，
 * 而 Upstash 免費只有 256MB。十五分鐘足夠吃掉「翻頁、換排序、來回看」那一段。
 */
export const REPORT_RECORD_CACHE_TTL_SECONDS = 15 * 60;

const REPORT_ANALYTICS_CACHE_PREFIX = "reports:analytics:v1";
const REPORT_ANALYTICS_VERSION_KEY = `${REPORT_ANALYTICS_CACHE_PREFIX}:version`;

/**
 * 這一次查詢跟快取的關係。
 *
 * `bypass` 是沒有設定 Redis，`error` 是有設定但讀寫失敗——**兩者一定要分得開**。
 * 原本兩種情況都只是安靜地回去查 D1，結果是「secret 設了但快取其實一直在噴錯」
 * 跟「快取正常運作」從外面看完全一樣，查 D1 用量暴增時無從判斷。
 */
export type ReportAnalyticsCacheStatus = "hit" | "miss" | "bypass" | "error";

export interface CachedReportAnalytics<T> {
  value: T;
  status: ReportAnalyticsCacheStatus;
}

/**
 * 把查詢結果放進 Redis。Redis 沒設定、讀寫失敗或內容損壞時都退回 loader，
 * 快取永遠不應該把報表本身變成故障點——但失敗要留下記錄。
 */
export interface ReportAnalyticsCache {
  read<T>(key: string, loader: () => Promise<T>, ttlSeconds?: number): Promise<CachedReportAnalytics<T>>;
}

/**
 * 一次請求用一個。同一個請求裡讀好幾組 key 時（例如列表加總筆數）版本 key 只讀一次，
 * 不必每組各跑一趟 Redis。寫回前的版本確認仍然每次重讀，那一次是刻意的。
 */
export function createReportAnalyticsCache(cache: CacheClient | undefined): ReportAnalyticsCache {
  let sharedVersion: Promise<string> | undefined;

  async function currentVersion(): Promise<string> {
    if (!cache) return "";
    const existing = await cache.get(REPORT_ANALYTICS_VERSION_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    await cache.set(REPORT_ANALYTICS_VERSION_KEY, created, REPORT_ANALYTICS_CACHE_TTL_SECONDS);
    return created;
  }

  return {
    async read<T>(
      key: string,
      loader: () => Promise<T>,
      ttlSeconds = REPORT_ANALYTICS_CACHE_TTL_SECONDS,
    ): Promise<CachedReportAnalytics<T>> {
      if (!cache) return { value: await loader(), status: "bypass" };

      let version: string;
      try {
        version = await (sharedVersion ??= currentVersion());
      } catch (error) {
        // 版本讀失敗會被記在共用的 promise 裡，重設才不會讓同一次請求的其他 key 全部跟著壞。
        sharedVersion = undefined;
        console.warn("報表快取版本讀取失敗，改查資料庫", { key, error: String(error) });
        return { value: await loader(), status: "error" };
      }

      try {
        const cached = await cache.get(`${REPORT_ANALYTICS_CACHE_PREFIX}:${version}:${key}`);
        if (cached !== null) return { value: JSON.parse(cached) as T, status: "hit" };
      } catch (error) {
        /*
         * 單一 entry 讀不到或內容壞掉不代表版本有問題，所以不動 sharedVersion——
         * 丟掉一個有效的版本會讓同一次請求的其他 key 重跑一趟版本讀取，正是這裡
         * 要省的那一趟；剛好碰上版本到期的話還會鑄一個新版本，把 sibling 剛寫進去
         * 的 entry 變成孤兒。
         */
        console.warn("報表快取讀取失敗，改查資料庫", { key, error: String(error) });
        return { value: await loader(), status: "error" };
      }

      const value = await loader();
      try {
        // Loader 執行期間可能剛好有匯入失效快取；只有 miss 時捕捉到的版本仍然有效，
        // 才能把結果寫回去，避免舊資料被寫進新的版本 namespace。
        if (await cache.get(REPORT_ANALYTICS_VERSION_KEY) === version) {
          await cache.set(`${REPORT_ANALYTICS_CACHE_PREFIX}:${version}:${key}`, JSON.stringify(value), ttlSeconds);
        }
      } catch (error) {
        // 寫入失敗不影響這次已經從資料庫算出的結果，但要看得到——寫不進去的話
        // 每一次請求都會是 miss，而 miss 的成本是二十幾個 D1 查詢。
        console.warn("報表快取寫入失敗", { key, error: String(error) });
      }
      return { value, status: "miss" };
    },
  };
}

/** 只讀一組 key 的捷徑。 */
export async function cachedReportAnalytics<T>(
  cache: CacheClient | undefined,
  key: string,
  loader: () => Promise<T>,
): Promise<CachedReportAnalytics<T>> {
  return createReportAnalyticsCache(cache).read(key, loader);
}

/** 以刪除版本 key 的方式讓所有舊查詢結果立刻失效，不需要掃描 Redis key。 */
export async function forgetReportAnalytics(cache: CacheClient | undefined): Promise<void> {
  if (!cache) return;
  try {
    await cache.del(REPORT_ANALYTICS_VERSION_KEY);
  } catch (error) {
    // 匯入已成功；快取晚一天自然過期即可，不把錯誤往上丟。
    console.warn("報表快取失效失敗，最多等 TTL 到期", { error: String(error) });
  }
}
