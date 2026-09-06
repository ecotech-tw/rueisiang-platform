import { ALL_PERMISSIONS } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { permissions, rolePermissionGrants, roles } from "@rueisiang/db/schema";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createTargetOnlyD1 } from "./local-d1/d1.js";

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

const BEFORE = "0098_cyberbiz_item_name_dedupe.sql";
const FK = "0099_permission_grants_fk.sql";

describe("權限鍵值的資料庫防線", () => {
  it("0099 把既有授權用到的鍵值補進鏡像表，七支同步 trigger 一支都不少", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);

    sqlite.prepare("INSERT INTO roles (id, role_key, name) VALUES ('r1', 'admin', '管理者')").run();
    sqlite.prepare("INSERT INTO role_permission_grants (role_id, permission) VALUES ('r1', 'admin:user:read')").run();
    sqlite.prepare("DELETE FROM permissions").run();

    applyLikeD1(sqlite, BEFORE, FK);

    expect(sqlite.prepare("SELECT permission FROM permissions").all()).toEqual([{ permission: "admin:user:read" }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM role_permission_grants").get()).toEqual({ n: 1 });
    // 重建會把建在表上的 trigger 一起帶走，少補一支就開始悄悄漂移。
    // 只數權限那七支——user_roles 那組另外六支跟這支 migration 無關。
    const triggers = sqlite.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger'
        AND tbl_name IN ('role_permissions', 'user_permissions', 'role_permission_grants', 'user_permission_grants')
      ORDER BY name
    `).all().map((row) => (row as { name: string }).name);
    expect(triggers).toEqual([
      "trg_role_permission_grants_to_legacy_delete",
      "trg_role_permission_grants_to_legacy_insert",
      "trg_role_permissions_to_grants_delete",
      "trg_role_permissions_to_grants_insert",
      "trg_user_permission_grants_to_legacy_insert",
      "trg_user_permissions_to_grants_delete",
      "trg_user_permissions_to_grants_insert",
    ]);
  });

  it("打錯字的權限鍵值寫不進去，連從舊表繞也不行", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, FK);
    sqlite.prepare("INSERT INTO roles (id, role_key, name) VALUES ('r1', 'admin', '管理者')").run();
    sqlite.prepare("INSERT INTO permissions (permission, synced_at) VALUES ('admin:user:read', CURRENT_TIMESTAMP)").run();

    expect(() => sqlite.prepare("INSERT INTO role_permission_grants (role_id, permission) VALUES ('r1', 'admin:usre:read')").run())
      .toThrow(/FOREIGN KEY/i);
    // 舊表沒有外鍵，但 trigger 會把它鏡到 grants，在那裡撞上。
    expect(() => sqlite.prepare("INSERT INTO role_permissions (role_id, permission) VALUES ('r1', 'bogus:key')").run())
      .toThrow(/FOREIGN KEY/i);
  });

  it("還在被授權用的權限刪不掉——RESTRICT 不是 CASCADE", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, FK);
    sqlite.prepare("INSERT INTO roles (id, role_key, name) VALUES ('r1', 'admin', '管理者')").run();
    sqlite.prepare("INSERT INTO permissions (permission, synced_at) VALUES ('admin:user:read', CURRENT_TIMESTAMP)").run();
    sqlite.prepare("INSERT INTO role_permission_grants (role_id, permission) VALUES ('r1', 'admin:user:read')").run();

    // CASCADE 的話這一句會把所有人的授權靜靜刪光（0023 就是這樣）。
    expect(() => sqlite.prepare("DELETE FROM permissions WHERE permission = 'admin:user:read'").run())
      .toThrow(/FOREIGN KEY/i);
  });
});

describe("syncSystemRoles 之後鏡像表就是完整的", () => {
  let db: ReturnType<typeof createDatabase>;
  beforeEach(() => { db = createDatabase(createTargetOnlyD1() as never); });

  it("鏡像表列出 permissions.ts 宣告的每一個權限", async () => {
    await syncSystemRoles(db);

    const mirrored = (await db.select({ permission: permissions.permission }).from(permissions)).map((row) => row.permission);
    expect(mirrored.sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it("系統角色的授權都指得到鏡像表", async () => {
    await syncSystemRoles(db);

    const [admin] = await db.select({ id: roles.id }).from(roles).where(eq(roles.roleKey, "admin"));
    const granted = await db.select({ permission: rolePermissionGrants.permission })
      .from(rolePermissionGrants).where(eq(rolePermissionGrants.roleId, admin!.id));
    expect(granted.length).toBeGreaterThan(0);
  });
});
