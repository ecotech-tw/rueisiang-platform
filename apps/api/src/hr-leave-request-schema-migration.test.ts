import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

let d1: LocalD1 | undefined;

function applyMigration(name: string) {
  const sql = fs.readFileSync(new URL(`../../../packages/db/migrations/${name}`, import.meta.url), "utf8");
  d1!.sqlite.exec("BEGIN");
  try {
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) d1!.sqlite.exec(trimmed);
    }
    d1!.sqlite.exec("COMMIT");
  } catch (error) {
    d1!.sqlite.exec("ROLLBACK");
    throw error;
  }
}

function insertFixture() {
  d1!.sqlite.exec(`
    INSERT INTO users (id, email, display_name, status) VALUES ('repair-user', 'repair@example.test', '修復測試', 'active');
    INSERT INTO hr_employments (id, employee_user_id, employee_number, position) VALUES ('repair-employment', 'repair-user', 'REPAIR-1', '一般職員');
    INSERT INTO hr_leave_types (id, name, active, default_pay_rate_ppm, created_by) VALUES ('repair-leave-type', '病假', 1, 1000000, 'repair-user');
    INSERT INTO hr_annual_leave_policy_versions (id, version_number, valid_from, created_by) VALUES ('repair-policy', 99, '2024-01-01', 'repair-user');
    INSERT INTO hr_annual_leave_brackets (id, policy_version_id, min_service_months, entitled_days) VALUES ('repair-bracket', 'repair-policy', 6, 7);
    INSERT INTO hr_annual_leave_entitlements (id, employment_id, policy_version_id, bracket_id, service_months, period_start, period_end, entitled_half_hours, created_by)
      VALUES ('repair-entitlement', 'repair-employment', 'repair-policy', 'repair-bracket', 12, '2026-01-01', '2027-01-01', 14, 'repair-user');
    INSERT INTO hr_leave_requests
      (id, employment_id, leave_type_id, leave_type, status, starts_at, ends_at, starts_on, ends_on, duration_minutes, pay_rate_ppm, reason, created_by)
      VALUES ('repair-request', 'repair-employment', 'repair-leave-type', '病假', 'approved', '2026-01-05 01:15:00', '2026-01-05 03:45:00', '2026-01-05', '2026-01-06', 150, 1000000, '保留資料', 'repair-user');
    INSERT INTO hr_annual_leave_ledger
      (id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by)
      VALUES ('repair-ledger', 'repair-entitlement', 'grant', 1, 'repair-source', 'repair-request', '保留台帳', 'repair-user');
  `);
}

function makeStaleLeaveRequestSchema() {
  d1!.sqlite.exec(`
    ALTER TABLE hr_annual_leave_ledger RENAME TO __stale_hr_annual_leave_ledger;
    ALTER TABLE hr_leave_requests RENAME TO __stale_hr_leave_requests;
    DROP INDEX IF EXISTS idx_hr_leave_requests_employment_period;
    DROP INDEX IF EXISTS idx_hr_leave_requests_employment_time;
    DROP INDEX IF EXISTS idx_hr_leave_requests_leave_type;
    CREATE TABLE hr_leave_requests (
      id text PRIMARY KEY NOT NULL,
      employment_id text NOT NULL,
      leave_type text NOT NULL,
      status text NOT NULL,
      starts_on text NOT NULL,
      ends_on text NOT NULL,
      duration_minutes integer NOT NULL,
      pay_rate_ppm integer DEFAULT 1000000 NOT NULL,
      reason text DEFAULT '' NOT NULL,
      reviewed_by text,
      reviewed_at text,
      review_comment text,
      created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
      created_by text NOT NULL,
      FOREIGN KEY (employment_id) REFERENCES hr_employments(id) ON DELETE restrict,
      FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE restrict,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE restrict
    );
    INSERT INTO hr_leave_requests
      (id, employment_id, leave_type, status, starts_on, ends_on, duration_minutes, pay_rate_ppm, reason, reviewed_by, reviewed_at, review_comment, created_at, created_by)
      SELECT id, employment_id, leave_type, status, starts_on, ends_on, duration_minutes, pay_rate_ppm, reason, reviewed_by, reviewed_at, review_comment, created_at, created_by
      FROM __stale_hr_leave_requests;
    CREATE TABLE hr_annual_leave_ledger (
      id text PRIMARY KEY NOT NULL,
      entitlement_id text NOT NULL,
      entry_kind text NOT NULL,
      delta_half_hours integer NOT NULL,
      source_key text NOT NULL,
      leave_request_id text,
      note text DEFAULT '' NOT NULL,
      created_by text,
      created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (entitlement_id) REFERENCES hr_annual_leave_entitlements(id) ON DELETE restrict,
      FOREIGN KEY (leave_request_id) REFERENCES hr_leave_requests(id) ON DELETE restrict,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE restrict
    );
    INSERT INTO hr_annual_leave_ledger
      (id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by, created_at)
      SELECT id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by, created_at
      FROM __stale_hr_annual_leave_ledger;
    DROP TABLE __stale_hr_annual_leave_ledger;
    DROP TABLE __stale_hr_leave_requests;
  `);
}

afterEach(() => {
  d1?.sqlite.close();
  d1 = undefined;
});

describe("HR 請假申請 schema 修復 migration", () => {
  it("保留正確 schema 的時間與關聯，並修復被舊 migration 順序覆蓋的資料庫", () => {
    d1 = createTargetOnlyD1();
    insertFixture();

    // 正常 schema 也會經過一次重建；trigger 必須保留既有的精確時間。
    applyMigration("0189_repair_hr_leave_request_schema.sql");
    expect(d1.sqlite.prepare("SELECT leave_type_id, starts_at, ends_at FROM hr_leave_requests WHERE id=?").get("repair-request")).toEqual({
      leave_type_id: "repair-leave-type",
      starts_at: "2026-01-05 01:15:00",
      ends_at: "2026-01-05 03:45:00",
    });
    expect(d1.sqlite.prepare("SELECT leave_request_id FROM hr_annual_leave_ledger WHERE id=?").get("repair-ledger")).toEqual({ leave_request_id: "repair-request" });

    makeStaleLeaveRequestSchema();
    expect(d1.sqlite.prepare("SELECT name FROM pragma_table_info('hr_leave_requests') WHERE name IN ('leave_type_id', 'starts_at', 'ends_at')").all()).toHaveLength(0);

    applyMigration("0189_repair_hr_leave_request_schema.sql");
    expect(d1.sqlite.prepare("SELECT leave_type_id, starts_at, ends_at FROM hr_leave_requests WHERE id=?").get("repair-request")).toEqual({
      leave_type_id: "repair-leave-type",
      starts_at: "2026-01-04 16:00:00",
      ends_at: "2026-01-05 16:00:00",
    });
    expect(d1.sqlite.prepare("SELECT leave_request_id FROM hr_annual_leave_ledger WHERE id=?").get("repair-ledger")).toEqual({ leave_request_id: "repair-request" });
    expect(d1.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
