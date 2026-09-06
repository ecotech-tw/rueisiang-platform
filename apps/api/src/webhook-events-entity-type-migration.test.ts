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

const BEFORE = "0096_merge_scopes.sql";
const ENTITY_TYPE = "0097_webhook_events_entity_type.sql";

describe("webhook 事件的 entity_type", () => {
  it("既有的列全部回填成 customer，external_entity_id 沿用會員 ID", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);

    sqlite.prepare(`
      INSERT INTO cyberbiz_webhook_events (id, topic, status, cyberbiz_customer_id, payload_json)
      VALUES ('e1', 'customers/update', 'processed', 'cb-42', '{}')
    `).run();

    applyLikeD1(sqlite, BEFORE, ENTITY_TYPE);

    expect(sqlite.prepare("SELECT id, entity_type, external_entity_id, status FROM cyberbiz_webhook_events").all())
      .toEqual([{ id: "e1", entity_type: "customer", external_entity_id: "cb-42", status: "processed" }]);
  });

  it("兩條 CHECK 都擋得住，商品事件寫得進去", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, ENTITY_TYPE);
    const insert = (id: string, column: "entity_type" | "status", value: string) =>
      sqlite.prepare(`INSERT INTO cyberbiz_webhook_events (id, topic, payload_json, ${column}) VALUES (?, 't', '{}', ?)`).run(id, value);

    expect(() => insert("bad-entity", "entity_type", "banana")).toThrow(/CHECK/i);
    // 'received' 是舊的預設值，設計裡沒有這個狀態——補跑與清理都不認得它。
    expect(() => insert("bad-status", "status", "received")).toThrow(/CHECK/i);
    expect(() => insert("ok-product", "entity_type", "product")).not.toThrow();
  });

  it("沒帶 entity_type 時的預設是 customer，attempts 從 1 起算", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, ENTITY_TYPE);

    sqlite.prepare("INSERT INTO cyberbiz_webhook_events (id, topic, payload_json) VALUES ('d', 't', '{}')").run();

    expect(sqlite.prepare("SELECT entity_type, status, attempts FROM cyberbiz_webhook_events WHERE id = 'd'").get())
      .toEqual({ entity_type: "customer", status: "processing", attempts: 1 });
  });
});
