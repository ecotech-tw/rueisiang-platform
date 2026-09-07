import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { normalizeReportScopeName, scopeSourceTypeFromId } from "./report-data.js";
import { reportRunScopes, reportRuns, scopes } from "./schema/reports.js";
import type { SalesTopSkuMetric } from "./report-analytics.js";
import type { ReportGroupBy, ReportPayoutQuery, ReportSalesQuery } from "./report-data.js";

export type CyberbizReportRunKind = "sales" | "payout";
export interface CyberbizReportRun {
  id: string;
  requestId: string;
  reportKind: CyberbizReportRunKind;
  periodKind: "month" | "custom";
  storesJson: string;
  startDate: string;
  endDate: string;
  d1ImportEligible: number;
  actorId: string;
  actorEmail: string;
  createdAt: string;
}
export type CyberbizSalesQuery = Omit<ReportSalesQuery, "range"> & {
  period?: string;
  reportMonth?: string;
  startDate?: string;
  endDate?: string;
  groupBy?: ReportGroupBy[];
  topSkuBy?: SalesTopSkuMetric;
};
export type CyberbizPayoutQuery = Omit<ReportPayoutQuery, "range"> & {
  period?: string;
  reportMonth?: string;
  startDate?: string;
  endDate?: string;
  groupBy?: ReportGroupBy[];
};

/**
 * 舊執行 API 的回傳形狀仍由 route 使用，但資料來源已經換成 target report_runs。
 * storesJson 由 report_run_scopes 還原成人看的據點名稱，避免把舊表欄位帶進 target。
 */
async function asCyberbizReportRun(db: Database, run: typeof reportRuns.$inferSelect): Promise<CyberbizReportRun> {
  const links = await db.select({ scopeId: reportRunScopes.scopeId })
    .from(reportRunScopes)
    .where(eq(reportRunScopes.reportRunId, run.id));
  const names = links.length
    ? await db.select({ id: scopes.id, name: scopes.name })
      .from(scopes)
      .where(inArray(scopes.id, links.map((link) => link.scopeId)))
      .orderBy(asc(scopes.sortOrder), asc(scopes.name))
    : [];
  return {
    id: run.id,
    requestId: run.requestId,
    reportKind: run.importsSales === 1 ? "sales" : "payout",
    periodKind: run.periodKind,
    storesJson: JSON.stringify(names.map((scope) => scope.name)),
    startDate: run.startDate,
    endDate: run.endDate,
    d1ImportEligible: run.periodKind === "month" ? 1 : 0,
    actorId: "",
    actorEmail: run.actorEmail,
    createdAt: run.createdAt,
  };
}

async function listTargetRuns(db: Database, reportKind?: CyberbizReportRunKind, limit = 20): Promise<CyberbizReportRun[]> {
  const rows = await db.select().from(reportRuns)
    .where(and(
      reportKind === "sales"
        ? eq(reportRuns.importsSales, 1)
        : reportKind === "payout"
          ? eq(reportRuns.importsPayout, 1)
          : undefined,
      // 執行頁只追 GitHub workflow_dispatch 建立的那筆 requestId；內部 D1 ingest
      // 也會留下 report_runs，但那些 requestId 不存在於 GitHub run-name，不能拿來當「上一次執行」。
      sql`${reportRuns.requestId} NOT LIKE 'cyberbiz-ingest:%'`,
      sql`${reportRuns.requestId} NOT LIKE 'target-import:%'`,
      sql`${reportRuns.actorEmail} <> ''`,
    ))
    .orderBy(desc(reportRuns.createdAt))
    .limit(Math.max(1, Math.min(limit, 100)));
  return Promise.all(rows.map((run) => asCyberbizReportRun(db, run)));
}

export async function recordCyberbizReportRun(
  db: Database,
  input: {
    requestId: string;
    reportKind: CyberbizReportRunKind;
    periodKind: "month" | "custom";
    stores: string[];
    scopeIds?: string[];
    startDate: string;
    endDate: string;
    actor: { id: string; email: string };
  },
): Promise<CyberbizReportRun> {
  const id = crypto.randomUUID();
  const requestedScopeIds = input.scopeIds?.length === input.stores.length ? input.scopeIds : undefined;
  const existingScopeRows = requestedScopeIds?.length
    ? await db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(inArray(scopes.id, requestedScopeIds))
    : input.stores.length
      ? await db.select({ id: scopes.id, name: scopes.name })
        .from(scopes)
        .where(inArray(scopes.normalizedName, input.stores.map(normalizeReportScopeName)))
      : [];
  const existingScopeIds = new Set(existingScopeRows.map((scope) => scope.id));
  const scopeIds = requestedScopeIds
    ? [...requestedScopeIds]
    : input.stores.map((name) => existingScopeRows.find((scope) => normalizeReportScopeName(scope.name) === normalizeReportScopeName(name))?.id).filter((scopeId): scopeId is string => !!scopeId);
  const scopeKind = "store" as const;

  const missingScopes = requestedScopeIds
    ? input.stores.flatMap((name, index) => {
      const id = requestedScopeIds[index];
      return id && !existingScopeIds.has(id) ? [{ id, name, sortOrder: index }] : [];
    })
    : [];
  await db.batch([
    // source_type 看 id 前綴，不看這次在跑哪種報表：出金與銷售是同一家店、
    // 同一個 driver，用 reportKind 決定會讓同一家店長出兩列。
    ...missingScopes.map((scope) => db.insert(scopes).values({
      id: scope.id,
      sourceType: scopeSourceTypeFromId(scope.id),
      scopeKind,
      name: scope.name.trim(),
      normalizedName: normalizeReportScopeName(scope.name),
      sortOrder: scope.sortOrder,
      active: 1,
    }).onConflictDoNothing()),
    db.insert(reportRuns).values({
      id,
      requestId: input.requestId,
      // report_runs.source_type 也是 driver，不是報表種類。這支路徑只有 CYBERBIZ
      // 在跑（蝦皮走 shopee_sales_runs），出金與銷售都是同一個 driver。
      sourceType: "cyberbiz",
      importsSales: input.reportKind === "sales" ? 1 : 0,
      importsPayout: input.reportKind === "payout" ? 1 : 0,
      periodKind: input.periodKind,
      startDate: input.startDate,
      endDate: input.endDate,
      status: "queued",
      actorEmail: input.actor.email,
    }),
    ...scopeIds.map((scopeId) => db.insert(reportRunScopes).values({ reportRunId: id, scopeId })),
  ] as never);
  const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, id)).limit(1);
  if (!run) throw new Error("寫入 target report run 後找不到資料。");
  const result = await asCyberbizReportRun(db, run);
  // 執行請求當下仍要回傳使用者送出的完整名稱清單；target scope 尚未建立時，
  // runner 後續匯入會補 scope，不能讓這次 audit response 先少掉據點。
  return { ...result, storesJson: JSON.stringify(input.stores) };
}

export async function listCyberbizReportRuns(
  db: Database,
  reportKind?: CyberbizReportRunKind,
  limit = 20,
): Promise<CyberbizReportRun[]> {
  return listTargetRuns(db, reportKind, limit);
}

export async function findCyberbizReportRun(db: Database, requestId: string): Promise<CyberbizReportRun | null> {
  const [run] = await db.select().from(reportRuns)
    .where(eq(reportRuns.requestId, requestId))
    .limit(1);
  return run ? asCyberbizReportRun(db, run) : null;
}
