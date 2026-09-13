import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { normalizeReportScopeName } from "./report-data.js";
import { reportRunScopes, reportRuns, scopes } from "./schema/reports.js";

const SHOPEE_SCOPE_ID = "shopee:store:default";
const SHOPEE_SCOPE_NAME = "蝦皮";

export interface ShopeeSalesSettings {
  id: string;
  driveFolderUrl: string;
  driveFolderName: string;
  updatedAt: string;
}

export interface ShopeeSalesRun {
  id: string;
  requestId: string;
  startDate: string;
  endDate: string;
  driveFolderUrl: string;
  actorId: string;
  actorEmail: string;
  createdAt: string;
}

function asShopeeSettings(scope?: Pick<typeof scopes.$inferSelect, "id" | "driveFolderUrl" | "driveFolderName" | "updatedAt">): ShopeeSalesSettings {
  return {
    id: scope?.id ?? SHOPEE_SCOPE_ID,
    driveFolderUrl: scope?.driveFolderUrl ?? "",
    driveFolderName: scope?.driveFolderName ?? "",
    updatedAt: scope?.updatedAt ?? "",
  };
}

/**
 * 蝦皮的 Drive 設定。
 *
 * 用 source_type 找而不是寫死 ID：設定的唯一入口是通路管理頁，那裡新增的蝦皮通路
 * 拿到的是自動產生的 ID。寫死 ID 的話，管理者在通路管理設好資料夾，上傳仍然回
 * 「尚未設定」，而且看不出為什麼。
 */
export async function getShopeeSalesSettings(db: Database): Promise<ShopeeSalesSettings> {
  const [scope] = await db
    .select({ id: scopes.id, driveFolderUrl: scopes.driveFolderUrl, driveFolderName: scopes.driveFolderName, updatedAt: scopes.updatedAt })
    .from(scopes)
    .where(and(eq(scopes.sourceType, "shopee"), isNull(scopes.archivedAt)))
    .orderBy(desc(scopes.active), asc(scopes.sortOrder), asc(scopes.id))
    .limit(1);
  return asShopeeSettings(scope);
}

function isCompleteMonth(startDate: string, endDate: string): boolean {
  const [year, month] = startDate.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).getUTCDate();
  return startDate === `${year}-${String(month).padStart(2, "0")}-01`
    && endDate === `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

export async function recordShopeeSalesRun(
  db: Database,
  input: {
    requestId: string;
    startDate: string;
    endDate: string;
    driveFolderUrl: string;
    driveFolderName?: string;
    actor: { id: string; email: string };
  },
): Promise<void> {
  const id = crypto.randomUUID();
  // 掛在設定解析到的那個蝦皮通路上。寫死 SHOPEE_SCOPE_ID 的話，管理者在通路管理
  // 建的蝦皮通路會拿到另一個 ID，執行紀錄就會掛到一個沒有人維護的第二列上。
  const scopeId = (await getShopeeSalesSettings(db)).id;
  await db.batch([
    db.insert(scopes).values({
      id: scopeId,
      sourceType: "shopee",
      scopeKind: "store",
      name: SHOPEE_SCOPE_NAME,
      normalizedName: normalizeReportScopeName(SHOPEE_SCOPE_NAME),
      driveFolderUrl: input.driveFolderUrl,
      active: 1,
      sortOrder: 0,
    }).onConflictDoNothing(),
    db.insert(reportRuns).values({
      id,
      requestId: input.requestId,
      sourceType: "shopee",
      importsSales: 1,
      importsPayout: isCompleteMonth(input.startDate, input.endDate) ? 1 : 0,
      periodKind: isCompleteMonth(input.startDate, input.endDate) ? "month" : "custom",
      startDate: input.startDate,
      endDate: input.endDate,
      status: "queued",
      actorEmail: input.actor.email,
    }),
    db.insert(reportRunScopes).values({
      reportRunId: id,
      scopeId,
      driveFolderUrl: input.driveFolderUrl,
      driveFolderName: input.driveFolderName ?? "",
    }),
  ] as never);
}

export async function listShopeeSalesRuns(db: Database, limit = 10): Promise<ShopeeSalesRun[]> {
  const rows = await db.all<{
    id: string;
    requestId: string;
    startDate: string;
    endDate: string;
    driveFolderUrl: string;
    actorEmail: string;
    createdAt: string;
  }>(sql`
    SELECT
      run.id AS id,
      run.request_id AS requestId,
      run.start_date AS startDate,
      run.end_date AS endDate,
      COALESCE(NULLIF(link.drive_folder_url, ''), scope.drive_folder_url, '') AS driveFolderUrl,
      run.actor_email AS actorEmail,
      run.created_at AS createdAt
    FROM report_runs run
    LEFT JOIN report_run_scopes link ON link.report_run_id = run.id
    LEFT JOIN scopes scope ON scope.id = link.scope_id
    WHERE run.source_type = 'shopee'
      AND run.imports_sales = 1
      AND run.request_id NOT LIKE 'cyberbiz-ingest:%'
      AND run.request_id NOT LIKE 'target-import:%'
      AND run.actor_email <> ''
    ORDER BY run.created_at DESC
    LIMIT ${Math.max(1, Math.min(limit, 100))}
  `);
  return rows.map((run) => ({ ...run, actorId: "" }));
}
