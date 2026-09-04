import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migrationFiles = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

/** 照 D1 的方式套用：每一支 migration 都在自己的 transaction 內完成。 */
function applyLikeD1(sqlite: DatabaseSync, from: string | null, to: string): void {
  for (const file of migrationFiles) {
    if (from && file <= from) continue;
    if (file > to) break;
    sqlite.exec("BEGIN;");
    for (const statement of readFileSync(path.join(migrationsDir, file), "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
    sqlite.exec("COMMIT;");
  }
}

describe("報表 scope migration", () => {
  it("0050 會用與 normalizeReportScopeName 一致的規則移除全形空白", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0049_unify_report_manifests.sql");
    sqlite.prepare(
      "INSERT INTO report_scopes (id, scope_kind, name, normalized_name, active) VALUES (?, ?, ?, ?, ?)",
    ).run("cyberbiz:store:full-width", "store", "誠品西門店　ABC", "舊的正規化值", 1);

    applyLikeD1(sqlite, "0049_unify_report_manifests.sql", "0050_recompute_report_scope_names.sql");

    expect(sqlite.prepare("SELECT normalized_name FROM report_scopes WHERE id = ?").get("cyberbiz:store:full-width"))
      .toEqual({ normalized_name: "誠品西門店abc" });
  });

  it("0051 建月表、0052 彙總日資料、0053 才刪除舊表，且歷史資料保留", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0049_unify_report_manifests.sql");
    sqlite.prepare(`
      INSERT INTO report_sales_daily (
        scope_id, business_date, sku, product_name, category,
        gross_quantity, return_quantity, net_quantity, sales_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("cyberbiz:store:test", "2026-07-01", "SKU-1", "商品一", "沐浴", 3, 1, 2, 180);
    sqlite.prepare(`
      INSERT INTO report_sales_daily (
        scope_id, business_date, sku, product_name, category,
        gross_quantity, return_quantity, net_quantity, sales_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("cyberbiz:store:test", "2026-07-31", "SKU-1", "商品一", "沐浴", 2, 0, 2, 200);

    applyLikeD1(sqlite, "0049_unify_report_manifests.sql", "0051_add_report_sales_monthly.sql");
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_sales_monthly'").get())
      .toEqual({ name: "report_sales_monthly" });
    applyLikeD1(sqlite, "0051_add_report_sales_monthly.sql", "0052_move_report_sales_daily_to_monthly.sql");
    expect(sqlite.prepare("SELECT scope_id, report_month, sku, gross_quantity, net_quantity, sales_amount FROM report_sales_monthly").get())
      .toEqual({ scope_id: "cyberbiz:store:test", report_month: "2026-07", sku: "SKU-1", gross_quantity: 5, net_quantity: 4, sales_amount: 380 });

    applyLikeD1(sqlite, "0052_move_report_sales_daily_to_monthly.sql", "0053_drop_report_sales_daily.sql");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM report_sales_monthly").get()).toEqual({ count: 1 });
    expect(() => sqlite.prepare("SELECT COUNT(*) FROM report_sales_daily").get()).toThrow();
  });

  it("0054 會把沒有歧義的既有 CYBERBIZ 商品連結轉成外部 SKU 對應", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0053_drop_report_sales_daily.sql");
    sqlite.prepare("INSERT INTO inventory_items (id, sku, name) VALUES (?, ?, ?)")
      .run("item-1", "WMS-001", "商品一");
    sqlite.prepare(`
      INSERT INTO cyberbiz_product_links (
        id, inventory_item_id, cyberbiz_product_id, cyberbiz_variant_id, sku
      ) VALUES (?, ?, ?, ?, ?)
    `).run("link-1", "item-1", "product-1", "variant-1", " cb-001 ");

    applyLikeD1(sqlite, "0053_drop_report_sales_daily.sql", "0054_add_product_sku_mappings.sql");

    expect(sqlite.prepare("SELECT inventory_item_id, external_sku FROM product_sku_mappings").all())
      .toEqual([{ inventory_item_id: "item-1", external_sku: "CB-001" }]);
  });

  it("0055 保留既有 mapping 並以 legacy 作為未分類通路", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0054_add_product_sku_mappings.sql");
    sqlite.prepare("INSERT INTO inventory_items (id, sku, name) VALUES (?, ?, ?)")
      .run("item-1", "WMS-001", "商品一");
    sqlite.prepare("INSERT INTO inventory_items (id, sku, name) VALUES (?, ?, ?)")
      .run("item-2", "WMS-002", "商品二");
    sqlite.prepare("INSERT INTO product_sku_mappings (id, inventory_item_id, external_sku) VALUES (?, ?, ?)")
      .run("legacy-mapping", "item-1", "SHARED-001");

    applyLikeD1(sqlite, "0054_add_product_sku_mappings.sql", "0055_add_product_sku_mapping_channel.sql");

    expect(sqlite.prepare("SELECT inventory_item_id, channel, external_sku FROM product_sku_mappings").all())
      .toEqual([{ inventory_item_id: "item-1", channel: "legacy", external_sku: "SHARED-001" }]);
    sqlite.prepare("INSERT INTO product_sku_mappings (id, inventory_item_id, channel, external_sku) VALUES (?, ?, ?, ?)")
      .run("shopee-mapping", "item-2", "shopee", "SHARED-001");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM product_sku_mappings WHERE external_sku = ?").get("SHARED-001"))
      .toEqual({ count: 2 });
  });

  it("0056 建立組合用料表，mapping 刪除會 cascade、用料商品刪除會 restrict", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0055_add_product_sku_mapping_channel.sql");
    sqlite.prepare("INSERT INTO inventory_items (id, sku, name) VALUES (?, ?, ?)")
      .run("bundle", "BUNDLE-001", "組合商品");
    sqlite.prepare("INSERT INTO inventory_items (id, sku, name) VALUES (?, ?, ?)")
      .run("component", "ITEM-001", "組合用料");
    sqlite.prepare("INSERT INTO product_sku_mappings (id, inventory_item_id, channel, external_sku) VALUES (?, ?, ?, ?)")
      .run("mapping-1", "bundle", "shopee", "P-001_M-001");

    applyLikeD1(sqlite, "0055_add_product_sku_mapping_channel.sql", "0056_add_product_bundle_components.sql");
    sqlite.prepare("INSERT INTO product_bundle_components (mapping_id, inventory_item_id, quantity) VALUES (?, ?, ?)")
      .run("mapping-1", "component", 3);
    expect(sqlite.prepare("SELECT mapping_id, inventory_item_id, quantity FROM product_bundle_components").all())
      .toEqual([{ mapping_id: "mapping-1", inventory_item_id: "component", quantity: 3 }]);
    expect(() => sqlite.prepare("DELETE FROM inventory_items WHERE id = ?").run("component")).toThrow();
    sqlite.prepare("DELETE FROM product_sku_mappings WHERE id = ?").run("mapping-1");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM product_bundle_components").get())
      .toEqual({ count: 0 });
  });

  it("0057 會補回既有 mapping 的通路商品名稱與一對一用料", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0056_add_product_bundle_components.sql");
    sqlite.prepare("INSERT INTO inventory_items (id, sku, name) VALUES (?, ?, ?)")
      .run("item-1", "WMS-001", "WMS 商品一");
    sqlite.prepare("INSERT INTO product_sku_mappings (id, inventory_item_id, channel, external_sku) VALUES (?, ?, ?, ?)")
      .run("legacy-mapping", "item-1", "shopee", "PRODUCT-001");

    applyLikeD1(sqlite, "0056_add_product_bundle_components.sql", "0057_add_product_sku_mapping_name.sql");

    expect(sqlite.prepare("SELECT external_name FROM product_sku_mappings WHERE id = ?").get("legacy-mapping"))
      .toEqual({ external_name: "WMS 商品一" });
    expect(sqlite.prepare("SELECT mapping_id, inventory_item_id, quantity FROM product_bundle_components").all())
      .toEqual([{ mapping_id: "legacy-mapping", inventory_item_id: "item-1", quantity: 1 }]);
  });

  it("0059 只會替有 WMS SKU 或自訂 mapping 回填 system SKU", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0058_allow_custom_sku_mapping.sql");
    sqlite.prepare("INSERT INTO inventory_items (id, sku, name) VALUES (?, ?, ?)")
      .run("item-with-sku", "WMS-001", "WMS 商品");
    sqlite.prepare("INSERT INTO inventory_items (id, sku, name) VALUES (?, ?, ?)")
      .run("item-without-sku", null, "尚未設定 SKU");
    sqlite.prepare("INSERT INTO product_sku_mappings (id, inventory_item_id, channel, external_sku) VALUES (?, ?, ?, ?)")
      .run("normal-mapping", "item-with-sku", "cyberbiz", "CB-001");
    sqlite.prepare("INSERT INTO product_sku_mappings (id, inventory_item_id, channel, external_sku) VALUES (?, ?, ?, ?)")
      .run("broken-mapping", "item-without-sku", "shopee", "BROKEN-001");
    sqlite.prepare("INSERT INTO product_sku_mappings (id, inventory_item_id, channel, external_sku) VALUES (?, ?, ?, ?)")
      .run("custom-mapping", null, "shopee", "CUSTOM-001");

    applyLikeD1(sqlite, "0058_allow_custom_sku_mapping.sql", "0059_add_product_sku_system_sku.sql");

    expect(sqlite.prepare("SELECT id, system_sku FROM product_sku_mappings ORDER BY id").all())
      .toEqual([
        { id: "broken-mapping", system_sku: null },
        { id: "custom-mapping", system_sku: "CUSTOM-001" },
        { id: "normal-mapping", system_sku: "WMS-001" },
      ]);
  });

  it("0060 把自訂 mapping 轉成自訂用料，WMS 用料原封不動，兩張表的資料都不會被 cascade 刪掉", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0059_add_product_sku_system_sku.sql");
    sqlite.prepare("INSERT INTO inventory_items (id, sku, name) VALUES (?, ?, ?)")
      .run("item-1", "SOAP-001", "香皂");
    sqlite.prepare("INSERT INTO inventory_items (id, sku, name) VALUES (?, ?, ?)")
      .run("item-2", "NET-001", "起泡網");
    // 有 WMS 主商品的組合：用料要原樣保留。
    sqlite.prepare("INSERT INTO product_sku_mappings (id, inventory_item_id, channel, external_name, external_sku, system_sku) VALUES (?, ?, ?, ?, ?, ?)")
      .run("wms-mapping", "item-1", "shopee", "香皂組", "BUNDLE-001", "SOAP-001");
    sqlite.prepare("INSERT INTO product_bundle_components (mapping_id, inventory_item_id, quantity) VALUES (?, ?, ?)")
      .run("wms-mapping", "item-1", 3);
    sqlite.prepare("INSERT INTO product_bundle_components (mapping_id, inventory_item_id, quantity) VALUES (?, ?, ?)")
      .run("wms-mapping", "item-2", 1);
    // 兩個通路的自訂 mapping 共用同一個 system SKU：要收斂成同一筆自訂商品。
    for (const [id, channel, externalSku] of [
      ["custom-cyberbiz", "cyberbiz", "ABX30001"],
      ["custom-shopee", "shopee", "2649_2162"],
    ] as const) {
      sqlite.prepare("INSERT INTO product_sku_mappings (id, inventory_item_id, channel, external_name, external_sku, system_sku) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, null, channel, "日光花園三入自選禮盒", externalSku, "ABX30001");
      sqlite.prepare("INSERT INTO product_bundle_components (mapping_id, inventory_item_id, quantity) VALUES (?, ?, ?)")
        .run(id, "item-1", 3);
    }

    applyLikeD1(sqlite, "0059_add_product_sku_system_sku.sql", "0060_component_level_custom_sku.sql");

    expect(sqlite.prepare("SELECT sku, name FROM custom_report_products").all())
      .toEqual([{ sku: "ABX30001", name: "日光花園三入自選禮盒" }]);
    expect(sqlite.prepare(
      "SELECT mapping_id, inventory_item_id, quantity FROM product_bundle_components WHERE mapping_id = ? ORDER BY inventory_item_id",
    ).all("wms-mapping")).toEqual([
      { mapping_id: "wms-mapping", inventory_item_id: "item-1", quantity: 3 },
      { mapping_id: "wms-mapping", inventory_item_id: "item-2", quantity: 1 },
    ]);
    /*
     * 自訂 mapping 的舊 WMS 用料本來就沒有被報表用到（只寫 system_sku 一列），
     * 所以照現在的實際輸出轉成單一自訂用料，匯入結果不變。
     */
    const customComponents = sqlite.prepare(
      "SELECT component.mapping_id, custom.sku, component.quantity"
      + " FROM product_bundle_components AS component"
      + " JOIN custom_report_products AS custom ON custom.id = component.custom_product_id"
      + " ORDER BY component.mapping_id",
    ).all();
    expect(customComponents).toEqual([
      { mapping_id: "custom-cyberbiz", sku: "ABX30001", quantity: 1 },
      { mapping_id: "custom-shopee", sku: "ABX30001", quantity: 1 },
    ]);
    // 三筆 mapping 都還在——重建父表時沒有被 ON DELETE CASCADE 連坐刪掉。
    expect(sqlite.prepare("SELECT COUNT(*) AS total FROM product_sku_mappings").get())
      .toEqual({ total: 3 });
  });

  it("0071／0072 將 WMS 分類拆成倉儲分類與報表商品分類，並保留既有 CYBERBIZ 指派", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0069_pink_giant_man.sql");
    sqlite.prepare("INSERT INTO product_categories (id, name, color) VALUES (?, ?, ?)")
      .run("legacy-bath", "沐浴清潔", "sky");

    applyLikeD1(sqlite, "0069_pink_giant_man.sql", "0070_unique_otto_octavius.sql");
    sqlite.prepare(`
      INSERT INTO cyberbiz_products (sku, product_id, variant_id, product_name)
      VALUES (?, ?, ?, ?)
    `).run("SOAP-001", "product-1", "variant-1", "香皂");
    sqlite.prepare("INSERT INTO cyberbiz_product_categories (sku, category_id) VALUES (?, ?)")
      .run("SOAP-001", "legacy-bath");

    applyLikeD1(sqlite, "0070_unique_otto_octavius.sql", "0072_copy_legacy_product_categories.sql");

    expect(sqlite.prepare("SELECT name, color FROM warehouse_categories").all())
      .toEqual([]);
    expect(sqlite.prepare("SELECT id, name, color FROM report_product_categories").all())
      .toEqual([{ id: "report-legacy-bath", name: "沐浴清潔", color: "sky" }]);
    expect(sqlite.prepare("SELECT sku, category_id FROM cyberbiz_product_categories").all())
      .toEqual([{ sku: "SOAP-001", category_id: "report-legacy-bath" }]);
  });

  it("0084 以舊商品 SKU 解析 target item，且正規化外部 SKU，不把 legacy ID 當 target FK", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0073_lame_shinko_yamashiro.sql");
    sqlite.prepare("INSERT INTO inventory_items (id, sku, name) VALUES (?, ?, ?)")
      .run("legacy-mapping-item", "MIGRATE-ITEM-001", "搬移商品");
    sqlite.prepare("INSERT INTO product_sku_mappings (id, channel, external_name, external_sku) VALUES (?, ?, ?, ?)")
      .run("mapping-normalize", "Shopee", "外部商品", " ext-migrate-001 ");
    sqlite.prepare("INSERT INTO product_bundle_components (id, mapping_id, inventory_item_id, quantity) VALUES (?, ?, ?, ?)")
      .run("mapping-normalize:0", "mapping-normalize", "legacy-mapping-item", 1);

    applyLikeD1(sqlite, "0073_lame_shinko_yamashiro.sql", "0084_report_external_mapping_backfill.sql");

    expect(sqlite.prepare(`
      SELECT external.source_type, external.external_key, external.item_id, item.source, item.sku
      FROM report_external_products external
      JOIN items item ON item.id = external.item_id
      WHERE external.id = 'backfill:external:mapping-normalize'
    `).all()).toEqual([{
      source_type: "shopee",
      external_key: "EXT-MIGRATE-001",
      item_id: "legacy-mapping-item",
      source: "custom",
      sku: "MIGRATE-ITEM-001",
    }]);
  });

  it("0085 將多用料 mapping 搬成 target BOM，且保留用料順序與數量", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0073_lame_shinko_yamashiro.sql");
    sqlite.prepare("INSERT INTO inventory_items (id, sku, name) VALUES (?, ?, ?)")
      .run("legacy-bundle-item", "LEGACY-BUNDLE-A", "組合用料 A");
    sqlite.prepare("INSERT INTO custom_report_products (id, sku, name, category) VALUES (?, ?, ?, ?)")
      .run("legacy-custom-item", "LEGACY-BUNDLE-B", "組合用料 B", "未分類");
    sqlite.prepare("INSERT INTO product_sku_mappings (id, channel, external_name, external_sku) VALUES (?, ?, ?, ?)")
      .run("legacy-bundle-mapping", "Shopee", "舊組合商品", " old-bundle-001 ");
    sqlite.prepare("INSERT INTO product_bundle_components (id, mapping_id, inventory_item_id, quantity) VALUES (?, ?, ?, ?)")
      .run("legacy-bundle-mapping:000", "legacy-bundle-mapping", "legacy-bundle-item", 2);
    sqlite.prepare("INSERT INTO product_bundle_components (id, mapping_id, custom_product_id, quantity) VALUES (?, ?, ?, ?)")
      .run("legacy-bundle-mapping:001", "legacy-bundle-mapping", "legacy-custom-item", 3);

    applyLikeD1(sqlite, "0073_lame_shinko_yamashiro.sql", "0084_report_external_mapping_backfill.sql");
    applyLikeD1(sqlite, "0084_report_external_mapping_backfill.sql", "0085_report_bundle_target_backfill.sql");

    expect(sqlite.prepare(`
      SELECT external.source_type, external.external_key, external.item_id, item.source, item.sku
      FROM report_external_products external
      JOIN items item ON item.id = external.item_id
      WHERE external.id = 'backfill:external:legacy-bundle-mapping'
    `).all()).toEqual([{
      source_type: "shopee",
      external_key: "OLD-BUNDLE-001",
      item_id: "report-bundle:legacy-bundle-mapping",
      source: "custom",
      sku: "REPORT-BUNDLE:LEGACY-BUNDLE-MAPPING",
    }]);
    expect(sqlite.prepare(`
      SELECT item.sku, component.quantity
      FROM item_components component
      JOIN items item ON item.id = component.component_item_id
      WHERE component.parent_item_id = 'report-bundle:legacy-bundle-mapping'
      ORDER BY component.rowid
    `).all()).toEqual([
      { sku: "LEGACY-BUNDLE-A", quantity: 2 },
      { sku: "LEGACY-BUNDLE-B", quantity: 3 },
    ]);
  });

  it("0086 以 legacy SKU 將 CYBERBIZ 連結搬到 target WMS 品項", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0073_lame_shinko_yamashiro.sql");
    sqlite.prepare("INSERT INTO inventory_items (id, sku, name, quantity, min_stock) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-linked-item", "LINKED-001", "已連結商品", 4, 2);
    sqlite.prepare(`
      INSERT INTO cyberbiz_product_links (
        id, inventory_item_id, cyberbiz_product_id, cyberbiz_variant_id, sku,
        warehouse_scope, pos_shop_id, sync_status, last_synced_quantity, last_synced_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legacy-link", "legacy-linked-item", "product-001", "variant-001", " linked-001 ", "company", 0, "failed", 3, "2026-01-01T00:00:00.000Z", "曾經失敗");

    applyLikeD1(sqlite, "0073_lame_shinko_yamashiro.sql", "0086_wms_cyberbiz_links_target.sql");

    expect(sqlite.prepare(`
      SELECT link.id, link.wms_item_id, link.cyberbiz_product_id, link.cyberbiz_variant_id,
        link.sku, link.sync_status, wms.quantity, wms.min_stock
      FROM wms_cyberbiz_links link
      JOIN wms_items wms ON wms.item_id = link.wms_item_id
    `).all()).toEqual([{
      id: "backfill:wms-link:legacy-link",
      wms_item_id: "legacy-linked-item",
      cyberbiz_product_id: "product-001",
      cyberbiz_variant_id: "variant-001",
      sku: "LINKED-001",
      sync_status: "failed",
      quantity: 4,
      min_stock: 2,
    }]);
  });

  it("0087 清掉沒有 media metadata 的懸空 zone image", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0086_wms_cyberbiz_links_target.sql");
    sqlite.prepare(`
      INSERT INTO zones (id, code, name, category, x, y, width, height)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("orphan-zone", "ORPHAN", "懸空圖片測試", "一般備品", 0, 0, 10, 10);
    sqlite.prepare(`
      INSERT INTO zone_images (id, zone_id, object_key, filename, content_type, size)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("orphan-image", "orphan-zone", "wms/orphan.jpg", "orphan.jpg", "image/jpeg", 10);

    applyLikeD1(sqlite, "0086_wms_cyberbiz_links_target.sql", "0087_wms_orphan_image_cleanup.sql");

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM zone_images").get()).toEqual({ count: 0 });
  });
});
