import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import {
  activityEvents,
  inventoryItems,
  productCategories,
  users,
  userRoles,
  zones,
} from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createLocalD1 } from "./local-d1/d1.js";

/**
 * 倉儲的 API。
 *
 * 重點放在三種「安靜出錯」的情況：權限沒掛好、界線被繞過（盤點的人改到別的
 * 欄位）、以及參照被打斷（層架、分類都不是外鍵）。單純的 CRUD 成功路徑只各
 * 測一次，那些壞掉的話任何人打開畫面都會立刻看到。
 */

const SECRET = "test-secret-test-secret-test-secret";
let d1: ReturnType<typeof createLocalD1>;
let db: ReturnType<typeof createDatabase>;

const env = () => ({
  DB: d1,
  AUTH_SESSION_SECRET: SECRET,
  GOOGLE_OAUTH_CLIENT_ID: "x",
  GOOGLE_OAUTH_CLIENT_SECRET: "x",
});

beforeEach(async () => {
  d1 = createLocalD1();
  db = createDatabase(d1 as never);
  await syncSystemRoles(db);
});

async function seedUser(email: string, roleId: string | null) {
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, email, displayName: email, status: "active" });
  // 不給 scope：預設就是 GLOBAL_SCOPE，這些測試不碰範圍限定的角色。
  if (roleId) await db.insert(userRoles).values({ userId: id, roleId });
  return id;
}

async function as(userId: string, email: string, path: string, init: RequestInit = {}) {
  const token = await signSession(
    newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }),
    SECRET,
  );
  return app.fetch(
    new Request(`https://test.local${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        ...(init.headers ?? {}),
      },
    }),
    env() as never,
  );
}

/** 大部分測試都要一個管理者跟一個能用的分類。 */
async function seedAdmin() {
  const id = await seedUser("admin@ecotech.tw", "role-admin");
  await db.insert(productCategories).values({ id: "cat-1", name: "一般備品", color: "rose" });
  return id;
}

describe("倉位", () => {
  it("新增倉位，代碼一律轉成大寫", async () => {
    const id = await seedAdmin();
    const response = await as(id, "admin@ecotech.tw", "/api/wms/zones", {
      method: "POST",
      body: JSON.stringify({ code: "a-01", name: "備品區" }),
    });

    expect(response.status).toBe(201);
    const [zone] = await db.select().from(zones);
    // 小寫存進去的話 unique 擋不住「a-01」與「A-01」這兩筆。
    expect(zone?.code).toBe("A-01");
    expect(JSON.parse(zone?.shelfLevels ?? "[]")).toHaveLength(3);
  });

  it("座標會被夾在合法範圍裡，超出去不會報錯", async () => {
    const id = await seedAdmin();
    await as(id, "admin@ecotech.tw", "/api/wms/zones", {
      method: "POST",
      body: JSON.stringify({ code: "A-01", name: "備品區", x: 999, y: -50, width: 1, height: 999 }),
    });

    const [zone] = await db.select().from(zones);
    // 單位是百分比，所以上限接近 100 而不是畫布的像素數。
    expect(zone?.x).toBe(92);
    expect(zone?.y).toBe(0);
    expect(zone?.width).toBe(8);
    expect(zone?.height).toBe(38);
  });

  it("拖曳只送 x/y，其他欄位不會被清掉", async () => {
    const id = await seedAdmin();
    await as(id, "admin@ecotech.tw", "/api/wms/zones", {
      method: "POST",
      body: JSON.stringify({ code: "A-01", name: "備品區", notes: "靠門口" }),
    });
    const [before] = await db.select().from(zones);

    await as(id, "admin@ecotech.tw", `/api/wms/zones/${before?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ x: 50, y: 60 }),
    });

    const [after] = await db.select().from(zones);
    expect(after?.x).toBe(50);
    expect(after?.name).toBe("備品區");
    expect(after?.notes).toBe("靠門口");
  });

  it("移動會記成 zone_moved，不是跟改資料混在一起", async () => {
    const id = await seedAdmin();
    await as(id, "admin@ecotech.tw", "/api/wms/zones", {
      method: "POST",
      body: JSON.stringify({ code: "A-01", name: "備品區" }),
    });
    const [zone] = await db.select().from(zones);

    await as(id, "admin@ecotech.tw", `/api/wms/zones/${zone?.id}`, {
      method: "PATCH",
      body: JSON.stringify({ x: 10 }),
    });

    const events = await db.select().from(activityEvents).where(eq(activityEvents.entityType, "zone"));
    // 一天可能拖幾十次，混在「修改倉位資料」裡的話那些紀錄就查不動了。
    expect(events.map((event) => event.eventType)).toEqual(["zone_created", "zone_moved"]);
    expect(events.every((event) => event.source === "wms")).toBe(true);
  });

  it("倉位還有商品就不准刪，而且要說得出還有幾項", async () => {
    const id = await seedAdmin();
    await db.insert(zones).values({ id: "z1", code: "A-01", name: "備品區", x: 0, y: 0, width: 10, height: 10 });
    await db.insert(inventoryItems).values({ id: "i1", name: "紙箱", category: "一般備品", zoneId: "z1" });

    const response = await as(id, "admin@ecotech.tw", "/api/wms/zones/z1", { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("1 項商品") });
    expect(await db.select().from(zones)).toHaveLength(1);
  });

  it("還有商品放在要移除的層架上就擋下來", async () => {
    const id = await seedAdmin();
    await db.insert(zones).values({ id: "z1", code: "A-01", name: "備品區", x: 0, y: 0, width: 10, height: 10 });
    await db.insert(inventoryItems).values({
      id: "i1", name: "紙箱", category: "一般備品", zoneId: "z1", shelfLevel: "bottom",
    });

    const response = await as(id, "admin@ecotech.tw", "/api/wms/zones/z1", {
      method: "PATCH",
      body: JSON.stringify({ shelfLevels: [{ id: "top", name: "上層" }] }),
    });

    // 放行的話那項商品會指向一個不存在的層，畫面上從此「不在任何一層」。
    expect(response.status).toBe(409);
    const [zone] = await db.select().from(zones);
    expect(JSON.parse(zone?.shelfLevels ?? "[]")).toHaveLength(3);
  });

  it("層架的 id 會被正規化，重複的會被拆開", async () => {
    const id = await seedAdmin();
    await as(id, "admin@ecotech.tw", "/api/wms/zones", {
      method: "POST",
      body: JSON.stringify({
        code: "A-01",
        name: "備品區",
        shelfLevels: [{ id: "上 層", name: "A" }, { id: "上 層", name: "B" }],
      }),
    });

    const [zone] = await db.select().from(zones);
    const levels = JSON.parse(zone?.shelfLevels ?? "[]") as { id: string }[];
    // 兩層的 id 一樣的話，它們在畫面上會變成同一層。
    expect(new Set(levels.map((level) => level.id)).size).toBe(2);
    expect(levels.every((level) => /^[a-zA-Z0-9-]+$/.test(level.id))).toBe(true);
  });
});

describe("庫存品項", () => {
  beforeEach(async () => {
    await db.insert(zones).values({ id: "z1", code: "A-01", name: "備品區", x: 0, y: 0, width: 10, height: 10 });
  });

  it("分類必須是分類表裡真的有的", async () => {
    const id = await seedAdmin();
    const response = await as(id, "admin@ecotech.tw", "/api/wms/items", {
      method: "POST",
      body: JSON.stringify({ name: "紙箱", category: "不存在的分類" }),
    });

    // category 存的是名字不是外鍵，沒有這道檢查就會安靜地存進一個孤兒分類。
    expect(response.status).toBe(400);
    expect(await db.select().from(inventoryItems)).toHaveLength(0);
  });

  it("選了不存在的層架就當作沒指定層，不是整筆退回", async () => {
    const id = await seedAdmin();
    const response = await as(id, "admin@ecotech.tw", "/api/wms/items", {
      method: "POST",
      body: JSON.stringify({ name: "紙箱", category: "一般備品", zoneId: "z1", shelfLevel: "沒這層" }),
    });

    expect(response.status).toBe(201);
    const [item] = await db.select().from(inventoryItems);
    expect(item?.zoneId).toBe("z1");
    expect(item?.shelfLevel).toBeNull();
  });

  it("找不到倉位時整筆退回", async () => {
    const id = await seedAdmin();
    const response = await as(id, "admin@ecotech.tw", "/api/wms/items", {
      method: "POST",
      body: JSON.stringify({ name: "紙箱", category: "一般備品", zoneId: "沒這一區" }),
    });
    expect(response.status).toBe(400);
  });

  it("SKU 轉成大寫", async () => {
    const id = await seedAdmin();
    await as(id, "admin@ecotech.tw", "/api/wms/items", {
      method: "POST",
      body: JSON.stringify({ name: "紙箱", category: "一般備品", sku: "box-01" }),
    });
    const [item] = await db.select().from(inventoryItems);
    expect(item?.sku).toBe("BOX-01");
  });

  it("編輯商品資料不會動到數量", async () => {
    const id = await seedAdmin();
    await db.insert(inventoryItems).values({
      id: "i1", name: "紙箱", category: "一般備品", quantity: 42,
    });

    await as(id, "admin@ecotech.tw", "/api/wms/items/i1", {
      method: "PATCH",
      body: JSON.stringify({ name: "大紙箱", quantity: 0 }),
    });

    const [item] = await db.select().from(inventoryItems);
    expect(item?.name).toBe("大紙箱");
    // 數量只能走盤點，不然只有盤點權限的人送一個 quantity 就繞過界線了。
    expect(item?.quantity).toBe(42);
  });
});

describe("盤點", () => {
  beforeEach(async () => {
    await db.insert(productCategories).values({ id: "cat-1", name: "一般備品", color: "rose" });
    await db.insert(inventoryItems).values({
      id: "i1", sku: "BOX-01", name: "紙箱", category: "一般備品", quantity: 10, minStock: 5,
    });
  });

  it("數量沒變也要留下紀錄", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const response = await as(id, "staff@ecotech.tw", "/api/wms/items/i1/count", {
      method: "PATCH",
      body: JSON.stringify({ quantity: 10 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ quantity: 10, changed: false });
    // 「今天數過、沒變」跟「今天沒數」是兩件事，只記變化的話證明不了有盤過。
    const [event] = await db.select().from(activityEvents).where(eq(activityEvents.eventType, "item_counted"));
    expect(event?.oldValue).toBe("10");
    expect(event?.newValue).toBe("10");
  });

  it("低於安全庫存會回報，但盤點照樣成立", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const response = await as(id, "staff@ecotech.tw", "/api/wms/items/i1/count", {
      method: "PATCH",
      body: JSON.stringify({ quantity: 2 }),
    });

    expect(await response.json()).toMatchObject({ quantity: 2, changed: true, belowMinimum: true });
    const [item] = await db.select().from(inventoryItems);
    expect(item?.quantity).toBe(2);
  });

  it("負數擋下來", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const response = await as(id, "staff@ecotech.tw", "/api/wms/items/i1/count", {
      method: "PATCH",
      body: JSON.stringify({ quantity: -1 }),
    });
    expect(response.status).toBe(400);
  });

  it("只有盤點權限的人改不動其他欄位", async () => {
    const id = await seedUser("staff@ecotech.tw", "role-staff");
    const response = await as(id, "staff@ecotech.tw", "/api/wms/items/i1", {
      method: "PATCH",
      body: JSON.stringify({ name: "改名字" }),
    });

    // 一般同仁有 wms:inventory:count 但沒有 wms:inventory:write。
    expect(response.status).toBe(403);
    const [item] = await db.select().from(inventoryItems);
    expect(item?.name).toBe("紙箱");
  });
});

describe("商品分類", () => {
  it("改名時商品的分類要跟著改", async () => {
    const id = await seedAdmin();
    await db.insert(inventoryItems).values([
      { id: "i1", name: "紙箱", category: "一般備品" },
      { id: "i2", name: "膠帶", category: "一般備品" },
    ]);

    await as(id, "admin@ecotech.tw", "/api/wms/categories/cat-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "包材" }),
    });

    const items = await db.select().from(inventoryItems);
    // category 存的是名字，少了這一步那兩項商品會從此不屬於任何分類。
    expect(items.every((item) => item.category === "包材")).toBe(true);
  });

  it("還有商品在用就不准刪", async () => {
    const id = await seedAdmin();
    await db.insert(inventoryItems).values({ id: "i1", name: "紙箱", category: "一般備品" });

    const response = await as(id, "admin@ecotech.tw", "/api/wms/categories/cat-1", { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(await db.select().from(productCategories)).toHaveLength(1);
  });

  it("沒人在用就刪得掉", async () => {
    const id = await seedAdmin();
    const response = await as(id, "admin@ecotech.tw", "/api/wms/categories/cat-1", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await db.select().from(productCategories)).toHaveLength(0);
  });

  it("不認得的顏色退回預設值，不是報錯", async () => {
    const id = await seedAdmin();
    await as(id, "admin@ecotech.tw", "/api/wms/categories", {
      method: "POST",
      body: JSON.stringify({ name: "耗材", color: "螢光粉紅" }),
    });

    const [category] = await db
      .select()
      .from(productCategories)
      .where(eq(productCategories.name, "耗材"));
    expect(category?.color).toBe("rose");
  });
});

describe("讀取與權限", () => {
  it("一次回完地圖、標示、分類與商品", async () => {
    const id = await seedAdmin();
    await db.insert(zones).values({ id: "z1", code: "A-01", name: "備品區", x: 0, y: 0, width: 10, height: 10 });
    await db.insert(inventoryItems).values({ id: "i1", name: "紙箱", category: "一般備品" });

    const response = await as(id, "admin@ecotech.tw", "/api/wms/warehouse");
    const payload = await response.json() as Record<string, unknown>;

    expect(payload.settings).toMatchObject({ canvasWidth: 1600, canvasHeight: 900 });
    expect(payload.zones).toHaveLength(1);
    expect(payload.items).toHaveLength(1);
    // 層架在這裡就解析好，前端不必自己 JSON.parse。
    expect((payload.zones as { shelfLevels: unknown[] }[])[0]?.shelfLevels).toHaveLength(3);
  });

  it("沒有倉儲權限的人一律擋在外面", async () => {
    const id = await seedUser("none@ecotech.tw", null);
    for (const [path, init] of [
      ["/api/wms/warehouse", {}],
      ["/api/wms/zones", { method: "POST", body: "{}" }],
      ["/api/wms/items", { method: "POST", body: "{}" }],
      ["/api/wms/items/i1/count", { method: "PATCH", body: "{}" }],
      ["/api/wms/categories", { method: "POST", body: "{}" }],
      ["/api/wms/settings", { method: "PATCH", body: "{}" }],
    ] as const) {
      const response = await as(id, "none@ecotech.tw", path, init);
      expect([response.status, path]).toEqual([403, path]);
    }
  });

  it("沒登入的一律 401", async () => {
    const response = await app.fetch(new Request("https://test.local/api/wms/warehouse"), env() as never);
    expect(response.status).toBe(401);
  });
});

describe("畫布設定", () => {
  it("第一次設定時那一列還不存在，也要存得起來", async () => {
    const id = await seedAdmin();
    const response = await as(id, "admin@ecotech.tw", "/api/wms/settings", {
      method: "PATCH",
      body: JSON.stringify({ canvasWidth: 2200, canvasHeight: 1200 }),
    });

    // update 打不到任何一列時不會報錯，只會安靜地什麼都沒發生——所以用 upsert。
    expect(await response.json()).toEqual({ canvasWidth: 2200, canvasHeight: 1200 });
    const again = await as(id, "admin@ecotech.tw", "/api/wms/warehouse");
    expect((await again.json() as { settings: unknown }).settings)
      .toEqual({ canvasWidth: 2200, canvasHeight: 1200 });
  });

  it("超出範圍的尺寸會被夾住", async () => {
    const id = await seedAdmin();
    const response = await as(id, "admin@ecotech.tw", "/api/wms/settings", {
      method: "PATCH",
      body: JSON.stringify({ canvasWidth: 99999, canvasHeight: 10 }),
    });
    expect(await response.json()).toEqual({ canvasWidth: 3200, canvasHeight: 550 });
  });
});
