import { applySyncPlan, buildSyncPlan, createDatabase, listCompanyLinks, type LinkedItem, type RemoteItem } from "@rueisiang/db";
import { activityEvents, cyberbizProductLinks, inventoryItems, productCategories } from "@rueisiang/db/schema";
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
  linkId: "l1",
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
    db = createDatabase(createLocalD1() as never);
    await db.insert(productCategories).values({ id: "cat-1", name: "一般備品", color: "rose" });
    await db.insert(inventoryItems).values({
      id: "i1", sku: "BOX-01", name: "紙箱", category: "一般備品", quantity: 10, minStock: 5,
    });
    await db.insert(cyberbizProductLinks).values({
      id: "l1", inventoryItemId: "i1", cyberbizProductId: "p1", cyberbizVariantId: "v1", sku: "BOX-01",
    });
  });

  it("官網的數量會寫進 WMS，並留下一筆紀錄", async () => {
    const result = await applySyncPlan(db, buildSyncPlan([LINK], [REMOTE]), actor);
    expect(result).toEqual({ updated: 1, unchanged: 0, failed: 0 });

    const [item] = await db.select().from(inventoryItems);
    expect(item?.quantity).toBe(42);
    // 安全庫存也跟著官網走——那是同一份設定的兩個地方。
    expect(item?.minStock).toBe(8);

    const [event] = await db.select().from(activityEvents).where(eq(activityEvents.eventType, "cyberbiz_synced"));
    expect(event?.oldValue).toBe("10");
    expect(event?.newValue).toBe("42");
    expect(event?.source).toBe("cyberbiz_sync");
  });

  it("連結失效時：數量一動也不動，連結標成 failed", async () => {
    const result = await applySyncPlan(db, buildSyncPlan([LINK], [{ ...REMOTE, sku: "OTHER-99" }]), actor);
    expect(result).toEqual({ updated: 0, unchanged: 0, failed: 1 });

    const [item] = await db.select().from(inventoryItems);
    // 這是整個檔案最重要的一條斷言。
    expect(item?.quantity).toBe(10);

    const [link] = await db.select().from(cyberbizProductLinks);
    expect(link?.syncStatus).toBe("failed");
    expect(link?.lastError).toContain("SKU");

    const [event] = await db.select().from(activityEvents);
    expect(event?.status).toBe("failed");
  });

  it("沒有變化時不寫商品，只更新同步時間", async () => {
    const same = { ...REMOTE, quantity: 10, safetyQuantity: 5 };
    const result = await applySyncPlan(db, buildSyncPlan([LINK], [same]), actor);
    expect(result).toEqual({ updated: 0, unchanged: 1, failed: 0 });

    // 沒變就不該留紀錄，不然每次同步都灌一整頁「什麼都沒發生」。
    expect(await db.select().from(activityEvents)).toHaveLength(0);
    const [link] = await db.select().from(cyberbizProductLinks);
    expect(link?.lastSyncedQuantity).toBe(10);
    expect(link?.syncStatus).toBe("synced");
  });

  it("讀連結時會帶上 WMS 這邊目前的數量", async () => {
    const [link] = await listCompanyLinks(db);
    expect(link).toMatchObject({ linkId: "l1", cyberbizVariantId: "v1", quantity: 10, minStock: 5 });
  });

  it("一次幾十筆也要全部寫進去（分批送不能漏）", async () => {
    // 分批的邊界是 50 句，而每筆更新會產生 3 句——刻意跨過好幾批。
    const links: LinkedItem[] = [];
    const remotes: RemoteItem[] = [];
    for (let index = 0; index < 40; index += 1) {
      const id = `bulk-${index}`;
      await db.insert(inventoryItems).values({
        id, sku: `SKU-${index}`, name: `商品 ${index}`, category: "一般備品", quantity: 0, minStock: 0,
      });
      await db.insert(cyberbizProductLinks).values({
        id: `link-${index}`, inventoryItemId: id, cyberbizProductId: "p1", cyberbizVariantId: `var-${index}`, sku: `SKU-${index}`,
      });
      links.push({
        linkId: `link-${index}`, inventoryItemId: id, cyberbizProductId: "p1", cyberbizVariantId: `var-${index}`,
        linkedSku: `SKU-${index}`, itemSku: `SKU-${index}`, itemName: `商品 ${index}`, quantity: 0, minStock: 0,
      });
      remotes.push({
        productId: "p1", variantId: `var-${index}`, sku: `SKU-${index}`, quantity: index + 1, safetyQuantity: 0,
      });
    }

    const result = await applySyncPlan(db, buildSyncPlan(links, remotes), actor);
    expect(result.updated).toBe(40);

    const rows = await db.select().from(inventoryItems).where(eq(inventoryItems.category, "一般備品"));
    const bulk = rows.filter((row) => row.id.startsWith("bulk-"));
    expect(bulk).toHaveLength(40);
    expect(bulk.every((row) => row.quantity === Number(row.id.split("-")[1]) + 1)).toBe(true);
  });
});
