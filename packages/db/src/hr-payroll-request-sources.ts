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
  const rows: Array<{ id: string; payrollRunId: string; sourceKind: SourceKind; sourceId: string }> = [];
  const add = (sourceKind: SourceKind, id: unknown) => {
    if (typeof id === "string" && id) rows.push({ id: crypto.randomUUID(), payrollRunId: runId, sourceKind, sourceId: id });
  };
  for (const [kind, key] of SOURCE_KEYS) {
    const entries = snapshot[key];
    if (Array.isArray(entries)) for (const entry of entries) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) add(kind, (entry as Record<string, unknown>).id);
    }
  }
  const clocks = snapshot.clocks;
  if (Array.isArray(clocks)) for (const clock of clocks) {
    if (clock && typeof clock === "object" && !Array.isArray(clock)) add("clock_correction", (clock as Record<string, unknown>).correctionRequestId);
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
    WHERE payroll_source.source_kind = ${sourceKind} AND payroll_source.source_id = ${sourceId})`;
}
