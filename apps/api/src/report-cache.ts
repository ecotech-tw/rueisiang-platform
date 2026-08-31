import type { CacheClient } from "./upstash.js";

/** 報表查詢不是即時帳務；同一組條件快取一天即可。 */
export const REPORT_ANALYTICS_CACHE_TTL_SECONDS = 24 * 60 * 60;

const REPORT_ANALYTICS_CACHE_PREFIX = "reports:analytics:v1";
const REPORT_ANALYTICS_VERSION_KEY = `${REPORT_ANALYTICS_CACHE_PREFIX}:version`;

/**
 * 把查詢結果放進 Redis。Redis 沒設定、讀寫失敗或內容損壞時都退回 loader，
 * 快取永遠不應該把報表本身變成故障點。
 */
export async function cachedReportAnalytics<T>(
  cache: CacheClient | undefined,
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  if (!cache) return loader();

  let version = "";
  try {
    const currentVersion = await cache.get(REPORT_ANALYTICS_VERSION_KEY);
    version = currentVersion ?? crypto.randomUUID();
    if (!currentVersion) {
      await cache.set(REPORT_ANALYTICS_VERSION_KEY, version, REPORT_ANALYTICS_CACHE_TTL_SECONDS);
    }
    const cached = await cache.get(`${REPORT_ANALYTICS_CACHE_PREFIX}:${version}:${key}`);
    if (cached !== null) return JSON.parse(cached) as T;
  } catch {
    return loader();
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
  } catch {
    // 寫入失敗不影響這次已經從資料庫算出的結果。
  }
  return value;
}
/** 以刪除版本 key 的方式讓所有舊查詢結果立刻失效，不需要掃描 Redis key。 */
export async function forgetReportAnalytics(cache: CacheClient | undefined): Promise<void> {
  if (!cache) return;
  try {
    await cache.del(REPORT_ANALYTICS_VERSION_KEY);
  } catch {
    // 匯入已成功；快取晚一天自然過期即可，不把錯誤往上丟。
  }
}

