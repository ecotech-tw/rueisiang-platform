import { eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { normalizeReportScopeName } from "./report-data.js";
import { reportRunScopes, reportRuns, scopes } from "./schema/reports.js";

/**
 * 官網（CYBERBIZ 線上商店）的對帳單執行紀錄。
 *
 * 為什麼不沿用 recordCyberbizReportRun：那支把「報表種類」壓成 imports_sales /
 * imports_payout 兩個旗標，而對帳單兩個都是 1（商品銷售與撥款同一份檔案），所以
 * 它在那兩個清單裡都會出現，把門市的執行紀錄弄髒。
 *
 * 區分的方式是 request_id 前綴——那條查詢本來就用前綴把 ingest 產生的 run 排除掉
 * （見 cyberbiz-reports.ts 的 listTargetRuns），沿用同一個手法比多開一個欄位便宜。
 */
export const SHOP_REQUEST_PREFIX = "shop:";

/** 官網是整個帳戶一份對帳單，不是櫃點，所以 scope_kind 是 channel。 */
export const SHOP_SCOPE_ID = "cyberbiz:channel:shop";
export const SHOP_SCOPE_NAME = "官網";

export interface ShopReportRun {
  id: string;
  requestId: string;
  startMonth: string;
  endMonth: string;
  actorEmail: string;
  driveFolderUrl: string;
  driveFolderName: string;
  createdAt: string;
}

export function shopReportRequestId(): string {
  return `${SHOP_REQUEST_PREFIX}${crypto.randomUUID()}`;
}

/** 月份範圍換成 report_runs 要的起訖日；end 是那個月的最後一天。 */
export function monthRangeToDates(startMonth: string, endMonth: string): { startDate: string; endDate: string } {
  const [year, month] = endMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).getUTCDate();
  return { startDate: `${startMonth}-01`, endDate: `${endMonth}-${String(lastDay).padStart(2, "0")}` };
}

export async function recordShopReportRun(
  db: Database,
  input: {
    requestId: string;
    startMonth: string;
    endMonth: string;
    actor: { id: string; email: string };
    driveFolderUrl: string;
    driveFolderName: string;
  },
): Promise<ShopReportRun> {
  const id = crypto.randomUUID();
  const { startDate, endDate } = monthRangeToDates(input.startMonth, input.endMonth);
  await db.batch([
    // 官網 scope 由 runner 匯入時也會 upsert 一次；這裡先建起來，執行紀錄才有東西可以掛。
    db.insert(scopes).values({
      id: SHOP_SCOPE_ID,
      sourceType: "cyberbiz",
      scopeKind: "channel",
      name: SHOP_SCOPE_NAME,
      normalizedName: normalizeReportScopeName(SHOP_SCOPE_NAME),
      active: 1,
      sortOrder: 0,
    }).onConflictDoNothing(),
    db.insert(reportRuns).values({
      id,
      requestId: input.requestId,
      sourceType: "cyberbiz",
      // 一份對帳單同時帶商品銷售與撥款，兩個旗標都要開。
      importsSales: 1,
      importsPayout: 1,
      // 對帳單的區間是 CYBERBIZ 每半個月自己切的，跨月挑選一律算 custom。
      periodKind: input.startMonth === input.endMonth ? "month" : "custom",
      startDate,
      endDate,
      status: "queued",
      actorEmail: input.actor.email,
    }),
    db.insert(reportRunScopes).values({
      reportRunId: id,
      scopeId: SHOP_SCOPE_ID,
      driveFolderUrl: input.driveFolderUrl,
      driveFolderName: input.driveFolderName,
    }),
  ] as never);
  return {
    id,
    requestId: input.requestId,
    startMonth: input.startMonth,
    endMonth: input.endMonth,
    actorEmail: input.actor.email,
    driveFolderUrl: input.driveFolderUrl,
    driveFolderName: input.driveFolderName,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 觸發 workflow 失敗時把那一列標成 failed。
 *
 * 成功的那一側沒有對應的收尾：runner 匯入時建立的是自己那筆 `target-import:` run，
 * 不會回頭更新這一列，所以跑成功的紀錄會一直停在 queued。執行頁只用它顯示「誰在
 * 什麼時候按了執行」，實際進度是去問 GitHub 的，所以現在不需要那條回呼；等之後
 * 需要在清單上直接看到成功或失敗時再補。
 */
export async function failShopReportRun(db: Database, requestId: string, message: string): Promise<void> {
  await db.update(reportRuns)
    .set({ status: "failed", lastError: message.slice(0, 500), updatedAt: new Date().toISOString() })
    .where(eq(reportRuns.requestId, requestId));
}

export async function listShopReportRuns(db: Database, limit = 10): Promise<ShopReportRun[]> {
  const rows = await db.all<{
    id: string;
    requestId: string;
    startDate: string;
    endDate: string;
    actorEmail: string;
    driveFolderUrl: string | null;
    driveFolderName: string | null;
    createdAt: string;
  }>(sql`
    SELECT
      runs.id AS id,
      runs.request_id AS requestId,
      runs.start_date AS startDate,
      runs.end_date AS endDate,
      runs.actor_email AS actorEmail,
      run_scopes.drive_folder_url AS driveFolderUrl,
      run_scopes.drive_folder_name AS driveFolderName,
      runs.created_at AS createdAt
    FROM report_runs AS runs
    LEFT JOIN report_run_scopes AS run_scopes
      ON run_scopes.report_run_id = runs.id AND run_scopes.scope_id = ${SHOP_SCOPE_ID}
    WHERE runs.request_id LIKE ${`${SHOP_REQUEST_PREFIX}%`}
      AND actor_email <> ''
    ORDER BY created_at DESC
    LIMIT ${Math.max(1, Math.min(limit, 100))}
  `);
  return rows.map((row) => ({
    id: row.id,
    requestId: row.requestId,
    startMonth: row.startDate.slice(0, 7),
    endMonth: row.endDate.slice(0, 7),
    actorEmail: row.actorEmail,
    driveFolderUrl: row.driveFolderUrl ?? "",
    driveFolderName: row.driveFolderName ?? "",
    createdAt: row.createdAt,
  }));
}
