import { describe, expect, it } from "vitest";
import { cachedReportAnalytics, forgetReportAnalytics, REPORT_ANALYTICS_CACHE_TTL_SECONDS } from "./report-cache.js";
import type { CacheClient } from "./upstash.js";

function fakeCache() {
  const values = new Map<string, string>();
  const writes: Array<{ key: string; value: string; ttlSeconds: number }> = [];
  const cache: CacheClient = {
    get: async (key) => values.get(key) ?? null,
    mget: async (keys) => keys.map((key) => values.get(key) ?? null),
    set: async (key, value, ttlSeconds) => {
      values.set(key, value);
      writes.push({ key, value, ttlSeconds });
    },
    setMany: async (entries) => {
      for (const entry of entries) {
        values.set(entry.key, entry.value);
        writes.push(entry);
      }
    },
    del: async (key) => {
      values.delete(key);
    },
  };
  return { cache, writes };
}

describe("營運報表快取", () => {
  it("相同查詢會讀快取，不重跑 loader", async () => {
    const { cache, writes } = fakeCache();
    let calls = 0;
    const loader = async () => ({ value: ++calls });

    await expect(cachedReportAnalytics(cache, "summary:sales?period=2026-08", loader)).resolves.toEqual({ value: 1 });
    await expect(cachedReportAnalytics(cache, "summary:sales?period=2026-08", loader)).resolves.toEqual({ value: 1 });

    expect(calls).toBe(1);
    expect(writes.some((entry) => entry.key.includes("summary:sales") && entry.ttlSeconds === REPORT_ANALYTICS_CACHE_TTL_SECONDS)).toBe(true);
  });

  it("匯入成功後刪除版本 key，下一次查詢會重新計算", async () => {
    const { cache } = fakeCache();
    let calls = 0;
    const loader = async () => ++calls;

    await cachedReportAnalytics(cache, "scopes", loader);
    await forgetReportAnalytics(cache);
    await cachedReportAnalytics(cache, "scopes", loader);

    expect(calls).toBe(2);
  });

  it("Redis 讀取失敗會退回資料庫 loader", async () => {
    const broken: CacheClient = {
      get: async () => { throw new Error("Redis 掛了"); },
      mget: async () => [],
      set: async () => {},
      setMany: async () => {},
      del: async () => {},
    };

    await expect(cachedReportAnalytics(broken, "summary:payout", async () => "database")).resolves.toBe("database");
  });
});

