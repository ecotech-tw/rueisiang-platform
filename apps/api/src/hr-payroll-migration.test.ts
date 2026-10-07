import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
function apply(sqlite: DatabaseSync, file: string) {
  sqlite.exec("BEGIN");
  try { sqlite.exec(readFileSync(path.join(directory, file), "utf8")); sqlite.exec("COMMIT"); }
  catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}

describe("HR 薪資與出勤設定 migration", () => {
  it("不重建既有 HR 表，並為既有任職回填主要辦公位置", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < "0133").sort()) apply(sqlite, file);
      sqlite.exec("INSERT INTO users(id,email) VALUES ('u','u@example.test'); INSERT INTO hr_employees(user_id,employee_number) VALUES ('u','E1'); INSERT INTO hr_employments(id,employee_user_id,hired_on,seniority_start_on) VALUES ('j','u','2026-01-01','2026-01-01'); INSERT INTO hr_attendance_locations(id,name,geolocation_required) VALUES ('l','辦公室',0); INSERT INTO hr_employee_attendance_locations(id,employment_id,location_id,valid_from) VALUES ('a','j','l','2026-01-01');");
      apply(sqlite, "0133_sticky_dracula.sql");
      apply(sqlite, "0134_backfill_hr_attendance_settings.sql");
      expect(sqlite.prepare("SELECT attendance_mode, primary_assignment_id FROM hr_employment_attendance_settings WHERE employment_id='j'").get()).toEqual({ attendance_mode: "general", primary_assignment_id: "a" });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { sqlite.close(); }
  });

  it("0153 在 foreign keys 開啟時保留既有結帳、允許空發薪日，並阻擋關閉期間新批次", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < "0153").sort()) apply(sqlite, file);
      sqlite.exec("INSERT INTO users(id,email,status) VALUES ('u','u@example.test','active'); INSERT INTO hr_employees(user_id,employee_number) VALUES ('u','E1'); INSERT INTO hr_employments(id,employee_user_id,hired_on,seniority_start_on) VALUES ('j','u','2026-01-01','2026-01-01'); INSERT INTO hr_payroll_periods(id,period_key,attendance_start,attendance_end,pay_date,created_by) VALUES ('p','2026-08','2026-08-01','2026-09-01','2026-09-05','u'); INSERT INTO hr_payroll_runs(id,payroll_period_id,version_number,request_id,input_revision,engine_version,status,expected_count,completed_count,created_by) VALUES ('r','p',1,'req',1,'test','closed',1,1,'u'); INSERT INTO hr_payslips(id,payroll_run_id,employment_id,employee_number,employee_name,earning_minor,deduction_minor,net_minor) VALUES ('s','r','j','E1','Test',100,0,100); INSERT INTO hr_leave_types(id,name,default_pay_rate_ppm,active,created_by) VALUES ('lt','測試假別',1000000,1,'u'); INSERT INTO hr_overtime_requests(id,employment_id,requested_start,requested_end,settlement_kind,status,rate_ppm,reason,created_by) VALUES ('ot','j','2026-08-05 01:00:00','2026-08-05 02:00:00','pay','pending',999,'舊資料','u');");
      apply(sqlite, "0153_hr_payroll_integrity.sql");
      expect(sqlite.prepare("SELECT period_key, employment_id, payroll_run_id FROM hr_payroll_closed_employees").all()).toEqual([{ period_key: "2026-08", employment_id: "j", payroll_run_id: "r" }]);
      expect(sqlite.prepare("SELECT pay_date, status FROM hr_payroll_periods WHERE id='p'").get()).toEqual({ pay_date: "2026-09-05", status: "closed" });
      expect(sqlite.prepare("SELECT rate_ppm FROM hr_overtime_requests WHERE id='ot'").get()).toEqual({ rate_ppm: 1333333 });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(sqlite.prepare("SELECT \"notnull\" FROM pragma_table_info('hr_bonus_performance_snapshots') WHERE name='idempotency_key'").get()).toEqual({ notnull: 1 });
      sqlite.exec("INSERT INTO hr_payroll_periods(id,period_key,attendance_start,attendance_end,pay_date,created_by) VALUES ('p2','2026-09','2026-09-01','2026-10-01',NULL,'u'); INSERT INTO hr_payroll_runs(id,payroll_period_id,version_number,request_id,input_revision,engine_version,status,expected_count,completed_count,created_by) VALUES ('r2','p2',1,'req2',1,'test','ready',0,0,'u');");
      expect(sqlite.prepare("SELECT pay_date FROM hr_payroll_runs WHERE id='r2'").get()).toEqual({ pay_date: null });
      expect(() => sqlite.exec("UPDATE hr_payroll_runs SET source_snapshot_json='not-json' WHERE id='r2'")).toThrow(/payroll_run_snapshot_invalid/);
      expect(() => sqlite.exec("UPDATE hr_payroll_runs SET pay_date='not-a-date' WHERE id='r2'")).toThrow(/payroll_run_snapshot_invalid/);
      expect(() => sqlite.exec("UPDATE hr_payroll_runs SET status='ready' WHERE id='r'")).toThrow(/payroll_run_closed/);
      expect(() => sqlite.exec("UPDATE hr_payroll_periods SET status='open' WHERE id='p'")).toThrow(/payroll_period_closed/);
      expect(() => sqlite.exec("UPDATE hr_payslips SET earning_minor=101, net_minor=101 WHERE id='s'")).toThrow(/payroll_run_closed/);
      expect(() => sqlite.exec("INSERT INTO hr_payslip_lines(id,payslip_id,line_key,direction,amount_minor,explanation_json) VALUES ('line-closed','s','late_line','earning',1,'{}')")).toThrow(/payroll_run_closed/);
      expect(() => sqlite.exec("INSERT INTO hr_payroll_run_employees(payroll_run_id,employment_id,input_revision,status) VALUES ('r','j',1,'succeeded')")).toThrow(/payroll_run_closed/);
      expect(() => sqlite.exec("DELETE FROM hr_payroll_closed_employees WHERE period_key='2026-08' AND employment_id='j'")).toThrow(/payroll_run_closed/);
      expect(() => sqlite.exec("INSERT INTO hr_monthly_leave_entries(id,employment_id,leave_type_id,leave_date,hours_half_units,pay_rate_ppm,deduction_amount,created_by,updated_by) VALUES ('leave-closed','j','lt','2026-08-05',2,1000000,0,'u','u')")).toThrow(/payroll_period_closed/);
      expect(() => sqlite.exec("INSERT INTO hr_monthly_hourly_entries(id,employment_id,work_date,hours_half_units,no_work,created_by,updated_by) VALUES ('hourly-closed','j','2026-08-05',2,0,'u','u')")).toThrow(/payroll_period_closed/);
      expect(() => sqlite.exec("INSERT INTO hr_payroll_runs(id,payroll_period_id,version_number,request_id,input_revision,engine_version,status,expected_count,completed_count,created_by) VALUES ('r3','p',2,'req3',1,'test','ready',0,0,'u')")).toThrow(/payroll_period_closed/);
      expect(() => sqlite.exec("INSERT INTO hr_payroll_adjustments(id,employment_id,source_period_key,effective_period_key,reason,created_by,updated_by) VALUES ('adj-closed','j','2026-08','2026-08','結帳後修改','u','u')")).toThrow(/payroll_period_closed/);
    } finally { sqlite.close(); }
  });

  it("薪資撤回 marker append-only，撤回後批次退回 ready 並清除 claim", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < "0203").sort()) apply(sqlite, file);
      sqlite.exec(`
        INSERT INTO users(id,email,status) VALUES ('u','u@example.test','active');
        INSERT INTO hr_employments(id,employee_user_id,employee_number,position) VALUES ('j','u','E1','一般職員');
        INSERT INTO hr_payroll_periods(id,period_key,attendance_start,attendance_end,status,created_by) VALUES ('p','2026-08','2026-08-01','2026-09-01','open','u');
        INSERT INTO hr_payroll_runs(id,payroll_period_id,version_number,request_id,input_revision,engine_version,status,expected_count,completed_count,created_by)
          VALUES ('r','p',1,'req',1,'test','ready',1,1,'u');
        INSERT INTO hr_payslips(id,payroll_run_id,employment_id,employee_number,employee_name,earning_minor,deduction_minor,net_minor)
          VALUES ('s','r','j','E1','Test',100,0,100);
        INSERT INTO hr_annual_leave_entitlements(id,employment_id,policy_version_id,bracket_id,service_months,period_start,period_end,entitled_half_hours,status,settled_at,created_by)
          VALUES ('annual-entitlement','j','annual-leave-policy-2017-v1','annual-leave-bracket-6m',6,'2025-09-01','2026-09-01',48,'settled','2026-08-31','u');
        INSERT INTO hr_annual_leave_ledger(id,entitlement_id,entry_kind,delta_half_hours,source_key,note,created_by)
          VALUES ('annual-settlement','annual-entitlement','settlement',-48,'annual-settlement:annual-entitlement','舊版特休折現','u');
        INSERT INTO hr_payslip_lines(id,payslip_id,line_key,direction,amount_minor,explanation_json)
          VALUES ('annual-settlement-line','s','annual_leave_settlement','earning',300000,'{"settlementItems":[{"sourceKey":"annual-settlement:annual-entitlement"}]}');
        INSERT INTO hr_payroll_closed_employees(period_key,employment_id,payroll_run_id) VALUES ('2026-08','j','r');
        INSERT INTO hr_payroll_periods(id,period_key,attendance_start,attendance_end,status,created_by) VALUES ('p2','2026-09','2026-09-01','2026-10-01','open','u');
        INSERT INTO hr_payroll_runs(id,payroll_period_id,version_number,request_id,input_revision,engine_version,status,expected_count,completed_count,created_by)
          VALUES ('r2','p2',1,'req2',1,'test','ready',0,0,'u');
      `);
      apply(sqlite, "0203_mysterious_newton_destine.sql");
      sqlite.exec("UPDATE hr_payroll_runs SET status='closed' WHERE id='r'; UPDATE hr_payroll_periods SET status='closed' WHERE id='p'; INSERT INTO hr_payroll_withdrawals(payroll_run_id,reason,withdrawn_by) VALUES ('r','撤回原因','u')");
      apply(sqlite, "0204_payroll_withdrawal_rollback.sql");
      expect(sqlite.prepare("SELECT status FROM hr_payroll_runs WHERE id='r'").get()).toEqual({ status: "ready" });
      expect(sqlite.prepare("SELECT status FROM hr_payroll_periods WHERE id='p'").get()).toEqual({ status: "open" });
      expect(sqlite.prepare("SELECT count(*) AS count FROM hr_payroll_closed_employees WHERE payroll_run_id='r'").get()).toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT status, settled_at FROM hr_annual_leave_entitlements WHERE id='annual-entitlement'").get()).toEqual({ status: "open", settled_at: null });
      expect(sqlite.prepare("SELECT entry_kind, delta_half_hours, source_key FROM hr_annual_leave_ledger WHERE source_key='annual-settlement-reversal:r:annual-settlement:annual-entitlement'").get()).toEqual({ entry_kind: "settlement_reversal", delta_half_hours: 48, source_key: "annual-settlement-reversal:r:annual-settlement:annual-entitlement" });
      expect(() => sqlite.exec("UPDATE hr_payroll_withdrawals SET reason='改寫原因' WHERE payroll_run_id='r'")).toThrow(/payroll_run_withdrawal_immutable/);
      expect(() => sqlite.exec("DELETE FROM hr_payroll_withdrawals WHERE payroll_run_id='r'")).toThrow(/payroll_run_withdrawal_immutable/);
      expect(() => sqlite.exec("INSERT INTO hr_payroll_withdrawals(payroll_run_id,reason,withdrawn_by) VALUES ('r2','無 claim','u')")).toThrow(/payroll_run_withdrawal_invalid/);
      sqlite.exec("UPDATE hr_payroll_runs SET status='closed' WHERE id='r2'");
      expect(() => sqlite.exec("UPDATE hr_payroll_runs SET status='ready' WHERE id='r2'")).toThrow(/payroll_run_closed/);
    } finally { sqlite.close(); }
  });

  it("0201 薪資加扣項移除來源月份、正規化未結帳快照並保留資料與結帳鎖", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < "0201").sort()) apply(sqlite, file);
      sqlite.exec(`
        INSERT INTO users(id,email,status) VALUES ('u','u@example.test','active');
        INSERT INTO hr_employments(id,employee_user_id,employee_number,position) VALUES ('j','u','E1','一般職員');
        INSERT INTO hr_payroll_periods(id,period_key,attendance_start,attendance_end,status,created_by) VALUES
          ('p-open','2026-09','2026-09-01','2026-10-01','open','u'),
          ('p-closed','2026-08','2026-08-01','2026-09-01','closed','u');
        INSERT INTO hr_payroll_adjustments(id,employment_id,source_period_key,effective_period_key,reason,created_by,updated_by)
          VALUES ('adj-old','j','2026-07','2026-09','舊資料','u','u');
        INSERT INTO hr_payroll_adjustment_items(id,adjustment_id,item_name,amount_minor)
          VALUES ('item-old','adj-old','舊項目',100);
        INSERT INTO hr_payroll_runs(id,payroll_period_id,version_number,request_id,input_revision,engine_version,status,expected_count,completed_count,created_by)
          VALUES ('run-new','p-open',1,'req-new',1,'test','ready',1,0,'u');
        UPDATE hr_payroll_runs SET source_snapshot_json='{"adjustments":[{"id":"adj-old","sourcePeriodKey":"2026-07","effectivePeriodKey":"2026-09"}],"adjustmentItems":[]}' WHERE id='run-new';
        INSERT INTO hr_payslips(id,payroll_run_id,employment_id,employee_number,employee_name,earning_minor,deduction_minor,net_minor)
          VALUES ('payslip-new','run-new','j','E1','一般職員',100,0,100);
        INSERT INTO hr_payslip_lines(id,payslip_id,line_key,direction,amount_minor,explanation_json)
          VALUES ('line-old','payslip-new','adjustment_1','earning',100,'{"adjustmentId":"adj-old","itemName":"舊項目","sourcePeriodKey":"2026-07","reason":"舊資料","formulaDetail":"人工調整（來源 2026-07） = NT$ 1"}');
      `);
      apply(sqlite, "0201_useful_living_lightning.sql");
      expect(sqlite.prepare("SELECT reason FROM hr_payroll_adjustments WHERE id='adj-old'").get()).toEqual({ reason: "舊資料" });
      expect(sqlite.prepare("SELECT item_name, amount_minor FROM hr_payroll_adjustment_items WHERE id='item-old'").get()).toEqual({ item_name: "舊項目", amount_minor: 100 });
      expect(sqlite.prepare("SELECT name FROM pragma_table_info('hr_payroll_adjustments') WHERE name='source_period_key'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT name FROM pragma_table_info('hr_payroll_record_items') WHERE name='source_period_key'").get()).toBeUndefined();
      expect(sqlite.prepare("SELECT json_extract(source_snapshot_json, '$.adjustments[0].sourcePeriodKey') AS source FROM hr_payroll_runs WHERE id='run-new'").get()).toEqual({ source: null });
      expect(sqlite.prepare("SELECT json_extract(explanation_json, '$.sourcePeriodKey') AS source, json_extract(explanation_json, '$.formulaDetail') AS formula FROM hr_payslip_lines WHERE id='line-old'").get()).toEqual({ source: null, formula: "人工加扣項（舊項目） = NT$ 1" });
      sqlite.exec("INSERT INTO hr_payroll_adjustments(id,employment_id,effective_period_key,reason,created_by,updated_by) VALUES ('adj-new','j','2026-09','一次性獎金','u','u'); INSERT INTO hr_payroll_record_items(id,payroll_run_id,person_kind,employment_id,item_name,direction,amount_minor,reason,created_by) VALUES ('record-item-new','run-new','employee','j','一次性獎金','earning',100000,'無來源月份','u');");
      expect(() => sqlite.exec("INSERT INTO hr_payroll_adjustment_items(id,adjustment_id,item_name,amount_minor) VALUES ('item-zero','adj-new','零元',0)")).toThrow(/payroll_adjustment_amount_invalid/);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => sqlite.exec("INSERT INTO hr_payroll_adjustments(id,employment_id,effective_period_key,reason,created_by,updated_by) VALUES ('adj-closed-0201','j','2026-08','結帳後修改','u','u')")).toThrow(/payroll_period_closed/);
    } finally { sqlite.close(); }
  });

  it("0191 拆分勞保基金時保留既有合併規則", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < "0191").sort()) apply(sqlite, file);
      sqlite.exec("INSERT INTO users(id,email) VALUES ('u','u@example.test'); INSERT INTO hr_insurance_contribution_rules(id,scheme,valid_from,employee_rate_ppm,employer_rate_ppm,dependent_rate_ppm,source_kind,note,created_by) VALUES ('legacy','labor','2026-01-01',25000,87500,0,'manual','舊版合併規則','u');");
      apply(sqlite, "0191_curly_the_spike.sql");
      expect(sqlite.prepare("SELECT scheme, component, employee_rate_ppm FROM hr_insurance_contribution_rules WHERE id='legacy'").get()).toEqual({ scheme: "labor", component: null, employee_rate_ppm: 25000 });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { sqlite.close(); }
  });
});
