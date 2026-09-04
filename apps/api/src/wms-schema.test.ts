import { createDatabase, createZone } from "@rueisiang/db";
import {
  items,
  mediaObjects,
  wmsCyberbizLinks,
  wmsItems,
  wmsShelves,
  wmsZoneImages,
  wmsZones,
} from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalD1 } from "./local-d1/d1.js";

/**
 * WMS target schema 的關聯約束。
 * 倉位被刪除前必須先搬走貨與層架；倉位照片則應跟著倉位與 media metadata 一起清理。
 */

let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  db = createDatabase(createLocalD1() as never);
});

const ZONE = {
  id: "z1",
  code: "A-01",
  name: "備品區",
  color: "mint",
  notes: "",
  active: 1,
};

async function seedZoneWithShelf() {
  await db.insert(wmsZones).values(ZONE);
  await db.insert(wmsShelves).values({ id: "shelf-1", zoneId: "z1", code: "middle", name: "中層", sortOrder: 1, active: 1 });
}

async function seedItem(id = "i1") {
  await db.insert(items).values({ id, source: "custom", kind: "supply", sku: id.toUpperCase(), name: "紙箱", active: 1 });
  await db.insert(wmsItems).values({ itemId: id, shelfId: "shelf-1", quantity: 1, unit: "件", minStock: 5, notes: "" });
}

describe("倉位與庫存", () => {
  it("倉位還有東西就刪不掉", async () => {
    await seedZoneWithShelf();
    await seedItem();

    await expect(db.delete(wmsZones).where(eq(wmsZones.id, "z1"))).rejects.toThrow();
    expect(await db.select().from(wmsItems)).toHaveLength(1);
  });

  it("品項搬走並移除層架之後倉位就刪得掉", async () => {
    await seedZoneWithShelf();
    await seedItem();

    await db.update(wmsItems).set({ shelfId: null }).where(eq(wmsItems.itemId, "i1"));
    await db.delete(wmsShelves).where(eq(wmsShelves.id, "shelf-1"));
    await db.delete(wmsZones).where(eq(wmsZones.id, "z1"));

    expect(await db.select().from(wmsZones)).toHaveLength(0);
    expect(await db.select().from(wmsItems)).toHaveLength(1);
  });

  it("倉位的照片跟著倉位一起消失", async () => {
    await db.insert(wmsZones).values(ZONE);
    await db.insert(mediaObjects).values({
      objectKey: "zones/z1/a.jpg",
      namespace: "wms",
      scopeKey: "z1",
      filename: "a.jpg",
      contentType: "image/jpeg",
      size: 1024,
      checksum: "test",
    });
    await db.insert(wmsZoneImages).values({ zoneId: "z1", objectKey: "zones/z1/a.jpg", sortOrder: 0 });

    await db.delete(wmsZones).where(eq(wmsZones.id, "z1"));
    expect(await db.select().from(wmsZoneImages)).toHaveLength(0);
    // media metadata 是可獨立清理的物件索引，刪除關聯不會反向刪除它。
    expect(await db.select().from(mediaObjects)).toHaveLength(1);
  });

  it("新增倉位會建立上／中／下三層", async () => {
    const { id } = await createZone(db, { ...ZONE, actor: { id: "u1", email: "u1@example.com" } });
    const shelves = await db.select().from(wmsShelves).where(eq(wmsShelves.zoneId, id));
    expect(shelves.map((shelf) => shelf.name)).toEqual(["上層", "中層", "底層"]);
  });
});

describe("CYBERBIZ 商品對應", () => {
  beforeEach(async () => {
    await seedZoneWithShelf();
    await seedItem();
    await seedItem("i2");
  });

  const LINK = {
    id: "l1",
    wmsItemId: "i1",
    cyberbizProductId: "p1",
    cyberbizVariantId: "v1",
    sku: "BOX-01",
    warehouseScope: "company",
    posShopId: 0,
    syncStatus: "synced",
    lastError: "",
  };

  it("一個款式只能對到一個品項", async () => {
    await db.insert(wmsCyberbizLinks).values(LINK);
    await expect(
      db.insert(wmsCyberbizLinks).values({ ...LINK, id: "l2", wmsItemId: "i2" }),
    ).rejects.toThrow();
  });

  it("一個品項也只能對到一個款式", async () => {
    await db.insert(wmsCyberbizLinks).values(LINK);
    await expect(
      db.insert(wmsCyberbizLinks).values({ ...LINK, id: "l2", cyberbizVariantId: "v2" }),
    ).rejects.toThrow();
  });

  it("品項被刪掉時對應也跟著刪，不會留下指向空氣的那一筆", async () => {
    await db.insert(wmsCyberbizLinks).values(LINK);
    await db.delete(items).where(eq(items.id, "i1"));
    expect(await db.select().from(wmsCyberbizLinks)).toHaveLength(0);
  });
});
