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

const BEFORE_MERGE = "0089_item_wms_permissions.sql";
const MERGE = "0089_z_merge_duplicate_sku_items.sql";
const UNIQUE_INDEX = "0090_items_sku_unique.sql";

/** 把一組重複的 SKU 種進 items：cyberbiz 一筆、custom 一筆。 */
function seedDuplicate(sqlite: DatabaseSync, sku: string, categoryId: string | null): void {
  sqlite.prepare("INSERT INTO items (id, source, kind, sku, name, category_id, active) VALUES (?, 'cyberbiz', 'sellable', ?, ?, NULL, 1)")
    .run(`cb:${sku}`, sku, `${sku} 官網`);
  sqlite.prepare("INSERT INTO cyberbiz_products (item_id, cyberbiz_product_id, cyberbiz_variant_id) VALUES (?, ?, ?)")
    .run(`cb:${sku}`, `p-${sku}`, `v-${sku}`);
  sqlite.prepare("INSERT INTO items (id, source, kind, sku, name, category_id, active) VALUES (?, 'custom', 'sellable', ?, ?, ?, 1)")
    .run(`custom:${sku}`, sku, `${sku} 自訂`, categoryId);
}

describe("items SKU 全平台唯一", () => {
  it("0089_z 把重複的 custom 品項併進 cyberbiz，報表列與分類都跟著搬", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE_MERGE);

    sqlite.prepare("INSERT INTO item_categories (id, depth, parent_id, parent_depth, name) VALUES ('cat-1', 0, NULL, NULL, '沐浴清潔')").run();
    seedDuplicate(sqlite, "ABX18001", "cat-1");
    sqlite.prepare("INSERT INTO scopes (id, scope_kind, source_type, name, normalized_name) VALUES ('scope-1', 'store', 'cyberbiz', '中友百貨', '中友百貨')").run();
    sqlite.prepare(`
      INSERT INTO report_item_sales_monthly (scope_id, report_month, item_id, record_origin, net_quantity, sales_amount, created_at, updated_at)
      VALUES ('scope-1', '2026-01', 'custom:ABX18001', 'manual', 5, 6845, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    applyLikeD1(sqlite, BEFORE_MERGE, MERGE);

    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM items WHERE sku = 'ABX18001'").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT id, category_id FROM items WHERE sku = 'ABX18001'").get())
      .toEqual({ id: "cb:ABX18001", category_id: "cat-1" });
    // 報表金額是這次搬移唯一不能動的東西。
    expect(sqlite.prepare("SELECT item_id, net_quantity, sales_amount FROM report_item_sales_monthly").all())
      .toEqual([{ item_id: "cb:ABX18001", net_quantity: 5, sales_amount: 6845 }]);
  });

  it("0090 之後同一個 SKU 不能再有第二筆，換來源也不行", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, UNIQUE_INDEX);

    sqlite.prepare("INSERT INTO items (id, source, kind, sku, name, active) VALUES ('cb:X1', 'cyberbiz', 'sellable', 'X1', '官網商品', 1)").run();
    expect(() => sqlite.prepare("INSERT INTO items (id, source, kind, sku, name, active) VALUES ('custom:X1', 'custom', 'sellable', 'X1', '自訂商品', 1)").run())
      .toThrow(/UNIQUE/i);
  });

  it("0089_z 沒有重複可併時什麼都不做", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE_MERGE);
    sqlite.prepare("INSERT INTO items (id, source, kind, sku, name, active) VALUES ('custom:Y1', 'custom', 'sellable', 'Y1', '只有自訂', 1)").run();

    applyLikeD1(sqlite, BEFORE_MERGE, UNIQUE_INDEX);

    expect(sqlite.prepare("SELECT id FROM items WHERE sku = 'Y1'").get()).toEqual({ id: "custom:Y1" });
  });
});
