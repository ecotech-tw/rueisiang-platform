import { sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { SHOP_REQUEST_PREFIX } from "./shop-report.js";

/**
 * 四種報表執行的共用清單。
 *
 * 以前每個執行頁各自撈自己的「最近執行」，條件都不一樣，還要靠 request_id 前綴
 * 互相排擠——官網那支同時開 imports_sales 與 imports_payout，不排除就會同時出現
 * 在出金表與商品銷售的清單裡。四個頁面合併成一頁之後，那些排擠規則換成這裡的
 * 一個 kind：判斷只有一處，加第五種報表時也只有一處要改。
 *
 * kind 是算出來的，不是欄位。加一欄要 migration 加回填，而且四個寫入點都得記得
 * 填；這些列的來源本來就決定了種類，算一次比同步四處可靠。
 */
export type ReportRunKind = "cyberbiz-payout" | "cyberbiz-sales" | "cyberbiz-shop" | "shopee";

export const REPORT_RUN_KINDS: readonly ReportRunKind[] = [
  "cyberbiz-payout",
  "cyberbiz-sales",
  "cyberbiz-shop",
  "shopee",
];

export interface ReportRunListRow {
  id: string;
  requestId: string;
  kind: ReportRunKind;
  scopeNames: string[];
  startDate: string;
  endDate: string;
  periodKind: "month" | "custom";
  status: string;
  actorEmail: string;
  createdAt: string;
}

/**
 * group_concat 的分隔字元用 unit separator（U+001F），不用逗號或頓號——店名本身
 * 就可能含那些符號，拿它們當分隔會把一家店切成兩家。
 */
const SCOPE_NAME_SEPARATOR = String.fromCharCode(31);

/** 種類判斷。順序有意義：官網兩個旗標都是 1，要在銷售那條之前先認出來。 */
const KIND_SQL = sql`CASE
  WHEN run.source_type = 'shopee' THEN 'shopee'
  WHEN run.request_id LIKE ${`${SHOP_REQUEST_PREFIX}%`} THEN 'cyberbiz-shop'
  WHEN run.imports_sales = 1 THEN 'cyberbiz-sales'
  ELSE 'cyberbiz-payout'
END`;

/**
 * 只留「人從執行頁按出來的」那些。
 *
 * runner 匯入資料時也會建 report_runs，但那些 request_id 不存在於 GitHub 的
 * run-name，拿來當「上一次執行」會對不到任何工作流程。actor_email 是空的同理。
 */
const HUMAN_RUNS = sql`run.request_id NOT LIKE 'cyberbiz-ingest:%'
  AND run.request_id NOT LIKE 'target-import:%'
  AND run.actor_email <> ''`;

export async function listReportRuns(
  db: Database,
  options: { kinds?: readonly ReportRunKind[]; limit?: number } = {},
): Promise<ReportRunListRow[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const rows = await db.all<{
    id: string;
    requestId: string;
    kind: ReportRunKind;
    scopeNames: string | null;
    startDate: string;
    endDate: string;
    periodKind: "month" | "custom";
    status: string;
    actorEmail: string;
    createdAt: string;
  }>(sql`
    SELECT
      run.id AS id,
      run.request_id AS requestId,
      ${KIND_SQL} AS kind,
      (
        SELECT group_concat(scope.name, char(31))
        FROM report_run_scopes AS link
        INNER JOIN scopes AS scope ON scope.id = link.scope_id
        WHERE link.report_run_id = run.id
      ) AS scopeNames,
      run.start_date AS startDate,
      run.end_date AS endDate,
      run.period_kind AS periodKind,
      run.status AS status,
      run.actor_email AS actorEmail,
      run.created_at AS createdAt
    FROM report_runs AS run
    WHERE ${HUMAN_RUNS}
      ${options.kinds ? sql`AND ${KIND_SQL} IN (${sql.join(options.kinds.map((kind) => sql`${kind}`), sql`, `)})` : sql``}
    ORDER BY run.created_at DESC
    LIMIT ${limit}
  `);
  return rows.map((row) => ({
    ...row,
    scopeNames: row.scopeNames ? row.scopeNames.split(SCOPE_NAME_SEPARATOR) : [],
  }));
}
