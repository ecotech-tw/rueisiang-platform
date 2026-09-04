import {
  createDatabase,
  createReportManualPayout,
  createReportManualSales,
  insertReportPayoutDaily,
  insertReportSalesMonthly,
  listCompanyLinks,
  loadWarehouse,
  processProductWebhook,
  queryReportPayout,
  queryReportSales,
  syncCyberbizProducts,
  upsertReportScope,
} from "@rueisiang/db";
import { items, wmsCyberbizLinks, wmsItems } from "@rueisiang/db/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTargetOnlyD1 } from "./local-d1/d1.js";

/** target schema 正式切換前的 destructive smoke：刪掉所有已搬移的 legacy 來源後再走一次主要流程。 */
async function dropMigratedLegacyTables(d1: ReturnType<typeof createTargetOnlyD1>) {
  await d1.exec(`
    PRAGMA foreign_keys = OFF;
    DROP VIEW IF EXISTS cyberbiz_products_compat;
    DROP TRIGGER IF EXISTS trg_cyberbiz_products_compat_insert;
    DROP TRIGGER IF EXISTS trg_cyberbiz_products_compat_update;
    DROP TABLE IF EXISTS cyberbiz_product_links;
    DROP TABLE IF EXISTS zone_images;
    DROP TABLE IF EXISTS product_bundle_components;
    DROP TABLE IF EXISTS cyberbiz_product_categories;
    DROP TABLE IF EXISTS product_sku_mappings;
    DROP TABLE IF EXISTS report_sku_ignores;
    DROP TABLE IF EXISTS custom_report_products;
    DROP TABLE IF EXISTS cyberbiz_products_legacy;
    DROP TABLE IF EXISTS report_sales_monthly;
    DROP TABLE IF EXISTS report_payout_daily;
    DROP TABLE IF EXISTS report_manual_sales_monthly;
    DROP TABLE IF EXISTS report_manual_payout_daily;
    DROP TABLE IF EXISTS report_scopes;
    DROP TABLE IF EXISTS report_product_categories;
    DROP TABLE IF EXISTS cyberbiz_report_runs;
    DROP TABLE IF EXISTS inventory_items;
    DROP TABLE IF EXISTS zones;
    DROP TABLE IF EXISTS warehouse_categories;
    DROP TABLE IF EXISTS warehouse_settings;
    DROP TABLE IF EXISTS layout_elements;
    PRAGMA foreign_keys = ON;
  `);
}

describe("target-only destructive integration", () => {
  it("移除 legacy report/WMS 表後仍可匯入、查詢、人工修訂與同步", async () => {
    const d1 = createTargetOnlyD1();
    const db = createDatabase(d1 as never);
    const scopeId = "cyberbiz:store:target-only";
    const actor = { id: "target-only-user", email: "target-only@example.com" };

    await db.insert(items).values({
      id: "target-wms-item",
      source: "custom",
      kind: "sellable",
      sku: "TARGET-WMS",
      name: "Target 倉儲商品",
      active: 1,
    });
    await db.insert(wmsItems).values({ itemId: "target-wms-item", quantity: 7, minStock: 2, unit: "件", notes: "" });
    await db.insert(wmsCyberbizLinks).values({
      id: "target-only-link",
      wmsItemId: "target-wms-item",
      cyberbizProductId: "target-product",
      cyberbizVariantId: "target-variant",
      sku: "TARGET-WMS",
    });
    await dropMigratedLegacyTables(d1);

    await upsertReportScope(db, { id: scopeId, scopeKind: "store", name: "Target-only 測試" });
    await syncCyberbizProducts(db, [{
      sku: "TARGET-CYBERBIZ",
      productId: "target-cyberbiz-product",
      variantId: "target-cyberbiz-variant",
      productName: "Target 官網商品",
    }]);
    await insertReportSalesMonthly(db, [
      { scopeId, reportMonth: "2026-09", sku: "TARGET-WMS", productName: "歷史名稱", category: "未分類", grossQuantity: 2, returnQuantity: 0, netQuantity: 2, salesAmount: 200 },
      { scopeId, reportMonth: "2026-09", sku: "TARGET-CYBERBIZ", productName: "歷史名稱", category: "未分類", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 80 },
    ]);
    await insertReportPayoutDaily(db, [{ scopeId, businessDate: "2026-09-01", payoutAmount: 50 }]);
    await createReportManualSales(db, {
      scopeId,
      reportMonth: "2026-09",
      skuSource: "custom",
      sku: "TARGET-MANUAL",
      productName: "Target 人工商品",
      grossQuantity: 1,
      returnQuantity: 0,
      netQuantity: 1,
      salesAmount: 70,
      actor,
    });
    await createReportManualPayout(db, { scopeId, businessDate: "2026-09-02", payoutAmount: 60, actor });

    const sales = await queryReportSales(db, {
      range: { period: "2026-09", startDate: "2026-09-01", endDate: "2026-09-30" },
      scopeType: "store",
      scopeId,
      groupBy: ["sku"],
    });
    expect(sales?.totals).toEqual({ grossQuantity: 4, returnQuantity: 0, netQuantity: 4, salesAmount: 350 });
    expect((await queryReportPayout(db, {
      range: { period: "2026-09", startDate: "2026-09-01", endDate: "2026-09-30" },
      scopeType: "store",
      scopeId,
      groupBy: ["day"],
    }))?.totals).toEqual({ payoutAmount: 110 });

    expect(await listCompanyLinks(db)).toMatchObject([{
      linkId: "target-only-link",
      inventoryItemId: "target-wms-item",
      itemSku: "TARGET-WMS",
      quantity: 7,
      minStock: 2,
    }]);
    expect((await loadWarehouse(db)).items.find((item) => item.id === "target-wms-item")?.cyberbiz).toMatchObject({
      cyberbizProductId: "target-product",
      cyberbizVariantId: "target-variant",
    });
    const webhook = await processProductWebhook(db, {
      rawBody: JSON.stringify({ variant_id: "target-variant", sku: "TARGET-WMS" }),
      topic: "variants/update",
      client: { fetchProduct: async () => [{ productId: "target-product", variantId: "target-variant", sku: "TARGET-WMS", quantity: 9, safetyQuantity: 3 }] } as never,
    });
    expect(webhook).toMatchObject({ status: "processed", sync: { updated: 1, failed: 0 } });
    expect((await db.select().from(wmsItems)).find((item) => item.itemId === "target-wms-item"))
      .toMatchObject({ quantity: 9, minStock: 3 });
    expect((await db.select({ sku: items.sku }).from(items).where(eq(items.source, "cyberbiz")))).toEqual([{ sku: "TARGET-CYBERBIZ" }]);
  });
});
