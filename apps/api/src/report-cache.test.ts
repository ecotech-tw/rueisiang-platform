import { describe, expect, it } from "vitest";
import {
  cachedReportAnalytics,
  createReportAnalyticsCache,
  forgetReportAnalytics,
  REPORT_ANALYTICS_CACHE_TTL_SECONDS,
} from "./report-cache.js";
import type { CacheClient } from "./upstash.js";

function fakeCache() {
  const values = new Map<string, string>();
  const writes: Array<{ key: string; value: string; ttlSeconds: number }> = [];
  const reads: string[] = [];
  const cache: CacheClient = {
    get: async (key) => {
      reads.push(key);
      return values.get(key) ?? null;
    },
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
  return { cache, writes, reads };
}

describe("營運報表快取", () => {
  it("相同查詢會讀快取，不重跑 loader", async () => {
    const { cache, writes } = fakeCache();
    let calls = 0;
    const loader = async () => ({ value: ++calls });

    await expect(cachedReportAnalytics(cache, "summary:sales?period=2026-08", loader))
      .resolves.toEqual({ value: { value: 1 }, status: "miss" });
    await expect(cachedReportAnalytics(cache, "summary:sales?period=2026-08", loader))
      .resolves.toEqual({ value: { value: 1 }, status: "hit" });

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

  it("沒有設定 Redis 時回報 bypass，與 Redis 噴錯的 error 分得開", async () => {
    await expect(cachedReportAnalytics(undefined, "scopes", async () => "database"))
      .resolves.toEqual({ value: "database", status: "bypass" });
  });

  it("Redis 讀取失敗會退回資料庫 loader", async () => {
    const broken: CacheClient = {
      get: async () => { throw new Error("Redis 掛了"); },
      mget: async () => [],
      set: async () => {},
      setMany: async () => {},
      del: async () => {},
    };

    await expect(cachedReportAnalytics(broken, "summary:payout", async () => "database"))
      .resolves.toEqual({ value: "database", status: "error" });
  });

  it("同一次請求讀多組 key 時，版本 key 只讀一次", async () => {
    const { cache, reads } = fakeCache();
    const session = createReportAnalyticsCache(cache);

    await Promise.all([
      session.read("manual:payout", async () => ({ rows: [] })),
      session.read("manual:payout:count", async () => 2),
    ]);

    // 進場只讀一次版本；寫回前的確認是刻意每組各讀一次，所以總共三次。
    const versionReads = reads.filter((key) => key.endsWith(":version"));
    expect(versionReads).toHaveLength(3);
  });

  it("可以指定較短的 TTL，資料管理列表才不會用一天的 key 塞滿 Redis", async () => {
    const { cache, writes } = fakeCache();

    await createReportAnalyticsCache(cache).read("manual:sales", async () => ({ rows: [] }), 900);

    const written = writes.find((entry) => entry.key.includes("manual:sales"));
    expect(written?.ttlSeconds).toBe(900);
    // 版本 key 本身仍然用預設的長 TTL。
    expect(writes.find((entry) => entry.key.endsWith(":version"))?.ttlSeconds)
      .toBe(REPORT_ANALYTICS_CACHE_TTL_SECONDS);
  });

  it("查詢載入期間快取失效時，不會把舊結果寫進新版本", async () => {
    const { cache, writes } = fakeCache();
    let markLoaderStarted!: () => void;
    const loaderStarted = new Promise<void>((resolve) => { markLoaderStarted = resolve; });
    let finishLoader!: (value: string) => void;

    const pending = cachedReportAnalytics(cache, "summary:sales?period=old", async () => {
      markLoaderStarted();
      return new Promise<string>((resolve) => { finishLoader = resolve; });
    });

    await loaderStarted;
    await forgetReportAnalytics(cache);
    await cachedReportAnalytics(cache, "summary:sales?period=new", async () => "fresh");
    finishLoader("stale");

    await expect(pending).resolves.toEqual({ value: "stale", status: "miss" });
    expect(writes.some((entry) => entry.key.includes("summary:sales?period=old"))).toBe(false);
  });
});
