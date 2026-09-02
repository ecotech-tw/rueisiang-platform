import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import {
  createDatabase,
  createReportManualSales,
  createReportProductCategory,
  deleteReportProductCategory,
  listCyberbizProductCategoryManagement,
  setCyberbizProductCategory,
  syncSystemRoles,
  updateReportProductCategory,
  upsertReportScope,
  type Database,
} from "@rueisiang/db";
import {
  activityEvents,
  cyberbizProductCategories,
  cyberbizProducts,
  reportProductCategories,
  reportManualSalesMonthly,
  users,
  userRoles,
} from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "test-secret-test-secret-test-secret";
const SCOPE_ID = "cyberbiz:store:product-category-test";

let d1: LocalD1;
let db: Database;

beforeEach(async () => {
  d1 = createLocalD1();
  db = createDatabase(d1 as never);
  await syncSystemRoles(db);
});

async function seedUser(email: string, roleId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, email, displayName: email, status: "active" });
  await db.insert(userRoles).values({ userId: id, roleId });
  return id;
}

async function as(userId: string, email: string, path: string, init: RequestInit = {}): Promise<Response> {
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
    {
      DB: d1,
      AUTH_SESSION_SECRET: SECRET,
      GOOGLE_OAUTH_CLIENT_ID: "test-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "test-secret",
    } as never,
  );
}

async function seedCategory(id: string, name: string) {
  await db.insert(reportProductCategories).values({ id, name, color: "rose" });
}

async function seedCyberbizProduct(sku: string, productName: string, variantName = "") {
  await db.insert(cyberbizProducts).values({
    sku,
    productId: `product-${sku}`,
    variantId: `variant-${sku}`,
    productName,
    variantName,
    published: 1,
  });
}

describe("CYBERBIZ 商品分類資料層", () => {
  it("以 CYBERBIZ 商品目錄列出全部 SKU，並可設定或清除分類", async () => {
    await seedCategory("category-bath", "沐浴清潔");
    await seedCategory("category-scent", "香氛品味");
    await seedCyberbizProduct("SKU-A", "沐浴清潔");
    await seedCyberbizProduct("SKU-B", "香氛禮盒", "經典款");

    const actor = { id: "admin", email: "admin@example.com" };
    const assigned = await setCyberbizProductCategory(db, {
      sku: " sku-a ",
      categoryId: "category-bath",
      actor,
    });

    expect(assigned).toEqual({ sku: "SKU-A", categoryId: "category-bath", categoryName: "沐浴清潔" });
    expect(await db.select().from(cyberbizProductCategories)).toHaveLength(1);

    const management = await listCyberbizProductCategoryManagement(db);
    expect(management.products).toEqual([
      {
        sku: "SKU-A",
        name: "沐浴清潔",
        published: true,
        categoryId: "category-bath",
        categoryName: "沐浴清潔",
        categoryColor: "rose",
      },
      {
        sku: "SKU-B",
        name: "香氛禮盒（經典款）",
        published: true,
        categoryId: null,
        categoryName: null,
        categoryColor: null,
      },
    ]);
    expect(management.categories).toEqual([
      { id: "category-bath", name: "沐浴清潔", color: "rose", skuCount: 1, customProductCount: 0, usageCount: 1 },
      { id: "category-scent", name: "香氛品味", color: "rose", skuCount: 0, customProductCount: 0, usageCount: 0 },
    ]);

    await setCyberbizProductCategory(db, { sku: "SKU-A", categoryId: null, actor });
    expect(await db.select().from(cyberbizProductCategories)).toHaveLength(0);
    expect(await db.select().from(activityEvents).where(eq(activityEvents.entityType, "cyberbiz_product_category")))
      .toHaveLength(2);
  });

  it("商品分類主檔可以獨立 CRUD，且刪除會檢查現行使用量", async () => {
    const actor = { id: "admin", email: "admin@example.com" };
    const created = await createReportProductCategory(db, { name: "生活用品", color: "sky", actor });
    expect(created).toMatchObject({ name: "生活用品", color: "sky" });

    const updated = await updateReportProductCategory(db, created.id, { name: "生活日用", color: "mint", actor });
    expect(updated).toEqual({ id: created.id, name: "生活日用", color: "mint" });
    await deleteReportProductCategory(db, created.id, actor);
    expect(await db.select().from(reportProductCategories)).toEqual([]);

    await seedCategory("category-used", "已使用");
    await seedCyberbizProduct("SKU-USED", "使用中的商品");
    await setCyberbizProductCategory(db, { sku: "SKU-USED", categoryId: "category-used", actor });
    await expect(deleteReportProductCategory(db, "category-used", actor)).rejects.toThrow("仍被");
  });

  it("人工報表以當下分類名稱寫入快照，未指定就寫未分類", async () => {
    await upsertReportScope(db, { id: SCOPE_ID, scopeKind: "store", name: "分類測試店" });
    await seedCategory("category-bath", "沐浴清潔");
    const actor = { id: "admin", email: "admin@example.com" };

    const categorized = await createReportManualSales(db, {
      scopeId: SCOPE_ID,
      reportMonth: "2026-08",
      skuSource: "custom",
      sku: "removed-bath",
      productName: "已下架沐浴組",
      category: "這個值不應直接寫入",
      categoryId: "category-bath",
      grossQuantity: 10,
      returnQuantity: 1,
      netQuantity: 9,
      salesAmount: 900,
      actor,
    });
    const uncategorized = await createReportManualSales(db, {
      scopeId: SCOPE_ID,
      reportMonth: "2026-08",
      skuSource: "custom",
      sku: "removed-other",
      productName: "已下架特別商品",
      categoryId: null,
      grossQuantity: 1,
      returnQuantity: 0,
      netQuantity: 1,
      salesAmount: 100,
      actor,
    });

    expect(categorized.category).toBe("沐浴清潔");
    expect(uncategorized.category).toBe("未分類");
    expect(await db.select({ category: reportManualSalesMonthly.category }).from(reportManualSalesMonthly))
      .toEqual([{ category: "沐浴清潔" }, { category: "未分類" }]);
  });
});

describe("CYBERBIZ 商品分類 API 權限", () => {
  it("預設只讓管理者讀寫商品分類", async () => {
    await seedCategory("category-bath", "沐浴清潔");
    await seedCyberbizProduct("SKU-A", "沐浴清潔");
    const adminId = await seedUser("category-admin@example.com", "role-admin");
    const managerId = await seedUser("category-manager@example.com", "role-manager");

    const adminRead = await as(adminId, "category-admin@example.com", "/api/tools/product-categories");
    expect(adminRead.status).toBe(200);
    expect(await adminRead.json()).toMatchObject({
      products: [expect.objectContaining({ sku: "SKU-A", categoryName: null })],
    });

    const managerRead = await as(managerId, "category-manager@example.com", "/api/tools/product-categories");
    expect(managerRead.status).toBe(403);

    const adminWrite = await as(adminId, "category-admin@example.com", "/api/tools/product-categories/SKU-A", {
      method: "PUT",
      body: JSON.stringify({ categoryId: "category-bath" }),
    });
    expect(adminWrite.status).toBe(200);
    expect(await adminWrite.json()).toEqual({
      sku: "SKU-A",
      categoryId: "category-bath",
      categoryName: "沐浴清潔",
    });

    const managerWrite = await as(managerId, "category-manager@example.com", "/api/tools/product-categories/SKU-A", {
      method: "PUT",
      body: JSON.stringify({ categoryId: null }),
    });
    expect(managerWrite.status).toBe(403);
  });
});
