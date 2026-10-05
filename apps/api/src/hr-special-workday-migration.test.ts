import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));

/** D1 會把每支 migration 包在 transaction；測試也要照同一個邊界執行。 */
function applyMigration(sqlite: DatabaseSync, file: string) {
  sqlite.exec("BEGIN");
  try {
    for (const statement of readFileSync(path.join(migrationsDirectory, file), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

describe("特殊上班日套用資料 migration", () => {
  it("在 D1 transaction 與外鍵開啟時保留舊資料並移除版本快照欄位", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys = ON");
      for (const file of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql") && name < "0198").sort()) applyMigration(sqlite, file);
      sqlite.exec(`
        INSERT INTO users(id, email) VALUES ('migration-user', 'migration@example.test');
        INSERT INTO hr_schedule_workers(id, display_name, created_by) VALUES ('migration-worker', '搬移測試', 'migration-user');
        INSERT INTO hr_special_workday_rules(id, name, created_by) VALUES ('migration-rule', '搬移規則', 'migration-user');
        INSERT INTO hr_special_workday_rule_versions(id, rule_id, version_number, valid_from, wage_kind, fixed_amount_minor, multiplier_ppm, overtime_rule, work_source, created_by)
          VALUES ('migration-version', 'migration-rule', 1, '2026-09-01', 'multiplier', NULL, 1800000, '一般加班', 'hourly', 'migration-user');
        INSERT INTO hr_special_workday_assignments(id, rule_version_id, employment_id, worker_id, work_date, rule_name_snapshot, wage_kind_snapshot, fixed_amount_minor_snapshot, multiplier_ppm_snapshot, work_source_snapshot, allowance_snapshot_json, allowance_quantity, applied_by)
          VALUES ('migration-assignment', 'migration-version', NULL, 'migration-worker', '2026-09-30', '舊規則名稱', 'multiplier', NULL, 1800000, 'hourly', '[{"itemName":"餐費","unitAmountMinor":100,"quantity":2}]', 2, 'migration-user');
      `);
      for (const file of ["0198_misty_millenium_guard.sql", "0199_backfill_special_workday_rule_ids.sql", "0200_worried_luminals.sql"]) applyMigration(sqlite, file);

      expect(sqlite.prepare("SELECT id, rule_id, work_date, allowance_snapshot_json FROM hr_special_workday_assignments WHERE id = 'migration-assignment'").get()).toEqual({
        id: "migration-assignment",
        rule_id: "migration-rule",
        work_date: "2026-09-30",
        allowance_snapshot_json: '[{"itemName":"餐費","unitAmountMinor":100,"quantity":2}]',
      });
      const columns = (sqlite.prepare("SELECT name FROM pragma_table_info('hr_special_workday_assignments') ORDER BY cid").all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).toContain("rule_id");
      expect(columns).not.toContain("rule_version_id");
      expect(columns).not.toContain("rule_name_snapshot");
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
