import {
  createCacheNamespace,
  forgetCacheNamespace,
  type CachedValue,
  type CacheNamespace,
  type CacheStatus,
} from "./cache-namespace.js";
import type { CacheClient } from "./upstash.js";

/** 報表查詢不是即時帳務；同一組條件快取一天即可。 */
export const REPORT_ANALYTICS_CACHE_TTL_SECONDS = 24 * 60 * 60;

/*
 * 資料管理列表的 key 基數大得多（篩選 × 排序 × 每一頁），而失效只是刪版本 key，
 * 舊 entry 會留到自己的 TTL 到期。用同樣的一天會讓每次匯入都疊一代垃圾，
 * 而 Upstash 免費只有 256MB。十五分鐘足夠吃掉「翻頁、換排序、來回看」那一段。
 */
export const REPORT_RECORD_CACHE_TTL_SECONDS = 15 * 60;

const REPORT_ANALYTICS_NAMESPACE = {
  prefix: "reports:analytics:v1",
  label: "報表",
  defaultTtlSeconds: REPORT_ANALYTICS_CACHE_TTL_SECONDS,
} as const;

export type ReportAnalyticsCacheStatus = CacheStatus;
export type CachedReportAnalytics<T> = CachedValue<T>;
export type ReportAnalyticsCache = CacheNamespace;

/** 一次請求用一個；版本 key 只讀一次。 */
export function createReportAnalyticsCache(cache: CacheClient | undefined): ReportAnalyticsCache {
  return createCacheNamespace(cache, REPORT_ANALYTICS_NAMESPACE);
}

/** 只讀一組 key 的捷徑。 */
export async function cachedReportAnalytics<T>(
  cache: CacheClient | undefined,
  key: string,
  loader: () => Promise<T>,
): Promise<CachedReportAnalytics<T>> {
  return createReportAnalyticsCache(cache).read(key, loader);
}

/** 匯入或人工修訂之後讓所有舊查詢結果立刻失效。 */
export async function forgetReportAnalytics(cache: CacheClient | undefined): Promise<void> {
  return forgetCacheNamespace(cache, REPORT_ANALYTICS_NAMESPACE);
}
