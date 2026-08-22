import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 0023 在 D1 上把 LINE 群組全部連坐刪光，0028 負責救回來。
 *
 * 為什麼本機測不出來：本機的 migration runner 一句一句跑，`PRAGMA foreign_keys=OFF`
 * 有生效；但正式環境走 `wrangler d1 migrations apply`，**整支 migration 包在 transaction
 * 裡**，而 PRAGMA foreign_keys 在 transaction 裡是 no-op（SQLite 的規格）。外鍵稽核
 * 一直開著，DROP TABLE 父表就連坐刪掉了子表。
 *
 * 所以這支測試刻意用 D1 的方式跑——每一支 migration 包一個 transaction。之後任何動到
 * 有外鍵指向的表時，這裡會先炸。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../../packages/db/migrations");
const migrationFiles = fs.readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort();

/** 照 D1 的方式套用：一支 migration 一個 transaction。 */
function applyLikeD1(sqlite: DatabaseSync, from: string | null, to: string): void {
  for (const file of migrationFiles) {
    if (from && file <= from) continue;
    if (file > to) break;
    sqlite.exec("BEGIN;");
    for (const statement of fs.readFileSync(path.join(migrationsDir, file), "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
    sqlite.exec("COMMIT;");
  }
}

function seedPreMigrationState(sqlite: DatabaseSync): void {
  sqlite.exec(`
    INSERT INTO assistant_line_channels
      (assistant_key, channel_id, channel_secret_encrypted, access_token_encrypted, display_name, enabled, updated_by)
    VALUES ('rueisiang-xiaoxiang', 'ch-1', 's', 't', 'Rueisiang 小香', 1, 'eli');
  `);
  for (const [i, lineGroupId] of ["Caaa", "Cbbb", "Cccc"].entries()) {
    sqlite.exec(`
      INSERT INTO assistant_line_groups (id, assistant_key, line_group_id, display_name, enabled)
      VALUES ('g${i}', 'rueisiang-xiaoxiang', '${lineGroupId}', '群組${i}', 1);
    `);
    // 每個群組都標註過小香——這就是之後唯一還救得回來的線索。
    sqlite.exec(`
      INSERT INTO assistant_line_messages
        (id, assistant_key, line_group_id, source_type, webhook_event_id, text, created_at)
      VALUES ('m${i}', 'rueisiang-xiaoxiang', '${lineGroupId}', 'group', 'e${i}', '@小香 你好', '2026-08-20T0${i}:00:00.000Z');
    `);
  }
}

describe("被 0023 誤刪的 LINE 群組", () => {
  function migrated(to: string): DatabaseSync {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0020_add_crm_order_permission.sql");
    seedPreMigrationState(sqlite);
    applyLikeD1(sqlite, "0020_add_crm_order_permission.sql", to);
    return sqlite;
  }

  it("在 D1 的執行方式下，0024 跑完群組真的會全部消失", () => {
    const sqlite = migrated("0024_amazing_ghost_rider.sql");
    expect(sqlite.prepare("SELECT COUNT(*) c FROM assistant_line_groups").get()).toEqual({ c: 0 });
    // 訊息沒有外鍵，所以沒有被連坐——這是唯一還留著的線索。
    expect(sqlite.prepare("SELECT COUNT(*) c FROM assistant_line_messages").get()).toEqual({ c: 3 });
  });

  it("0028 從訊息紀錄把三個群組都救回來", () => {
    const sqlite = migrated("0028_restore_line_groups.sql");
    const rows = sqlite.prepare(
      "SELECT line_group_id, display_name, enabled, tool_mode FROM assistant_line_groups ORDER BY line_group_id",
    ).all();
    expect(rows).toEqual([
      { line_group_id: "Caaa", display_name: "", enabled: 0, tool_mode: "inherit" },
      { line_group_id: "Cbbb", display_name: "", enabled: 0, tool_mode: "inherit" },
      { line_group_id: "Cccc", display_name: "", enabled: 0, tool_mode: "inherit" },
    ]);
  });

  it("救回來的一律是未開通——名稱與開關救不回來，不該擅自替管理員決定", () => {
    const sqlite = migrated("0028_restore_line_groups.sql");
    const enabled = sqlite.prepare("SELECT COUNT(*) c FROM assistant_line_groups WHERE enabled = 1").get();
    expect(enabled).toEqual({ c: 0 });
  });

  it("重跑不會產生重複的群組", () => {
    const sqlite = migrated("0028_restore_line_groups.sql");
    const sql = fs.readFileSync(path.join(migrationsDir, "0028_restore_line_groups.sql"), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
    expect(sqlite.prepare("SELECT COUNT(*) c FROM assistant_line_groups").get()).toEqual({ c: 3 });
  });
});
