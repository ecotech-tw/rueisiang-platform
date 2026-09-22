import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migration = "0127_white_ricochet.sql";
const attendanceMigration = "0128_skinny_lifeguard.sql";
const clockMigration = "0129_rainy_enchantress.sql";
const requestMigration = "0130_outgoing_ultimatum.sql";
const fixMigration = "0131_curious_stone_men.sql";
if (!migration || !attendanceMigration || !clockMigration || !requestMigration || !fixMigration) throw new Error("找不到 HR migration");
function apply(sqlite: DatabaseSync, file: string) {
  sqlite.exec("BEGIN");
  try { sqlite.exec(readFileSync(path.join(directory, file), "utf8")); sqlite.exec("COMMIT"); }
  catch (error) { sqlite.exec("ROLLBACK"); throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
}

describe("HR 新增式 migration", () => {
  it("逐支交易由空庫升級，既有 users／scopes 保留，外鍵與唯一性生效", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < migration).sort()) apply(sqlite, file);
      sqlite.exec("INSERT INTO users(id,email) VALUES ('u','u@example.test'); INSERT INTO scopes(id,source_type,scope_kind,name,normalized_name) VALUES ('s','manual','store','測試櫃','測試櫃');");
      apply(sqlite, migration);
      apply(sqlite, attendanceMigration);
      apply(sqlite, clockMigration);
      apply(sqlite, requestMigration);
      apply(sqlite, fixMigration);
      expect(sqlite.prepare("SELECT email FROM users WHERE id='u'").get()).toEqual({ email: "u@example.test" });
      expect(sqlite.prepare("SELECT name FROM scopes WHERE id='s'").get()).toEqual({ name: "測試櫃" });
      sqlite.exec("INSERT INTO hr_employees(user_id,employee_number) VALUES ('u','E1');");
      expect(sqlite.prepare("SELECT supervisor_user_id FROM hr_employees WHERE user_id='u'").get()).toEqual({ supervisor_user_id: null });
      expect(() => sqlite.exec("INSERT INTO hr_employees(user_id,employee_number) VALUES ('u','E2')")).toThrow(/UNIQUE/);
      expect(() => sqlite.exec("INSERT INTO hr_employees(user_id,employee_number) VALUES ('missing','E2')")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("INSERT INTO hr_employees(user_id,employee_number) VALUES ('u',' ')")).toThrow(/UNIQUE|CHECK/);
      sqlite.exec("INSERT INTO hr_attendance_locations(id,name,geolocation_required,latitude_e7,longitude_e7) VALUES ('l','台北櫃',1,250330000,1215654000);");
      expect(() => sqlite.exec("INSERT INTO hr_attendance_locations(id,name,geolocation_required) VALUES ('invalid','缺座標',1)")).toThrow(/CHECK/);
      sqlite.exec("INSERT INTO hr_employments(id,employee_user_id,hired_on,seniority_start_on) VALUES ('j','u','2026-01-01','2026-01-01'); INSERT INTO hr_employee_scopes(id,employment_id,scope_id,valid_from) VALUES ('a','j','s','2026-01-01'); INSERT INTO hr_employee_attendance_locations(id,employment_id,location_id,valid_from) VALUES ('la','j','l','2026-01-01'); INSERT INTO hr_clock_events(id,employee_user_id,employment_id,attendance_location_id,idempotency_key,event_kind) VALUES ('ce','u','j','l','key','clock_in'); INSERT INTO hr_form_requests(id,employee_user_id,employment_id,correction_date,requested_event_kind,requested_at,reason) VALUES ('fr','u','j','2026-01-01','clock_in','2026-01-01 01:00:00','補打卡測試');");
      expect(() => sqlite.exec("DELETE FROM users WHERE id='u'")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("DELETE FROM hr_employees WHERE user_id='u'")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("DELETE FROM hr_employments WHERE id='j'")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("DELETE FROM hr_attendance_locations WHERE id='l'")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("DELETE FROM scopes WHERE id='s'")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("UPDATE hr_employments SET ended_on='2025-01-01' WHERE id='j'")).toThrow(/CHECK/);
      expect(() => sqlite.exec("UPDATE hr_employee_scopes SET revision=0 WHERE id='a'")).toThrow(/CHECK/);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { sqlite.close(); }
  });

  it("扁平化分段搬移保留既有 employment id、下游外鍵與任職動作歷史", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < "0174_").sort()) apply(sqlite, file);
      sqlite.exec("INSERT INTO users(id,email,status) VALUES ('u','u@example.test','active'),('sup','sup@example.test','active'),('other','other@example.test','active');");
      sqlite.exec("INSERT INTO hr_employees(user_id,employee_number,supervisor_user_id) VALUES ('u','E1','sup'),('other','E2',NULL);");
      sqlite.exec("INSERT INTO hr_employments(id,employee_user_id,hired_on,ended_on,seniority_start_on) VALUES ('old','u','2025-01-01','2025-12-31','2025-01-01'),('current','u','2026-01-01',NULL,'2026-01-01');");
      sqlite.exec("INSERT INTO hr_employment_actions(id,employee_user_id,employment_id,action_kind,expected_revision) VALUES ('action-1','u','old','employment_ended',1);");
      sqlite.exec("INSERT INTO hr_clock_events(id,employee_user_id,employment_id,idempotency_key,event_kind) VALUES ('clock-1','u','old','key-1','clock_in');");
      sqlite.exec("INSERT INTO hr_payroll_periods(id,period_key,attendance_start,attendance_end,pay_date,status,created_by) VALUES ('period-1','2026-01','2026-01-01','2026-02-01','2026-02-05','open','u'); INSERT INTO hr_payroll_runs(id,payroll_period_id,version_number,request_id,input_revision,engine_version,status,expected_count,completed_count,created_by) VALUES ('run-1','period-1',1,'request-1',1,'test','calculating',1,0,'u'); INSERT INTO hr_payroll_run_employees(payroll_run_id,employment_id,input_revision,status,last_error) VALUES ('run-1','old',1,'calculating','');");
      sqlite.exec("INSERT INTO hr_compensation_versions(id,employment_id,version_number,valid_from,pay_basis,base_amount_minor,note,created_by) VALUES ('comp-1','old',1,'2026-01-01','monthly',100000,'test','u'); INSERT INTO hr_compensation_items(id,compensation_version_id,item_name,amount_minor,item_kind,created_by) VALUES ('item-1','comp-1','本薪',100000,'fixed','u'); INSERT INTO hr_insurance_versions(id,employment_id,scheme,version_number,status,valid_from,insured_amount_minor,dependent_count,rate_year,source_kind,source_url,note,created_by) VALUES ('insurance-1','old','labor',1,'enrolled','2026-01-01',100000,0,2026,'manual','','test','u');");
      sqlite.exec("INSERT INTO hr_payslips(id,payroll_run_id,employment_id,employee_number,employee_name,earning_minor,deduction_minor,net_minor) VALUES ('payslip-1','run-1','old','E1','員工',100000,0,100000); INSERT INTO hr_payslip_lines(id,payslip_id,line_key,direction,amount_minor) VALUES ('line-1','payslip-1','base','earning',100000); INSERT INTO hr_payslip_compensation_links(payslip_id,compensation_version_id) VALUES ('payslip-1','comp-1'); INSERT INTO hr_payslip_insurance_links(payslip_id,insurance_version_id) VALUES ('payslip-1','insurance-1');");

      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file >= "0174_").sort()) apply(sqlite, file);

      expect(sqlite.prepare("SELECT employee_number, supervisor_user_id, archived_at FROM hr_employments WHERE id='current'").get()).toMatchObject({ employee_number: "E1", supervisor_user_id: "sup", archived_at: null });
      expect(sqlite.prepare("SELECT employee_number, archived_at FROM hr_employments WHERE id='old'").get()).toMatchObject({ employee_number: "E1", archived_at: "2025-12-31" });
      expect(sqlite.prepare("SELECT id, employee_number, archived_at FROM hr_employments WHERE employee_user_id='other'").get()).toMatchObject({ id: "legacy-employment-other", employee_number: "E2", archived_at: null });
      expect(sqlite.prepare("SELECT employment_id FROM hr_clock_events WHERE id='clock-1'").get()).toEqual({ employment_id: "old" });
      expect(sqlite.prepare("SELECT employment_id FROM hr_payroll_run_employees WHERE payroll_run_id='run-1'").get()).toEqual({ employment_id: "old" });
      expect(sqlite.prepare("SELECT compensation_version_id, amount_basis FROM hr_compensation_items WHERE id='item-1'").get()).toEqual({ compensation_version_id: "comp-1", amount_basis: "monthly" });
      expect(sqlite.prepare("SELECT compensation_version_id FROM hr_payslip_compensation_links WHERE payslip_id='payslip-1'").get()).toEqual({ compensation_version_id: "comp-1" });
      expect(sqlite.prepare("SELECT insurance_version_id FROM hr_payslip_insurance_links WHERE payslip_id='payslip-1'").get()).toEqual({ insurance_version_id: "insurance-1" });
      expect(sqlite.prepare("SELECT payslip_id FROM hr_payslip_lines WHERE id='line-1'").get()).toEqual({ payslip_id: "payslip-1" });
      expect(sqlite.prepare("SELECT count(*) AS count FROM hr_employment_actions").get()).toEqual({ count: 1 });
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hr_employees'").get()).toBeUndefined();
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(sqlite.prepare("PRAGMA table_info(hr_employments)").all().map((column) => (column as { name: string }).name)).not.toContain("hired_on");
    } finally { sqlite.close(); }
  });
});
