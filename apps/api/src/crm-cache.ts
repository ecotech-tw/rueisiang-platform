import {
  createCacheNamespace,
  forgetCacheNamespace,
  type CachedValue,
  type CacheNamespace,
} from "./cache-namespace.js";
import type { CacheClient } from "./upstash.js";

/*
 * 客戶統計是儀表板數字（總數、啟用、停權、資料不完整、標籤分布），不是交易資料，
 * 但它們跟篩選條件無關卻每次開頁都重算——四個 count 加標籤聚合就是三萬多列。
 *
 * 一分鐘足夠吃掉「翻頁、換排序、打字搜尋」那一段，落差也短到不會讓人困惑。
 * 使用者自己動到客戶的那幾條路徑會主動清掉（見 routes/crm.ts）；webhook 與批次
 * 同步刻意不清，不然同步一跑快取就一直被清空，等於沒有。
 */
export const CRM_STATS_CACHE_TTL_SECONDS = 60;

const CRM_NAMESPACE = {
  prefix: "crm:v1",
  label: "客戶",
  defaultTtlSeconds: CRM_STATS_CACHE_TTL_SECONDS,
} as const;

export type CachedCrm<T> = CachedValue<T>;

export function createCrmCache(cache: CacheClient | undefined): CacheNamespace {
  return createCacheNamespace(cache, CRM_NAMESPACE);
}

/** 使用者自己改了客戶之後，統計要馬上跟上，不能等 TTL。 */
export async function forgetCrmStats(cache: CacheClient | undefined): Promise<void> {
  return forgetCacheNamespace(cache, CRM_NAMESPACE);
}
