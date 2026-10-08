import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migration = "0222_burly_synch.sql";

function apply(sqlite: DatabaseSync, file: string) {
  sqlite.exec("BEGIN");
  try {
    for (const statement of readFileSync(path.join(directory, file), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

describe("0222 員工自助通知與審核者 migration", () => {
  it("在 D1 transaction 中保留既有申請並新增審核者欄位與通知表", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < migration).sort()) apply(sqlite, file);
      sqlite.exec(`
        INSERT INTO users (id, email, status) VALUES ('self-service-user', 'self-service@example.test', 'active');
        INSERT INTO hr_employments (id, employee_user_id, employee_number, legal_name, position)
          VALUES ('self-service-employment', 'self-service-user', 'E-SELF', '自助測試員工', '測試職員');
        INSERT INTO hr_leave_requests
          (id, employment_id, leave_type, status, starts_on, ends_on, duration_minutes, created_by)
          VALUES ('self-service-leave', 'self-service-employment', '病假', 'pending', '2026-01-05', '2026-01-06', 480, 'self-service-user');
        INSERT INTO hr_overtime_requests
          (id, employment_id, requested_start, requested_end, settlement_kind, created_by)
          VALUES ('self-service-overtime', 'self-service-employment', '2026-01-05 09:00:00', '2026-01-05 10:00:00', 'pay', 'self-service-user');
      `);

      apply(sqlite, migration);

      expect(sqlite.prepare("SELECT id, approver_user_id, revision FROM hr_leave_requests WHERE id='self-service-leave'").get()).toEqual({
        id: "self-service-leave", approver_user_id: null, revision: 1,
      });
      expect(sqlite.prepare("SELECT id, approver_user_id FROM hr_overtime_requests WHERE id='self-service-overtime'").get()).toEqual({
        id: "self-service-overtime", approver_user_id: null,
      });
      expect(sqlite.prepare("SELECT count(*) AS count FROM hr_notifications").get()).toEqual({ count: 0 });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(readFileSync(path.join(directory, migration), "utf8")).not.toMatch(/PRAGMA\s+foreign_keys\s*=\s*OFF|DROP\s+TABLE/i);
    } finally {
      sqlite.close();
    }
  });
});
