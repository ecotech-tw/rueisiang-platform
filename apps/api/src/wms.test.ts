import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import {
  activityEvents,
  inventoryItems,
  cyberbizProductLinks,
  productCategories,
  zoneImages,
  users,
  userRoles,
  zones,
} from "@rueisiang/db/schema";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createLocalD1 } from "./local-d1/d1.js";
import { createLocalR2 } from "./local-d1/r2.js";

/**
 * 倉儲的 API。
 *
 * 重點放在三種「安靜出錯」的情況：權限沒掛好、界線被繞過（盤點的人改到別的
 * 欄位）、以及參照被打斷（層架、分類都不是外鍵）。單純的 CRUD 成功路徑只各
 * 測一次，那些壞掉的話任何人打開畫面都會立刻看到。
 */

const SECRET = "test-secret-test-secret-test-secret";
let d1: ReturnType<typeof createLocalD1>;
let uploads: ReturnType<typeof createLocalR2>;
let db: ReturnType<typeof createDatabase>;

type TestEnv = {
  DB: ReturnType<typeof createLocalD1>;
  UPLOADS?: ReturnType<typeof createLocalR2>;
  AUTH_SESSION_SECRET: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  NAS_STORAGE_URL?: string;
  NAS_STORAGE_TOKEN?: string;
};

const env = (): TestEnv => ({
  DB: d1,
  UPLOADS: uploads,
  AUTH_SESSION_SECRET: SECRET,
  GOOGLE_OAUTH_CLIENT_ID: "x",
  GOOGLE_OAUTH_CLIENT_SECRET: "x",
});

beforeEach(async () => {
  d1 = createLocalD1();
  // 每個測試一個乾淨的暫存目錄，不然上一個測試的檔案會留到下一個。
  uploads = createLocalR2(fs.mkdtempSync(path.join(os.tmpdir(), "wms-uploads-")));
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

async function as(userId: string, email: string, path: string, init: RequestInit = {}, runtimeEnv = env()) {
  const token = await signSession(
    newSessionClaims({ id: userId, email, name: "測試", pictureUrl: "" }),
    SECRET,
  );
  return app.fetch(
    new Request(`https://test.local${path}`, {
      ...init,
      headers: {
        /*
         * 送 FormData 時不能自己設 Content-Type：那個標頭要帶 multipart 的
         * boundary，只有 FormData 自己組得出來。寫死 application/json 的話
         * 伺服器那端會解不開，回 500。
         */
        ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        ...(init.headers ?? {}),
      },
    }),
    runtimeEnv as never,
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

/*
 * 安全庫存的真相來源。
 *
 * 已連結的商品，數量與安全庫存都以官網為準（見 wms-sync.ts）。數量本來就走盤點
 * 不走這張表單，安全庫存也要比照——不擋的話會發生一件很難查的事：改了不會推上
 * 官網，而且下次同步就被官網的值蓋回去，使用者看到自己的修改安靜地消失。
 */
describe("安全庫存以官網為準", () => {
  beforeEach(async () => {
    await db.insert(productCategories).values({ id: "cat-1", name: "一般備品", color: "rose" });
    await db.insert(inventoryItems).values({
      id: "i1", sku: "BOX-01", name: "紙箱", category: "一般備品", quantity: 10, minStock: 5,
    });
  });

  async function edit(body: Record<string, unknown>) {
    const id = await seedUser("admin@ecotech.tw", "role-admin");
    return as(id, "admin@ecotech.tw", "/api/wms/items/i1", {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  async function link() {
    await db.insert(cyberbizProductLinks).values({
      id: "l1", inventoryItemId: "i1", cyberbizProductId: "p1", cyberbizVariantId: "v1", sku: "BOX-01",
    });
  }

  it("沒連結時照樣可以改", async () => {
    const response = await edit({ minStock: 50 });
    expect(response.status).toBe(200);
    const [item] = await db.select().from(inventoryItems);
    expect(item?.minStock).toBe(50);
  });

  it("已連結時改安全庫存會被擋下來，而且值沒有動", async () => {
    await link();
    const response = await edit({ minStock: 50 });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("官網") });
    const [item] = await db.select().from(inventoryItems);
    expect(item?.minStock).toBe(5);
  });

  /*
   * 表單會把整份欄位送回來，其中包含沒有變動的安全庫存。那種情況報錯的話，
   * 已連結的商品就連名字都改不了了。
   */
  it("已連結但安全庫存沒變時，其他欄位照樣改得動", async () => {
    await link();
    const response = await edit({ name: "大紙箱", minStock: 5 });

    expect(response.status).toBe(200);
    const [item] = await db.select().from(inventoryItems);
    expect(item?.name).toBe("大紙箱");
  });

  it("已連結時完全不送 minStock 也不受影響", async () => {
    await link();
    const response = await edit({ name: "大紙箱" });

    expect(response.status).toBe(200);
    const [item] = await db.select().from(inventoryItems);
    expect(item?.minStock).toBe(5);
  });

  /*
   * Code review 抓到的：表單一定會送安全庫存，而它送的是**開啟表單那一刻**的值。
   *
   * 表單開著的時候官網同步把值改掉了的話，送回來的舊值就會被判成「要改成不同
   * 的值」，於是連改個名字都會 409——這項商品完全編輯不動，而錯誤訊息完全沒提
   * 到這件事。前端已經改成連結時不送這個欄位，這裡釘住後端的那一半：不送就是
   * 不要動。
   */
  it("已連結時不送 minStock，其他欄位就改得動——即使官網那邊剛改過", async () => {
    await link();
    // 官網同步把安全庫存改成 99，這時表單手上還是 5。
    await db.update(inventoryItems).set({ minStock: 99 }).where(eq(inventoryItems.id, "i1"));

    const response = await edit({ name: "大紙箱" });

    expect(response.status).toBe(200);
    const [item] = await db.select().from(inventoryItems);
    expect(item?.name).toBe("大紙箱");
    // 沒送就是不要動，官網那個值留著。
    expect(item?.minStock).toBe(99);
  });

  /*
   * 反方向仍然要通：官網同步回來時就是要改這個值，那條路不受這個限制。
   */
  it("從官網同步回來時照樣寫得進去", async () => {
    await link();
    const { applySyncPlan, buildSyncPlan } = await import("@rueisiang/db");
    await applySyncPlan(
      db,
      buildSyncPlan(
        [{ linkId: "l1", inventoryItemId: "i1", cyberbizProductId: "p1", cyberbizVariantId: "v1", linkedSku: "BOX-01", itemSku: "BOX-01", itemName: "紙箱", quantity: 10, minStock: 5 }],
        [{ productId: "p1", variantId: "v1", sku: "BOX-01", quantity: 10, safetyQuantity: 99 }],
      ),
      null,
    );

    const [item] = await db.select().from(inventoryItems);
    expect(item?.minStock).toBe(99);
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

describe("倉位現場照片", () => {
  const PIXEL = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  afterEach(() => vi.unstubAllGlobals());

  function upload(bytes: Uint8Array = PIXEL, name = "shelf.png", type = "image/png") {
    const form = new FormData();
    // Workers 的型別裡沒有 BlobPart，測試跑在 Node 上所以實際型別是對的。
    form.append("file", new File([bytes as never], name, { type }));
    return form;
  }

  function nasEnv() {
    return {
      ...env(),
      UPLOADS: undefined,
      NAS_STORAGE_URL: "https://storage.test",
      NAS_STORAGE_TOKEN: "nas-secret",
    };
  }

  function stubNasStorage() {
    const objects = new Map<string, Uint8Array>();
    let uploadNumber = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("x-storage-token")).toBe("nas-secret");
      const method = init?.method ?? "GET";

      if (method === "POST") {
        const bytes = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        const key = `wms/zones/z1/2026/08/00000000-0000-0000-0000-${String(++uploadNumber).padStart(12, "0")}.png`;
        objects.set(key, bytes);
        return new Response(JSON.stringify({
          object: { key, size: bytes.byteLength, checksum: "0".repeat(64), contentType: "image/png" },
        }), { status: 201, headers: { "content-type": "application/json" } });
      }

      const key = url.searchParams.get("key") ?? "";
      if (method === "GET") {
        const bytes = objects.get(key);
        return bytes ? new Response(bytes, { status: 200, headers: { "content-type": "image/png" } }) : new Response(null, { status: 404 });
      }
      if (method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 405 });
    });
    vi.stubGlobal("fetch", fetcher);
    return objects;
  }

  beforeEach(async () => {
    await db.insert(zones).values({ id: "z1", code: "A-01", name: "備品區", x: 0, y: 0, width: 10, height: 10 });
  });

  it("上傳之後讀得回來，內容一模一樣", async () => {
    const id = await seedUser("admin@ecotech.tw", "role-admin");
    const created = await as(id, "admin@ecotech.tw", "/api/wms/zones/z1/images", {
      method: "POST",
      body: upload(),
    });
    expect(created.status).toBe(201);
    const { id: imageId } = await created.json() as { id: string };

    const read = await as(id, "admin@ecotech.tw", `/api/wms/images/${imageId}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(PIXEL);
  });

  it("設定 NAS 時新照片寫入 NAS，舊 R2 路徑仍由既有測試覆蓋", async () => {
    const objects = stubNasStorage();
    const id = await seedUser("admin@ecotech.tw", "role-admin");
    const created = await as(id, "admin@ecotech.tw", "/api/wms/zones/z1/images", {
      method: "POST",
      body: upload(),
    }, nasEnv());
    expect(created.status).toBe(201);
    const { id: imageId } = await created.json() as { id: string };
    const [row] = await db.select().from(zoneImages);
    expect(row!.objectKey).toMatch(/^wms\/zones\/z1\/2026\/08\//);
    expect(objects.size).toBe(1);

    const read = await as(id, "admin@ecotech.tw", `/api/wms/images/${imageId}`, {}, nasEnv());
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(PIXEL);

    const deleted = await as(id, "admin@ecotech.tw", `/api/wms/images/${imageId}`, { method: "DELETE" }, nasEnv());
    expect(deleted.status).toBe(200);
    expect(objects.size).toBe(0);
  });

  it("不是圖片就擋下來，而且不會留下索引", async () => {
    const id = await seedUser("admin@ecotech.tw", "role-admin");
    const response = await as(id, "admin@ecotech.tw", "/api/wms/zones/z1/images", {
      method: "POST",
      body: upload(new Uint8Array([1, 2, 3]), "notes.txt", "text/plain"),
    });

    expect(response.status).toBe(400);
    const list = await as(id, "admin@ecotech.tw", "/api/wms/zones/z1/images");
    expect((await list.json() as { images: unknown[] }).images).toHaveLength(0);
  });

  it("刪掉倉位時，R2 上的檔案也要跟著清掉", async () => {
    const id = await seedUser("admin@ecotech.tw", "role-admin");
    await as(id, "admin@ecotech.tw", "/api/wms/zones/z1/images", {
      method: "POST", body: upload(),
    });
    const [row] = await db.select().from(zoneImages);
    expect(await uploads.head(row!.objectKey)).not.toBeNull();

    await as(id, "admin@ecotech.tw", "/api/wms/zones/z1", { method: "DELETE" });

    // zone_images 是 cascade，索引會自己消失——但 R2 沒有 cascade，要自己刪。
    expect(await db.select().from(zoneImages)).toHaveLength(0);
    expect(await uploads.head(row!.objectKey)).toBeNull();
  });

  it("刪一張照片，檔案也要不見", async () => {
    const id = await seedUser("admin@ecotech.tw", "role-admin");
    const created = await as(id, "admin@ecotech.tw", "/api/wms/zones/z1/images", {
      method: "POST", body: upload(),
    });
    const { id: imageId } = await created.json() as { id: string };
    const [row] = await db.select().from(zoneImages);

    await as(id, "admin@ecotech.tw", `/api/wms/images/${imageId}`, { method: "DELETE" });
    expect(await uploads.head(row!.objectKey)).toBeNull();
  });

  it("沒有綁定 R2 時只有照片壞掉，其他功能照常", async () => {
    const id = await seedUser("admin@ecotech.tw", "role-admin");
    const noBucket = { ...env(), UPLOADS: undefined };

    const upload503 = await app.fetch(
      new Request("https://test.local/api/wms/zones/z1/images", {
        method: "POST",
        body: upload(),
        headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id, email: "admin@ecotech.tw", name: "測試", pictureUrl: "" }), SECRET))}` },
      }),
      noBucket as never,
    );
    expect(upload503.status).toBe(503);

    // 地圖本身不該因為沒設定物件儲存就一起停擺。
    const warehouse = await app.fetch(
      new Request("https://test.local/api/wms/warehouse", {
        headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id, email: "admin@ecotech.tw", name: "測試", pictureUrl: "" }), SECRET))}` },
      }),
      noBucket as never,
    );
    expect(warehouse.status).toBe(200);
  });

  it("沒有地圖權限的人看不到照片", async () => {
    const id = await seedUser("none@ecotech.tw", null);
    const response = await as(id, "none@ecotech.tw", "/api/wms/zones/z1/images");
    expect(response.status).toBe(403);
  });
});

describe("操作紀錄", () => {
  beforeEach(async () => {
    await db.insert(zones).values({ id: "z1", code: "A-01", name: "備品區", x: 8, y: 10, width: 20, height: 18 });
    await db.insert(productCategories).values({ id: "cat-1", name: "一般備品", color: "rose" });
  });

  /**
   * oldValue/newValue 會被直接印在「變更」那一欄。
   *
   * 一整包 JSON 塞進去的話那一欄會爆版，而且沒有人讀得下去——整包快照要放
   * payloadJson。這條測試就是釘住這件事。
   */
  it("欄位級的值看得懂，整包快照放 payload", async () => {
    const id = await seedUser("admin@ecotech.tw", "role-admin");
    await as(id, "admin@ecotech.tw", "/api/wms/zones/z1", {
      method: "PATCH",
      body: JSON.stringify({ x: 30, y: 40 }),
    });

    const [event] = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.eventType, "zone_moved"));

    expect(event?.field).toBe("position");
    expect(event?.oldValue).toBe("8%, 10%");
    expect(event?.newValue).toBe("30%, 40%");
    // 完整的前後狀態沒有不見，只是搬到不會被印出來的地方。
    expect(JSON.parse(event?.payloadJson ?? "{}")).toMatchObject({ before: { x: 8 }, after: { x: 30 } });
  });

  it("新增與刪除不寫 oldValue/newValue，只留快照", async () => {
    const id = await seedUser("admin@ecotech.tw", "role-admin");
    await as(id, "admin@ecotech.tw", "/api/wms/zones", {
      method: "POST",
      body: JSON.stringify({ code: "B-01", name: "包材區" }),
    });

    const [event] = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.eventType, "zone_created"));

    // 「新增」沒有「從什麼變成什麼」，硬塞一個值只是製造噪音。
    expect(event?.oldValue).toBeNull();
    expect(event?.newValue).toBeNull();
    expect(JSON.parse(event?.payloadJson ?? "{}")).toMatchObject({ code: "B-01" });
  });

  it("分類改名記的是名字本身，不是整個物件", async () => {
    const id = await seedUser("admin@ecotech.tw", "role-admin");
    await as(id, "admin@ecotech.tw", "/api/wms/categories/cat-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "包材" }),
    });

    const [event] = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.eventType, "category_updated"));
    expect(event?.oldValue).toBe("一般備品");
    expect(event?.newValue).toBe("包材");
  });

  it("只回倉儲的紀錄，CRM 的不會混進來", async () => {
    const id = await seedUser("admin@ecotech.tw", "role-admin");
    await db.insert(activityEvents).values({
      id: "evt-crm", entityType: "customer", entityId: "c1", entityLabel: "王小明",
      eventType: "customer_created", summary: "新增客戶", source: "crm",
    });
    await as(id, "admin@ecotech.tw", "/api/wms/zones/z1", {
      method: "PATCH",
      body: JSON.stringify({ x: 30 }),
    });

    const response = await as(id, "admin@ecotech.tw", "/api/wms/activity");
    const body = await response.json() as { events: { entityType: string }[] };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.some((event) => event.entityType === "customer")).toBe(false);
  });

  it("沒有倉儲紀錄權限的人看不到", async () => {
    const id = await seedUser("none@ecotech.tw", null);
    const response = await as(id, "none@ecotech.tw", "/api/wms/activity");
    expect(response.status).toBe(403);
  });
});

/**
 * 盤點推回 CYBERBIZ。
 *
 * 這一段釘的是**順序**：先寫本地，再推官網。跟 CRM 刻意相反，理由是真相來源
 * 不同——人已經在現場數完了，不能因為官網連不上就把他數的結果丟掉。
 */
describe("盤點與 CYBERBIZ", () => {
  /** 假的官網。回應依序取用，用完就一直重複最後一筆。 */
  function stubCyberbiz(responses: { status?: number; body?: unknown }[]) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    let index = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      const spec = responses[Math.min(index, responses.length - 1)] ?? {};
      index += 1;
      return new Response(JSON.stringify(spec.body ?? {}), { status: spec.status ?? 200 });
    });
    return calls;
  }

  /** 官網回一個商品，帶一個款式。 */
  const product = (quantity: number) => ({
    body: {
      product: {
        id: "p1",
        title: "紙箱",
        published: true,
        product_variants: [
          { id: "v1", name: "單一款式", sku: "BOX-01", inventory_quantity: quantity, safety_inventory_quantity: 5 },
        ],
      },
    },
  });

  const withToken = () => ({ ...env(), CYBERBIZ_API_TOKEN: "test-token", CYBERBIZ_API_BASE_URL: "https://api.example.test" });

  async function asWithToken(userId: string, path: string, init: RequestInit = {}) {
    const token = await signSession(newSessionClaims({ id: userId, email: "admin@ecotech.tw", name: "測試", pictureUrl: "" }), SECRET);
    return app.fetch(
      new Request(`https://test.local${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
      }),
      withToken() as never,
    );
  }

  beforeEach(async () => {
    await db.insert(productCategories).values({ id: "cat-1", name: "一般備品", color: "rose" });
    await db.insert(inventoryItems).values({
      id: "i1", sku: "BOX-01", name: "紙箱", category: "一般備品", quantity: 10, minStock: 5,
    });
    await db.insert(cyberbizProductLinks).values({
      id: "l1", inventoryItemId: "i1", cyberbizProductId: "p1", cyberbizVariantId: "v1", sku: "BOX-01",
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("盤點之後把差額推到官網，並重讀驗證", async () => {
    // 讀現況 10 → 送調整 → 重讀驗證 42
    const calls = stubCyberbiz([product(10), { body: {} }, product(42)]);
    const id = await seedUser("admin@ecotech.tw", "role-admin");

    const response = await asWithToken(id, "/api/wms/items/i1/count", {
      method: "PATCH",
      body: JSON.stringify({ quantity: 42 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ quantity: 42, cyberbiz: { status: "synced", changed: true } });

    // 官網收到的是**差額**（+32 的 surplus），不是「設成 42」。
    const adjustment = calls.find((call) => call.url.includes("/stock_adjustments"));
    expect(adjustment?.method).toBe("POST");
    expect(adjustment?.body).toMatchObject({
      pos_shop_id: 0,
      items: [{ sku: "BOX-01", quantity: 32, type: "surplus" }],
    });

    const [link] = await db.select().from(cyberbizProductLinks);
    expect(link?.syncStatus).toBe("synced");
    expect(link?.lastSyncedQuantity).toBe(42);
  });

  it("官網掛掉時盤點仍然成立，只把連結標成失敗", async () => {
    stubCyberbiz([{ status: 500, body: { error: "官網掛了" } }]);
    const id = await seedUser("admin@ecotech.tw", "role-admin");

    const response = await asWithToken(id, "/api/wms/items/i1/count", {
      method: "PATCH",
      body: JSON.stringify({ quantity: 42 }),
    });

    // 這是這一段最重要的一條：人數完的結果不能因為官網連不上就丟掉。
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ quantity: 42, cyberbiz: { status: "failed" } });
    const [item] = await db.select().from(inventoryItems);
    expect(item?.quantity).toBe(42);

    const [link] = await db.select().from(cyberbizProductLinks);
    expect(link?.syncStatus).toBe("failed");

    // 而且要留下紀錄，不然沒有人知道兩邊從此不一致。
    const [event] = await db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.eventType, "cyberbiz_sync_failed"));
    expect(event?.summary).toContain("沒有推上 CYBERBIZ");
  });

  it("數量沒變就不送調整，只確認一次", async () => {
    const calls = stubCyberbiz([product(10)]);
    const id = await seedUser("admin@ecotech.tw", "role-admin");

    const response = await asWithToken(id, "/api/wms/items/i1/count", {
      method: "PATCH",
      body: JSON.stringify({ quantity: 10 }),
    });

    expect(await response.json()).toMatchObject({ changed: false, cyberbiz: { status: "synced", changed: false } });
    expect(calls.some((call) => call.url.includes("/stock_adjustments"))).toBe(false);
  });

  it("沒有連結的商品不會去打官網", async () => {
    await db.delete(cyberbizProductLinks);
    const calls = stubCyberbiz([product(10)]);
    const id = await seedUser("admin@ecotech.tw", "role-admin");

    const response = await asWithToken(id, "/api/wms/items/i1/count", {
      method: "PATCH",
      body: JSON.stringify({ quantity: 42 }),
    });

    expect(await response.json()).toMatchObject({ cyberbiz: { status: "unlinked" } });
    expect(calls).toHaveLength(0);
  });
});
