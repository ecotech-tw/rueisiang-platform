import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));

function triggerInventory(sqlite: DatabaseSync) {
  return (sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as Array<{ name: string; sql: string }>)
    .map(({ name, sql }) => ({ name, sql: sql.replace(/\s+/g, " ").trim() }));
}

function foreignKeyInventory(sqlite: DatabaseSync) {
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return tables.flatMap(({ name }) => {
    const quotedName = name.replaceAll("'", "''");
    const foreignKeys = sqlite.prepare(`PRAGMA foreign_key_list('${quotedName}')`).all() as Array<{
      from: string;
      table: string;
      to: string;
      on_delete: string;
      on_update: string;
    }>;
    return foreignKeys.map((foreignKey) => ({
      child: name,
      from: foreignKey.from,
      parent: foreignKey.table,
      to: foreignKey.to,
      onDelete: foreignKey.on_delete,
      onUpdate: foreignKey.on_update,
    }));
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

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

      const triggersBeforeMigration = triggerInventory(sqlite);
      const foreignKeysBeforeMigration = foreignKeyInventory(sqlite);
      apply(sqlite, "0220_thick_princess_powerful.sql");
      const foreignKeysAfterMigration = foreignKeyInventory(sqlite);
      const foreignKeyKey = (foreignKey: ReturnType<typeof foreignKeyInventory>[number]) => `${foreignKey.child}.${foreignKey.from}`;
      const foreignKeysBeforeByKey = new Map(foreignKeysBeforeMigration.map((foreignKey) => [foreignKeyKey(foreignKey), foreignKey]));
      const foreignKeysAfterByKey = new Map(foreignKeysAfterMigration.map((foreignKey) => [foreignKeyKey(foreignKey), foreignKey]));
      const removedForeignKeys = [...foreignKeysBeforeByKey.keys()].filter((key) => !foreignKeysAfterByKey.has(key)).sort();
      const addedForeignKeys = [...foreignKeysAfterByKey.keys()].filter((key) => !foreignKeysBeforeByKey.has(key)).sort();
      const reparentedForeignKeys = [...foreignKeysBeforeByKey].flatMap(([key, before]) => {
        const after = foreignKeysAfterByKey.get(key);
        return after && (before.parent !== after.parent || before.to !== after.to)
          ? [`${key}:${before.parent}.${before.to}->${after.parent}.${after.to}`]
          : [];
      }).sort();
      const foreignKeyActions = (inventory: ReturnType<typeof foreignKeyInventory>) => inventory
        .map((foreignKey) => `${foreignKeyKey(foreignKey)}:${foreignKey.onDelete}:${foreignKey.onUpdate}`).sort();
      expect(removedForeignKeys).toEqual([]);
      expect(addedForeignKeys).toEqual(["hr_schedule_workers.employment_id"]);
      expect(reparentedForeignKeys).toEqual([
        "hr_payroll_closed_workers.worker_id:hr_schedule_workers.id->hr_employments.id",
        "hr_payroll_record_items.worker_id:hr_schedule_workers.id->hr_employments.id",
        "hr_payroll_worker_results.worker_id:hr_schedule_workers.id->hr_employments.id",
        "hr_schedule_worker_entries.worker_id:hr_schedule_workers.id->hr_employments.id",
        "hr_special_workday_assignments.worker_id:hr_schedule_workers.id->hr_employments.id",
        "hr_worker_compensation_versions.worker_id:hr_schedule_workers.id->hr_employments.id",
        "hr_worker_overtime_requests.worker_id:hr_schedule_workers.id->hr_employments.id",
      ]);
      expect(foreignKeyActions(foreignKeysAfterMigration)).toEqual([
        ...foreignKeyActions(foreignKeysBeforeMigration),
        "hr_schedule_workers.employment_id:RESTRICT:NO ACTION",
      ].sort());

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
      expect(triggerInventory(sqlite)).toEqual(triggersBeforeMigration);
      const workerEntrySchema = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hr_schedule_worker_entries'").get() as { sql: string };
      expect(workerEntrySchema.sql).toContain("ck_hr_schedule_worker_entries_standard");
      expect(workerEntrySchema.sql).toContain("ck_hr_schedule_worker_entries_break");
      const workerResultSchema = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hr_payroll_worker_results'").get() as { sql: string };
      expect(workerResultSchema.sql).toContain("ck_hr_payroll_worker_results_overtime");

      expect(() => sqlite.prepare("UPDATE hr_worker_compensation_versions SET overtime_rate_ppm = 0 WHERE id = 'worker-compensation-1'").run()).toThrow("hr_worker_compensation_overtime_invalid");
      expect(() => sqlite.prepare("UPDATE hr_schedule_worker_entries SET standard_minutes = 481 WHERE id = 'worker-schedule-1'").run()).toThrow("schedule_entry_minutes_exceed_duration");
      expect(() => sqlite.prepare("UPDATE hr_payroll_worker_results SET overtime_minor = -1 WHERE id = 'worker-result-1'").run()).toThrow("CHECK constraint failed");
      expect(() => sqlite.prepare(`INSERT INTO hr_monthly_hourly_entries (id, employment_id, work_date, hours_half_units, no_work, created_by, updated_by)
        VALUES ('invalid-monthly-hours', 'formal-employment', '2026-01-01', 0, 0, 'migration-user', 'migration-user')`).run()).toThrow("monthly_hourly_validation_failed");
      expect(() => sqlite.prepare(`INSERT INTO hr_overtime_requests (id, employment_id, scope_id, requested_start, requested_end, settlement_kind, created_by)
        VALUES ('formal-overtime', 'formal-employment', 'migration-scope', '2026-01-05 18:00:00', '2026-01-05 19:00:00', 'pay', 'migration-user')`).run()).not.toThrow();
      expect(() => sqlite.prepare("UPDATE hr_overtime_requests SET rate_ppm = 1400000 WHERE id = 'formal-overtime'").run()).toThrow("overtime_rate_server_determined");
      sqlite.prepare("INSERT INTO hr_payroll_closed_employees (period_key, employment_id, payroll_run_id) VALUES ('2026-01', 'formal-employment', 'migration-run')").run();
      expect(() => sqlite.prepare("DELETE FROM hr_payroll_closed_employees WHERE period_key = '2026-01' AND employment_id = 'formal-employment'").run()).toThrow("payroll_run_closed");
      apply(sqlite, "0221_peaceful_wolf_cub.sql");
      expect(foreignKeyInventory(sqlite)).toEqual(foreignKeysAfterMigration);
      const workerEmploymentIndex = (sqlite.prepare("PRAGMA index_list('hr_schedule_workers')").all() as Array<{ name: string; unique: number }>).find((index) => index.name === "idx_hr_schedule_workers_employment");
      expect(workerEmploymentIndex?.unique).toBe(1);
      expect(() => sqlite.prepare(`INSERT INTO hr_schedule_workers (id, employment_id, display_name, active, created_by)
        VALUES ('duplicate-worker-mirror', 'worker-1', '重複鏡像', 1, 'migration-user')`).run()).toThrow("hr_schedule_worker_identity_mismatch");
      expect(() => sqlite.prepare("UPDATE hr_employments SET person_kind='employee', employee_user_id='migration-user' WHERE id='worker-1'").run()).toThrow("hr_employment_person_kind_immutable");
      expect(() => sqlite.prepare(`INSERT INTO hr_schedule_workers (id, employment_id, display_name, active, created_by)
        VALUES ('mismatched-worker-id', 'worker-4', '錯誤鏡像 ID', 1, 'migration-user')`).run()).toThrow("hr_schedule_worker_identity_mismatch");
      expect(() => sqlite.prepare("UPDATE hr_schedule_workers SET employment_id='formal-employment' WHERE id='worker-1'").run()).toThrow("worker_employment_required");
      expect(() => sqlite.prepare("UPDATE hr_worker_compensation_versions SET worker_id='formal-employment' WHERE id='worker-compensation-1'").run()).toThrow("worker_employment_required");
      expect(() => sqlite.prepare("UPDATE hr_schedule_worker_entries SET worker_id='formal-employment' WHERE id='worker-schedule-1'").run()).toThrow("worker_employment_required");
      expect(() => sqlite.prepare("UPDATE hr_worker_overtime_requests SET worker_id='formal-employment' WHERE id='worker-overtime-1'").run()).toThrow("worker_employment_required");
      expect(() => sqlite.prepare("UPDATE hr_payroll_worker_results SET worker_id='formal-employment' WHERE id='worker-result-1'").run()).toThrow("worker_employment_required");
      expect(() => sqlite.prepare("UPDATE hr_payroll_closed_workers SET worker_id='formal-employment' WHERE worker_id='worker-1'").run()).toThrow("worker_employment_required");
      expect(() => sqlite.prepare("UPDATE hr_special_workday_assignments SET worker_id='formal-employment' WHERE id='worker-special-day-1'").run()).toThrow("special_workday_person_kind_mismatch");
      expect(() => sqlite.prepare("UPDATE hr_payroll_record_items SET worker_id='formal-employment' WHERE id='worker-record-item-1'").run()).toThrow("payroll_record_person_kind_mismatch");
      expect(() => sqlite.prepare(`INSERT INTO hr_worker_compensation_versions (id, worker_id, version_number, valid_from, pay_basis, base_amount_minor, created_by)
        VALUES ('mismatched-worker-compensation', 'formal-employment', 1, '2026-01-01', 'daily', 1000, 'migration-user')`).run()).toThrow("worker_employment_required");
      expect(() => sqlite.prepare(`INSERT INTO hr_schedule_worker_entries (id, schedule_version_id, worker_id, scope_id, shift_version_id, work_date, starts_at, ends_at, created_by)
        VALUES ('mismatched-worker-schedule', 'migration-schedule', 'formal-employment', 'migration-scope', 'migration-shift', '2026-01-10', '2026-01-10 09:00:00', '2026-01-10 18:00:00', 'migration-user')`).run()).toThrow("worker_employment_required");
      expect(() => sqlite.prepare(`INSERT INTO hr_worker_overtime_requests (id, worker_id, scope_id, requested_start, requested_end, settlement_kind, created_by)
        VALUES ('mismatched-worker-overtime', 'formal-employment', 'migration-scope', '2026-01-10 18:00:00', '2026-01-10 19:00:00', 'pay', 'migration-user')`).run()).toThrow("worker_employment_required");
      expect(() => sqlite.prepare(`INSERT INTO hr_payroll_worker_results (id, payroll_run_id, worker_id, worker_name, compensation_version_id, pay_basis, scheduled_days, amount_minor)
        VALUES ('mismatched-worker-result', 'migration-run', 'formal-employment', '錯誤人員類型', 'worker-compensation-1', 'daily', 1, 1000)`).run()).toThrow("worker_employment_required");
      expect(() => sqlite.prepare("INSERT INTO hr_payroll_closed_workers (period_key, worker_id, payroll_run_id) VALUES ('2026-02', 'formal-employment', 'migration-run')").run()).toThrow("worker_employment_required");
      expect(() => sqlite.prepare(`INSERT INTO hr_special_workday_assignments (id, rule_id, worker_id, work_date, applied_by)
        VALUES ('mismatched-worker-special-day', 'migration-rule', 'formal-employment', '2026-02-10', 'migration-user')`).run()).toThrow("special_workday_person_kind_mismatch");
      expect(() => sqlite.prepare(`INSERT INTO hr_payroll_record_items(id, payroll_run_id, person_kind, worker_id, item_name, direction, amount_minor, reason, created_by)
        VALUES ('mismatched-worker-record', 'migration-run', 'worker', 'formal-employment', '錯誤人員類型', 'earning', 100, '測試', 'migration-user')`).run()).toThrow("payroll_record_person_kind_mismatch");

      const formalOnlyTables = [
        "hr_employment_service_periods", "hr_employee_scopes", "hr_employee_attendance_locations", "hr_employment_attendance_settings",
        "hr_clock_events", "hr_compensation_versions", "hr_insurance_versions", "hr_monthly_leave_entries", "hr_monthly_hourly_entries",
        "hr_leave_requests", "hr_overtime_requests", "hr_schedule_entries", "hr_bonus_policy_members", "hr_payroll_adjustments",
        "hr_payroll_closed_employees", "hr_payroll_run_employees", "hr_payslips", "hr_annual_leave_entitlements", "hr_form_requests",
      ];
      for (const table of formalOnlyTables) {
        const guards = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND name LIKE 'trg_hr_formal_%' ORDER BY name").all(table);
        expect(guards, `${table} must reject worker employment IDs on insert and update`).toHaveLength(2);
      }
      expect(() => sqlite.prepare("UPDATE hr_compensation_versions SET employment_id='worker-1' WHERE id='formal-compensation'").run()).toThrow("formal_employee_employment_required");
      expect(() => sqlite.prepare(`INSERT INTO hr_employment_service_periods (employment_id, service_start_on) VALUES ('worker-1', '2026-01-01')`).run()).toThrow("formal_employee_employment_required");
      expect(() => sqlite.prepare(`INSERT INTO hr_employee_scopes (id, employment_id, scope_id, valid_from) VALUES ('worker-scope', 'worker-1', 'migration-scope', '2026-01-01')`).run()).toThrow("formal_employee_employment_required");
      expect(() => sqlite.prepare(`INSERT INTO hr_monthly_hourly_entries (id, employment_id, work_date, hours_half_units, no_work, created_by, updated_by)
        VALUES ('worker-monthly-hours', 'worker-1', '2026-01-01', 2, 0, 'migration-user', 'migration-user')`).run()).toThrow("formal_employee_employment_required");
      expect(() => sqlite.prepare(`INSERT INTO hr_payroll_adjustments (id, employment_id, effective_period_key, reason, created_by, updated_by)
        VALUES ('worker-adjustment', 'worker-1', '2026-01', '不適用支援人員', 'migration-user', 'migration-user')`).run()).toThrow("formal_employee_employment_required");
      expect(() => sqlite.prepare(`INSERT INTO hr_clock_events (id, employee_user_id, employment_id, idempotency_key, event_kind, occurred_at)
        VALUES ('worker-clock', 'migration-user', 'worker-1', 'worker-clock', 'clock_in', '2026-01-01 01:00:00')`).run()).toThrow("formal_employee_identity_mismatch");
      expect(() => sqlite.prepare(`INSERT INTO hr_form_requests (id, employee_user_id, employment_id, correction_date, requested_event_kind, requested_at, reason)
        VALUES ('worker-form', 'migration-user', 'worker-1', '2026-01-01', 'clock_in', '2026-01-01 01:00:00', '不適用支援人員')`).run()).toThrow("formal_employee_identity_mismatch");
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("員工與支援人員 ID 碰撞時在拆表前中止並保留兩邊資料", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < "0220_").sort()) apply(sqlite, file);
      sqlite.exec(`
        INSERT INTO users(id, email, status) VALUES ('collision-user', 'collision@example.test', 'active');
        INSERT INTO hr_employments(id, employee_user_id, employee_number, legal_name, position)
          VALUES ('shared-person-id', 'collision-user', 'E-COLLISION', '正式測試員工', '測試職員');
        INSERT INTO hr_schedule_workers(id, display_name, active, created_by)
          VALUES ('shared-person-id', '支援測試人員', 1, 'collision-user');
      `);

      expect(() => apply(sqlite, "0220_thick_princess_powerful.sql")).toThrow("hr_unify_0220_employment_id_collision");
      expect(sqlite.prepare("SELECT id, employee_number FROM hr_employments").all()).toEqual([{ id: "shared-person-id", employee_number: "E-COLLISION" }]);
      expect(sqlite.prepare("SELECT id, display_name FROM hr_schedule_workers").all()).toEqual([{ id: "shared-person-id", display_name: "支援測試人員" }]);
      expect(sqlite.prepare("PRAGMA table_info(hr_employments)").all().some((column) => (column as { name: string }).name === "person_kind")).toBe(false);
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE '__hr_unify_0220_%'").all()).toEqual([]);
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
