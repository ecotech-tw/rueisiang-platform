import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, createReportManualSales, syncCyberbizProducts, syncSystemRoles } from "@rueisiang/db";
import { itemCategories, items, scopes, users, userRoleAssignments } from "@rueisiang/db/schema";
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

  it("CYBERBIZ 同步不覆寫 kind 與 active", async () => {
    await db.insert(items).values({ id: "i3", source: "custom", kind: "supply", sku: "ABX3", name: "護髮素軟管", active: 0 });

    await syncCyberbizProducts(db, [{ sku: "ABX3", productId: "p3", variantId: "v3", productName: "護髮素軟管" }]);

    const [row] = await db.select().from(items).where(eq(items.sku, "ABX3"));
    // source 會被接管（官網開始賣它了），但 kind 與 active 是我們的判斷。
    expect(row).toMatchObject({ id: "i3", source: "cyberbiz", kind: "supply", active: 0, name: "護髮素軟管" });
  });
});

