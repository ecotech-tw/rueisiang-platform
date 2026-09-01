import type { CacheClient } from "./upstash.js";

/** 報表查詢不是即時帳務；同一組條件快取一天即可。 */
export const REPORT_ANALYTICS_CACHE_TTL_SECONDS = 24 * 60 * 60;

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
export async function cachedReportAnalytics<T>(
  cache: CacheClient | undefined,
  key: string,
  loader: () => Promise<T>,
): Promise<CachedReportAnalytics<T>> {
  if (!cache) return { value: await loader(), status: "bypass" };

  let version = "";
  try {
    const currentVersion = await cache.get(REPORT_ANALYTICS_VERSION_KEY);
    version = currentVersion ?? crypto.randomUUID();
    if (!currentVersion) {
      await cache.set(REPORT_ANALYTICS_VERSION_KEY, version, REPORT_ANALYTICS_CACHE_TTL_SECONDS);
    }
    const cached = await cache.get(`${REPORT_ANALYTICS_CACHE_PREFIX}:${version}:${key}`);
    if (cached !== null) return { value: JSON.parse(cached) as T, status: "hit" };
  } catch (error) {
    console.warn("報表快取讀取失敗，改查資料庫", { key, error: String(error) });
    return { value: await loader(), status: "error" };
  }

  const value = await loader();
  try {
    // Loader 執行期間可能剛好有匯入失效快取；只有 miss 時捕捉到的版本仍然有效，
    // 才能把結果寫回去，避免舊資料被寫進新的版本 namespace。
    const currentVersion = await cache.get(REPORT_ANALYTICS_VERSION_KEY);
    if (currentVersion === version) {
      await cache.set(
        `${REPORT_ANALYTICS_CACHE_PREFIX}:${version}:${key}`,
        JSON.stringify(value),
        REPORT_ANALYTICS_CACHE_TTL_SECONDS,
      );
    }
  } catch (error) {
    // 寫入失敗不影響這次已經從資料庫算出的結果，但要看得到——寫不進去的話
    // 每一次請求都會是 miss，而 miss 的成本是二十幾個 D1 查詢。
    console.warn("報表快取寫入失敗", { key, error: String(error) });
  }
  return { value, status: "miss" };
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
