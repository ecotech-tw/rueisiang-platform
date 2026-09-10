import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const tableMigration = "0133_lucky_rick_jones.sql";
const permissionMigration = "0134_restore_hr_scope_permissions.sql";
const migrationFiles = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

function apply(sqlite: DatabaseSync, file: string) {
  sqlite.exec("BEGIN");
  try {
    for (const statement of readFileSync(path.join(directory, file), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

describe("HR 管理範圍 migration", () => {
  it("保留既有 users／scopes，權限可重跑且關聯採 RESTRICT", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of migrationFiles) {
        if (file >= tableMigration) break;
        apply(sqlite, file);
      }
      sqlite.exec("INSERT INTO users(id,email,status) VALUES ('manager','manager@example.test','active'),('admin','admin@example.test','active');");
      sqlite.exec("INSERT INTO scopes(id,source_type,scope_kind,name,normalized_name) VALUES ('scope','manual','store','測試櫃點','測試櫃點');");
      sqlite.exec("INSERT INTO roles(id,role_key,name,is_system) VALUES ('role-admin','admin','管理者',1);");
      apply(sqlite, tableMigration);
      apply(sqlite, permissionMigration);
      apply(sqlite, permissionMigration);

      sqlite.exec("INSERT INTO hr_management_scopes(user_id,scope_id) VALUES ('manager','scope');");
      expect(sqlite.prepare("SELECT user_id,scope_id FROM hr_management_scopes").all()).toEqual([{ user_id: "manager", scope_id: "scope" }]);
      expect(sqlite.prepare("SELECT permission FROM permissions WHERE permission LIKE 'hr:%' ORDER BY permission").all()).toEqual([
        { permission: "hr:audit:read" },
        { permission: "hr:employee:read" },
        { permission: "hr:employee:write" },
        { permission: "hr:office:read" },
        { permission: "hr:office:write" },
        { permission: "hr:request:review" },
        { permission: "hr:scope:read" },
        { permission: "hr:scope:write" },
      ]);
      expect(sqlite.prepare("SELECT permission FROM role_permission_grants WHERE role_id='role-admin' ORDER BY permission").all()).toEqual([
        { permission: "hr:audit:read" },
        { permission: "hr:scope:read" },
        { permission: "hr:scope:write" },
      ]);
      expect(() => sqlite.exec("DELETE FROM users WHERE id='manager'")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("DELETE FROM scopes WHERE id='scope'")).toThrow(/FOREIGN KEY/);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
