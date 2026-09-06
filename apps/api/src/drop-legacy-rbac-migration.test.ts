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

const BEFORE = "0099_permission_grants_fk.sql";
const DROP_LEGACY = "0110_drop_legacy_rbac_tables.sql";

describe("收掉 RBAC 的舊表", () => {
  it("授權資料完好，舊表與同步 trigger 都不見了", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);

    sqlite.prepare("INSERT INTO users (id, email, status) VALUES ('u1', 'a@b.c', 'active')").run();
    sqlite.prepare("INSERT INTO roles (id, role_key, name) VALUES ('r1', 'admin', '管理者')").run();
    sqlite.prepare("INSERT INTO permissions (permission, synced_at) VALUES ('admin:user:read', CURRENT_TIMESTAMP)").run();
    sqlite.prepare("INSERT INTO user_role_assignments (user_id, role_id) VALUES ('u1', 'r1')").run();
    sqlite.prepare("INSERT INTO role_permission_grants (role_id, permission) VALUES ('r1', 'admin:user:read')").run();

    applyLikeD1(sqlite, BEFORE, DROP_LEGACY);

    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM user_role_assignments").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM role_permission_grants").get()).toEqual({ n: 1 });

    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row) => (row as { name: string }).name);
    for (const legacy of ["user_roles", "user_permissions", "role_permissions"]) {
      expect(tables).not.toContain(legacy);
    }
    // 13 支雙向同步 trigger 全部跟著收掉；留一支就會去寫一張不存在的表。
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'").get()).toEqual({ n: 0 });
  });

  it("舊表沒了之後，權限鍵值的外鍵還是擋得住", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, DROP_LEGACY);
    sqlite.prepare("INSERT INTO roles (id, role_key, name) VALUES ('r1', 'admin', '管理者')").run();

    expect(() => sqlite.prepare("INSERT INTO role_permission_grants (role_id, permission) VALUES ('r1', 'admin:usre:read')").run())
      .toThrow(/FOREIGN KEY/i);
  });
});
