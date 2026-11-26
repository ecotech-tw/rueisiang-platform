import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migrations = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
const target = migrations.find((name) => readFileSync(path.join(directory, name), "utf8").includes("CREATE TABLE `cyberbiz_order_restocks`"))!;

function apply(sqlite: DatabaseSync, filename: string) {
  sqlite.exec("BEGIN");
  try {
    for (const statement of readFileSync(path.join(directory, filename), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
    sqlite.exec("COMMIT");
  } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}

describe("訂單回補 migration（D1 transaction 語意）", () => {
  it("重建事件表保留既有 payload、外鍵及狀態，新增訂單／調倉類型與永久防重帳本", () => {
    expect(target).toBeTruthy();
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const file of migrations) { if (file >= target) break; apply(sqlite, file); }
    sqlite.exec(`
      INSERT INTO crm_customers (id, name, phone, normalized_phone) VALUES ('customer', '既有客戶', '', '');
      INSERT INTO items (id, sku, name, source, kind) VALUES ('soap', 'SOAP', '香皂', 'custom', 'sellable');
      INSERT INTO cyberbiz_webhook_events (id, topic, entity_type, status, customer_id, payload_json, attempts)
      VALUES ('old-member', 'customers/update', 'customer', 'processed', 'customer', '{"id":1}', 2),
             ('old-product', 'variants/update', 'product', 'failed', NULL, '{"inventory_quantity":10}', 3);
    `);
    apply(sqlite, target);
    expect(sqlite.prepare("SELECT id, entity_type, status, customer_id, payload_json, attempts FROM cyberbiz_webhook_events ORDER BY id").all()).toEqual([
      { id: "old-member", entity_type: "customer", status: "processed", customer_id: "customer", payload_json: '{"id":1}', attempts: 2 },
      { id: "old-product", entity_type: "product", status: "failed", customer_id: null, payload_json: '{"inventory_quantity":10}', attempts: 3 },
    ]);
    sqlite.exec(`INSERT INTO cyberbiz_webhook_events (id, topic, entity_type, payload_json) VALUES ('order', 'orders/create', 'order', '{}'), ('transfer', 'stock_requisitions/approved', 'stock', '{}')`);
    expect(() => sqlite.exec("INSERT INTO cyberbiz_webhook_events (id, topic, entity_type, payload_json) VALUES ('bad', 'bad', 'banana', '{}')")).toThrow(/CHECK/);
    sqlite.exec(`INSERT INTO cyberbiz_order_restocks (id, event_id, order_id, order_name, phase, source, variant_id, item_id, mode, state) VALUES ('ledger', 'order', '700', '#700', 'create', '手機', '200', 'soap', 'apply', 'applied')`);
    sqlite.exec("DELETE FROM cyberbiz_webhook_events WHERE id = 'order'");
    expect(sqlite.prepare("SELECT state FROM cyberbiz_order_restocks WHERE id = 'ledger'").get()).toEqual({ state: "applied" });
    expect(() => sqlite.exec(`INSERT INTO cyberbiz_order_restocks (id, event_id, order_id, order_name, phase, source, variant_id, mode) VALUES ('duplicate', 'another-event', '700', '#700', 'create', '手機', '200', 'apply')`)).toThrow(/UNIQUE/);
    sqlite.exec("DELETE FROM items WHERE id = 'soap'");
    expect(sqlite.prepare("SELECT state, item_id FROM cyberbiz_order_restocks WHERE id = 'ledger'").get()).toEqual({ state: "applied", item_id: null });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(sqlite.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    sqlite.close();
  });
});
