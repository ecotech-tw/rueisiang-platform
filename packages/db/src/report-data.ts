import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  reportManualSalesMonthly,
  reportPayoutDaily,
  reportSalesMonthly,
  reportScopes,
  type NewReportPayoutDaily,
  type NewReportSalesMonthly,
  type ReportScope,
  type ReportScopeKind,
  type ReportPayoutDaily,
} from "./schema/reports.js";
import { customReportProducts, inventoryItems, productBundleComponents, productSkuMappings } from "./schema/wms.js";
import { legacyShopeeExternalSku, reportScopeChannel } from "./product-sku-mappings.js";

export type { ReportManualSkuSource, ReportPayoutDaily, ReportScopeKind } from "./schema/reports.js";

export type ReportGroupBy = "day" | "month" | "scope" | "sku" | "category";

export interface ReportRange {
  period: string;
  startDate: string;
  endDate: string;
  /** HTTP 以 startDate/endDate 查詢時保留這個資訊，避免同月自訂區間被當成整月。 */
  isCustom?: boolean;
}

export interface ReportScopeInput {
  id: string;
  scopeKind: ReportScopeKind;
  name: string;
  active?: boolean;
}

export interface ReportSalesQuery {
  range: ReportRange;
  scopeType: ReportScopeKind;
  scopeId?: string;
  scopeName?: string;
  groupBy?: ReportGroupBy[];
  sku?: string;
  category?: string;
  productName?: string;
  /** 以商品名稱模糊搜尋，或以系統 SKU 精確搜尋。 */
  productQuery?: string;
}

export interface ReportPayoutQuery {
  range: ReportRange;
  scopeType: ReportScopeKind;
  scopeId?: string;
  scopeName?: string;
  groupBy?: ReportGroupBy[];
}

export interface ReportSalesQueryResult {
  status: "ok" | "NO_DATA_FOR_RANGE" | "UNSUPPORTED_GRANULARITY";
  period: string;
  requestedStart: string;
  requestedEnd: string;
  scopeType: ReportScopeKind;
  scopeId?: string;
  scopeName?: string;
  rows: Array<Record<string, string | number | null>>;
  totals: {
    grossQuantity: number;
    returnQuantity: number;
    netQuantity: number;
    salesAmount: number;
  };
  message?: string;
}

export interface ReportPayoutQueryResult {
  status: "ok" | "NO_DATA_FOR_RANGE";
  period: string;
  requestedStart: string;
  requestedEnd: string;
  scopeType: ReportScopeKind;
  scopeId?: string;
  scopeName?: string;
  rows: Array<Record<string, string | number | null>>;
  totals: { payoutAmount: number };
  message?: string;
}

export class ReportScopeAmbiguousError extends Error {
  readonly code = "ambiguous_report_scope";

  constructor(scopeKind: ReportScopeKind, name: string) {
    super(`報表 ${scopeKind} scope 名稱「${name}」對應到多個啟用中的據點，請改用 scopeId。`);
    this.name = "ReportScopeAmbiguousError";
  }
}

export function normalizeReportScopeName(value: string): string {
  return value.trim().replace(/\s+/gu, "").toLocaleLowerCase();
}

export function parseReportRange(period?: string, startDate?: string, endDate?: string): ReportRange {
  const start = startDate?.trim();
  const end = endDate?.trim();
  if (Boolean(start) !== Boolean(end)) throw new Error("startDate 與 endDate 必須同時提供。");
  if (start && end) {
    if (!isDate(start) || !isDate(end) || start > end) throw new Error("日期區間必須是有效的 YYYY-MM-DD，且起日不可晚於迄日。");
    return { period: start.slice(0, 7) === end.slice(0, 7) ? start.slice(0, 7) : `${start}~${end}`, startDate: start, endDate: end, isCustom: true };
  }

  const value = period?.trim() ?? "";
  if (/^\d{4}$/.test(value)) return { period: value, startDate: `${value}-01-01`, endDate: `${value}-12-31` };
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    const [year, month] = value.split("-").map(Number);
    const day = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).getUTCDate();
    return { period: value, startDate: `${value}-01`, endDate: `${value}-${String(day).padStart(2, "0")}` };
  }
  throw new Error("period 必須是 YYYY 或 YYYY-MM；若查詢自訂區間，請同時提供 startDate 與 endDate。");
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** API 寫入逐日資料時也要沿用查詢的日曆驗證，避免 SQLite 收進不存在的日期。 */
export function isValidReportDate(value: string): boolean {
  return isDate(value);
}

export async function listReportScopes(db: Database, scopeKind?: ReportScopeKind): Promise<ReportScope[]> {
  return db.select().from(reportScopes)
    .where(and(eq(reportScopes.active, 1), scopeKind ? eq(reportScopes.scopeKind, scopeKind) : undefined))
    .orderBy(asc(reportScopes.name));
}

/*
 * 人工修訂是同一個報表 key 的覆蓋層：
 * - 有人工資料時，該 key 不再採用匯入資料。
 * - 人工資料可以補上匯入資料沒有的 key。
 * - 刪除人工資料後，原本的匯入資料會自然恢復。
 *
 * 這裡使用固定 SQL table name，而不是使用者輸入，因此不會把外部值插入 identifier。
 */
const EFFECTIVE_SALES_SOURCE = sql`(
  SELECT
    imported.scope_id,
    imported.report_month,
    imported.sku,
    imported.product_name,
    imported.category,
    imported.gross_quantity,
    imported.return_quantity,
    imported.net_quantity,
    imported.sales_amount
  FROM report_sales_monthly AS imported
  WHERE NOT EXISTS (
    SELECT 1
    FROM report_manual_sales_monthly AS manual
    WHERE manual.scope_id = imported.scope_id
      AND manual.report_month = imported.report_month
      AND lower(manual.sku) = lower(imported.sku)
  )
  UNION ALL
  SELECT
    manual.scope_id,
    manual.report_month,
    manual.sku,
    manual.product_name,
    manual.category,
    manual.gross_quantity,
    manual.return_quantity,
    manual.net_quantity,
    manual.sales_amount
  FROM report_manual_sales_monthly AS manual
) AS report_sales_effective`;

const EFFECTIVE_SALES_COLUMNS = {
  scopeId: sql.raw("report_sales_effective.scope_id"),
  reportMonth: sql.raw("report_sales_effective.report_month"),
  sku: sql.raw("report_sales_effective.sku"),
  productName: sql.raw("report_sales_effective.product_name"),
  category: sql.raw("report_sales_effective.category"),
  grossQuantity: sql.raw("report_sales_effective.gross_quantity"),
  returnQuantity: sql.raw("report_sales_effective.return_quantity"),
  netQuantity: sql.raw("report_sales_effective.net_quantity"),
  salesAmount: sql.raw("report_sales_effective.sales_amount"),
};

const EFFECTIVE_PAYOUT_SOURCE = sql`(
  SELECT
    imported.scope_id,
    imported.business_date,
    imported.payout_amount
  FROM report_payout_daily AS imported
  WHERE NOT EXISTS (
    SELECT 1
    FROM report_manual_payout_daily AS manual
    WHERE manual.scope_id = imported.scope_id
      AND manual.business_date = imported.business_date
  )
  UNION ALL
  SELECT
    manual.scope_id,
    manual.business_date,
    manual.payout_amount
  FROM report_manual_payout_daily AS manual
) AS report_payout_effective`;

const EFFECTIVE_PAYOUT_COLUMNS = {
  scopeId: sql.raw("report_payout_effective.scope_id"),
  businessDate: sql.raw("report_payout_effective.business_date"),
  payoutAmount: sql.raw("report_payout_effective.payout_amount"),
};

export interface LatestReportSalesPeriods {
  latestPeriod: string | null;
  byScope: Record<string, string>;
}

/** 回傳啟用中 scope 的最新商品銷售月份，供統計首頁選擇有資料的預設期間。 */
export async function latestReportSalesPeriods(
  db: Database,
  scopeIds: readonly string[],
): Promise<LatestReportSalesPeriods> {
  if (!scopeIds.length) return { latestPeriod: null, byScope: {} };

  const [importedRows, manualRows] = await Promise.all([
    db.select({
      scopeId: reportSalesMonthly.scopeId,
      reportMonth: sql<string | null>`max(${reportSalesMonthly.reportMonth})`,
    }).from(reportSalesMonthly)
      .where(inArray(reportSalesMonthly.scopeId, [...scopeIds]))
      .groupBy(reportSalesMonthly.scopeId),
    db.select({
      scopeId: reportManualSalesMonthly.scopeId,
      reportMonth: sql<string | null>`max(${reportManualSalesMonthly.reportMonth})`,
    }).from(reportManualSalesMonthly)
      .where(inArray(reportManualSalesMonthly.scopeId, [...scopeIds]))
      .groupBy(reportManualSalesMonthly.scopeId),
  ]);

  const byScope: Record<string, string> = {};
  let latestPeriod: string | null = null;
  for (const row of [...importedRows, ...manualRows]) {
    if (!row.reportMonth) continue;
    const existing = byScope[row.scopeId];
    if (!existing || row.reportMonth > existing) byScope[row.scopeId] = row.reportMonth;
    if (!latestPeriod || row.reportMonth > latestPeriod) latestPeriod = row.reportMonth;
  }
  for (const period of Object.values(byScope)) {
    if (!latestPeriod || period > latestPeriod) latestPeriod = period;
  }
  return { latestPeriod, byScope };
}

export async function upsertReportScope(db: Database, input: ReportScopeInput): Promise<ReportScope> {
  const now = new Date().toISOString();
  await db.insert(reportScopes).values({
    id: input.id,
    scopeKind: input.scopeKind,
    name: input.name.trim(),
    normalizedName: normalizeReportScopeName(input.name),
    active: input.active === false ? 0 : 1,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: reportScopes.id,
    set: {
      scopeKind: input.scopeKind,
      name: input.name.trim(),
      normalizedName: normalizeReportScopeName(input.name),
      active: input.active === false ? 0 : 1,
      updatedAt: now,
    },
  });
  const [scope] = await db.select().from(reportScopes).where(eq(reportScopes.id, input.id)).limit(1);
  if (!scope) throw new Error("寫入報表 scope 後找不到資料。");
  return scope;
}

export async function findReportScope(
  db: Database,
  input: { scopeKind: ReportScopeKind; id?: string; name?: string },
): Promise<ReportScope | null> {
  if (input.id) {
    const [scope] = await db.select().from(reportScopes).where(and(
      eq(reportScopes.id, input.id),
      eq(reportScopes.scopeKind, input.scopeKind),
      eq(reportScopes.active, 1),
    )).limit(1);
    return scope ?? null;
  }
  if (!input.name) return null;
  const scopes = await db.select().from(reportScopes).where(and(
    eq(reportScopes.scopeKind, input.scopeKind),
    eq(reportScopes.normalizedName, normalizeReportScopeName(input.name)),
    eq(reportScopes.active, 1),
  )).limit(2);
  if (scopes.length > 1) throw new ReportScopeAmbiguousError(input.scopeKind, input.name);
  return scopes[0] ?? null;
}

/** 月份匯入是一次性快照；即使當月零筆，也要清掉該據點該月份的舊 SKU。 */
export async function insertReportSalesMonthly(
  db: Database,
  rows: readonly NewReportSalesMonthly[],
  target?: { scopeId: string; reportMonth: string; replaceExisting?: boolean },
): Promise<void> {
  type Statement = Parameters<Database["batch"]>[0][number];
  const months = new Map<string, {
    scopeId: string;
    reportMonth: string;
    rows: NewReportSalesMonthly[];
    replaceExisting: boolean;
  }>();
  const month = (scopeId: string, reportMonth: string, replaceExisting = true) => {
    const key = `${reportMonth}\u0000${scopeId}`;
    const existing = months.get(key);
    if (existing) {
      // 同一批次若由 target 補上一個空月份，target 的 merge 設定也要套用到既有 rows。
      if (!replaceExisting) existing.replaceExisting = false;
      return existing;
    }
    const created = { scopeId, reportMonth, rows: [] as NewReportSalesMonthly[], replaceExisting };
    months.set(key, created);
    return created;
  };
  for (const row of rows) month(row.scopeId, row.reportMonth).rows.push(row);
  if (target) month(target.scopeId, target.reportMonth, target.replaceExisting ?? true);

  // replace 模式每月一組：該月的 delete 與它自己的 insert 綁在一起，一組不跨 db.batch()。batch 是
  // 一個 transaction，把組切開的話中途失敗會留下「刪掉了但沒寫回去」的空洞。一組本身就超過上限時讓它獨佔一批。
  const groups: Statement[][] = [];
  for (const entry of months.values()) {
    const group: Statement[] = [];
    if (entry.replaceExisting) {
      group.push(db.delete(reportSalesMonthly).where(and(
        eq(reportSalesMonthly.scopeId, entry.scopeId),
        eq(reportSalesMonthly.reportMonth, entry.reportMonth),
      )));
    }
    for (const chunk of chunks(entry.rows, 8)) {
      if (!chunk.length) continue;
      group.push(db.insert(reportSalesMonthly).values(chunk).onConflictDoUpdate({
        target: [reportSalesMonthly.scopeId, reportSalesMonthly.reportMonth, reportSalesMonthly.sku],
        set: {
          productName: sql`excluded.product_name`,
          category: sql`excluded.category`,
          grossQuantity: sql`excluded.gross_quantity`,
          returnQuantity: sql`excluded.return_quantity`,
          netQuantity: sql`excluded.net_quantity`,
          salesAmount: sql`excluded.sales_amount`,
          updatedAt: sql`excluded.updated_at`,
        },
      }));
    }
    groups.push(group);
  }

  let batch: Statement[] = [];
  for (const group of groups) {
    if (batch.length && batch.length + group.length > 50) {
      await db.batch(batch as [Statement, ...Statement[]]);
      batch = [];
    }
    batch.push(...group);
  }
  if (batch.length) await db.batch(batch as [Statement, ...Statement[]]);
}

export async function insertReportPayoutDaily(db: Database, rows: readonly NewReportPayoutDaily[]): Promise<void> {
  type Statement = Parameters<Database["batch"]>[0][number];
  const statements: Statement[] = [];
  for (const chunk of chunks(rows, 20)) {
    if (!chunk.length) continue;
    statements.push(db.insert(reportPayoutDaily).values(chunk).onConflictDoUpdate({
      target: [reportPayoutDaily.scopeId, reportPayoutDaily.businessDate],
      set: {
        payoutAmount: sql`excluded.payout_amount`,
        updatedAt: sql`excluded.updated_at`,
      },
    }));
  }
  for (const chunk of chunks(statements, 50)) {
    if (chunk.length) await db.batch(chunk as [Statement, ...Statement[]]);
  }
}

export async function updateReportPayoutDaily(
  db: Database,
  input: { scopeId: string; businessDate: string; payoutAmount: number },
): Promise<ReportPayoutDaily | null> {
  const [existing] = await db.select().from(reportPayoutDaily).where(and(
    eq(reportPayoutDaily.scopeId, input.scopeId),
    eq(reportPayoutDaily.businessDate, input.businessDate),
  )).limit(1);
  if (!existing) return null;

  const updatedAt = new Date().toISOString();
  await db.update(reportPayoutDaily)
    .set({ payoutAmount: input.payoutAmount, updatedAt })
    .where(and(
      eq(reportPayoutDaily.scopeId, input.scopeId),
      eq(reportPayoutDaily.businessDate, input.businessDate),
    ));
  return { ...existing, payoutAmount: input.payoutAmount, updatedAt };
}

export async function deleteReportPayoutDaily(
  db: Database,
  input: { scopeId: string; businessDate: string },
): Promise<boolean> {
  const [existing] = await db.select({ scopeId: reportPayoutDaily.scopeId }).from(reportPayoutDaily).where(and(
    eq(reportPayoutDaily.scopeId, input.scopeId),
    eq(reportPayoutDaily.businessDate, input.businessDate),
  )).limit(1);
  if (!existing) return false;

  await db.delete(reportPayoutDaily).where(and(
    eq(reportPayoutDaily.scopeId, input.scopeId),
    eq(reportPayoutDaily.businessDate, input.businessDate),
  ));
  return true;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

type SalesGroupBy = Exclude<ReportGroupBy, "day">;

const SALES_GROUPS: Record<SalesGroupBy, { alias: string; expression: ReturnType<typeof sql> }> = {
  month: { alias: "reportMonth", expression: EFFECTIVE_SALES_COLUMNS.reportMonth },
  scope: { alias: "scopeId", expression: EFFECTIVE_SALES_COLUMNS.scopeId },
  sku: { alias: "sku", expression: EFFECTIVE_SALES_COLUMNS.sku },
  category: { alias: "category", expression: EFFECTIVE_SALES_COLUMNS.category },
};

type PayoutGroupBy = "day" | "month" | "scope";

const REPORT_STORE_SCOPE_ID = /^(?:[A-Za-z][A-Za-z0-9_-]*:store:|store-)/;

/** 公司報表會納入的店別 scope 格式；避免寫入查不到的孤兒 scope。 */
export function isCompanyReportStoreScopeId(scopeId: string): boolean {
  return REPORT_STORE_SCOPE_ID.test(scopeId);
}

const PAYOUT_GROUPS: Record<PayoutGroupBy, { alias: string; expression: ReturnType<typeof sql> }> = {
  day: { alias: "businessDate", expression: EFFECTIVE_PAYOUT_COLUMNS.businessDate },
  month: { alias: "reportMonth", expression: sql`substr(${EFFECTIVE_PAYOUT_COLUMNS.businessDate}, 1, 7)` },
  scope: { alias: "scopeId", expression: EFFECTIVE_PAYOUT_COLUMNS.scopeId },
};

function selectedGroups(groups: readonly ReportGroupBy[] | undefined): SalesGroupBy[] {
  return [...new Set(groups?.filter((group): group is SalesGroupBy => group !== "day" && group in SALES_GROUPS) ?? [])];
}

function selectedPayoutGroups(groups: readonly ReportGroupBy[] | undefined): PayoutGroupBy[] {
  return [...new Set(groups?.filter((group): group is PayoutGroupBy => group === "day" || group === "month" || group === "scope") ?? [])];
}

function scopeCondition(column: ReturnType<typeof sql>, scopeIds: readonly string[]) {
  return scopeIds.length === 1
    ? sql`${column} = ${scopeIds[0]}`
    : sql`${column} IN (${sql.join(scopeIds.map((id) => sql`${id}`), sql`, `)})`;
}

export async function scopeIdsForQuery(db: Database, query: { scopeType: ReportScopeKind; scopeId?: string; scopeName?: string }): Promise<{ ids: string[]; scope?: ReportScope }> {
  if (query.scopeType === "store") {
    const scope = await findReportScope(db, { scopeKind: "store", id: query.scopeId, name: query.scopeName });
    return scope ? { ids: [scope.id], scope } : { ids: [] };
  }
  return {
    // 公司總額納入所有通路，但只接受既定的 channel:store:id 格式與舊版 store- ID。
    ids: (await listReportScopes(db, "store"))
      .filter((scope) => isCompanyReportStoreScopeId(scope.id))
      .map((scope) => scope.id),
  };
}

function queryConditions(
  dateColumn: ReturnType<typeof sql>,
  scopeColumn: ReturnType<typeof sql>,
  range: ReportRange,
  scopeIds: readonly string[],
) {
  return sql.join([
    sql`${dateColumn} >= ${range.startDate}`,
    sql`${dateColumn} <= ${range.endDate}`,
    scopeCondition(scopeColumn, scopeIds),
  ], sql` AND `);
}

function monthConditions(
  monthColumn: ReturnType<typeof sql>,
  scopeColumn: ReturnType<typeof sql>,
  range: ReportRange,
  scopeIds: readonly string[],
) {
  return sql.join([
    sql`${monthColumn} >= ${range.startDate.slice(0, 7)}`,
    sql`${monthColumn} <= ${range.endDate.slice(0, 7)}`,
    scopeCondition(scopeColumn, scopeIds),
  ], sql` AND `);
}

function isWholeMonthRange(range: ReportRange): boolean {
  if (!range.startDate.endsWith("-01")) return false;
  const [year, month] = range.endDate.slice(0, 7).split("-").map(Number);
  const lastDay = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).getUTCDate();
  return range.endDate === `${range.endDate.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export async function queryReportSales(db: Database, query: ReportSalesQuery): Promise<ReportSalesQueryResult | null> {
  if (!isWholeMonthRange(query.range)) {
    return {
      status: "UNSUPPORTED_GRANULARITY",
      period: query.range.period,
      requestedStart: query.range.startDate,
      requestedEnd: query.range.endDate,
      scopeType: query.scopeType,
      rows: [],
      totals: { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 },
      message: "商品銷售資料目前只支援完整月份查詢，請改用 YYYY-MM 或完整月份的起訖日期。",
    };
  }
  const { ids, scope } = await scopeIdsForQuery(db, query);
  if (!ids.length) return null;
  const groups = selectedGroups(query.groupBy?.length ? query.groupBy : ["sku"]);
  const dimensions = groups.map((group) => SALES_GROUPS[group]);
  const requestedSku = query.sku?.trim();
  const productQuery = query.productQuery?.trim();
  // 這次查詢涵蓋的通路；legacy 一律納入，那是還沒標通路的舊 mapping。
  const aliasChannels = [...new Set([...ids.map(reportScopeChannel), "legacy"])];
  const legacyAlias = requestedSku ? legacyShopeeExternalSku(requestedSku) : "";
  const aliasKeys = requestedSku
    ? [...new Set([requestedSku, ...(legacyAlias ? [legacyAlias] : [])])]
    : [];
  const filters = [
    monthConditions(EFFECTIVE_SALES_COLUMNS.reportMonth, EFFECTIVE_SALES_COLUMNS.scopeId, query.range, ids),
    /*
     * 外部 SKU 也查得到，但不能因此把別的商品算進來。
     *
     * 四道限制：
     * (1) 只有查詢值本身不是任何 WMS SKU 時才走 mapping 這條路。external_sku 允許等於
     *     另一個商品的 WMS SKU（見「外部 SKU 等於非第一順位用料的 WMS SKU 不算衝突」），
     *     不擋的話查香皂會連整個組合的資料一起加總。
     * (2) 只認一對一的對應。report_sales_monthly 是以 SKU 為粒度，沒有保留「這筆組合貢獻
     *     了多少」，所以組合的用料數字裡混著該用料的直接銷售與其他組合的展開——把那個
     *     總和當成這個組合的銷售回報出去會是錯的。
     * (3) 只認這次查詢涵蓋的通路（外加 legacy 舊資料）。只比 external_sku 的話，
     *     CYBERBIZ 的別名會撈出蝦皮同一個正式 SKU 的資料列，即使蝦皮根本沒有那個別名。
     * (4) 對應寫進報表的 SKU 一律從用料即時解析（WMS 商品或報表自訂商品），不留第二份
     *     快照——商品改名 SKU 之後快照不會跟著動，匯入寫新值、查詢查舊值就會查無資料。
     *
     * 蝦皮的別名另外吃 legacyShopeeExternalSku：匯入端允許「商品ID_規格ID」回退到只有
     * 商品 ID 的舊 mapping，查詢端沒有跟上的話同一個值查得到匯入卻查不到報表。
     */
    ...(requestedSku ? [sql`(
      lower(${EFFECTIVE_SALES_COLUMNS.sku}) = lower(${requestedSku})
      OR (
        NOT EXISTS (
          SELECT 1 FROM ${inventoryItems} AS wmsItem
          WHERE lower(wmsItem.sku) = lower(${requestedSku})
        )
        AND EXISTS (
          SELECT 1
          FROM ${productSkuMappings} AS mapping
          JOIN ${productBundleComponents} AS component ON component.mapping_id = mapping.id
          LEFT JOIN ${inventoryItems} AS componentItem ON componentItem.id = component.inventory_item_id
          LEFT JOIN ${customReportProducts} AS customProduct ON customProduct.id = component.custom_product_id
          WHERE lower(mapping.external_sku) IN (${sql.join(aliasKeys.map((key) => sql`lower(${key})`), sql`, `)})
            AND mapping.channel IN (${sql.join(aliasChannels.map((channel) => sql`${channel}`), sql`, `)})
            AND lower(COALESCE(componentItem.sku, customProduct.sku)) = lower(${EFFECTIVE_SALES_COLUMNS.sku})
            AND (
              SELECT COUNT(*) FROM ${productBundleComponents} AS sibling
              WHERE sibling.mapping_id = mapping.id
            ) = 1
        )
      )
    )`] : []),
    ...(query.category ? [sql`lower(${EFFECTIVE_SALES_COLUMNS.category}) = lower(${query.category})`] : []),
    ...(query.productName ? [sql`lower(${EFFECTIVE_SALES_COLUMNS.productName}) LIKE lower(${`%${query.productName}%`})`] : []),
    ...(productQuery ? [sql`(
      lower(${EFFECTIVE_SALES_COLUMNS.productName}) LIKE lower(${`%${productQuery}%`})
      OR lower(${EFFECTIVE_SALES_COLUMNS.sku}) = lower(${productQuery})
    )`] : []),
  ];
  const selected = [
    ...dimensions.map((item) => sql`${item.expression} AS ${sql.raw(item.alias)}`),
    ...(groups.includes("sku") ? [sql`MAX(${EFFECTIVE_SALES_COLUMNS.productName}) AS productName`] : []),
    sql`SUM(${EFFECTIVE_SALES_COLUMNS.grossQuantity}) AS grossQuantity`,
    sql`SUM(${EFFECTIVE_SALES_COLUMNS.returnQuantity}) AS returnQuantity`,
    sql`SUM(${EFFECTIVE_SALES_COLUMNS.netQuantity}) AS netQuantity`,
    sql`SUM(${EFFECTIVE_SALES_COLUMNS.salesAmount}) AS salesAmount`,
  ];
  const grouped = dimensions.length ? sql` GROUP BY ${sql.join(dimensions.map((item) => item.expression), sql`, `)}` : sql``;
  const order = dimensions.length ? sql` ORDER BY ${sql.join(dimensions.map((item) => item.expression), sql`, `)}` : sql``;
  const rows = await db.all<Record<string, unknown>>(sql`SELECT ${sql.join(selected, sql`, `)} FROM ${EFFECTIVE_SALES_SOURCE} WHERE ${sql.join(filters, sql` AND `)}${grouped}${order}`);
  const emptyAggregate = rows.length > 0 && rows.every((row) => (
    row.grossQuantity == null && row.returnQuantity == null && row.netQuantity == null && row.salesAmount == null
  ));
  if (!rows.length || emptyAggregate) {
    const coverage = await db.all<{ count: unknown }>(sql`SELECT COUNT(*) AS count FROM ${EFFECTIVE_SALES_SOURCE} WHERE ${monthConditions(
      EFFECTIVE_SALES_COLUMNS.reportMonth,
      EFFECTIVE_SALES_COLUMNS.scopeId,
      query.range,
      ids,
    )}`);
    if (asNumber(coverage[0]?.count) === 0) return null;
    return {
      status: "ok",
      period: query.range.period,
      requestedStart: query.range.startDate,
      requestedEnd: query.range.endDate,
      scopeType: query.scopeType,
      ...(scope ? { scopeId: scope.id, scopeName: scope.name } : {}),
      rows: [],
      totals: { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 },
      message: "指定區間已有匯入的商品銷售資料，但沒有符合目前篩選條件的資料；請調整 SKU、分類或商品名稱。",
    };
  }

  const scopeNames = new Map((await listReportScopes(db, "store")).map((item) => [item.id, item.name]));
  const resultRows = rows.map((row) => ({
    ...row,
    ...(row.scopeId ? { scopeName: scopeNames.get(String(row.scopeId)) ?? String(row.scopeId) } : {}),
    grossQuantity: asNumber(row.grossQuantity),
    returnQuantity: asNumber(row.returnQuantity),
    netQuantity: asNumber(row.netQuantity),
    salesAmount: asNumber(row.salesAmount),
  }));
  return {
    status: "ok",
    period: query.range.period,
    requestedStart: query.range.startDate,
    requestedEnd: query.range.endDate,
    scopeType: query.scopeType,
    ...(scope ? { scopeId: scope.id, scopeName: scope.name } : {}),
    rows: resultRows,
    totals: resultRows.reduce((totals, row) => ({
      grossQuantity: totals.grossQuantity + asNumber(row.grossQuantity),
      returnQuantity: totals.returnQuantity + asNumber(row.returnQuantity),
      netQuantity: totals.netQuantity + asNumber(row.netQuantity),
      salesAmount: totals.salesAmount + asNumber(row.salesAmount),
    }), { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 }),
  };
}

export async function queryReportPayout(db: Database, query: ReportPayoutQuery): Promise<ReportPayoutQueryResult | null> {
  const { ids, scope } = await scopeIdsForQuery(db, query);
  if (!ids.length) return null;
  const groups = selectedPayoutGroups(query.groupBy?.length ? query.groupBy : ["day"]);
  const dimensions = groups.map((group) => PAYOUT_GROUPS[group]);
  const conditions = queryConditions(EFFECTIVE_PAYOUT_COLUMNS.businessDate, EFFECTIVE_PAYOUT_COLUMNS.scopeId, query.range, ids);
  const selected = [
    ...dimensions.map((item) => sql`${item.expression} AS ${sql.raw(item.alias)}`),
    sql`SUM(${EFFECTIVE_PAYOUT_COLUMNS.payoutAmount}) AS payoutAmount`,
  ];
  const grouped = dimensions.length ? sql` GROUP BY ${sql.join(dimensions.map((item) => item.expression), sql`, `)}` : sql``;
  const order = dimensions.length ? sql` ORDER BY ${sql.join(dimensions.map((item) => item.expression), sql`, `)}` : sql``;
  const rows = await db.all<Record<string, unknown>>(sql`SELECT ${sql.join(selected, sql`, `)} FROM ${EFFECTIVE_PAYOUT_SOURCE} WHERE ${conditions}${grouped}${order}`);
  if (!rows.length || (dimensions.length === 0 && rows.every((row) => row.payoutAmount == null))) return null;
  const scopeNames = new Map((await listReportScopes(db, "store")).map((item) => [item.id, item.name]));
  const resultRows = rows.map((row) => ({
    ...row,
    ...(row.scopeId ? { scopeName: scopeNames.get(String(row.scopeId)) ?? String(row.scopeId) } : {}),
    payoutAmount: asNumber(row.payoutAmount),
  }));
  return {
    status: "ok",
    period: query.range.period,
    requestedStart: query.range.startDate,
    requestedEnd: query.range.endDate,
    scopeType: query.scopeType,
    ...(scope ? { scopeId: scope.id, scopeName: scope.name } : {}),
    rows: resultRows,
    totals: { payoutAmount: resultRows.reduce((total, row) => total + asNumber(row.payoutAmount), 0) },
  };
}
