import {
  addProductSkuMapping,
  addReportSkuIgnore,
  createDatabase,
  deleteProductSkuMapping,
  ignoreReportExternalProduct,
  listProductCategoryOptions,
  loadProductSkuMappingManagement,
  resolveProductSkus,
  resolveReportExternalProduct,
  schema,
  unignoreReportExternalProduct,
  updateProductSkuMapping,
} from "@rueisiang/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

let d1: LocalD1;
function db() { return createDatabase(d1 as never); }
const ACTOR = { id: "external-product-test", email: "manager@example.com" };

beforeEach(() => {
  d1 = createLocalD1(":memory:", { targetOnly: true });
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

  // 分類的建立、改名與刪除改由 /api/items/categories 那一組負責（見
  // items-catalog.test.ts 的「品項分類」）。這裡只留下報表這一側真正在用的東西：
  // 分類選項的計數。
  it("忽略已有 parent 快照的組合商品時保留停用 parent", async () => {
    const created = await addProductSkuMapping(db(), {
      channel: "Shopee", externalName: "有歷史的組合", externalSku: "HISTORICAL-BUNDLE",
      components: [{ customSku: "HISTORICAL-COMPONENT", customName: "歷史用料", customCategory: "未分類", quantity: 2 }], actor: ACTOR,
    });
    const parentId = `report-bundle:${created.id}`;
    await db().insert(schema.scopes).values({ id: "bundle-history-scope", sourceType: "shopee", scopeKind: "store", name: "歷史蝦皮", normalizedName: "歷史蝦皮" });
    await db().insert(schema.reportRuns).values({
      id: "bundle-history-run", requestId: "bundle-history-request", sourceType: "shopee", importsSales: 1,
      periodKind: "month", startDate: "2026-07-01", endDate: "2026-07-31", status: "succeeded", actorEmail: ACTOR.email,
    });
    await db().insert(schema.reportBundleSalesMonthly).values({
      scopeId: "bundle-history-scope", reportMonth: "2026-07", externalSku: "HISTORICAL-BUNDLE", itemId: parentId, reportRunId: "bundle-history-run",
      grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 100,
    });

    await ignoreReportExternalProduct(db(), { id: created.id, reason: "停用", actor: ACTOR });
    expect(await db().select({ active: schema.items.active }).from(schema.items).where(eq(schema.items.id, parentId))).toEqual([{ active: 0 }]);
    expect(await db().select().from(schema.itemComponents).where(eq(schema.itemComponents.parentItemId, parentId))).toEqual([]);
  });

  it("刪除 legacy 分類表後仍能算出 target CYBERBIZ 商品的分類選項", async () => {
    const itemId = "target-cyberbiz-item";
    await db().insert(schema.itemCategories).values({ id: "target-category", depth: 0, name: "Target 分類", color: "teal" });
    await db().insert(schema.items).values({
      id: itemId, source: "cyberbiz", kind: "sellable", sku: "CB-TARGET-001",
      name: "Target 官網商品", active: 1, categoryId: "target-category",
    });
    await db().insert(schema.cyberbizProductCatalog).values({
      itemId, cyberbizProductId: "target-product", cyberbizVariantId: "target-variant", productName: "Target 官網商品", variantName: "大包裝", published: 1,
    });

    expect(await listProductCategoryOptions(db())).toMatchObject([{
      id: "target-category", name: "Target 分類", color: "teal", skuCount: 1, usageCount: 1,
    }]);
  });

  it("target mapping 可用 item_components 保存多用料 BOM，解析與忽略都不依賴 legacy 表", async () => {
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

  it("target mapping 可管理 target 單一用料 mapping", async () => {
    const wmsItemId = "target-wms-item";
    await db().insert(schema.items).values({ id: wmsItemId, source: "custom", kind: "sellable", sku: "WMS-TARGET-001", name: "WMS Target 商品", active: 1 });
    await db().insert(schema.wmsItems).values({ itemId: wmsItemId, quantity: 4, unit: "件", minStock: 1, notes: "" });

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
