import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  reportPayoutDaily,
  reportSalesMonthly,
  reportScopes,
  type NewReportPayoutDaily,
  type NewReportSalesMonthly,
  type ReportScope,
  type ReportScopeKind,
} from "./schema/reports.js";

export type { ReportScopeKind } from "./schema/reports.js";

export type ReportGroupBy = "day" | "month" | "scope" | "sku" | "category";

export interface ReportRange {
  period: string;
  startDate: string;
  endDate: string;
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
    return { period: start.slice(0, 7) === end.slice(0, 7) ? start.slice(0, 7) : `${start}~${end}`, startDate: start, endDate: end };
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

export async function listReportScopes(db: Database, scopeKind?: ReportScopeKind): Promise<ReportScope[]> {
  return db.select().from(reportScopes)
    .where(and(eq(reportScopes.active, 1), scopeKind ? eq(reportScopes.scopeKind, scopeKind) : undefined))
    .orderBy(asc(reportScopes.name));
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
  target?: { scopeId: string; reportMonth: string },
): Promise<void> {
  type Statement = Parameters<Database["batch"]>[0][number];
  const months = new Map<string, { scopeId: string; reportMonth: string; rows: NewReportSalesMonthly[] }>();
  const month = (scopeId: string, reportMonth: string) => {
    const key = `${reportMonth}\u0000${scopeId}`;
    const existing = months.get(key);
    if (existing) return existing;
    const created = { scopeId, reportMonth, rows: [] as NewReportSalesMonthly[] };
    months.set(key, created);
    return created;
  };
  for (const row of rows) month(row.scopeId, row.reportMonth).rows.push(row);
  if (target) month(target.scopeId, target.reportMonth);

  // 每月一組：該月的 delete 與它自己的 insert 綁在一起，一組不跨 db.batch()。batch 是
  // 一個 transaction，把組切開的話中途失敗會留下「刪掉了但沒寫回去」的空洞。一組本身就超過上限時讓它獨佔一批。
  const groups: Statement[][] = [];
  for (const entry of months.values()) {
    const group: Statement[] = [db.delete(reportSalesMonthly).where(and(
      eq(reportSalesMonthly.scopeId, entry.scopeId),
      eq(reportSalesMonthly.reportMonth, entry.reportMonth),
    ))];
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

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

type SalesGroupBy = Exclude<ReportGroupBy, "day">;

const SALES_GROUPS: Record<SalesGroupBy, { alias: string; expression: ReturnType<typeof sql> }> = {
  month: { alias: "reportMonth", expression: sql`${reportSalesMonthly.reportMonth}` },
  scope: { alias: "scopeId", expression: sql`${reportSalesMonthly.scopeId}` },
  sku: { alias: "sku", expression: sql`${reportSalesMonthly.sku}` },
  category: { alias: "category", expression: sql`${reportSalesMonthly.category}` },
};

type PayoutGroupBy = "day" | "month" | "scope";

const PAYOUT_GROUPS: Record<PayoutGroupBy, { alias: string; expression: ReturnType<typeof sql> }> = {
  day: { alias: "businessDate", expression: sql`${reportPayoutDaily.businessDate}` },
  month: { alias: "reportMonth", expression: sql`substr(${reportPayoutDaily.businessDate}, 1, 7)` },
  scope: { alias: "scopeId", expression: sql`${reportPayoutDaily.scopeId}` },
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

async function scopeIdsForQuery(db: Database, query: { scopeType: ReportScopeKind; scopeId?: string; scopeName?: string }): Promise<{ ids: string[]; scope?: ReportScope }> {
  if (query.scopeType === "store") {
    const scope = await findReportScope(db, { scopeKind: "store", id: query.scopeId, name: query.scopeName });
    return scope ? { ids: [scope.id], scope } : { ids: [] };
  }
  return {
    ids: (await listReportScopes(db, "store")).map((scope) => scope.id),
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
  const filters = [
    monthConditions(sql`${reportSalesMonthly.reportMonth}`, sql`${reportSalesMonthly.scopeId}`, query.range, ids),
    ...(query.sku ? [sql`lower(${reportSalesMonthly.sku}) = lower(${query.sku})`] : []),
    ...(query.category ? [sql`lower(${reportSalesMonthly.category}) = lower(${query.category})`] : []),
    ...(query.productName ? [sql`lower(${reportSalesMonthly.productName}) LIKE lower(${`%${query.productName}%`})`] : []),
  ];
  const selected = [
    ...dimensions.map((item) => sql`${item.expression} AS ${sql.raw(item.alias)}`),
    sql`SUM(${reportSalesMonthly.grossQuantity}) AS grossQuantity`,
    sql`SUM(${reportSalesMonthly.returnQuantity}) AS returnQuantity`,
    sql`SUM(${reportSalesMonthly.netQuantity}) AS netQuantity`,
    sql`SUM(${reportSalesMonthly.salesAmount}) AS salesAmount`,
  ];
  const grouped = dimensions.length ? sql` GROUP BY ${sql.join(dimensions.map((item) => item.expression), sql`, `)}` : sql``;
  const order = dimensions.length ? sql` ORDER BY ${sql.join(dimensions.map((item) => item.expression), sql`, `)}` : sql``;
  const rows = await db.all<Record<string, unknown>>(sql`SELECT ${sql.join(selected, sql`, `)} FROM ${reportSalesMonthly} WHERE ${sql.join(filters, sql` AND `)}${grouped}${order}`);
  const emptyAggregate = rows.length > 0 && rows.every((row) => (
    row.grossQuantity == null && row.returnQuantity == null && row.netQuantity == null && row.salesAmount == null
  ));
  if (!rows.length || emptyAggregate) {
    const coverage = await db.all<{ count: unknown }>(sql`SELECT COUNT(*) AS count FROM ${reportSalesMonthly} WHERE ${monthConditions(
      sql`${reportSalesMonthly.reportMonth}`,
      sql`${reportSalesMonthly.scopeId}`,
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
  const conditions = queryConditions(sql`${reportPayoutDaily.businessDate}`, sql`${reportPayoutDaily.scopeId}`, query.range, ids);
  const selected = [
    ...dimensions.map((item) => sql`${item.expression} AS ${sql.raw(item.alias)}`),
    sql`SUM(${reportPayoutDaily.payoutAmount}) AS payoutAmount`,
  ];
  const grouped = dimensions.length ? sql` GROUP BY ${sql.join(dimensions.map((item) => item.expression), sql`, `)}` : sql``;
  const order = dimensions.length ? sql` ORDER BY ${sql.join(dimensions.map((item) => item.expression), sql`, `)}` : sql``;
  const rows = await db.all<Record<string, unknown>>(sql`SELECT ${sql.join(selected, sql`, `)} FROM ${reportPayoutDaily} WHERE ${conditions}${grouped}${order}`);
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
