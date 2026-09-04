import { desc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { reportIngestIssues, reportRuns, type ReportIngestIssue, type ReportRun } from "./schema/reports.js";

export async function listReportRuns(db: Database, limit = 50): Promise<ReportRun[]> {
  return db.select().from(reportRuns).orderBy(desc(reportRuns.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
}

export async function listReportIngestIssues(
  db: Database,
  input: { reportRunId?: string; limit?: number } = {},
): Promise<ReportIngestIssue[]> {
  return db.select().from(reportIngestIssues)
    .where(input.reportRunId ? eq(reportIngestIssues.reportRunId, input.reportRunId) : undefined)
    .orderBy(desc(reportIngestIssues.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
}

export async function getReportRun(db: Database, id: string): Promise<ReportRun | null> {
  const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, id)).limit(1);
  return run ?? null;
}
