import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migrationFiles = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

/** 照 D1 的方式逐支套用 migration，每支都在自己的 transaction 內完成。 */
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

const BEFORE = "0099_permission_grants_fk.sql";
const BEFORE_ACTIVITY_RENAME = "0099_rename_payout_daily.sql";
const RENAME = "0100_activity_entity_type_rename.sql";

describe("0100 activity entity_type rename", () => {
  it("只改四種 entity_type，保留 entity_id 與其他類型", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);

    const insert = sqlite.prepare(`
      INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary)
      VALUES (?, ?, ?, 'test', 'migration test')
    `);
    for (const [id, entityType, entityId] of [
      ["evt-item", "inventory_item", "legacy-item-42"],
      ["evt-category", "report_product_category", "legacy-category-7"],
      ["evt-zone", "zone", "legacy-zone-3"],
      ["evt-wms-category", "warehouse_category", "legacy-wms-category-9"],
      ["evt-customer", "customer", "customer-1"],
      ["evt-manual", "report_manual_entry", "manual-1"],
      ["evt-mapping", "product_sku_mapping", "mapping-1"],
    ] as const) {
      insert.run(id, entityType, entityId);
    }

    applyLikeD1(sqlite, BEFORE, RENAME);

    expect(sqlite.prepare("SELECT id, entity_type, entity_id FROM activity_events ORDER BY id").all()).toEqual([
      { id: "evt-category", entity_type: "item_category", entity_id: "legacy-category-7" },
      { id: "evt-customer", entity_type: "customer", entity_id: "customer-1" },
      { id: "evt-item", entity_type: "item", entity_id: "legacy-item-42" },
      { id: "evt-manual", entity_type: "report_manual_entry", entity_id: "manual-1" },
      { id: "evt-mapping", entity_type: "product_sku_mapping", entity_id: "mapping-1" },
      { id: "evt-wms-category", entity_type: "wms_category", entity_id: "legacy-wms-category-9" },
      { id: "evt-zone", entity_type: "wms_zone", entity_id: "legacy-zone-3" },
    ]);
  });

  it("重跑 0100 不會改動已完成的資料", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);
    sqlite.prepare(`
      INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary)
      VALUES ('evt-idempotent', 'inventory_item', 'item-1', 'test', 'migration test')
    `).run();

    applyLikeD1(sqlite, BEFORE, BEFORE_ACTIVITY_RENAME);
    applyLikeD1(sqlite, BEFORE_ACTIVITY_RENAME, RENAME);
    applyLikeD1(sqlite, BEFORE_ACTIVITY_RENAME, RENAME);

    expect(sqlite.prepare("SELECT entity_type, entity_id FROM activity_events WHERE id = 'evt-idempotent'").get())
      .toEqual({ entity_type: "item", entity_id: "item-1" });
  });
});
