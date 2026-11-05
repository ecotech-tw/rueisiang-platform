import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const explanationMigration = "0244_chief_moon_knight.sql";
const protectedLineTriggers = [
  "trg_hr_payslip_lines_closed_insert",
  "trg_hr_payslip_lines_closed_update",
  "trg_hr_payslip_lines_closed_delete",
];

function apply(sqlite: DatabaseSync, file: string) {
  sqlite.exec("BEGIN");
  try { sqlite.exec(readFileSync(path.join(directory, file), "utf8")); sqlite.exec("COMMIT"); }
  catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}

function explanationJson(length: number) {
  const prefix = '{"detail":"';
  const suffix = '"}';
  return `${prefix}${"x".repeat(length - prefix.length - suffix.length)}${suffix}`;
}

describe("薪資明細說明長度 migration", () => {
  it("允許 20,000 字元、保留既有明細並恢復結帳保護 triggers", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < "0153").sort()) apply(sqlite, file);
      sqlite.exec(`
        INSERT INTO users(id,email,status) VALUES ('u','u@example.test','active');
        INSERT INTO hr_employees(user_id,employee_number) VALUES ('u','E1');
        INSERT INTO hr_employments(id,employee_user_id,hired_on,seniority_start_on) VALUES ('j','u','2026-01-01','2026-01-01');
        INSERT INTO hr_payroll_periods(id,period_key,attendance_start,attendance_end,pay_date,created_by) VALUES
          ('p-closed','2026-08','2026-08-01','2026-09-01','2026-09-05','u'),
          ('p-open','2026-09','2026-09-01','2026-10-01','2026-10-05','u');
        INSERT INTO hr_payroll_runs(id,payroll_period_id,version_number,request_id,input_revision,engine_version,status,expected_count,completed_count,created_by) VALUES
          ('r-closed','p-closed',1,'req-closed',1,'test','closed',1,1,'u'),
          ('r-open','p-open',1,'req-open',1,'test','ready',0,0,'u');
        INSERT INTO hr_payslips(id,payroll_run_id,employment_id,employee_number,employee_name,earning_minor,deduction_minor,net_minor) VALUES
          ('s-closed','r-closed','j','E1','Test',100,0,100),
          ('s-open','r-open','j','E1','Test',100,0,100);
        INSERT INTO hr_payslip_lines(id,payslip_id,line_key,direction,amount_minor,explanation_json)
          VALUES ('line-existing','s-closed','base_salary','earning',100,'{"legacy":true}');
      `);
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file >= "0153" && file < explanationMigration).sort()) apply(sqlite, file);
      apply(sqlite, explanationMigration);

      expect(sqlite.prepare("SELECT explanation_json AS explanationJson FROM hr_payslip_lines WHERE id='line-existing'").get()).toEqual({ explanationJson: '{"legacy":true}' });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (?, ?, ?) ORDER BY name").all(...protectedLineTriggers).map((row) => (row as { name: string }).name)).toEqual([...protectedLineTriggers].sort());
      expect(() => sqlite.exec("INSERT INTO hr_payslip_lines(id,payslip_id,line_key,direction,amount_minor,explanation_json) VALUES ('closed-insert','s-closed','closed_insert','earning',1,'{}')")).toThrow(/payroll_run_closed/);
      expect(() => sqlite.exec("UPDATE hr_payslip_lines SET explanation_json='{}' WHERE id='line-existing'")).toThrow(/payroll_run_closed/);
      expect(() => sqlite.exec("DELETE FROM hr_payslip_lines WHERE id='line-existing'")).toThrow(/payroll_run_closed/);

      const insert = sqlite.prepare("INSERT INTO hr_payslip_lines(id,payslip_id,line_key,direction,amount_minor,explanation_json) VALUES (?, 's-open', ?, 'earning', 1, ?)");
      const atLimit = explanationJson(20_000);
      const overLimit = explanationJson(20_001);
      expect(atLimit.length).toBe(20_000);
      expect(() => insert.run("line-at-limit", "at_limit", atLimit)).not.toThrow();
      expect(() => insert.run("line-over-limit", "over_limit", overLimit)).toThrow(/ck_hr_payslip_lines_explanation/);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { sqlite.close(); }
  });
});
