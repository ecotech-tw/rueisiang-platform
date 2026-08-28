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
});
