import { createDatabase } from "@rueisiang/db";
import {
  cyberbizProductLinks,
  inventoryItems,
  zoneImages,
  zones,
} from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalD1 } from "./local-d1/d1.js";

/**
 * WMS 的資料表。
 *
 * 這裡釘的不是「欄位有沒有建出來」——那個 migration 跑得起來就成立了。釘的是
 * 兩條刻意選過、而且選錯會掉資料的 onDelete：倉位被刪掉時，裡面的品項要擋下來
 * （restrict），但倉位的照片要跟著走（cascade）。
 */

let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  // as never：LocalD1 只實作 D1 用得到的那幾支，其他測試也是這樣接。
  db = createDatabase(createLocalD1() as never);
});

const ZONE = {
  id: "z1",
  code: "A-01",
  name: "備品區",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
};

describe("倉位與庫存", () => {
  it("倉位還有東西就刪不掉", async () => {
    await db.insert(zones).values(ZONE);
    await db.insert(inventoryItems).values({ id: "i1", name: "紙箱", zoneId: "z1" });

    // 「這批貨現在在哪」沒有別的地方找得回來，所以要先把品項搬走才准刪倉位。
    await expect(db.delete(zones).where(eq(zones.id, "z1"))).rejects.toThrow();
    expect(await db.select().from(inventoryItems)).toHaveLength(1);
  });

  it("品項搬走之後倉位就刪得掉", async () => {
    await db.insert(zones).values(ZONE);
    await db.insert(inventoryItems).values({ id: "i1", name: "紙箱", zoneId: "z1" });

    await db.update(inventoryItems).set({ zoneId: null }).where(eq(inventoryItems.id, "i1"));
    await db.delete(zones).where(eq(zones.id, "z1"));

    expect(await db.select().from(zones)).toHaveLength(0);
    // 品項留著，只是暫時沒有位置。
    expect(await db.select().from(inventoryItems)).toHaveLength(1);
  });

  it("倉位的照片跟著倉位一起消失", async () => {
    await db.insert(zones).values(ZONE);
    await db.insert(zoneImages).values({
      id: "img1",
      zoneId: "z1",
      objectKey: "zones/z1/a.jpg",
      filename: "a.jpg",
      contentType: "image/jpeg",
      size: 1024,
    });

    await db.delete(zones).where(eq(zones.id, "z1"));
    // 照片拍的就是那個倉位，倉位沒了照片留著只是垃圾。
    expect(await db.select().from(zoneImages)).toHaveLength(0);
  });

  it("預設的層是上／中／下三層", async () => {
    await db.insert(zones).values(ZONE);
    const [row] = await db.select().from(zones);
    expect(JSON.parse(row?.shelfLevels ?? "[]").map((level: { name: string }) => level.name))
      .toEqual(["上層", "中層", "底層"]);
  });
});

describe("CYBERBIZ 商品對應", () => {
  beforeEach(async () => {
    await db.insert(zones).values(ZONE);
    await db.insert(inventoryItems).values([
      { id: "i1", name: "紙箱", zoneId: "z1" },
      { id: "i2", name: "膠帶", zoneId: "z1" },
    ]);
  });

  const LINK = {
    id: "l1",
    inventoryItemId: "i1",
    cyberbizProductId: "p1",
    cyberbizVariantId: "v1",
    sku: "BOX-01",
  };

  it("一個款式只能對到一個品項", async () => {
    await db.insert(cyberbizProductLinks).values(LINK);
    // 兩個品項對同一個款式的話，「官網要扣哪一個」就沒有答案。
    await expect(
      db.insert(cyberbizProductLinks).values({ ...LINK, id: "l2", inventoryItemId: "i2" }),
    ).rejects.toThrow();
  });

  it("一個品項也只能對到一個款式", async () => {
    await db.insert(cyberbizProductLinks).values(LINK);
    await expect(
      db.insert(cyberbizProductLinks).values({ ...LINK, id: "l2", cyberbizVariantId: "v2" }),
    ).rejects.toThrow();
  });

  it("品項被刪掉時對應也跟著刪，不會留下指向空氣的那一筆", async () => {
    await db.insert(cyberbizProductLinks).values(LINK);
    await db.delete(inventoryItems).where(eq(inventoryItems.id, "i1"));
    expect(await db.select().from(cyberbizProductLinks)).toHaveLength(0);
  });
});
