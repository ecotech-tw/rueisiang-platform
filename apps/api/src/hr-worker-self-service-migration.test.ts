import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const first = "0239_lame_maginty.sql";
const guards = "0240_hr_worker_self_service_guards.sql";
function apply(sqlite: DatabaseSync, file: string) {
  sqlite.exec("BEGIN");
  try {
    for (const statement of readFileSync(path.join(directory, file), "utf8").split("--> statement-breakpoint")) if (statement.trim()) sqlite.exec(statement);
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

describe("支援人員本人服務 migration", () => {
  it("逐支 transaction 升級，保留原任職、敘薪、出勤與薪資，並維持打卡身分及正式人事隔離", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < first).sort()) apply(sqlite, file);
      sqlite.exec(`
        INSERT INTO users (id, email, status) VALUES ('formal', 'formal@test.local', 'active'), ('worker', 'worker@test.local', 'active'), ('other', 'other@test.local', 'active');
        INSERT INTO hr_employments (id, employee_user_id, employee_number, legal_name) VALUES ('formal-job', 'formal', 'E1', '正式員工');
        INSERT INTO hr_employments (id, person_kind, employee_number, legal_name) VALUES ('worker-job', 'worker', 'W1', '支援人員');
        INSERT INTO hr_attendance_locations (id, name, latitude_e7, longitude_e7) VALUES ('location', '櫃位', 250000000, 1215000000);
        INSERT INTO hr_clock_events (id, employee_user_id, employment_id, idempotency_key, event_kind) VALUES ('old-clock', 'formal', 'formal-job', 'old-clock', 'clock_in');
        INSERT INTO hr_worker_compensation_versions (id, worker_id, version_number, valid_from, pay_basis, base_amount_minor, created_by) VALUES ('old-compensation', 'worker-job', 1, '2026-11-01', 'daily', 190000, 'formal');
        INSERT INTO hr_payroll_periods (id, period_key, attendance_start, attendance_end, created_by) VALUES ('old-period', '2026-11', '2026-11-01', '2026-12-01', 'formal');
        INSERT INTO hr_payroll_runs (id, payroll_period_id, version_number, request_id, input_revision, engine_version, status, created_by) VALUES ('old-run', 'old-period', 1, 'old-run', 1, 'test', 'ready', 'formal');
        INSERT INTO hr_payroll_worker_results (id, payroll_run_id, worker_id, worker_name, pay_basis, scheduled_days, amount_minor) VALUES ('old-payroll', 'old-run', 'worker-job', '支援人員', 'daily', 1, 190000);
        UPDATE hr_payroll_runs SET status='closed' WHERE id='old-run';
      `);
      const before = ["hr_employments", "hr_worker_compensation_versions", "hr_clock_events", "hr_payroll_worker_results"].map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()] as const);
      apply(sqlite, first);
      apply(sqlite, guards);
      for (const [table, rows] of before) expect(sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all(), table).toEqual(rows);
      sqlite.exec(`
        INSERT INTO hr_worker_account_links (worker_id, user_id, linked_by) VALUES ('worker-job', 'worker', 'formal');
        INSERT INTO hr_employment_attendance_settings (employment_id, attendance_mode) VALUES ('worker-job', 'scheduled');
        INSERT INTO hr_employee_attendance_locations (id, employment_id, location_id, valid_from) VALUES ('worker-location', 'worker-job', 'location', '2026-11-01');
        INSERT INTO hr_clock_events (id, employee_user_id, employment_id, idempotency_key, event_kind) VALUES ('worker-clock', 'worker', 'worker-job', 'worker-clock', 'clock_in');
      `);
      expect(() => sqlite.exec("INSERT INTO hr_clock_events (id, employee_user_id, employment_id, idempotency_key, event_kind) VALUES ('invalid', 'other', 'worker-job', 'invalid', 'clock_in')")).toThrow("hr_clock_identity_mismatch");
      expect(() => sqlite.exec("UPDATE hr_clock_events SET employee_user_id='other' WHERE id='worker-clock'")).toThrow("hr_clock_identity_mismatch");
      expect(() => sqlite.exec("INSERT INTO hr_employment_service_periods (employment_id, service_start_on) VALUES ('worker-job', '2026-11-01')")).toThrow("formal_employee_employment_required");
      expect(() => sqlite.exec("INSERT INTO hr_form_requests (id, employee_user_id, employment_id, correction_date, requested_event_kind, requested_at, reason) VALUES ('invalid-form', 'worker', 'worker-job', '2026-11-01', 'clock_in', '2026-11-01 00:00:00', '不可申請')")).toThrow("formal_employee_identity_mismatch");
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(readFileSync(path.join(directory, guards), "utf8")).not.toMatch(/DROP\s+TABLE|DELETE\s+FROM|PRAGMA\s+foreign_keys\s*=\s*OFF/i);
    } finally { sqlite.close(); }
  });
});
