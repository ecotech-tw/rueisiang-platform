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

describe("加班取消改為刪除的 migration", () => {
  it("在 D1 transaction 與外鍵開啟時只刪除已取消的申請，並讓被駁回的時段可以重新申請", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys = ON");
      for (const file of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql") && name < "0213").sort()) applyMigration(sqlite, file);
      sqlite.exec(`
        INSERT INTO users(id, email) VALUES ('migration-user', 'migration@example.test');
        INSERT INTO hr_employments(id, employee_user_id, employee_number, position) VALUES ('migration-employment', 'migration-user', 'E-MIGRATION', '櫃點人員');
      `);
      const insert = sqlite.prepare(`INSERT INTO hr_overtime_requests(id, employment_id, requested_start, requested_end, settlement_kind, status, rate_ppm, created_by)
        VALUES (?, 'migration-employment', ?, ?, 'pay', ?, 1333333, 'migration-user')`);
      insert.run("approved", "2026-09-01 10:00:00", "2026-09-01 11:00:00", "approved");
      insert.run("pending", "2026-09-02 10:00:00", "2026-09-02 11:00:00", "pending");
      insert.run("rejected", "2026-09-03 10:00:00", "2026-09-03 11:00:00", "rejected");
      insert.run("cancelled", "2026-09-04 10:00:00", "2026-09-04 11:00:00", "cancelled");

      for (const file of ["0213_ambitious_black_bolt.sql", "0214_delete_cancelled_overtime.sql"]) applyMigration(sqlite, file);

      expect(sqlite.prepare("SELECT id FROM hr_overtime_requests ORDER BY id").all()).toEqual([{ id: "approved" }, { id: "pending" }, { id: "rejected" }]);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      // 被駁回的時段可以重新申請；仍然有效的申請之間照舊不能有完全相同的時段。
      insert.run("after-rejected", "2026-09-03 10:00:00", "2026-09-03 11:00:00", "approved");
      expect(() => insert.run("duplicate", "2026-09-01 10:00:00", "2026-09-01 11:00:00", "pending")).toThrow(/UNIQUE constraint failed/);
    } finally {
      sqlite.close();
    }
  });
});
