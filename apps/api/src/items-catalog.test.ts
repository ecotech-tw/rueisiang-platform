import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, createReportManualSales, syncCyberbizProducts, syncSystemRoles } from "@rueisiang/db";
import { activityEvents, cyberbizProducts, itemCategories, items, scopes, users, userRoleAssignments } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1 } from "./local-d1/d1.js";

const SECRET = "test-secret-test-secret-test-secret";
let d1: ReturnType<typeof createTargetOnlyD1>;
let db: ReturnType<typeof createDatabase>;

const env = () => ({
  DB: d1,
  AUTH_SESSION_SECRET: SECRET,
  GOOGLE_OAUTH_CLIENT_ID: "test-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-secret",
});

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  db = createDatabase(d1 as never);
  await syncSystemRoles(db);
  await db.insert(itemCategories).values({ id: "cat-1", depth: 0, name: "包材", color: "rose", sortOrder: 0, active: 1 });
});

async function seedAdmin(email = "admin@ecotech.tw") {
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, email, displayName: email, googleName: email, status: "active" });
  await db.insert(userRoleAssignments).values({ userId: id, roleId: "role-admin" });
  return { id, email };
}

async function createItem(payload: Record<string, unknown>) {
  const admin = await seedAdmin();
  const token = await signSession(newSessionClaims({ id: admin.id, email: admin.email, name: admin.email, pictureUrl: "" }), SECRET);
  return app.fetch(new Request("https://test.local/api/items/catalog", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    body: JSON.stringify(payload),
  }), env() as never);
}

describe("新增自訂品項", () => {
  it("SKU 留白時自動編號並記成 supply——包材與半成品本來就沒有 SKU", async () => {
    const response = await createItem({ name: "淋膜紙", categoryId: "cat-1" });
    expect(response.status).toBe(201);
    const created = await response.json() as { id: string; sku: string };
    expect(created.sku).toMatch(/^WMS-[0-9A-F]{8}$/);

    const [row] = await db.select().from(items).where(eq(items.id, created.id));
    expect(row).toMatchObject({ kind: "supply", source: "custom", name: "淋膜紙", sku: created.sku });
  });

  it("有填 SKU 就是拿去賣的東西，記成 sellable", async () => {
    const response = await createItem({ name: "禮盒", sku: "box-m", categoryId: "cat-1" });
    expect(response.status).toBe(201);
    const created = await response.json() as { id: string; sku: string };
    expect(created.sku).toBe("BOX-M");

    const [row] = await db.select().from(items).where(eq(items.id, created.id));
    expect(row).toMatchObject({ kind: "sellable", sku: "BOX-M" });
  });

  it("SKU 撞到既有的 CYBERBIZ 品項會回 409，而不是撞在唯一索引上", async () => {
    await db.insert(items).values({ id: "cb:ABX1", source: "cyberbiz", kind: "sellable", sku: "ABX1", name: "官網商品", active: 1 });

    const response = await createItem({ name: "重複的", sku: "ABX1", categoryId: "cat-1" });
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toContain("官網商品");
  });

  it("名稱還是必填", async () => {
    expect((await createItem({ categoryId: "cat-1" })).status).toBe(400);
  });

  it("送 cyberbizSku 也只會建自訂品項——那條路已經收掉了", async () => {
    const response = await createItem({ name: "官網的", sku: "NEW-1", cyberbizSku: "ABX9", categoryId: "cat-1" });
    expect(response.status).toBe(201);
    const [row] = await db.select().from(items).where(eq(items.sku, "NEW-1"));
    expect(row).toMatchObject({ source: "custom" });
  });
});

describe("SKU 全平台唯一之後，找既有品項不能只看 source", () => {
  it("人工報表輸入官網已有的 SKU 時沿用同一筆，不會撞唯一索引", async () => {
    await db.insert(items).values({ id: "cb:ABX2", source: "cyberbiz", kind: "sellable", sku: "ABX2", name: "官網商品", active: 1 });
    await db.insert(scopes).values({ id: "cyberbiz:store:a", scopeKind: "store", sourceType: "cyberbiz", name: "測試店", normalizedName: "測試店" });

    const created = await createReportManualSales(db, {
      scopeId: "cyberbiz:store:a", reportMonth: "2026-07", skuSource: "custom", sku: "ABX2",
      productName: "人工輸入的名字", category: "包材",
      grossQuantity: 3, returnQuantity: 0, netQuantity: 3, salesAmount: 300,
      actor: { id: "u1", email: "admin@ecotech.tw" },
    });
    expect(created).toBeTruthy();

    // 沿用官網那一筆，而且名稱不被人工輸入蓋掉——名稱由同步負責。
    expect(await db.select({ id: items.id }).from(items).where(eq(items.sku, "ABX2"))).toEqual([{ id: "cb:ABX2" }]);
    expect((await db.select({ name: items.name }).from(items).where(eq(items.id, "cb:ABX2")))[0]).toEqual({ name: "官網商品" });
  });
});

describe("kind 是我們的判斷，不是同步來的事實", () => {
  async function patchItem(id: string, payload: Record<string, unknown>) {
    const admin = await seedAdmin(`edit-${crypto.randomUUID()}@ecotech.tw`);
    const token = await signSession(newSessionClaims({ id: admin.id, email: admin.email, name: admin.email, pictureUrl: "" }), SECRET);
    return app.fetch(new Request(`https://test.local/api/items/catalog/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
      body: JSON.stringify(payload),
    }), env() as never);
  }

  it("分錯的可以改回來——0076 只憑有沒有 SKU 分過一輪", async () => {
    await db.insert(items).values({ id: "i1", source: "custom", kind: "supply", sku: "WMS-1", name: "養皂3入禮盒", active: 1 });

    expect((await patchItem("i1", { kind: "sellable" })).status).toBe(200);
    expect((await db.select({ kind: items.kind }).from(items).where(eq(items.id, "i1")))[0]).toEqual({ kind: "sellable" });
  });

  it("沒送 kind 就不動它", async () => {
    await db.insert(items).values({ id: "i2", source: "custom", kind: "supply", sku: "WMS-2", name: "淋膜紙", active: 1 });

    expect((await patchItem("i2", { name: "淋膜紙（大）" })).status).toBe(200);
    expect((await db.select({ kind: items.kind }).from(items).where(eq(items.id, "i2")))[0]).toEqual({ kind: "supply" });
  });

  it("重複 SKU 不會靜默選最後一筆商品身分", async () => {
    await expect(syncCyberbizProducts(db, [
      { sku: "DUP-1", productId: "p1", variantId: "v1", productName: "商品一" },
      { sku: "dup-1", productId: "p2", variantId: "v2", productName: "商品二" },
    ])).rejects.toThrow("重複 SKU");
    expect(await db.select().from(items)).toHaveLength(0);
  });

  it("CYBERBIZ 同步不會改寫既有品項的 external identity", async () => {
    await db.insert(items).values({ id: "linked-1", source: "cyberbiz", kind: "sellable", sku: "STABLE-1", name: "既有商品", active: 1 });
    await db.insert(cyberbizProducts).values({
      itemId: "linked-1",
      cyberbizProductId: "old-product",
      cyberbizVariantId: "old-variant",
      productName: "既有商品",
      variantName: "規格",
      published: 1,
      rawJson: "{}",
    });

    await expect(syncCyberbizProducts(db, [{
      sku: "STABLE-1",
      productId: "new-product",
      variantId: "new-variant",
      productName: "不應覆蓋",
    }])).rejects.toThrow("已連結其他商品身分");
    expect(await db.select({ productId: cyberbizProducts.cyberbizProductId, variantId: cyberbizProducts.cyberbizVariantId })
      .from(cyberbizProducts)
      .where(eq(cyberbizProducts.itemId, "linked-1")))
      .toEqual([{ productId: "old-product", variantId: "old-variant" }]);
  });

  it("CYBERBIZ 同步不覆寫 kind 與 active", async () => {
    await db.insert(items).values({ id: "i3", source: "custom", kind: "supply", sku: "ABX3", name: "護髮素軟管", active: 0 });

    await syncCyberbizProducts(db, [{ sku: "ABX3", productId: "p3", variantId: "v3", productName: "護髮素軟管" }]);

    const [row] = await db.select().from(items).where(eq(items.sku, "ABX3"));
    // source 會被接管（官網開始賣它了），但 kind 與 active 是我們的判斷。
    expect(row).toMatchObject({ id: "i3", source: "cyberbiz", kind: "supply", active: 0, name: "護髮素軟管" });
  });
});

/*
 * 分類的建立、改名與刪除原本有兩套實作：/api/items/categories 與已經移除的
 * /api/tools/product-categories。後者的選單入口在 schema 改造那一輪就拿掉了，但
 * 它的測試是唯一在守「分類還在用就不能刪」的地方——實作留一套，保護也要留著。
 */
describe("品項分類", () => {
  async function call(pathname: string, init?: RequestInit) {
    const admin = await seedAdmin(`admin-${crypto.randomUUID()}@ecotech.tw`);
    const token = await signSession(newSessionClaims({ id: admin.id, email: admin.email, name: admin.email, pictureUrl: "" }), SECRET);
    return app.fetch(new Request(`https://test.local${pathname}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    }), env() as never);
  }

  async function categoryRows() {
    const response = await call("/api/items/categories");
    return ((await response.json()) as { categories: Array<{ id: string; name: string; usageCount: number; color: string }> }).categories;
  }

  it("同一層級不能有兩個同名分類", async () => {
    const response = await call("/api/items/categories", { method: "POST", body: JSON.stringify({ name: "包材" }) });
    expect(response.status).toBe(409);
  });

  it("還有品項在用的分類刪不掉，清空之後才刪得掉", async () => {
    const item = await createItem({ name: "禮盒紙盒", categoryId: "cat-1" });
    expect(item.status).toBe(201);
    const itemId = ((await item.json()) as { id: string }).id;

    expect((await categoryRows()).find((row) => row.id === "cat-1")?.usageCount).toBe(1);
    expect((await call("/api/items/categories/cat-1", { method: "DELETE" })).status).toBe(409);

    // 把品項移出分類就刪得掉——是「先清空再刪」，不是連坐把品項一起刪掉。
    expect((await call(`/api/items/catalog/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "禮盒紙盒", kind: "supply", categoryId: null }),
    })).status).toBe(200);
    expect((await call("/api/items/categories/cat-1", { method: "DELETE" })).status).toBe(200);
    expect((await categoryRows()).some((row) => row.id === "cat-1")).toBe(false);
    expect((await db.select().from(items).where(eq(items.id, itemId)))).toHaveLength(1);
  });

  // 分類的寫入是需要授權的操作，所以要查得到是誰做的。被移除那一側原本有寫，
  // 合併時差點掉在地上。
  it("建立、改名與刪除分類都留下操作紀錄", async () => {
    expect((await call("/api/items/categories", { method: "POST", body: JSON.stringify({ name: "新分類" }) })).status).toBe(201);
    expect((await call("/api/items/categories/cat-1", { method: "PATCH", body: JSON.stringify({ name: "包材（改名）" }) })).status).toBe(200);
    expect((await call("/api/items/categories/cat-1", { method: "DELETE" })).status).toBe(200);

    const events = await db.select().from(activityEvents).where(eq(activityEvents.entityType, "item_category"));
    expect(events.map((row) => row.eventType).sort()).toEqual([
      "item_category_created", "item_category_deleted", "item_category_updated",
    ]);
    // 刪掉之後 join 不回名字，所以標籤要當場存下來。
    expect(events.find((row) => row.eventType === "item_category_deleted")?.entityLabel).toBe("包材（改名）");

    // 刪不存在的分類是 404，不會留下一筆「刪了一個沒有的分類」。
    expect((await call("/api/items/categories/cat-1", { method: "DELETE" })).status).toBe(404);
    expect(await db.select().from(activityEvents).where(eq(activityEvents.entityType, "item_category"))).toHaveLength(3);
  });

  it("換分類的紀錄兩邊都存名字，不是一邊 ID 一邊名字", async () => {
    await db.insert(itemCategories).values({ id: "cat-2", depth: 0, name: "香氛", color: "sky", sortOrder: 1, active: 1 });
    const item = await createItem({ name: "換分類的品項", categoryId: "cat-1" });
    const itemId = ((await item.json()) as { id: string }).id;

    expect((await call(`/api/items/catalog/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "換分類的品項", categoryId: "cat-2" }),
    })).status).toBe(200);

    const [event] = await db.select().from(activityEvents).where(eq(activityEvents.field, "category"));
    expect(event).toMatchObject({ oldValue: "包材", newValue: "香氛" });
  });

  it("改名不會動到品項與它的分類關聯", async () => {
    expect((await createItem({ name: "包材品項", categoryId: "cat-1" })).status).toBe(201);

    expect((await call("/api/items/categories/cat-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "包材（改名）", color: "amber" }),
    })).status).toBe(200);

    expect((await categoryRows()).find((row) => row.id === "cat-1"))
      .toMatchObject({ name: "包材（改名）", color: "amber", usageCount: 1 });
  });
});
