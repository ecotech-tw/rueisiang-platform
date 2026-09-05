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

const BEFORE = "0092_item_categories_constraints.sql";
const SINGLE_DEFINITION = "0093_schema_single_definition.sql";
const DROP_LEGACY_KEY = "0094_drop_roles_legacy_key.sql";

describe("schema 一張表一個定義", () => {
  it("0093 重建 users 時不會把角色授權連坐刪光", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);

    sqlite.prepare("INSERT INTO users (id, email, status) VALUES ('u1', 'a@b.c', 'active')").run();
    sqlite.prepare("INSERT INTO roles (id, role_key, name) VALUES ('r1', 'admin', '管理者')").run();
    // user_roles 與 user_role_assignments 之間有雙向同步的 trigger，插一邊另一邊會自己長出來。
    sqlite.prepare("INSERT INTO user_roles (user_id, role_id) VALUES ('u1', 'r1')").run();

    applyLikeD1(sqlite, BEFORE, SINGLE_DEFINITION);

    // 四張子表都是 ON DELETE CASCADE；沒有先存後補的話這裡會全部變成 0。
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM user_roles").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM user_role_assignments").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE substr(name, 1, 1) = char(95)").get()).toEqual({ n: 0 });
  });

  it("0093 之後 users.status 只收得下三種值", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, SINGLE_DEFINITION);

    sqlite.prepare("INSERT INTO users (id, email, status) VALUES ('ok', 'a@b.c', 'disabled')").run();
    expect(() => sqlite.prepare("INSERT INTO users (id, email, status) VALUES ('bad', 'x@y.z', 'banana')").run())
      .toThrow(/CHECK/i);
  });

  it("0093 之後 schema 宣告的索引在資料庫裡都找得到", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, SINGLE_DEFINITION);

    const names = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => (row as { name: string }).name));
    for (const name of [
      "idx_users_email", "idx_users_google_subject", "idx_users_invitation_token_hash", "idx_users_status",
      "idx_roles_role_key", "idx_user_roles_user",
      "idx_customers_cyberbiz_customer_id", "idx_customers_normalized_phone", "idx_customers_status_channel",
      "idx_customers_updated_at", "idx_customers_cyberbiz_updated_at", "idx_customers_incomplete",
      "idx_saved_views_name",
      "idx_webhook_events_status", "idx_webhook_events_customer", "idx_webhook_events_entity",
    ]) expect(names).toContain(name);
    expect(names).not.toContain("idx_cyberbiz_customer_webhooks_customer");
  });

  it("0094 拿掉 roles 的舊 key 欄位，角色與授權都留著", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, SINGLE_DEFINITION);

    sqlite.prepare("INSERT INTO roles (id, role_key, name) VALUES ('r1', 'admin', '管理者')").run();
    sqlite.prepare("INSERT INTO role_permissions (role_id, permission) VALUES ('r1', 'admin:user:read')").run();

    applyLikeD1(sqlite, SINGLE_DEFINITION, DROP_LEGACY_KEY);

    const columns = sqlite.prepare("PRAGMA table_info(roles)").all().map((row) => (row as { name: string }).name);
    expect(columns).not.toContain("key");
    expect(columns).toContain("role_key");
    // roles 底下有四張 ON DELETE CASCADE 的子表，DROP COLUMN 不該碰到它們。
    expect(sqlite.prepare("SELECT role_key FROM roles").all()).toEqual([{ role_key: "admin" }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM role_permissions").get()).toEqual({ n: 1 });
    const triggers = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((row) => (row as { name: string }).name);
    expect(triggers).not.toContain("trg_roles_role_key_to_legacy_insert");
    expect(triggers).not.toContain("trg_roles_role_key_to_legacy_update");
  });
});
