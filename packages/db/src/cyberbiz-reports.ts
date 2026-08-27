import { desc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { cyberbizReportRuns, type CyberbizReportRun, type CyberbizReportRunKind } from "./schema/cyberbiz-reports.js";
import type { ReportGroupBy, ReportPayoutQuery, ReportSalesQuery } from "./report-data.js";

export type { CyberbizReportRun, CyberbizReportRunKind } from "./schema/cyberbiz-reports.js";
export type CyberbizSalesQuery = Omit<ReportSalesQuery, "range"> & {
  period?: string;
  reportMonth?: string;
  startDate?: string;
  endDate?: string;
  groupBy?: ReportGroupBy[];
};
export type CyberbizPayoutQuery = Omit<ReportPayoutQuery, "range"> & {
  period?: string;
  reportMonth?: string;
  startDate?: string;
  endDate?: string;
  groupBy?: ReportGroupBy[];
};

export async function recordCyberbizReportRun(
  db: Database,
  input: {
    requestId: string;
    reportKind: CyberbizReportRunKind;
    periodKind: "month" | "custom";
    stores: string[];
    startDate: string;
    endDate: string;
    actor: { id: string; email: string };
  },
): Promise<CyberbizReportRun> {
  const [run] = await db.insert(cyberbizReportRuns).values({
    id: crypto.randomUUID(),
    requestId: input.requestId,
    reportKind: input.reportKind,
    periodKind: input.periodKind,
    storesJson: JSON.stringify(input.stores),
    startDate: input.startDate,
    endDate: input.endDate,
    d1ImportEligible: input.periodKind === "month" ? 1 : 0,
    actorId: input.actor.id,
    actorEmail: input.actor.email,
  }).returning();
  if (!run) throw new Error("寫入 CYBERBIZ report job 後找不到資料。");
  return run;
}

export async function listCyberbizReportRuns(
  db: Database,
  reportKind?: CyberbizReportRunKind,
  limit = 20,
): Promise<CyberbizReportRun[]> {
  return db.select().from(cyberbizReportRuns)
    .where(reportKind ? eq(cyberbizReportRuns.reportKind, reportKind) : undefined)
    .orderBy(desc(cyberbizReportRuns.createdAt))
    .limit(Math.max(1, Math.min(limit, 100)));
}

export async function findCyberbizReportRun(db: Database, requestId: string): Promise<CyberbizReportRun | null> {
  const [run] = await db.select().from(cyberbizReportRuns)
    .where(eq(cyberbizReportRuns.requestId, requestId))
    .limit(1);
  return run ?? null;
}
