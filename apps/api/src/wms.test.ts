import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import {
  activityEvents,
  items,
  mediaObjects,
  users,
  userRoles,
  wmsCategories,
  wmsItems,
  wmsLayoutElements,
  wmsLayouts,
  wmsShelves,
  wmsZones,
  wmsZoneImages,
  wmsCyberbizLinks,
} from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createLocalR2 } from "./local-d1/r2.js";
import { createTargetOnlyD1 } from "./local-d1/d1.js";

const SECRET = "test-secret-test-secret-test-secret";
let d1: ReturnType<typeof createTargetOnlyD1>;
let uploads: ReturnType<typeof createLocalR2>;
let db: ReturnType<typeof createDatabase>;

type TestEnv = {
  DB: ReturnType<typeof createTargetOnlyD1>;
  UPLOADS: ReturnType<typeof createLocalR2>;
  AUTH_SESSION_SECRET: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
};

const env = (): TestEnv => ({
  DB: d1,
  UPLOADS: uploads,
  AUTH_SESSION_SECRET: SECRET,
  GOOGLE_OAUTH_CLIENT_ID: "test-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-secret",
});

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  uploads = createLocalR2(fs.mkdtempSync(path.join(os.tmpdir(), "wms-target-uploads-")));
  db = createDatabase(d1 as never);
  await syncSystemRoles(db);
});

async function seedUser(email = "admin@ecotech.tw", roleId: string | null = "role-admin") {
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, email, displayName: email, googleName: email, status: "active" });
  if (roleId) await db.insert(userRoles).values({ userId: id, roleId });
  return id;
}

async function as(userId: string, email: string, route: string, init: RequestInit = {}, runtimeEnv: TestEnv = env()) {
  const token = await signSession(
    newSessionClaims({ id: userId, email, name: email, pictureUrl: "" }),
    SECRET,
  );
  return app.fetch(new Request(`https://test.local${route}`, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      ...(init.headers ?? {}),
    },
  }), runtimeEnv as never);
}

async function seedCategory(id = "wms-cat-1", name = "一般備品") {
  await db.insert(wmsCategories).values({ id, name, color: "rose", active: 1 });
  return id;
}

async function seedZone(id = "zone-1", code = "A-01") {
  await db.insert(wmsLayouts).values({ id: "layout:main", name: "主倉庫", canvasWidth: 1600, canvasHeight: 900, active: 1 }).onConflictDoNothing();
  await db.insert(wmsZones).values({ id, code, name: "備品區", color: "mint", notes: "", active: 1 });
  await db.insert(wmsLayoutElements).values({ id: `wms-zone:${id}`, layoutId: "layout:main", elementType: "zone", zoneId: id, label: "備品區", color: "mint", x: 8, y: 10, width: 20, height: 18, zIndex: 0 });
  await db.insert(wmsShelves).values([
    { id: `${id}-top`, zoneId: id, code: "top", name: "上層", sortOrder: 0, active: 1 },
    { id: `${id}-bottom`, zoneId: id, code: "bottom", name: "底層", sortOrder: 1, active: 1 },
  ]);
}

async function seedWmsItem(id = "item-1", sku = "BOX-01") {
  await db.insert(items).values({ id, source: "custom", kind: "sellable", sku, name: "紙箱", categoryId: null, active: 1 });
  await db.insert(wmsItems).values({ itemId: id, wmsCategoryId: "wms-cat-1", quantity: 10, unit: "件", minStock: 5, notes: "" });
  return id;
}

describe("WMS target-only API", () => {
  it("新增與移動倉位，並在 target tables 留下操作紀錄", async () => {
    const userId = await seedUser();
    const categoryId = await seedCategory();
    const created = await as(userId, "admin@ecotech.tw", "/api/wms/zones", {
      method: "POST",
      body: JSON.stringify({ code: "a-01", name: "備品區", x: 999, y: -5, shelfLevels: [{ id: "上 層", name: "A" }, { id: "上 層", name: "B" }] }),
    });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    const [zone] = await db.select().from(wmsZones).where(eq(wmsZones.id, id));
    expect(zone).toMatchObject({ code: "A-01", name: "備品區" });
    const shelves = await db.select().from(wmsShelves).where(eq(wmsShelves.zoneId, id));
    expect(shelves).toHaveLength(2);
    expect(new Set(shelves.map((shelf) => shelf.code)).size).toBe(2);
    expect(categoryId).toBe("wms-cat-1");

    const moved = await as(userId, "admin@ecotech.tw", `/api/wms/zones/${id}`, {
      method: "PATCH", body: JSON.stringify({ x: 40, y: 50 }),
    });
    expect(moved.status).toBe(200);
    expect(await db.select({ eventType: activityEvents.eventType }).from(activityEvents).where(eq(activityEvents.entityId, id)))
      .toMatchObject([{ eventType: "zone_created" }, { eventType: "zone_moved" }]);
  });

  it("地圖資料不會把 zone 的 layout row 當成額外元素回傳", async () => {
    const userId = await seedUser();
    await seedZone();
    await db.insert(wmsLayoutElements).values({
      id: "wms-decoration-1", layoutId: "layout:main", elementType: "decoration", zoneId: null,
      label: "出貨口", color: "sky", x: 40, y: 10, width: 12, height: 10, zIndex: 1,
    });

    const response = await as(userId, "admin@ecotech.tw", "/api/wms/warehouse");
    expect(response.status).toBe(200);
    const warehouse = await response.json() as { layoutElements: Array<{ id: string; elementType: string }> };
    expect(warehouse.layoutElements).toHaveLength(1);
    expect(warehouse.layoutElements[0]).toMatchObject({ id: "wms-decoration-1", elementType: "decoration" });
  });

  it("有商品使用倉位或層架時禁止刪除與移除層架", async () => {
    const userId = await seedUser();
    await seedCategory();
    await seedZone();
    await seedWmsItem();
    await db.update(wmsItems).set({ shelfId: "zone-1-top" }).where(eq(wmsItems.itemId, "item-1"));

    const zoneDelete = await as(userId, "admin@ecotech.tw", "/api/wms/zones/zone-1", { method: "DELETE" });
    expect(zoneDelete.status).toBe(409);
    const shelfDelete = await as(userId, "admin@ecotech.tw", "/api/wms/zones/zone-1", {
      method: "PATCH", body: JSON.stringify({ shelfLevels: [{ id: "bottom", name: "底層" }] }),
    });
    expect(shelfDelete.status).toBe(409);
  });

  it("建立與編輯 WMS 品項只在 items 與 wms_items 寫入", async () => {
    const userId = await seedUser();
    await seedCategory();
    await seedZone();
    const created = await as(userId, "admin@ecotech.tw", "/api/wms/items", {
      method: "POST",
      body: JSON.stringify({ sku: "box-02", name: "小紙箱", category: "一般備品", zoneId: "zone-1", shelfLevel: "top", quantity: 12 }),
    });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    const [master] = await db.select().from(items).where(eq(items.id, id));
    const [wms] = await db.select().from(wmsItems).where(eq(wmsItems.itemId, id));
    expect(master).toMatchObject({ sku: "BOX-02", name: "小紙箱", source: "custom" });
    expect(wms).toMatchObject({ quantity: 12, shelfId: "zone-1-top" });

    const edited = await as(userId, "admin@ecotech.tw", `/api/wms/items/${id}`, {
      method: "PATCH", body: JSON.stringify({ name: "小紙箱（改）", category: "一般備品", quantity: 999 }),
    });
    expect(edited.status).toBe(200);
    const [afterMaster] = await db.select().from(items).where(eq(items.id, id));
    const [afterWms] = await db.select().from(wmsItems).where(eq(wmsItems.itemId, id));
    expect(afterMaster?.name).toBe("小紙箱（改）");
    expect(afterWms?.quantity).toBe(12);

    await db.insert(wmsCyberbizLinks).values({
      id: "wms-cyberbiz-link-1",
      wmsItemId: id,
      cyberbizProductId: "product-1",
      cyberbizVariantId: "variant-1",
      sku: "BOX-02",
      warehouseScope: "company",
      syncStatus: "synced",
      lastSyncedQuantity: 12,
      lastSyncedAt: new Date().toISOString(),
    });
    const changedLinkedSku = await as(userId, "admin@ecotech.tw", `/api/wms/items/${id}`, {
      method: "PATCH", body: JSON.stringify({ sku: "BOX-99", category: "一般備品" }),
    });
    expect(changedLinkedSku.status).toBe(409);
    const [unchangedMaster] = await db.select().from(items).where(eq(items.id, id));
    expect(unchangedMaster?.sku).toBe("BOX-02");
  });

  it("盤點會更新 wms_items，數量不變也會留下紀錄", async () => {
    const userId = await seedUser();
    await seedCategory();
    await seedWmsItem();
    const counted = await as(userId, "admin@ecotech.tw", "/api/wms/items/item-1/count", {
      method: "PATCH", body: JSON.stringify({ quantity: 10 }),
    });
    expect(counted.status).toBe(200);
    expect(await counted.json()).toMatchObject({ quantity: 10, changed: false, cyberbiz: { status: "unlinked" } });
    expect(await db.select({ eventType: activityEvents.eventType }).from(activityEvents).where(eq(activityEvents.eventType, "item_counted")))
      .toHaveLength(1);
  });

  it("倉儲分類 CRUD 使用 wms_categories，且使用中的分類不能刪除", async () => {
    const userId = await seedUser();
    await seedCategory();
    await seedWmsItem();
    const conflict = await as(userId, "admin@ecotech.tw", "/api/wms/categories/wms-cat-1", { method: "DELETE" });
    expect(conflict.status).toBe(409);

    await db.delete(wmsItems).where(eq(wmsItems.itemId, "item-1"));
    const removed = await as(userId, "admin@ecotech.tw", "/api/wms/categories/wms-cat-1", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await db.select().from(wmsCategories)).toHaveLength(0);
  });

  it("讀取倉庫快照時組合 target master、WMS、分類與層架", async () => {
    const userId = await seedUser();
    await seedCategory();
    await seedZone();
    await seedWmsItem();
    await db.update(wmsItems).set({ shelfId: "zone-1-bottom" }).where(eq(wmsItems.itemId, "item-1"));
    const response = await as(userId, "admin@ecotech.tw", "/api/wms/warehouse");
    expect(response.status).toBe(200);
    const payload = await response.json() as { items: Array<Record<string, unknown>>; zones: Array<Record<string, unknown>>; categories: unknown[] };
    expect(payload.items).toMatchObject([{ id: "item-1", sku: "BOX-01", category: "一般備品", zoneId: "zone-1", shelfLevel: "bottom" }]);
    expect(payload.zones).toHaveLength(1);
    expect(payload.categories).toHaveLength(1);
  });

  it("照片會寫入 media_objects 與 wms_zone_images，讀取與刪除也會清掉檔案", async () => {
    const userId = await seedUser();
    await seedZone();
    const form = new FormData();
    form.append("file", new File([new Uint8Array([137, 80, 78, 71])], "test.png", { type: "image/png" }));
    const created = await as(userId, "admin@ecotech.tw", "/api/wms/zones/zone-1/images", { method: "POST", body: form });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    const [image] = await db.select().from(wmsZoneImages);
    expect(image?.objectKey).toMatch(/^zones\/zone-1\//);
    expect(await db.select().from(mediaObjects)).toMatchObject([{ contentType: "image/png", filename: "test.png" }]);
    expect(await uploads.head(image!.objectKey)).not.toBeNull();

    const read = await as(userId, "admin@ecotech.tw", `/api/wms/images/${id}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));

    const deleted = await as(userId, "admin@ecotech.tw", `/api/wms/images/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await db.select().from(wmsZoneImages)).toHaveLength(0);
    expect(await db.select().from(mediaObjects)).toHaveLength(0);
    expect(await uploads.head(image!.objectKey)).toBeNull();
  });
});

describe("WMS target-only permission boundary", () => {
  it("沒有 WMS 權限時不能讀取倉庫", async () => {
    const userId = await seedUser("viewer@example.com", null);
    const response = await as(userId, "viewer@example.com", "/api/wms/warehouse");
    expect(response.status).toBe(403);
  });
});
