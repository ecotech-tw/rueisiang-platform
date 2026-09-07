import { applySyncPlan, buildSyncPlan, claimCyberbizSyncLock, createDatabase, listCompanyLinks, loadWarehouse, releaseCyberbizSyncLock, type LinkedItem, type RemoteItem } from "@rueisiang/db";
import { activityEvents, cyberbizProductCatalog, cyberbizSyncLocks, items, wmsCategories, wmsItems } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalD1 } from "./local-d1/d1.js";

/**
 * WMS 與 CYBERBIZ 的庫存對帳。
 *
 * 這裡釘的幾乎全是「**不該**發生什麼」：連結失效時不准寫數量。寫錯的後果沒有人
 * 看得出來——倉庫的人會照著一個錯的數字去撿貨，而系統顯示一切正常。
 */

const LINK: LinkedItem = {
  inventoryItemId: "i1",
  cyberbizProductId: "p1",
  cyberbizVariantId: "v1",
  linkedSku: "BOX-01",
  itemSku: "BOX-01",
  itemName: "紙箱",
  quantity: 10,
  minStock: 5,
};

const REMOTE: RemoteItem = {
  productId: "p1",
  variantId: "v1",
  sku: "BOX-01",
  quantity: 42,
  safetyQuantity: 8,
};

describe("同步計畫", () => {
  it("一切吻合時會標出數量與安全庫存的變化", () => {
    const [entry] = buildSyncPlan([LINK], [REMOTE]);
    expect(entry?.status).toBe("synced");
    expect(entry?.quantityChanged).toBe(true);
    expect(entry?.minStockChanged).toBe(true);
  });

  it("數量一樣就不算變更", () => {
    const [entry] = buildSyncPlan([LINK], [{ ...REMOTE, quantity: 10, safetyQuantity: 5 }]);
    expect(entry?.status).toBe("synced");
    expect(entry?.quantityChanged).toBe(false);
    expect(entry?.minStockChanged).toBe(false);
  });

  it("官網找不到那個款式：標記失敗，而且不算有變更", () => {
    const [entry] = buildSyncPlan([LINK], []);
    expect(entry?.status).toBe("failed");
    expect(entry?.error).toContain("找不到");
    // 這一條是重點：失敗的不能被當成「有新數量可以寫」。
    expect(entry?.quantityChanged).toBe(false);
  });

  it("product_id 對不上：連結失效，不寫數量", () => {
    const [entry] = buildSyncPlan([LINK], [{ ...REMOTE, productId: "p999" }]);
    expect(entry?.status).toBe("failed");
    expect(entry?.error).toContain("product_id");
    expect(entry?.quantityChanged).toBe(false);
  });

  it("SKU 對不上：連結失效，不寫數量", () => {
    const [entry] = buildSyncPlan([LINK], [{ ...REMOTE, sku: "OTHER-99" }]);
    expect(entry?.status).toBe("failed");
    expect(entry?.error).toContain("SKU");
    expect(entry?.quantityChanged).toBe(false);
  });

  it("SKU 只差大小寫與空白不算不一致", () => {
    const [entry] = buildSyncPlan([LINK], [{ ...REMOTE, sku: "  box-01 " }]);
    expect(entry?.status).toBe("synced");
  });
});

describe("套用同步", () => {
  let db: ReturnType<typeof createDatabase>;
  const actor = { id: "u1", email: "admin@ecotech.tw" };

  beforeEach(async () => {
    db = createDatabase(createLocalD1(":memory:", { targetOnly: true }) as never);
    await db.insert(items).values({ id: "i1", source: "custom", kind: "sellable", sku: "BOX-01", name: "紙箱", active: 1 });
    await db.insert(wmsCategories).values({ id: "cat-1", name: "一般備品", color: "rose", active: 1 });
    await db.insert(wmsItems).values({ itemId: "i1", wmsCategoryId: "cat-1", quantity: 10, minStock: 5 });
    await db.insert(cyberbizProductCatalog).values({
      itemId: "i1", cyberbizProductId: "p1", cyberbizVariantId: "v1",
    });
  });

  it("官網的數量會寫進 WMS，並留下一筆紀錄", async () => {
    const result = await applySyncPlan(db, buildSyncPlan([LINK], [REMOTE]), actor);
    expect(result).toEqual({ updated: 1, unchanged: 0, failed: 0 });

    const [item] = await db.select().from(wmsItems);
    expect(item?.quantity).toBe(42);
    // 安全庫存也跟著官網走——那是同一份設定的兩個地方。
    expect(item?.minStock).toBe(8);

    const [event] = await db.select().from(activityEvents).where(eq(activityEvents.eventType, "cyberbiz_synced"));
    expect(event?.oldValue).toBe("10");
    expect(event?.newValue).toBe("42");
    expect(event?.source).toBe("cyberbiz_sync");
  });

  it("外部身分失效時：數量一動也不動，留下失敗紀錄", async () => {
    const result = await applySyncPlan(db, buildSyncPlan([LINK], [{ ...REMOTE, sku: "OTHER-99" }]), actor);
    expect(result).toEqual({ updated: 0, unchanged: 0, failed: 1 });

    const [item] = await db.select().from(wmsItems);
    // 這是整個檔案最重要的一條斷言。
    expect(item?.quantity).toBe(10);

    const [event] = await db.select().from(activityEvents).where(eq(activityEvents.eventType, "cyberbiz_sync_failed"));
    expect(event?.status).toBe("failed");
    expect(event?.error).toContain("SKU");
    expect((await db.select().from(cyberbizProductCatalog))[0]?.syncStatus).toBe("failed");

  });

  it("沒有變化時不寫商品，但會留下最後同步時間", async () => {
    const same = { ...REMOTE, quantity: 10, safetyQuantity: 5 };
    const result = await applySyncPlan(db, buildSyncPlan([LINK], [same]), actor);
    expect(result).toEqual({ updated: 0, unchanged: 1, failed: 0 });

    const [event] = await db.select().from(activityEvents);
    expect(event).toMatchObject({ eventType: "cyberbiz_synced", field: "sync", source: "cyberbiz_sync" });
    expect((await db.select().from(cyberbizProductCatalog))[0]?.syncStatus).toBe("synced");
  });

  it("外部差額推送同一時間只允許一個工作取得 lease", async () => {
    const first = await claimCyberbizSyncLock(db, "i1");
    expect(first).toEqual(expect.any(String));
    expect(await claimCyberbizSyncLock(db, "i1")).toBeNull();

    await releaseCyberbizSyncLock(db, "i1", first!);
    const second = await claimCyberbizSyncLock(db, "i1");
    expect(second).toEqual(expect.any(String));
    expect(await db.select().from(cyberbizSyncLocks)).toHaveLength(1);
  });

  it("讀連結時會帶上 WMS 這邊目前的數量", async () => {
    const [link] = await listCompanyLinks(db);
    expect(link).toMatchObject({ inventoryItemId: "i1", cyberbizVariantId: "v1", quantity: 10, minStock: 5 });
  });

  it("一次幾十筆也要全部寫進去（分批送不能漏）", async () => {
    // 分批的邊界是 50 句，而每筆更新會產生 3 句——刻意跨過好幾批。
    const links: LinkedItem[] = [];
    const remotes: RemoteItem[] = [];
    for (let index = 0; index < 40; index += 1) {
      const id = `bulk-${index}`;
      await db.insert(items).values({ id, source: "custom", kind: "sellable", sku: `SKU-${index}`, name: `商品 ${index}`, active: 1 });
      await db.insert(wmsItems).values({ itemId: id, wmsCategoryId: "cat-1", quantity: 0, minStock: 0 });
      await db.insert(cyberbizProductCatalog).values({
        itemId: id, cyberbizProductId: "p1", cyberbizVariantId: `var-${index}`,
      });
      links.push({
        inventoryItemId: id, cyberbizProductId: "p1", cyberbizVariantId: `var-${index}`,
        linkedSku: `SKU-${index}`, itemSku: `SKU-${index}`, itemName: `商品 ${index}`, quantity: 0, minStock: 0,
      });
      remotes.push({
        productId: "p1", variantId: `var-${index}`, sku: `SKU-${index}`, quantity: index + 1, safetyQuantity: 0,
      });
    }

    const result = await applySyncPlan(db, buildSyncPlan(links, remotes), actor);
    expect(result.updated).toBe(40);

    const rows = await db.select().from(wmsItems).where(eq(wmsItems.wmsCategoryId, "cat-1"));
    const bulk = rows.filter((row) => row.itemId.startsWith("bulk-"));
    expect(bulk).toHaveLength(40);
    expect(bulk.every((row) => row.quantity === Number(row.itemId.split("-")[1]) + 1)).toBe(true);
  });
});

describe("target WMS CYBERBIZ 連結", () => {
  const actor = { id: "u1", email: "admin@ecotech.tw" };

  it("legacy link 表移除後仍可讀取與套用同步結果", async () => {
    const targetD1 = createLocalD1(":memory:", { targetOnly: true });
    const targetDb = createDatabase(targetD1 as never);
    await targetDb.insert(items).values({ id: "target-linked-item", source: "custom", kind: "sellable", sku: "TARGET-LINK-001", name: "Target 連結商品", active: 1 });
    await targetDb.insert(wmsItems).values({ itemId: "target-linked-item", quantity: 7, minStock: 2, unit: "件", notes: "" });
    await targetDb.insert(cyberbizProductCatalog).values({ itemId: "target-linked-item", cyberbizProductId: "target-product", cyberbizVariantId: "target-variant" });


    const link = (await listCompanyLinks(targetDb))[0];
    expect(link).toMatchObject({ inventoryItemId: "target-linked-item", cyberbizVariantId: "target-variant", itemSku: "TARGET-LINK-001", quantity: 7, minStock: 2 });
    expect((await loadWarehouse(targetDb)).items[0]?.cyberbiz).toMatchObject({
      cyberbizProductId: "target-product",
      cyberbizVariantId: "target-variant",
      sku: "TARGET-LINK-001",
    });
    const result = await applySyncPlan(targetDb, buildSyncPlan([link!], [{ productId: "target-product", variantId: "target-variant", sku: "TARGET-LINK-001", quantity: 11, safetyQuantity: 4 }]), actor);
    expect(result).toEqual({ updated: 1, unchanged: 0, failed: 0 });
    expect((await targetDb.select().from(wmsItems))[0]).toMatchObject({ itemId: "target-linked-item", quantity: 11, minStock: 4 });
    expect(await targetDb.select().from(activityEvents).where(eq(activityEvents.eventType, "cyberbiz_synced"))).toHaveLength(1);
  });
});
