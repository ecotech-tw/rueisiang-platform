import type { CyberbizInventoryClient, CyberbizInventoryItem } from "@rueisiang/cyberbiz";
import { describe, expect, it } from "vitest";
import { forgetCatalog, loadCatalog, selectPage, type Catalog } from "./cyberbiz-catalog.js";
import type { CacheClient } from "./upstash.js";

/**
 * CYBERBIZ 商品目錄的快取與篩選。
 *
 * 最重要的一組斷言是「**快取壞掉時不能讓整頁壞掉**」——快取是加速用的，
 * 沒有它該慢慢跑，不是回一個錯誤畫面。
 */

function item(overrides: Partial<CyberbizInventoryItem> = {}): CyberbizInventoryItem {
  return {
    productId: "p1",
    productName: "紙箱",
    variantId: "v1",
    variantName: "單一款式",
    sku: "BOX-01",
    quantity: 10,
    safetyQuantity: 5,
    inventoryManagement: true,
    published: true,
    posShopId: "",
    posShopName: "",
    updatedAt: null,
    ...overrides,
  };
}

/** 假的官網。回傳指定的商品，並記錄被翻了幾頁。 */
function stubClient(pages: CyberbizInventoryItem[][]): CyberbizInventoryClient & { calls: number } {
  const client = {
    calls: 0,
    async fetchPage({ page = 1 } = {}) {
      client.calls += 1;
      return pages[page - 1] ?? [];
    },
    async fetchProduct() { return []; },
    async resolveBySku() { throw new Error("用不到"); },
    async setCompanyQuantity() { throw new Error("用不到"); },
  };
  return client as unknown as CyberbizInventoryClient & { calls: number };
}

/** 一份什麼都不做的假快取。只覆寫這個測試在意的那一兩個方法。 */
function fakeCache(overrides: Partial<CacheClient> = {}): CacheClient {
  return {
    get: async () => null,
    mget: async () => [],
    set: async () => {},
    setMany: async () => {},
    del: async () => {},
    ...overrides,
  };
}

describe("目錄快取", () => {
  it("沒有快取時直接問官網", async () => {
    const client = stubClient([[item()]]);
    const catalog = await loadCatalog(client, undefined);
    expect(catalog.items).toHaveLength(1);
    expect(catalog.cached).toBe(false);
  });

  it("有快取就用快取，不去打官網", async () => {
    const stored: Omit<Catalog, "cached"> = {
      items: [item({ sku: "CACHED-01" })],
      fetchedAt: "2026-08-20T00:00:00.000Z",
      truncated: false,
    };
    const cache = fakeCache({ get: async () => JSON.stringify(stored) });
    const client = stubClient([[item()]]);

    const catalog = await loadCatalog(client, cache);
    expect(catalog.cached).toBe(true);
    expect(catalog.items[0]?.sku).toBe("CACHED-01");
    expect(client.calls).toBe(0);
  });

  it("refresh 會跳過快取", async () => {
    const cache = fakeCache({ get: async () => JSON.stringify({ items: [item({ sku: "OLD" })], fetchedAt: "x", truncated: false }) });
    const catalog = await loadCatalog(stubClient([[item({ sku: "NEW" })]]), cache, true);
    expect(catalog.items[0]?.sku).toBe("NEW");
    expect(catalog.cached).toBe(false);
  });

  it("快取讀不到時退回問官網，不是整個壞掉", async () => {
    const cache = fakeCache({ get: async () => { throw new Error("Redis 掛了"); } });
    const catalog = await loadCatalog(stubClient([[item()]]), cache);
    expect(catalog.items).toHaveLength(1);
  });

  it("快取內容壞掉時也退回問官網", async () => {
    const cache = fakeCache({ get: async () => "這不是 JSON" });
    const catalog = await loadCatalog(stubClient([[item()]]), cache);
    expect(catalog.items).toHaveLength(1);
  });

  it("寫不進快取不影響這一次的結果", async () => {
    const cache = fakeCache({ get: async () => null, set: async () => { throw new Error("寫入失敗"); } });
    const catalog = await loadCatalog(stubClient([[item()]]), cache);
    expect(catalog.items).toHaveLength(1);
  });

  it("門市的庫存會被濾掉", async () => {
    const client = stubClient([[item(), item({ variantId: "v2", posShopId: "7", posShopName: "信義店" })]]);
    const catalog = await loadCatalog(client, undefined);
    // 不濾的話同一個 SKU 會出現好幾筆，而且數量互不相同。
    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]?.variantId).toBe("v1");
  });

  it("拿到的比一頁少就停，不會多翻一頁", async () => {
    const client = stubClient([[item()]]);
    await loadCatalog(client, undefined);
    expect(client.calls).toBe(1);
  });
});

describe("丟掉快取", () => {
  it("會刪掉目錄那個 key", async () => {
    const deleted: string[] = [];
    await forgetCatalog(fakeCache({ del: async (key) => { deleted.push(key); } }));
    expect(deleted).toEqual(["cyberbiz:catalog:company"]);
  });

  it("沒設定快取時什麼都不做", async () => {
    await expect(forgetCatalog(undefined)).resolves.toBeUndefined();
  });

  it("刪不掉也不往上丟——推已經成功了，畫面舊一點不該變成錯誤", async () => {
    const cache = fakeCache({ del: async () => { throw new Error("Redis 掛了"); } });
    await expect(forgetCatalog(cache)).resolves.toBeUndefined();
  });
});

describe("目錄的篩選與分頁", () => {
  const catalog: Catalog = {
    items: [
      item({ variantId: "v1", sku: "BOX-01", quantity: 10, safetyQuantity: 5 }),
      item({ variantId: "v2", sku: "BOX-02", quantity: 0, safetyQuantity: 5 }),
      item({ variantId: "v3", sku: "TAPE-01", quantity: 3, safetyQuantity: 10, productName: "膠帶" }),
      item({ variantId: "v4", sku: "", quantity: 8, safetyQuantity: 1, productName: "未命名" }),
    ],
    fetchedAt: "2026-08-20T00:00:00.000Z",
    cached: false,
    truncated: false,
  };
  const linked = new Map([["v1", "i1"]]);
  const base = { search: "", link: "all", stock: "all", page: 1, pageSize: 25 };

  it("標出哪些已經連到 WMS", () => {
    const page = selectPage(catalog, linked, base);
    expect(page.items.find((row) => row.variantId === "v1")?.linkedItemId).toBe("i1");
    expect(page.items.find((row) => row.variantId === "v2")?.linkedItemId).toBeNull();
  });

  it("篩「尚未連結」", () => {
    const page = selectPage(catalog, linked, { ...base, link: "unlinked" });
    expect(page.items.map((row) => row.variantId)).not.toContain("v1");
    expect(page.total).toBe(3);
  });

  it("零庫存與低於安全庫存是兩件事", () => {
    expect(selectPage(catalog, linked, { ...base, stock: "zero" }).items.map((row) => row.variantId)).toEqual(["v2"]);
    // 低庫存指的是「還有貨但不夠」，零庫存不算在裡面。
    expect(selectPage(catalog, linked, { ...base, stock: "low" }).items.map((row) => row.variantId)).toEqual(["v3"]);
  });

  it("搜尋比對名稱、款式與 SKU", () => {
    expect(selectPage(catalog, linked, { ...base, search: "膠帶" }).total).toBe(1);
    expect(selectPage(catalog, linked, { ...base, search: "box" }).total).toBe(2);
  });

  it("沒有 SKU 的排最後", () => {
    const page = selectPage(catalog, linked, base);
    expect(page.items[page.items.length - 1]?.variantId).toBe("v4");
  });

  it("分頁只切目前這一頁，total 是篩選後的總數", () => {
    const page = selectPage(catalog, linked, { ...base, pageSize: 25, page: 2 });
    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(4);
  });
});
