import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
// 照 D1 的方式跑：每一支 migration 包在一個 transaction 裡。
function apply(sqlite: DatabaseSync, file: string) {
  sqlite.exec("BEGIN");
  try { sqlite.exec(readFileSync(path.join(directory, file), "utf8")); sqlite.exec("COMMIT"); }
  catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}

describe("特殊上班日薪資依據索引表 migration", () => {
  it("0211 把既有批次的來源快照與薪資明細補進索引，不重複、不收壞資料", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < "0210").sort()) apply(sqlite, file);
      // 只關心批次、薪資單與明細三張表；它們的上游（員工、任職）跟這支回填無關，種資料時先不檢查外鍵。
      sqlite.exec("PRAGMA foreign_keys=OFF");
      const snapshot = JSON.stringify({ specialWorkdays: [
        { id: "a1", ruleId: "rule", ruleVersionId: "v1", workDate: "2026-04-03" },
        { id: "a2", ruleId: "rule", workDate: "2026-04-04" },
        "不是物件",
        { id: 5 },
      ] });
      sqlite.exec(`INSERT INTO hr_payroll_periods(id,period_key,attendance_start,attendance_end,created_by) VALUES ('p','2026-04','2026-04-01','2026-05-01','u');`);
      const run = sqlite.prepare("INSERT INTO hr_payroll_runs(id,payroll_period_id,version_number,request_id,input_revision,source_snapshot_json,engine_version,status,expected_count,completed_count,created_by) VALUES (?,?,?,?,1,?,'test','ready',0,0,'u')");
      run.run("r1", "p", 1, "req1", snapshot);
      run.run("r2", "p", 2, "req2", "{}");
      const payslip = sqlite.prepare("INSERT INTO hr_payslips(id,payroll_run_id,employment_id,employee_number,employee_name,earning_minor,deduction_minor,net_minor) VALUES (?,?,'j','E1','員工',0,0,0)");
      payslip.run("s1", "r1");
      payslip.run("s2", "r2");
      const line = sqlite.prepare("INSERT INTO hr_payslip_lines(id,payslip_id,line_key,direction,amount_minor,explanation_json) VALUES (?,?,?,'earning',0,?)");
      // r1 的明細只重複快照已有的東西，不該多出列。
      line.run("l1", "s1", "special_workday", JSON.stringify({ assignmentIds: ["a1"] }));
      line.run("l2", "s1", "overtime", JSON.stringify({ specialWorkdayRuleSnapshots: [{ workDate: "2026-04-03", ruleVersionId: "v1" }] }));
      // r2 是沒有快照的早期批次，只能從明細補。
      line.run("l3", "s2", "special_workday", JSON.stringify({ assignmentIds: ["a3", "a3", 7] }));
      line.run("l4", "s2", "overtime", JSON.stringify({ specialWorkdayRuleSnapshots: [{ workDate: "2026-04-05", ruleVersionId: "v9" }, { workDate: "2026-04-05" }] }));
      line.run("l5", "s2", "base", "{}");
      sqlite.exec("PRAGMA foreign_keys=ON");

      apply(sqlite, "0210_flashy_penance.sql");
      apply(sqlite, "0211_backfill_payroll_special_workday_sources.sql");

      expect(sqlite.prepare("SELECT payroll_run_id, assignment_id, rule_id, rule_version_id, work_date FROM hr_payroll_special_workday_sources ORDER BY payroll_run_id, assignment_id, rule_version_id").all()).toEqual([
        { payroll_run_id: "r1", assignment_id: "a1", rule_id: "rule", rule_version_id: "v1", work_date: "2026-04-03" },
        { payroll_run_id: "r1", assignment_id: "a2", rule_id: "rule", rule_version_id: null, work_date: "2026-04-04" },
        { payroll_run_id: "r2", assignment_id: null, rule_id: null, rule_version_id: "v9", work_date: "2026-04-05" },
        { payroll_run_id: "r2", assignment_id: "a3", rule_id: null, rule_version_id: null, work_date: null },
      ]);
      expect(sqlite.prepare("PRAGMA foreign_key_check(hr_payroll_special_workday_sources)").all()).toEqual([]);
      // 批次還有索引列時刪不掉（RESTRICT），刪批次的流程要先清索引。
      expect(() => sqlite.exec("DELETE FROM hr_payslip_lines WHERE payslip_id='s2'; DELETE FROM hr_payslips WHERE id='s2'; DELETE FROM hr_payroll_runs WHERE id='r2'")).toThrow(/FOREIGN KEY/);
    } finally { sqlite.close(); }
  });
});
