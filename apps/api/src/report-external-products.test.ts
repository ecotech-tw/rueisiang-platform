import {
  addProductSkuMapping,
  addReportSkuIgnore,
  createDatabase,
  createReportProductCategory,
  deleteProductSkuMapping,
  ignoreReportExternalProduct,
  deleteReportProductCategory,
  listCyberbizProductCategoryManagement,
  listProductCategoryOptions,
  loadProductSkuMappingManagement,
  resolveProductSkus,
  resolveReportExternalProduct,
  schema,
  setCyberbizProductCategory,
  unignoreReportExternalProduct,
  updateProductSkuMapping,
  updateReportProductCategory,
} from "@rueisiang/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

let d1: LocalD1;
function db() { return createDatabase(d1 as never); }
const ACTOR = { id: "external-product-test", email: "manager@example.com" };

beforeEach(() => {
  d1 = createLocalD1();
});

describe("報表外部商品管理", () => {
  it("可以對應、忽略與取消忽略外部商品", async () => {
    const itemId = "external-product-item";
    await db().insert(schema.items).values({ id: itemId, source: "custom", kind: "sellable", sku: "ITEM-001", name: "測試品項", active: 1 });
    await db().insert(schema.reportExternalProducts).values({
      id: "external-product-1",
      sourceType: "cyberbiz",
      externalKey: "EXT-001",
      externalVariantKey: "",
      externalName: "外部測試商品",
      resolution: "ignored",
      itemId: null,
      ignoredReason: "待確認",
    });

    const resolved = await resolveReportExternalProduct(db(), { id: "external-product-1", itemId, actor: ACTOR });
    expect(resolved).toMatchObject({ resolution: "mapped", itemId, ignoredReason: "" });

    const ignored = await ignoreReportExternalProduct(db(), { id: resolved.id, reason: "不納入統計", actor: ACTOR });
    expect(ignored).toMatchObject({ resolution: "ignored", itemId: null, ignoredReason: "不納入統計" });

    await unignoreReportExternalProduct(db(), { id: resolved.id, actor: ACTOR });
    expect(await db().select().from(schema.reportExternalProducts).where(eq(schema.reportExternalProducts.id, resolved.id))).toEqual([]);
  });

  it("刪除 legacy 分類表後仍能管理 target CYBERBIZ 商品分類", async () => {
    const itemId = "target-cyberbiz-item";
    await db().insert(schema.items).values({ id: itemId, source: "cyberbiz", kind: "sellable", sku: "CB-TARGET-001", name: "Target 官網商品", active: 1 });
    await db().insert(schema.targetCyberbizProducts).values({
      itemId, cyberbizProductId: "target-product", cyberbizVariantId: "target-variant", productName: "Target 官網商品", variantName: "大包裝", published: 1,
    });
    await d1.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE report_product_categories;
      DROP TABLE cyberbiz_product_categories;
      DROP TABLE cyberbiz_products_legacy;
      DROP TRIGGER IF EXISTS trg_cyberbiz_products_compat_insert;
      DROP TRIGGER IF EXISTS trg_cyberbiz_products_compat_update;
      DROP VIEW cyberbiz_products_compat;
      PRAGMA foreign_keys = ON;
    `);

    const created = await createReportProductCategory(db(), { name: "Target 分類", color: "teal", actor: ACTOR });
    expect(created).toMatchObject({ name: "Target 分類", color: "teal" });
    expect(await setCyberbizProductCategory(db(), { sku: "CB-TARGET-001", categoryId: created.id, actor: ACTOR }))
      .toMatchObject({ sku: "CB-TARGET-001", categoryId: created.id, categoryName: "Target 分類" });
    expect((await listCyberbizProductCategoryManagement(db())).products).toMatchObject([{
      sku: "CB-TARGET-001", name: "Target 官網商品（大包裝）", categoryId: created.id, categoryName: "Target 分類",
    }]);
    expect(await listProductCategoryOptions(db())).toMatchObject([{
      id: created.id, name: "Target 分類", color: "teal", skuCount: 1, usageCount: 1,
    }]);

    const updated = await updateReportProductCategory(db(), created.id, { name: "Target 分類修訂", color: "amber", actor: ACTOR });
    expect(updated).toMatchObject({ id: created.id, name: "Target 分類修訂", color: "amber" });
    expect((await listCyberbizProductCategoryManagement(db())).products[0]).toMatchObject({ categoryName: "Target 分類修訂" });
    await expect(deleteReportProductCategory(db(), created.id, ACTOR)).rejects.toMatchObject({ kind: "conflict" });
    await setCyberbizProductCategory(db(), { sku: "CB-TARGET-001", categoryId: null, actor: ACTOR });
    await deleteReportProductCategory(db(), created.id, ACTOR);
    expect(await db().select().from(schema.itemCategories)).toEqual([]);
  });

  it("target mapping 可用 item_components 保存多用料 BOM，解析與忽略都不依賴 legacy 表", async () => {
    await d1.exec("PRAGMA foreign_keys = OFF; DROP TABLE product_sku_mappings; DROP TABLE product_bundle_components; DROP TABLE custom_report_products; DROP TABLE report_sku_ignores; PRAGMA foreign_keys = ON;");

    const created = await addProductSkuMapping(db(), {
      channel: "Shopee", externalName: "Target 組合商品", externalSku: "target-bundle-001",
      components: [
        { customSku: "TARGET-COMPONENT-A", customName: "Target 用料 A", customCategory: "未分類", quantity: 2 },
        { customSku: "TARGET-COMPONENT-B", customName: "Target 用料 B", customCategory: "未分類", quantity: 1 },
      ], actor: ACTOR,
    });
    expect((await loadProductSkuMappingManagement(db())).mappings).toMatchObject([{
      id: created.id,
      externalSku: "TARGET-BUNDLE-001",
      components: [
        { source: "custom", sku: "TARGET-COMPONENT-A", name: "Target 用料 A", quantity: 2 },
        { source: "custom", sku: "TARGET-COMPONENT-B", name: "Target 用料 B", quantity: 1 },
      ],
    }]);
    expect(await resolveProductSkus(db(), ["TARGET-BUNDLE-001"], "shopee")).toMatchObject(new Map([
      ["TARGET-BUNDLE-001", {
        externalName: "Target 組合商品",
        components: [
          { sku: "TARGET-COMPONENT-A", quantity: 2 },
          { sku: "TARGET-COMPONENT-B", quantity: 1 },
        ],
      }],
    ]));

    await addReportSkuIgnore(db(), { channel: "shopee", externalSku: "TARGET-BUNDLE-001", reason: "補寄用", actor: ACTOR });
    expect(await resolveProductSkus(db(), ["TARGET-BUNDLE-001"], "shopee")).toEqual(new Map());
  });

  it("刪除 legacy mapping 表後仍能管理 target 單一用料 mapping", async () => {
    const wmsItemId = "target-wms-item";
    await db().insert(schema.items).values({ id: wmsItemId, source: "custom", kind: "sellable", sku: "WMS-TARGET-001", name: "WMS Target 商品", active: 1 });
    await db().insert(schema.wmsItems).values({ itemId: wmsItemId, quantity: 4, unit: "件", minStock: 1, notes: "" });
    await d1.exec("PRAGMA foreign_keys = OFF; DROP TABLE product_sku_mappings; DROP TABLE product_bundle_components; DROP TABLE custom_report_products; DROP TABLE report_sku_ignores; PRAGMA foreign_keys = ON;");

    const created = await addProductSkuMapping(db(), {
      channel: "Shopee", externalName: "Target 外部商品", externalSku: "target-ext-001",
      components: [{ customSku: "TARGET-CUSTOM-001", customName: "Target 自訂用料", customCategory: "未分類", quantity: 1 }], actor: ACTOR,
    });
    expect(created).toMatchObject({ channel: "shopee", externalSku: "TARGET-EXT-001" });
    const createdManagement = await loadProductSkuMappingManagement(db());
    expect(createdManagement.mappings).toMatchObject([{
      id: created.id,
      channel: "shopee",
      components: [{ source: "custom", sku: "TARGET-CUSTOM-001", name: "Target 自訂用料", quantity: 1 }],
    }]);

    const updated = await updateProductSkuMapping(db(), {
      id: created.id, channel: "shopee", externalName: "Target 外部商品修訂", externalSku: "target-ext-002",
      components: [{ inventoryItemId: wmsItemId, quantity: 1 }], actor: ACTOR,
    });
    expect(updated).toMatchObject({ id: created.id, externalSku: "TARGET-EXT-002" });
    expect((await loadProductSkuMappingManagement(db())).mappings).toMatchObject([{
      id: created.id,
      externalSku: "TARGET-EXT-002",
      components: [{ source: "item", inventoryItemId: wmsItemId, sku: "WMS-TARGET-001", quantity: 1 }],
    }]);

    await deleteProductSkuMapping(db(), created.id, ACTOR);
    expect((await loadProductSkuMappingManagement(db())).mappings).toEqual([]);
  });
});
