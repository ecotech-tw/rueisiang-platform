import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  reportItemSalesMonthly,
  reportManualSalesMonthly,
  reportPayoutDaily,
  reportSalesMonthly,
  reportScopes,
  targetReportPayoutDaily,
  type NewReportPayoutDaily,
  type NewReportSalesMonthly,
  type ReportScope,
  type ReportScopeKind,
} from "./schema/reports.js";
import { items as itemMasters } from "./schema/items.js";
import { customReportProducts, inventoryItems, productBundleComponents, productSkuMappings } from "./schema/wms.js";
import { legacyShopeeExternalSku, reportDataChannel } from "./product-sku-mappings.js";

export type { ReportManualSkuSource, ReportPayoutDaily, ReportScopeKind } from "./schema/reports.js";

async function hasTable(db: Database, name: string): Promise<boolean> {
  const row = await db.get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name} LIMIT 1`);
  return Boolean(row);
}

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

/**
 * 單次請求內共用的店別名冊。
 *
 * 一份統計會呼叫 queryReportSales / queryReportPayout 好幾次（本期、上期、
 * 去年同期、趨勢、店別、分類、SKU⋯），而每一次都要讀兩遍 report_scopes——
 * 一次解析 scope id、一次把 id 換成店名。八次查詢就是十六趟往返讀同一張表。
 *
 * 刻意做成傳進去的物件而不是模組層的快取：它的壽命必須剛好是一次請求，
 * 新增店別下一個請求就要看得到。
 */
export interface ReportScopeDirectory {
  stores(): Promise<ReportScope[]>;
  /** 指定店別時走這裡；同一組條件在一次請求內只查一次。 */
  store(lookup: { id?: string; name?: string }): Promise<ReportScope | null>;
}

export function createReportScopeDirectory(db: Database): ReportScopeDirectory {
  let all: Promise<ReportScope[]> | undefined;

  function stores(): Promise<ReportScope[]> {
    // 失敗的 promise 不能留下來，不然同一次請求後續的呼叫拿到的都是同一個錯誤，連重試都沒有。
    return (all ??= listReportScopes(db, "store").catch((error) => {
      all = undefined;
      throw error;
    }));
  }

  return {
    stores,
    /*
     * 從同一份名冊推導，不另外查一次。名冊的條件（scopeKind = store 且 active）
     * 跟 findReportScope 的 id 分支完全等價，name 分支也只是比對 normalizedName
     * 再加上「超過一筆就是同名」，所以指定店別的下限是一次查詢而不是兩次。
     */
    async store(lookup) {
      const scopes = await stores();
      if (lookup.id) return scopes.find((scope) => scope.id === lookup.id) ?? null;
      if (!lookup.name) return null;
      const normalized = normalizeReportScopeName(lookup.name);
      const matched = scopes.filter((scope) => scope.normalizedName === normalized);
      if (matched.length > 1) throw new ReportScopeAmbiguousError("store", lookup.name);
      return matched[0] ?? null;
    },
  };
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
    AND NOT EXISTS (
      SELECT 1
      FROM report_item_sales_monthly AS target_sales
      JOIN items AS target_item ON target_item.id = target_sales.item_id
      WHERE target_sales.scope_id = imported.scope_id
        AND target_sales.report_month = imported.report_month
        AND lower(target_item.sku) = lower(imported.sku)
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
  WHERE NOT EXISTS (
    SELECT 1
    FROM report_item_sales_monthly AS target_sales
    JOIN items AS target_item ON target_item.id = target_sales.item_id
    WHERE target_sales.scope_id = manual.scope_id
      AND target_sales.report_month = manual.report_month
      AND lower(target_item.sku) = lower(manual.sku)
  )
  UNION ALL
  SELECT
    target.scope_id,
    target.report_month,
    item.sku,
    item.name AS product_name,
    COALESCE(category.name, '未分類') AS category,
    target.gross_quantity,
    target.return_quantity,
    target.net_quantity,
    target.sales_amount
  FROM report_item_sales_monthly AS target
  JOIN items AS item ON item.id = target.item_id
  LEFT JOIN item_categories AS category ON category.id = item.category_id
) AS report_sales_effective`;

const TARGET_EFFECTIVE_SALES_SOURCE = sql`(
  SELECT
    sales.scope_id,
    sales.report_month,
    item.sku,
    item.name AS product_name,
    COALESCE(category.name, '未分類') AS category,
    sales.gross_quantity,
    sales.return_quantity,
    sales.net_quantity,
    sales.sales_amount
  FROM report_item_sales_monthly AS sales
  JOIN items AS item ON item.id = sales.item_id
  LEFT JOIN item_categories AS category ON category.id = item.category_id
  WHERE sales.record_origin = 'manual'
    OR (sales.record_origin = 'imported' AND NOT EXISTS (
      SELECT 1
      FROM report_item_sales_monthly AS manual
      WHERE manual.scope_id = sales.scope_id
        AND manual.report_month = sales.report_month
        AND manual.item_id = sales.item_id
        AND manual.record_origin = 'manual'
    ))
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
    target.scope_id,
    target.business_date,
    target.payout_amount
  FROM report_payout_daily_target AS target
  WHERE target.record_origin = 'manual'
    OR (target.record_origin = 'imported' AND NOT EXISTS (
      SELECT 1
      FROM report_manual_payout_daily AS manual
      WHERE manual.scope_id = target.scope_id
        AND manual.business_date = target.business_date
    ))
  UNION ALL
  SELECT
    imported.scope_id,
    imported.business_date,
    imported.payout_amount
  FROM report_payout_daily AS imported
  WHERE NOT EXISTS (
    SELECT 1 FROM report_payout_daily_target AS target
    WHERE target.scope_id = imported.scope_id
      AND target.business_date = imported.business_date
  )
    AND NOT EXISTS (
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
  WHERE NOT EXISTS (
    SELECT 1 FROM report_payout_daily_target AS target
    WHERE target.scope_id = manual.scope_id
      AND target.business_date = manual.business_date
  )
) AS report_payout_effective`;

const TARGET_EFFECTIVE_PAYOUT_SOURCE = sql`(
  SELECT
    target.scope_id,
    target.business_date,
    target.payout_amount
  FROM report_payout_daily_target AS target
  WHERE target.record_origin = 'manual'
    OR (target.record_origin = 'imported' AND NOT EXISTS (
      SELECT 1
      FROM report_payout_daily_target AS manual
      WHERE manual.scope_id = target.scope_id
        AND manual.business_date = target.business_date
        AND manual.record_origin = 'manual'
    ))
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

  const legacySalesExists = await hasTable(db, "report_sales_monthly");
  const [importedRows, manualRows, targetRows] = await Promise.all([
    legacySalesExists
      ? db.select({ scopeId: reportSalesMonthly.scopeId, reportMonth: sql<string | null>`max(${reportSalesMonthly.reportMonth})` }).from(reportSalesMonthly).where(inArray(reportSalesMonthly.scopeId, [...scopeIds])).groupBy(reportSalesMonthly.scopeId)
      : Promise.resolve([]),
    legacySalesExists
      ? db.select({ scopeId: reportManualSalesMonthly.scopeId, reportMonth: sql<string | null>`max(${reportManualSalesMonthly.reportMonth})` }).from(reportManualSalesMonthly).where(inArray(reportManualSalesMonthly.scopeId, [...scopeIds])).groupBy(reportManualSalesMonthly.scopeId)
      : Promise.resolve([]),
    db.select({ scopeId: reportItemSalesMonthly.scopeId, reportMonth: sql<string | null>`max(${reportItemSalesMonthly.reportMonth})` }).from(reportItemSalesMonthly).where(inArray(reportItemSalesMonthly.scopeId, [...scopeIds])).groupBy(reportItemSalesMonthly.scopeId),
  ]);

  const byScope: Record<string, string> = {};
  let latestPeriod: string | null = null;
  for (const row of [...importedRows, ...manualRows, ...targetRows]) {
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
  target?: { scopeId: string; reportMonth: string; replaceExisting?: boolean; reportRunId?: string },
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
  const legacySalesExists = await hasTable(db, "report_sales_monthly");
  const groups: Statement[][] = [];
  for (const entry of months.values()) {
    if (!legacySalesExists) continue;
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

  if (target?.reportRunId) {
    const targetRows = rows.filter((row) => row.scopeId === target.scopeId && row.reportMonth === target.reportMonth);
    const itemRows = targetRows.length
      ? await db.select({ id: itemMasters.id, sku: itemMasters.sku }).from(itemMasters).where(sql`lower(${itemMasters.sku}) IN (${sql.join([...new Set(targetRows.map((row) => row.sku.toLowerCase()))].map((sku) => sql`${sku}`), sql`, `)})`)
      : [];
    const itemsBySku = new Map(itemRows.filter((item): item is { id: string; sku: string } => Boolean(item.sku)).map((item) => [item.sku.toLowerCase(), item.id]));
    const mappedRows = targetRows.flatMap((row) => {
      const itemId = itemsBySku.get(row.sku.toLowerCase());
      return itemId ? [{ scopeId: row.scopeId, reportMonth: row.reportMonth, itemId, recordOrigin: "imported" as const, reportRunId: target.reportRunId, grossQuantity: row.grossQuantity, returnQuantity: row.returnQuantity, netQuantity: row.netQuantity, salesAmount: row.salesAmount }] : [];
    });
    const targetStatements: Statement[] = [];
    if (target.replaceExisting !== false) {
      targetStatements.push(db.delete(reportItemSalesMonthly).where(and(eq(reportItemSalesMonthly.scopeId, target.scopeId), eq(reportItemSalesMonthly.reportMonth, target.reportMonth), eq(reportItemSalesMonthly.recordOrigin, "imported"))));
    }
    for (const chunk of chunks(mappedRows, 20)) {
      if (chunk.length) targetStatements.push(db.insert(reportItemSalesMonthly).values(chunk).onConflictDoUpdate({ target: [reportItemSalesMonthly.scopeId, reportItemSalesMonthly.reportMonth, reportItemSalesMonthly.itemId, reportItemSalesMonthly.recordOrigin], set: { reportRunId: target.reportRunId, grossQuantity: sql`excluded.gross_quantity`, returnQuantity: sql`excluded.return_quantity`, netQuantity: sql`excluded.net_quantity`, salesAmount: sql`excluded.sales_amount`, updatedAt: sql`CURRENT_TIMESTAMP` } }));
    }
    if (targetStatements.length) await db.batch(targetStatements as [Statement, ...Statement[]]);
  }
}

export async function insertReportPayoutDaily(db: Database, rows: readonly NewReportPayoutDaily[], reportRunId?: string): Promise<void> {
  type Statement = Parameters<Database["batch"]>[0][number];
  const legacyPayoutExists = await hasTable(db, "report_payout_daily");
  const statements: Statement[] = [];
  for (const chunk of chunks(rows, 20)) {
    if (!legacyPayoutExists || !chunk.length) continue;
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
  if (reportRunId && rows.length) {
    const targetRows = rows.map((row) => ({ scopeId: row.scopeId, businessDate: row.businessDate, recordOrigin: "imported" as const, reportRunId, payoutAmount: row.payoutAmount }));
    for (const chunk of chunks(targetRows, 20)) {
      await db.batch([db.insert(targetReportPayoutDaily).values(chunk).onConflictDoUpdate({ target: [targetReportPayoutDaily.scopeId, targetReportPayoutDaily.businessDate, targetReportPayoutDaily.recordOrigin], set: { reportRunId, payoutAmount: sql`excluded.payout_amount`, updatedAt: sql`CURRENT_TIMESTAMP` } })]);
    }
  }
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

export async function scopeIdsForQuery(
  db: Database,
  query: { scopeType: ReportScopeKind; scopeId?: string; scopeName?: string },
  directory: ReportScopeDirectory = createReportScopeDirectory(db),
): Promise<{ ids: string[]; scope?: ReportScope }> {
  if (query.scopeType === "store") {
    const scope = await directory.store({ id: query.scopeId, name: query.scopeName });
    return scope ? { ids: [scope.id], scope } : { ids: [] };
  }
  return {
    // 公司總額納入所有通路，但只接受既定的 channel:store:id 格式與舊版 store- ID。
    ids: (await directory.stores())
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

export async function queryReportSales(
  db: Database,
  query: ReportSalesQuery,
  directory: ReportScopeDirectory = createReportScopeDirectory(db),
): Promise<ReportSalesQueryResult | null> {
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
  const { ids, scope } = await scopeIdsForQuery(db, query, directory);
  if (!ids.length) return null;
  const groups = selectedGroups(query.groupBy?.length ? query.groupBy : ["sku"]);
  const dimensions = groups.map((group) => SALES_GROUPS[group]);
  const effectiveSalesSource = await hasTable(db, "report_sales_monthly") ? EFFECTIVE_SALES_SOURCE : TARGET_EFFECTIVE_SALES_SOURCE;
  const legacyInventoryExists = await hasTable(db, "inventory_items");
  const requestedSku = query.sku?.trim();
  const productQuery = query.productQuery?.trim();
  // 這次查詢涵蓋的通路；legacy 一律納入，那是還沒標通路的舊 mapping。
  const aliasChannels = [...new Set([...ids.map(reportDataChannel), "legacy"])];
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
    ...(requestedSku ? [legacyInventoryExists ? sql`(
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
    )` : sql`lower(${EFFECTIVE_SALES_COLUMNS.sku}) = lower(${requestedSku})`] : []),
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
  const rows = await db.all<Record<string, unknown>>(sql`SELECT ${sql.join(selected, sql`, `)} FROM ${effectiveSalesSource} WHERE ${sql.join(filters, sql` AND `)}${grouped}${order}`);
  const emptyAggregate = rows.length > 0 && rows.every((row) => (
    row.grossQuantity == null && row.returnQuantity == null && row.netQuantity == null && row.salesAmount == null
  ));
  if (!rows.length || emptyAggregate) {
    const coverage = await db.all<{ count: unknown }>(sql`SELECT COUNT(*) AS count FROM ${effectiveSalesSource} WHERE ${monthConditions(
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

  const scopeNames = new Map((await directory.stores()).map((item) => [item.id, item.name]));
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

export async function queryReportPayout(
  db: Database,
  query: ReportPayoutQuery,
  directory: ReportScopeDirectory = createReportScopeDirectory(db),
): Promise<ReportPayoutQueryResult | null> {
  const { ids, scope } = await scopeIdsForQuery(db, query, directory);
  if (!ids.length) return null;
  const effectivePayoutSource = await hasTable(db, "report_payout_daily") ? EFFECTIVE_PAYOUT_SOURCE : TARGET_EFFECTIVE_PAYOUT_SOURCE;
  const groups = selectedPayoutGroups(query.groupBy?.length ? query.groupBy : ["day"]);
  const dimensions = groups.map((group) => PAYOUT_GROUPS[group]);
  const conditions = queryConditions(EFFECTIVE_PAYOUT_COLUMNS.businessDate, EFFECTIVE_PAYOUT_COLUMNS.scopeId, query.range, ids);
  const selected = [
    ...dimensions.map((item) => sql`${item.expression} AS ${sql.raw(item.alias)}`),
    sql`SUM(${EFFECTIVE_PAYOUT_COLUMNS.payoutAmount}) AS payoutAmount`,
  ];
  const grouped = dimensions.length ? sql` GROUP BY ${sql.join(dimensions.map((item) => item.expression), sql`, `)}` : sql``;
  const order = dimensions.length ? sql` ORDER BY ${sql.join(dimensions.map((item) => item.expression), sql`, `)}` : sql``;
  const rows = await db.all<Record<string, unknown>>(sql`SELECT ${sql.join(selected, sql`, `)} FROM ${effectivePayoutSource} WHERE ${conditions}${grouped}${order}`);
  if (!rows.length || (dimensions.length === 0 && rows.every((row) => row.payoutAmount == null))) return null;
  const scopeNames = new Map((await directory.stores()).map((item) => [item.id, item.name]));
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
