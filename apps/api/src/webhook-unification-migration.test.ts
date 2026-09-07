import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migrationFiles = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

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

describe("0112/0113 CYBERBIZ target cutover", () => {
  it("把舊事件與 WMS 商品身分搬進 target 表", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0111_drop_payout_stores.sql");

    sqlite.prepare(`
      INSERT INTO cyberbiz_product_webhooks
        (id, topic, product_id, variant_id, sku, quantity, payload_hash, status, attempts, result, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-product-event",
      "variants/update",
      "product-1",
      "variant-1",
      "SKU-1",
      17,
      "legacy-product-event",
      "failed",
      2,
      "{\"productId\":\"product-1\"}",
      "官網暫時無法連線",
    );

    applyLikeD1(sqlite, "0111_drop_payout_stores.sql", "0112_cyberbiz_webhook_events_unify.sql");

    sqlite.prepare(`
      INSERT INTO items (id, source, kind, sku, name, active)
      VALUES ('wms-item-1', 'cyberbiz', 'sellable', 'SKU-1', '商品 1', 1)
    `).run();
    sqlite.prepare(`
      INSERT INTO wms_items (item_id, quantity, min_stock, unit, notes)
      VALUES ('wms-item-1', 3, 1, '件', '')
    `).run();
    sqlite.prepare(`
      INSERT INTO wms_cyberbiz_links
        (id, wms_item_id, cyberbiz_product_id, cyberbiz_variant_id, sku, last_error)
      VALUES ('legacy-link', 'wms-item-1', 'product-1', 'variant-1', 'SKU-1', '舊同步失敗')
    `).run();

    applyLikeD1(sqlite, "0112_cyberbiz_webhook_events_unify.sql", "0113_wms_cyberbiz_identity_cutover.sql");

    expect(sqlite.prepare(`
      SELECT id, topic, entity_type, external_entity_id, status, attempts, last_error, payload_json
      FROM cyberbiz_webhook_events
      WHERE id = 'legacy-product-event'
    `).get()).toEqual({
      id: "legacy-product-event",
      topic: "variants/update",
      entity_type: "product",
      external_entity_id: "variant-1",
      status: "failed",
      attempts: 2,
      last_error: "官網暫時無法連線",
      payload_json: JSON.stringify({
        product_id: "product-1",
        variant_id: "variant-1",
        sku: "SKU-1",
        inventory_quantity: 17,
      }),
    });
    expect(sqlite.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cyberbiz_product_webhooks'
    `).get()).toBeUndefined();
    expect(sqlite.prepare(`
      SELECT item_id, cyberbiz_product_id, cyberbiz_variant_id
      FROM cyberbiz_products
      WHERE item_id = 'wms-item-1'
    `).get()).toEqual({
      item_id: "wms-item-1",
      cyberbiz_product_id: "product-1",
      cyberbiz_variant_id: "variant-1",
    });
    expect(sqlite.prepare(`
      SELECT entity_type, entity_id, event_type, status, error
      FROM activity_events
      WHERE id = 'migration:0113:wms-cyberbiz:legacy-link'
    `).get()).toEqual({
      entity_type: "item",
      entity_id: "wms-item-1",
      event_type: "cyberbiz_sync_failed",
      status: "failed",
      error: "舊同步失敗",
    });
    expect(sqlite.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wms_cyberbiz_links'
    `).get()).toBeUndefined();
  });
});
