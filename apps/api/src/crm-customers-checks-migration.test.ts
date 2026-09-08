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

const BEFORE = "0116_shopee_sales_to_report_runs.sql";
const REBUILD = "0119_crm_customer_children_restore.sql";
const MIGRATION_END = "0122_crm_customer_children_restore.sql";

/**
 * 明寫 sync_status，跟正式環境一樣——crm-sync.ts 與 crm-write.ts 的 insert 都
 * 帶 "synced"。不帶的話會吃到舊表的預設 'local_only'，那個值不在新的值域裡。
 */
function seedCustomer(sqlite: DatabaseSync, id: string) {
  sqlite.prepare("INSERT INTO crm_customers (id, phone, normalized_phone, name, sync_status) VALUES (?, '0912345678', '0912345678', ?, 'synced')")
    .run(id, `客戶 ${id}`);
}

describe("crm_customers 的兩條 CHECK", () => {
  it("重建不會弄丟標籤關聯與 webhook 的客戶對應", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);

    seedCustomer(sqlite, "c1");
    sqlite.prepare("INSERT INTO crm_tags (id, name) VALUES ('t1', 'VIP')").run();
    sqlite.prepare("INSERT INTO crm_customer_tags (customer_id, crm_tag_id) VALUES ('c1', 't1')").run();
    sqlite.prepare(`
      INSERT INTO cyberbiz_webhook_events (id, topic, payload_json, customer_id, entity_type)
      VALUES ('w1', 'customers/update', '{}', 'c1', 'customer')
    `).run();

    applyLikeD1(sqlite, BEFORE, MIGRATION_END);

    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM crm_customers").get()).toEqual({ n: 1 });
    // crm_customer_tags 是 ON DELETE CASCADE；沒有先存後補的話這裡會變成 0。
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM crm_customer_tags").get()).toEqual({ n: 1 });
    // webhook 的 customer_id 是 ON DELETE SET NULL；沒補回去的話會變成 null。
    expect(sqlite.prepare("SELECT customer_id FROM cyberbiz_webhook_events WHERE id = 'w1'").get())
      .toEqual({ customer_id: "c1" });
    // 六支索引跟著表一起被刪掉，要全部補回來。
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'crm_customers' AND sql IS NOT NULL
    `).get()).toEqual({ n: 6 });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'index' AND name IN ('idx_crm_customer_tags_customer', 'idx_webhook_events_customer_id')
    `).get()).toEqual({ n: 2 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE substr(name, 1, 1) = char(95)").get()).toEqual({ n: 0 });
  });

  it("中間 transaction 的新增資料不會被子表還原覆蓋", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);

    seedCustomer(sqlite, "c1");
    sqlite.prepare("INSERT INTO crm_tags (id, name) VALUES ('t1', 'VIP'), ('t2', '新標籤')").run();
    sqlite.prepare("INSERT INTO crm_customer_tags (customer_id, crm_tag_id) VALUES ('c1', 't1')").run();
    sqlite.prepare(`
      INSERT INTO cyberbiz_webhook_events (id, topic, payload_json, customer_id, entity_type)
      VALUES ('w1', 'customers/update', '{}', 'c1', 'customer')
    `).run();

    applyLikeD1(sqlite, BEFORE, REBUILD);

    // 模擬舊 Worker 在 parent 重建與索引／子表還原之間建立的資料。
    seedCustomer(sqlite, "c2");
    sqlite.prepare("INSERT INTO crm_customer_tags (customer_id, crm_tag_id) VALUES ('c2', 't2')").run();
    sqlite.prepare(`
      INSERT INTO cyberbiz_webhook_events (id, topic, payload_json, customer_id, entity_type)
      VALUES ('w2', 'customers/update', '{}', 'c2', 'customer')
    `).run();

    applyLikeD1(sqlite, REBUILD, MIGRATION_END);

    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM crm_customer_tags").get()).toEqual({ n: 2 });
    expect(sqlite.prepare("SELECT customer_id FROM cyberbiz_webhook_events WHERE id = 'w2'").get())
      .toEqual({ customer_id: "c2" });
  });

  it("值域外的 status 與 sync_status 寫不進去", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, MIGRATION_END);
    const insert = (id: string, column: "status" | "sync_status", value: string) =>
      sqlite.prepare(`INSERT INTO crm_customers (id, phone, normalized_phone, ${column}) VALUES (?, '09', '09', ?)`).run(id, value);

    expect(() => insert("bad-status", "status", "disabled")).toThrow(/CHECK/i);
    // 'local_only' 是舊的預設值，補跑只撈 failed，這個狀態會讓那一列永遠卡住。
    expect(() => insert("bad-sync", "sync_status", "local_only")).toThrow(/CHECK/i);
    expect(() => insert("ok-blocked", "status", "blocked")).not.toThrow();
    expect(() => insert("ok-failed", "sync_status", "failed")).not.toThrow();
  });

  it("殘留的 local_only 會讓 migration 當場中止，而不是被靜靜改掉", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);

    // 舊表的預設就是 local_only，不帶欄位就會拿到它。
    sqlite.prepare("INSERT INTO crm_customers (id, phone, normalized_phone) VALUES ('legacy', '09', '09')").run();

    // 正式環境長不出這種列（寫入端都明寫 synced），但真的遇到時要吵，
    // 不能猜它該對應到 synced 還是 failed——猜錯會讓補跑撈錯對象。
    expect(() => applyLikeD1(sqlite, BEFORE, MIGRATION_END)).toThrow(/CHECK/i);
  });

  it("沒帶 sync_status 時的預設是 synced，不是舊的 local_only", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, MIGRATION_END);

    seedCustomer(sqlite, "c2");

    expect(sqlite.prepare("SELECT status, sync_status FROM crm_customers WHERE id = 'c2'").get())
      .toEqual({ status: "active", sync_status: "synced" });
  });
});
