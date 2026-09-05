import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { itemCategories, items, users, userRoles } from "@rueisiang/db/schema";
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
  await db.insert(userRoles).values({ userId: id, roleId: "role-admin" });
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
});
