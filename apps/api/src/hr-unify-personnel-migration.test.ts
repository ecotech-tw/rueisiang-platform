import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));

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

describe("0220 共用人員 migration", () => {
  it("保留正式員工與支援人員 ID、歷史敘薪，並把 worker 子表改接 canonical employment", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < "0220_").sort()) apply(sqlite, file);
      sqlite.exec(`
        INSERT INTO users(id, email, status) VALUES ('migration-user', 'migration@example.test', 'active');
        INSERT INTO hr_employments(id, employee_user_id, employee_number, legal_name, position)
          VALUES ('formal-employment', 'migration-user', 'E-MIGRATION', '正式測試員工', '測試職員');
        INSERT INTO scopes(id, source_type, scope_kind, name, normalized_name)
          VALUES ('migration-scope', 'manual', 'store', '測試櫃點', '測試櫃點');
        INSERT INTO hr_shift_templates(id, code, name, created_by)
          VALUES ('migration-template', 'MIG', '測試班別', 'migration-user');
        INSERT INTO hr_shift_versions(id, shift_template_id, version_number, start_second, end_second, created_by)
          VALUES ('migration-shift', 'migration-template', 1, 32400, 64800, 'migration-user');
        INSERT INTO hr_schedule_versions(id, period_start, period_end, version_number, status, submitted_by, approved_by)
          VALUES ('migration-schedule', '2026-01-01', '2026-02-01', 1, 'published', 'migration-user', 'migration-user');
        INSERT INTO hr_payroll_periods(id, period_key, attendance_start, attendance_end, created_by)
          VALUES ('payroll-period-2026-01', '2026-01', '2026-01-01', '2026-02-01', 'migration-user');
        INSERT INTO hr_payroll_runs(id, payroll_period_id, version_number, request_id, input_revision, engine_version, status, created_by)
          VALUES ('migration-run', 'payroll-period-2026-01', 1, 'migration-request', 1, 'test', 'ready', 'migration-user');
        INSERT INTO hr_special_workday_rules(id, name, created_by)
          VALUES ('migration-rule', '測試特殊日', 'migration-user');
        INSERT INTO hr_special_workday_rule_versions(id, rule_id, version_number, valid_from, wage_kind, fixed_amount_minor, overtime_rule, work_source, created_by)
          VALUES ('migration-rule-v1', 'migration-rule', 1, '2026-01-01', 'fixed_hourly', 10000, '[]', 'hourly', 'migration-user');
        INSERT INTO hr_compensation_versions(id, employment_id, version_number, valid_from, pay_basis, base_amount_minor, created_by)
          VALUES ('formal-compensation', 'formal-employment', 1, '2026-01-01', 'monthly', 300000, 'migration-user');
      `);

      const workerIds = ["worker-1", "worker-2", "worker-3", "worker-4"];
      for (const [index, workerId] of workerIds.entries()) {
        const number = index + 1;
        const day = `2026-01-0${number}`;
        sqlite.prepare("INSERT INTO hr_schedule_workers(id, display_name, active, created_by) VALUES (?, ?, 1, ?)").run(workerId, `支援${number}`, "migration-user");
        sqlite.prepare("INSERT INTO hr_worker_compensation_versions(id, worker_id, version_number, valid_from, pay_basis, base_amount_minor, created_by) VALUES (?, ?, 1, '2026-01-01', 'daily', ?, ?)").run(`worker-compensation-${number}`, workerId, 12000 * number, "migration-user");
        sqlite.prepare("INSERT INTO hr_schedule_worker_entries(id, schedule_version_id, worker_id, scope_id, shift_version_id, work_date, starts_at, ends_at, created_by) VALUES (?, 'migration-schedule', ?, 'migration-scope', 'migration-shift', ?, ?, ?, 'migration-user')").run(`worker-schedule-${number}`, workerId, day, `${day} 09:00:00`, `${day} 18:00:00`);
        sqlite.prepare("INSERT INTO hr_worker_overtime_requests(id, worker_id, scope_id, requested_start, requested_end, settlement_kind, created_by) VALUES (?, ?, 'migration-scope', ?, ?, 'pay', 'migration-user')").run(`worker-overtime-${number}`, workerId, `${day} 18:00:00`, `${day} 19:00:00`);
        sqlite.prepare("INSERT INTO hr_payroll_worker_results(id, payroll_run_id, worker_id, worker_name, compensation_version_id, pay_basis, scheduled_days, amount_minor) VALUES (?, 'migration-run', ?, ?, ?, 'daily', 1, ?)").run(`worker-result-${number}`, workerId, `支援${number}`, `worker-compensation-${number}`, 12000 * number);
        sqlite.prepare("INSERT INTO hr_payroll_closed_workers(period_key, worker_id, payroll_run_id) VALUES ('2026-01', ?, 'migration-run')").run(workerId);
        sqlite.prepare("INSERT INTO hr_special_workday_assignments(id, rule_id, worker_id, work_date, applied_by) VALUES (?, 'migration-rule', ?, ?, 'migration-user')").run(`worker-special-day-${number}`, workerId, `2026-02-0${number}`);
        sqlite.prepare("INSERT INTO hr_payroll_record_items(id, payroll_run_id, person_kind, worker_id, item_name, direction, amount_minor, reason, created_by) VALUES (?, 'migration-run', 'worker', ?, '測試補貼', 'earning', 100, '測試', 'migration-user')").run(`worker-record-item-${number}`, workerId);
      }

      apply(sqlite, "0220_thick_princess_powerful.sql");

      expect(sqlite.prepare("SELECT id, person_kind, employee_user_id, employee_number, legal_name FROM hr_employments ORDER BY id").all()).toEqual([
        { id: "formal-employment", person_kind: "employee", employee_user_id: "migration-user", employee_number: "E-MIGRATION", legal_name: "正式測試員工" },
        { id: "worker-1", person_kind: "worker", employee_user_id: null, employee_number: "W-worker1", legal_name: "支援1" },
        { id: "worker-2", person_kind: "worker", employee_user_id: null, employee_number: "W-worker2", legal_name: "支援2" },
        { id: "worker-3", person_kind: "worker", employee_user_id: null, employee_number: "W-worker3", legal_name: "支援3" },
        { id: "worker-4", person_kind: "worker", employee_user_id: null, employee_number: "W-worker4", legal_name: "支援4" },
      ]);
      expect(sqlite.prepare("SELECT id, employment_id, display_name FROM hr_schedule_workers ORDER BY id").all()).toEqual(workerIds.map((id, index) => ({ id, employment_id: id, display_name: `支援${index + 1}` })));
      expect(sqlite.prepare("SELECT employment_id, base_amount_minor FROM hr_compensation_versions").get()).toEqual({ employment_id: "formal-employment", base_amount_minor: 300000 });
      expect(sqlite.prepare("SELECT worker_id, base_amount_minor FROM hr_worker_compensation_versions ORDER BY worker_id").all()).toEqual(workerIds.map((workerId, index) => ({ worker_id: workerId, base_amount_minor: 12000 * (index + 1) })));
      for (const table of ["hr_schedule_worker_entries", "hr_worker_overtime_requests", "hr_payroll_worker_results", "hr_payroll_closed_workers", "hr_special_workday_assignments", "hr_payroll_record_items"]) {
        expect(sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: workerIds.length });
      }
      const legacyReferences = sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE name <> 'hr_schedule_workers' AND sql LIKE '%REFERENCES%hr_schedule_workers%'").all();
      expect(legacyReferences).toEqual([]);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("活動編號碰撞時在拆表前中止，保留原始資料供人工處理", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < "0220_").sort()) apply(sqlite, file);
      sqlite.exec(`
        INSERT INTO users(id, email, status) VALUES ('collision-user', 'collision@example.test', 'active');
        INSERT INTO hr_employments(id, employee_user_id, employee_number, legal_name, position)
          VALUES ('formal-employment', 'collision-user', 'W-workeremployment', '正式測試員工', '測試職員');
        INSERT INTO hr_schedule_workers(id, display_name, active, created_by)
          VALUES ('worker-employment', '支援測試人員', 1, 'collision-user');
      `);

      expect(() => apply(sqlite, "0220_thick_princess_powerful.sql")).toThrow("hr_unify_0220_employee_number_collision");
      expect(sqlite.prepare("SELECT employee_number FROM hr_employments").all()).toEqual([{ employee_number: "W-workeremployment" }]);
      expect(sqlite.prepare("PRAGMA table_info(hr_employments)").all().some((column) => (column as { name: string }).name === "person_kind")).toBe(false);
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE '__hr_unify_0220_%'").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
