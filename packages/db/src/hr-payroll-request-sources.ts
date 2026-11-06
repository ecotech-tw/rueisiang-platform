import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Database } from "./client.js";
import { hrPayrollRequestSourceRuns, hrPayrollRequestSources, hrPayrollRuns } from "./schema/hr-payroll-runs.js";

type SourceKind = "leave" | "overtime" | "worker_overtime" | "clock_correction";
const SOURCE_KEYS = [["leave", "leaves"], ["overtime", "overtime"], ["worker_overtime", "workerOvertime"]] as const;

export function payrollRequestSourceStatements(db: Database, runId: string, sourceSnapshotJson: string) {
  let snapshot: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(sourceSnapshotJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) snapshot = parsed as Record<string, unknown>;
  } catch {
    // 壞掉的快照無法索引；仍寫入 marker，避免重複解析。
  }
  const rows: Array<{ id: string; payrollRunId: string; sourceKind: SourceKind; sourceId: string; personKind: "employee" | "worker" | null; personId: string | null }> = [];
  const add = (sourceKind: SourceKind, entry: Record<string, unknown>, id: unknown) => {
    if (typeof id !== "string" || !id) return;
    const personId = typeof entry.workerId === "string" ? entry.workerId : typeof entry.employmentId === "string" ? entry.employmentId : null;
    const personKind = personId ? (sourceKind === "worker_overtime" || typeof entry.workerId === "string" ? "worker" : "employee") : null;
    rows.push({ id: crypto.randomUUID(), payrollRunId: runId, sourceKind, sourceId: id, personKind, personId });
  }
  for (const [kind, key] of SOURCE_KEYS) {
    const entries = snapshot[key];
    if (Array.isArray(entries)) for (const entry of entries) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) add(kind, entry as Record<string, unknown>, (entry as Record<string, unknown>).id);
    }
  }
  const clocks = snapshot.clocks;
  if (Array.isArray(clocks)) for (const clock of clocks) {
    if (clock && typeof clock === "object" && !Array.isArray(clock)) add("clock_correction", clock as Record<string, unknown>, (clock as Record<string, unknown>).correctionRequestId);
  }
  const statements = [db.insert(hrPayrollRequestSourceRuns).values({ payrollRunId: runId })];
  for (let i = 0; i < rows.length; i += 16) statements.push(db.insert(hrPayrollRequestSources).values(rows.slice(i, i + 16)) as never);
  return statements;
}

export async function ensurePayrollRequestSourcesIndexed(db: Database) {
  const missing = await db.select({ id: hrPayrollRuns.id, sourceSnapshotJson: hrPayrollRuns.sourceSnapshotJson }).from(hrPayrollRuns)
    .where(sql`${hrPayrollRuns.id} NOT IN (SELECT payroll_run_id FROM hr_payroll_request_source_runs)`);
  for (const run of missing) {
    try {
      await db.batch(payrollRequestSourceStatements(db, run.id, run.sourceSnapshotJson) as never);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) continue;
      throw error;
    }
  }
}

export function payrollRequestSourceReference(sourceKind: SourceKind, sourceId: SQLWrapper | string): SQL {
  return sql`EXISTS (SELECT 1 FROM hr_payroll_request_sources AS payroll_source
    INNER JOIN hr_payroll_runs AS source_run ON source_run.id = payroll_source.payroll_run_id
    WHERE payroll_source.source_kind = ${sourceKind} AND payroll_source.source_id = ${sourceId}
      AND (payroll_source.person_id IS NULL OR (
        NOT EXISTS (SELECT 1 FROM hr_payroll_record_withdrawals AS withdrawn
          WHERE withdrawn.payroll_run_id = payroll_source.payroll_run_id
            AND withdrawn.person_kind = payroll_source.person_kind AND withdrawn.person_id = payroll_source.person_id)
        AND (EXISTS (SELECT 1 FROM hr_payslips AS record WHERE record.payroll_run_id=payroll_source.payroll_run_id AND record.employment_id=payroll_source.person_id)
          OR EXISTS (SELECT 1 FROM hr_payroll_worker_results AS record WHERE record.payroll_run_id=payroll_source.payroll_run_id AND record.worker_id=payroll_source.person_id))
      )))`;
}
