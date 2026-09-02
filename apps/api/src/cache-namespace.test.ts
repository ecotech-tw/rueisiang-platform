import { describe, expect, it } from "vitest";
import { createCacheNamespace, forgetCacheNamespace } from "./cache-namespace.js";
import type { CacheClient } from "./upstash.js";

function fakeCache() {
  const values = new Map<string, string>();
  const cache: CacheClient = {
    get: async (key) => values.get(key) ?? null,
    mget: async (keys) => keys.map((key) => values.get(key) ?? null),
    set: async (key, value) => {
      values.set(key, value);
    },
    setMany: async (entries) => {
      for (const entry of entries) values.set(entry.key, entry.value);
    },
    del: async (key) => {
      values.delete(key);
    },
  };
  return { cache, values };
}

const REPORTS = { prefix: "reports:analytics:v1", label: "報表", defaultTtlSeconds: 60 } as const;
const CRM = { prefix: "crm:v1", label: "客戶", defaultTtlSeconds: 60 } as const;

describe("快取命名空間", () => {
  it("兩個命名空間各自失效，不會清掉對方", async () => {
    const { cache } = fakeCache();
    let reportLoads = 0;
    let crmLoads = 0;
    const loadReport = async () => ++reportLoads;
    const loadCrm = async () => ++crmLoads;

    await createCacheNamespace(cache, REPORTS).read("summary", loadReport);
    await createCacheNamespace(cache, CRM).read("customers:stats", loadCrm);
    expect([reportLoads, crmLoads]).toEqual([1, 1]);

    // 只清客戶：報表那邊必須還是命中。
    await forgetCacheNamespace(cache, CRM);
    await createCacheNamespace(cache, REPORTS).read("summary", loadReport);
    await createCacheNamespace(cache, CRM).read("customers:stats", loadCrm);
    expect([reportLoads, crmLoads]).toEqual([1, 2]);
  });

  it("同名的 key 落在不同命名空間，不會互相覆蓋", async () => {
    const { cache } = fakeCache();

    await createCacheNamespace(cache, REPORTS).read("stats", async () => "報表的值");
    const crm = await createCacheNamespace(cache, CRM).read("stats", async () => "客戶的值");

    expect(crm).toEqual({ value: "客戶的值", status: "miss" });
    expect(await createCacheNamespace(cache, REPORTS).read("stats", async () => "不該被呼叫"))
      .toEqual({ value: "報表的值", status: "hit" });
  });
});
