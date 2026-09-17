import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migrationFiles = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

/**
 * 照 D1 的方式套用：每一支 migration 都在自己的 transaction 內完成，失敗就整支回滾。
 *
 * 一句一句 exec 的話，閘門那支失敗時前面的 CREATE TABLE 會留下來，測試會給出 D1 上
 * 不存在的狀態——這支測試要證明的正是「整支回滾」。
 */
function applyLikeD1(sqlite: DatabaseSync, from: string | null, to: string): void {
  for (const file of migrationFiles) {
    if (from && file <= from) continue;
    if (file > to) break;
    sqlite.exec("BEGIN;");
    try {
      for (const statement of readFileSync(path.join(migrationsDir, file), "utf8").split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed) sqlite.exec(trimmed);
      }
      sqlite.exec("COMMIT;");
    } catch (error) {
      sqlite.exec("ROLLBACK;");
      throw error;
    }
  }
}

const BEFORE = "0159_burly_red_wolf.sql";
const GUARD = "0160_guard_bonus_pool_empty.sql";
const DROP_POOLS = "0162_curvy_midnight.sql";
const BONUS_POOL_TABLES = ["hr_bonus_pools", "hr_bonus_allocations", "hr_bonus_revenue_snapshots", "hr_bonus_performance_snapshots"];

function tableNames(sqlite: DatabaseSync) {
  return sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
}

describe("移除獎金池那四張表", () => {
  it("四張表都是空的時候，閘門放行並刪乾淨", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, DROP_POOLS);

    const tables = tableNames(sqlite);
    for (const table of BONUS_POOL_TABLES) expect(tables).not.toContain(table);
    // 閘門自己的表只在交易裡活一下，不能殘留成一張沒人認得的表。
    expect(tables).not.toContain("_guard_bonus_pool_empty");
  });

  it("只要有一筆資料，閘門就擋下部署，資料原封不動", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);
    sqlite.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@b.c')").run();
    sqlite.prepare("INSERT INTO scopes (id, scope_kind, name, normalized_name) VALUES ('s1', 'store', '示範店', '示範店')").run();
    sqlite.prepare(`INSERT INTO hr_bonus_performance_snapshots
      (id, scope_id, employment_id, period_start, period_end, amount_minor, source_kind, source_ref, idempotency_key, provenance_json, created_by)
      VALUES ('p1', 's1', NULL, '2026-09-01', '2026-10-01', 100, 'manual', '', 'k1', '{}', 'u1')`).run();

    expect(() => applyLikeD1(sqlite, BEFORE, GUARD)).toThrow(/CHECK constraint failed/);

    // DROP 不可逆，所以要證明的不只是「有報錯」，而是報錯之後什麼都沒被刪。
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM hr_bonus_performance_snapshots").get()).toEqual({ n: 1 });
    const tables = tableNames(sqlite);
    for (const table of BONUS_POOL_TABLES) expect(tables).toContain(table);
    expect(tables).not.toContain("_guard_bonus_pool_empty");
  });
});
