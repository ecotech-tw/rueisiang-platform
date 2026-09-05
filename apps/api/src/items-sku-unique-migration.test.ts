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
const ALIGN_NAMES = "0091_align_index_names.sql";
const CATEGORY_CONSTRAINTS = "0092_item_categories_constraints.sql";

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

  it("0091 之後，索引名稱跟 schema 宣告的一致", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, ALIGN_NAMES);

    const names = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => (row as { name: string }).name));
    // schema/*.ts 宣告的名字要在
    for (const name of [
      "idx_wms_categories_name", "idx_wms_zones_code", "idx_wms_layouts_name",
      "idx_wms_cyberbiz_links_item", "idx_wms_cyberbiz_links_variant",
      "idx_crm_tags_name", "idx_webhook_events_status", "idx_webhook_events_entity",
      "idx_payout_daily_date", "idx_item_categories_id_depth",
    ]) expect(names).toContain(name);
    // 改名前的名字與重複的索引要不在
    for (const name of [
      "idx_customer_tag_catalog_name", "idx_cyberbiz_customer_webhooks_status",
      "idx_payout_target_date", "idx_cyberbiz_products_item",
    ]) expect(names).not.toContain(name);
  });

  it("0092 重建 item_categories 時不會把 items 的分類連坐清掉", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, ALIGN_NAMES);

    sqlite.prepare("INSERT INTO item_categories (id, depth, parent_id, parent_depth, name) VALUES ('root', 0, NULL, NULL, '沐浴清潔')").run();
    sqlite.prepare("INSERT INTO item_categories (id, depth, parent_id, parent_depth, name) VALUES ('kid', 1, 'root', 0, '洗髮')").run();
    sqlite.prepare("INSERT INTO items (id, source, kind, sku, name, category_id, active) VALUES ('i1', 'custom', 'sellable', 'S1', '商品一', 'kid', 1)").run();

    applyLikeD1(sqlite, ALIGN_NAMES, CATEGORY_CONSTRAINTS);

    // items.category_id 是 ON DELETE SET NULL；重建時沒有先存後補的話這裡會是 null。
    expect(sqlite.prepare("SELECT category_id FROM items WHERE id = 'i1'").get()).toEqual({ category_id: "kid" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM item_categories").get()).toEqual({ n: 2 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE substr(name, 1, 1) = char(95)").get()).toEqual({ n: 0 });
  });

  it("0092 之後兩層分類的約束真的擋得住", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, CATEGORY_CONSTRAINTS);
    const insert = (id: string, depth: number, parentId: string | null, parentDepth: number | null, name: string) =>
      sqlite.prepare("INSERT INTO item_categories (id, depth, parent_id, parent_depth, name) VALUES (?, ?, ?, ?, ?)")
        .run(id, depth, parentId, parentDepth, name);

    insert("root", 0, null, null, "沐浴清潔");
    insert("kid", 1, "root", 0, "洗髮");

    expect(() => insert("dup", 0, null, null, "沐浴清潔")).toThrow(/UNIQUE/i);
    expect(() => insert("grandkid", 2, "kid", 1, "孫")).toThrow(/CHECK/i);
    expect(() => insert("self", 1, "self", 0, "自己")).toThrow(/FOREIGN KEY/i);
    expect(() => insert("kid2", 1, "root", 0, "洗髮")).toThrow(/UNIQUE/i);
    expect(() => sqlite.prepare("DELETE FROM item_categories WHERE id = 'root'").run()).toThrow(/FOREIGN KEY/i);
  });
});
