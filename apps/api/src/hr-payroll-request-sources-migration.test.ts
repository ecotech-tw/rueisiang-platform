import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
function apply(sqlite: DatabaseSync, file: string) {
  sqlite.exec("BEGIN");
  try { sqlite.exec(readFileSync(path.join(directory, file), "utf8")); sqlite.exec("COMMIT"); }
  catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}

describe("薪資試算申請來源索引 migration", () => {
  it("回填已納入薪資的請假、加班與補打卡來源", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("CREATE TABLE hr_payroll_runs (id TEXT PRIMARY KEY, source_snapshot_json TEXT NOT NULL)");
      sqlite.prepare("INSERT INTO hr_payroll_runs VALUES (?, ?)").run("run-1", JSON.stringify({
        leaves: [{ id: "leave-1" }],
        overtime: [{ id: "overtime-1" }],
        workerOvertime: [{ id: "worker-overtime-1" }],
        clocks: [{ correctionRequestId: "clock-correction-1" }, { correctionRequestId: null }],
      }));
      apply(sqlite, "0237_aromatic_doctor_doom.sql");
      apply(sqlite, "0238_backfill_payroll_request_sources.sql");
      expect(sqlite.prepare("SELECT payroll_run_id, source_kind, source_id FROM hr_payroll_request_sources ORDER BY source_kind").all()).toEqual([
        { payroll_run_id: "run-1", source_kind: "clock_correction", source_id: "clock-correction-1" },
        { payroll_run_id: "run-1", source_kind: "leave", source_id: "leave-1" },
        { payroll_run_id: "run-1", source_kind: "overtime", source_id: "overtime-1" },
        { payroll_run_id: "run-1", source_kind: "worker_overtime", source_id: "worker-overtime-1" },
      ]);
      expect(sqlite.prepare("SELECT payroll_run_id FROM hr_payroll_request_source_runs").all()).toEqual([{ payroll_run_id: "run-1" }]);
      sqlite.exec("DELETE FROM hr_payroll_runs WHERE id='run-1'");
      expect(sqlite.prepare("SELECT count(*) AS count FROM hr_payroll_request_sources WHERE payroll_run_id='run-1'").get()).toEqual({ count: 4 });
    } finally { sqlite.close(); }
  });
});
