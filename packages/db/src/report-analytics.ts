import type { Database } from "./client.js";
import { reportDataChannel } from "./product-sku-mappings.js";
import {
  queryReportPayout,
  queryReportSales,
  type ReportPayoutQueryResult,
  type ReportRange,
  type ReportScopeKind,
  type ReportSalesQueryResult,
} from "./report-data.js";

export type AnalyticsGranularity = "day" | "month" | "year";
export type SalesTopSkuMetric = "salesAmount" | "netQuantity";

export interface ReportAnalyticsQuery {
  range: ReportRange;
  scopeType: ReportScopeKind;
  scopeId?: string;
  scopeName?: string;
  productQuery?: string;
  /** 只供測試固定「今天」；HTTP consumer 不需要傳這個值。 */
  today?: string;
  topSkuBy?: SalesTopSkuMetric;
}

export interface ReportAnalyticsPoint {
  key: string;
  value: number;
}

export interface ReportAnalyticsRange {
  start: string;
  end: string;
  total: number;
  points: ReportAnalyticsPoint[];
}

export interface ReportComparisonRanges {
  current: ReportRange;
  previous: ReportRange;
  lastYear: ReportRange;
  granularity: AnalyticsGranularity;
  complete: boolean;
  asOfDate?: string;
}

export interface ReportGrowth {
  mom: number | null;
  yoy: number | null;
}

export interface ReportPayoutBreakdown {
  scopeId: string;
  scopeName: string;
  channel: string;
  value: number;
  share: number;
  yoy: number | null;
}

export interface ReportPayoutSummary {
  status: "ok" | "NO_DATA_FOR_RANGE";
  period: string;
  granularity: AnalyticsGranularity;
  complete: boolean;
  asOfDate?: string;
  current: ReportAnalyticsRange;
  previous: ReportAnalyticsRange | null;
  lastYear: ReportAnalyticsRange | null;
  growth: ReportGrowth;
  dailyAverage: number | null;
  dataDays: number;
  highestDay: { date: string; value: number } | null;
  breakdown: ReportPayoutBreakdown[];
  message?: string;
}

export interface ReportSalesBreakdown {
  scopeId: string;
  scopeName: string;
  channel: string;
  value: number;
  share: number;
  quantityShare: number;
  yoy: number | null;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
}

export interface ReportSalesCategoryBreakdown {
  category: string;
  value: number;
  share: number;
  quantityShare: number;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
}

export interface ReportSalesSkuBreakdown {
  sku: string;
  productName: string;
  value: number;
  salesAmount: number;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  share: number;
  quantityShare: number;
  isOther?: boolean;
}

export interface ReportSalesSummary {
  status: "ok" | "NO_DATA_FOR_RANGE" | "UNSUPPORTED_GRANULARITY";
  period: string;
  granularity: AnalyticsGranularity;
  complete: boolean;
  asOfDate?: string;
  current: ReportAnalyticsRange;
  trend: ReportAnalyticsRange | null;
  previous: ReportAnalyticsRange | null;
  lastYear: ReportAnalyticsRange | null;
  currentQuantity: ReportAnalyticsRange;
  trendQuantity: ReportAnalyticsRange | null;
  previousQuantity: ReportAnalyticsRange | null;
  lastYearQuantity: ReportAnalyticsRange | null;
  growth: ReportGrowth;
  quantityGrowth: ReportGrowth;
  salesAmount: number;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  returnRate: number | null;
  skuCount: number;
  breakdown: ReportSalesBreakdown[];
  byCategory: ReportSalesCategoryBreakdown[];
  bySku: ReportSalesSkuBreakdown[];
  byTopSku: ReportSalesSkuBreakdown[];
  topSkuBy: SalesTopSkuMetric;
  message?: string;
}

interface DateRangeParts {
  year: number;
  month: number;
  day: number;
}

interface ReportPayoutDay {
  date: string;
  value: number;
}

interface ReportSalesMonth {
  month: string;
  salesAmount: number;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MONTH_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u;
const YEAR_PERIOD_PATTERN = /^\d{4}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 報表日期是台北營業日，但 Worker 的時鐘是 UTC；不在這裡轉換的話，台灣凌晨
 * 的查詢會提前切到下一天，出金頁就會短少最後一筆資料。
 */
function todayInTaipei(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseDate(value: string): DateRangeParts {
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  return { year, month, day };
}

function toUtcDate(value: string): Date {
  const parts = parseDate(value);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = toUtcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthEnd(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
}

function monthIndex(value: string): number {
  const parts = parseDate(value);
  return parts.year * 12 + parts.month - 1;
}

function addMonthsClamped(value: string, months: number): string {
  const parts = parseDate(value);
  const target = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1));
  const year = target.getUTCFullYear();
  const month = target.getUTCMonth() + 1;
  const day = Math.min(parts.day, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addYearsClamped(value: string, years: number): string {
  return addMonthsClamped(value, years * 12);
}

function daysBetween(start: string, end: string): number {
  if (start > end) return 0;
  return Math.floor((toUtcDate(end).getTime() - toUtcDate(start).getTime()) / DAY_MS) + 1;
}

function earlierDate(left: string, right: string): string {
  return left < right ? left : right;
}

function reportRange(period: string, startDate: string, endDate: string, isCustom = false): ReportRange {
  return { period, startDate, endDate, ...(isCustom ? { isCustom: true } : {}) };
}

function periodKind(range: ReportRange): "month" | "year" | "custom" {
  if (range.isCustom) return "custom";
  if (MONTH_PERIOD_PATTERN.test(range.period)) return "month";
  if (YEAR_PERIOD_PATTERN.test(range.period)) return "year";
  return "custom";
}

function sameMonth(start: string, end: string): boolean {
  return start.slice(0, 7) === end.slice(0, 7);
}

function sameYear(start: string, end: string): boolean {
  return start.slice(0, 4) === end.slice(0, 4);
}

function isWholeMonthRange(range: ReportRange): boolean {
  if (!range.startDate.endsWith("-01")) return false;
  const parts = parseDate(range.endDate);
  return range.endDate === monthEnd(parts.year, parts.month);
}

function calendarMonthRange(start: string, offset: number, count: number): ReportRange {
  const first = addMonthsClamped(`${start.slice(0, 7)}-01`, offset);
  const startDate = `${first.slice(0, 7)}-01`;
  const last = addMonthsClamped(startDate, count - 1);
  const lastParts = parseDate(last);
  const endDate = monthEnd(lastParts.year, lastParts.month);
  return reportRange(`${startDate}~${endDate}`, startDate, endDate, true);
}

function granularityOf(range: ReportRange): AnalyticsGranularity {
  if (periodKind(range) === "month" || (periodKind(range) === "custom" && sameMonth(range.startDate, range.endDate))) {
    return "day";
  }
  if (periodKind(range) === "year" || (periodKind(range) === "custom" && sameYear(range.startDate, range.endDate))) {
    return "month";
  }
  return "year";
}

function salesGranularityOf(range: ReportRange): AnalyticsGranularity {
  if (periodKind(range) === "custom" && !sameYear(range.startDate, range.endDate)) return "year";
  return "month";
}

function salesTrendRange(range: ReportRange): ReportRange | null {
  const kind = periodKind(range);
  if (kind !== "month" && !(kind === "custom" && sameMonth(range.startDate, range.endDate))) return null;
  return calendarMonthRange(range.startDate, -12, 13);
}

function alignedEnd(start: string, days: number, maximum: string): string {
  if (days <= 0) return addDays(start, -1);
  return earlierDate(addDays(start, days - 1), maximum);
}

function completeRangeForMonth(start: string, complete: boolean, days: number): { previous: ReportRange; lastYear: ReportRange } {
  const previousStart = addMonthsClamped(start, -1).slice(0, 7) + "-01";
  const lastYearStart = addYearsClamped(start, -1).slice(0, 7) + "-01";
  const previousEnd = complete
    ? monthEnd(parseDate(previousStart).year, parseDate(previousStart).month)
    : alignedEnd(previousStart, days, monthEnd(parseDate(previousStart).year, parseDate(previousStart).month));
  const lastYearEnd = complete
    ? monthEnd(parseDate(lastYearStart).year, parseDate(lastYearStart).month)
    : alignedEnd(lastYearStart, days, monthEnd(parseDate(lastYearStart).year, parseDate(lastYearStart).month));
  return {
    previous: reportRange(previousStart.slice(0, 7), previousStart, previousEnd),
    lastYear: reportRange(lastYearStart.slice(0, 7), lastYearStart, lastYearEnd),
  };
}

/**
 * 建立比較期。未完成月份／年份不能拿整個上期比較，所以用本期已經過的天數序位；
 * 完整期間則保留日曆上的完整月份或年份，月底由 addMonthsClamped 負責夾住。
 *
 * 商品銷售呼叫時會關閉 clipIncomplete：月報沒有 MTD，當月就算尚未匯入也仍以
 * 完整月份查詢，讓「沒有資料」和「只查到半個月」不會混在一起。
 */
export function buildReportComparisonRanges(
  range: ReportRange,
  today = todayInTaipei(),
  clipIncomplete = true,
): ReportComparisonRanges {
  if (!DATE_PATTERN.test(today)) throw new Error("比較期的 today 必須是 YYYY-MM-DD。");
  const complete = range.endDate < today;
  const currentEnd = !complete && clipIncomplete ? earlierDate(range.endDate, today) : range.endDate;
  const current = reportRange(range.period, range.startDate, currentEnd, range.isCustom === true);
  const currentDays = daysBetween(current.startDate, current.endDate);
  const kind = periodKind(range);
  let previous: ReportRange;
  let lastYear: ReportRange;

  if (kind === "month") {
    const monthRanges = completeRangeForMonth(range.startDate, complete || !clipIncomplete, currentDays);
    previous = monthRanges.previous;
    lastYear = monthRanges.lastYear;
  } else if (kind === "year") {
    const year = parseDate(range.startDate).year;
    const previousStart = `${year - 1}-01-01`;
    const lastYearStart = `${year - 1}-01-01`;
    const previousEnd = complete || !clipIncomplete
      ? `${year - 1}-12-31`
      : alignedEnd(previousStart, currentDays, `${year - 1}-12-31`);
    const lastYearEnd = complete || !clipIncomplete
      ? `${year - 1}-12-31`
      : alignedEnd(lastYearStart, currentDays, `${year - 1}-12-31`);
    previous = reportRange(String(year - 1), previousStart, previousEnd);
    lastYear = reportRange(String(year - 1), lastYearStart, lastYearEnd);
  } else {
    const days = clipIncomplete ? currentDays : daysBetween(range.startDate, range.endDate);
    const previousStart = addDays(current.startDate, -days);
    const previousEnd = days > 0 ? addDays(previousStart, days - 1) : addDays(previousStart, -1);
    const lastYearStart = addYearsClamped(current.startDate, -1);
    const lastYearEnd = complete || !clipIncomplete
      ? addYearsClamped(current.endDate, -1)
      : days > 0 ? addDays(lastYearStart, days - 1) : addDays(lastYearStart, -1);
    previous = reportRange(`${previousStart}~${previousEnd}`, previousStart, previousEnd, true);
    lastYear = reportRange(`${lastYearStart}~${lastYearEnd}`, lastYearStart, lastYearEnd, true);
  }

  return {
    current,
    previous,
    lastYear,
    granularity: granularityOf(range),
    complete,
    ...(complete ? {} : { asOfDate: today }),
  };
}

/**
 * 商品銷售只能查完整月份；自訂日期若剛好是完整月份，前後比較也要保持月份邊界，
 * 否則 report-data 會正確地回報 UNSUPPORTED_GRANULARITY，讓一個可查的完整月份變成查不到。
 */
function buildSalesComparisonRanges(range: ReportRange, today?: string): ReportComparisonRanges {
  const comparison = buildReportComparisonRanges(range, today, false);
  if (periodKind(range) !== "custom" || !isWholeMonthRange(range)) return comparison;

  const monthCount = monthIndex(range.endDate) - monthIndex(range.startDate) + 1;
  return {
    ...comparison,
    previous: calendarMonthRange(range.startDate, -monthCount, monthCount),
    lastYear: calendarMonthRange(range.startDate, -12, monthCount),
    granularity: salesGranularityOf(range),
  };
}

export function calculateGrowth(current: number, comparison: ReportAnalyticsRange | null): number | null {
  if (!comparison || comparison.total === 0) return null;
  return (current - comparison.total) / comparison.total;
}

function numberValue(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  const result = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function stringValue(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : value == null ? undefined : String(value);
}

function payoutDays(result: ReportPayoutQueryResult | null): ReportPayoutDay[] | null {
  if (!result) return null;
  return result.rows.flatMap((row) => {
    const date = stringValue(row, "businessDate");
    return date ? [{ date, value: numberValue(row, "payoutAmount") }] : [];
  });
}

function salesMonths(result: ReportSalesQueryResult | null): ReportSalesMonth[] | null {
  if (!result) return null;
  return result.rows.flatMap((row) => {
    const month = stringValue(row, "reportMonth");
    return month ? [{
      month,
      salesAmount: numberValue(row, "salesAmount"),
      grossQuantity: numberValue(row, "grossQuantity"),
      returnQuantity: numberValue(row, "returnQuantity"),
      netQuantity: numberValue(row, "netQuantity"),
    }] : [];
  });
}

function pointKey(date: string, granularity: AnalyticsGranularity): string {
  if (granularity === "day") return date;
  if (granularity === "month") return date.slice(0, 7);
  return date.slice(0, 4);
}

function rangeFromPoints(range: ReportRange, points: readonly { key: string; value: number }[]): ReportAnalyticsRange {
  const sorted = [...points].sort((left, right) => left.key.localeCompare(right.key));
  return {
    start: range.startDate,
    end: range.endDate,
    total: sorted.reduce((total, point) => total + point.value, 0),
    points: sorted,
  };
}

function payoutRange(range: ReportRange, rows: readonly ReportPayoutDay[] | null, granularity: AnalyticsGranularity): ReportAnalyticsRange | null {
  if (!rows) return null;
  const values = new Map<string, number>();
  for (const row of rows) {
    const key = pointKey(row.date, granularity);
    values.set(key, (values.get(key) ?? 0) + row.value);
  }
  return rangeFromPoints(range, [...values].map(([key, value]) => ({ key, value })));
}

type SalesRangeMetric = "salesAmount" | "netQuantity";

function salesRange(
  range: ReportRange,
  result: ReportSalesQueryResult | null,
  granularity: AnalyticsGranularity,
  metric: SalesRangeMetric = "salesAmount",
): ReportAnalyticsRange | null {
  const rows = salesMonths(result);
  if (!rows) return null;
  const values = new Map<string, number>();
  for (const row of rows) {
    const key = granularity === "year" ? row.month.slice(0, 4) : row.month;
    values.set(key, (values.get(key) ?? 0) + row[metric]);
  }
  return rangeFromPoints(range, [...values].map(([key, value]) => ({ key, value })));
}

function reportQuery(query: ReportAnalyticsQuery, range: ReportRange) {
  return {
    range,
    scopeType: query.scopeType,
    ...(query.scopeId ? { scopeId: query.scopeId } : {}),
    ...(query.scopeName ? { scopeName: query.scopeName } : {}),
    ...(query.productQuery ? { productQuery: query.productQuery } : {}),
  };
}

async function queryPayoutDays(db: Database, query: ReportAnalyticsQuery, range: ReportRange): Promise<ReportPayoutDay[] | null> {
  return payoutDays(await queryReportPayout(db, reportQuery(query, range)));
}

async function queryPayoutScopes(db: Database, query: ReportAnalyticsQuery, range: ReportRange): Promise<ReportPayoutQueryResult | null> {
  return queryReportPayout(db, { ...reportQuery(query, range), groupBy: ["scope"] });
}

async function querySalesMonths(db: Database, query: ReportAnalyticsQuery, range: ReportRange): Promise<ReportSalesQueryResult | null> {
  return queryReportSales(db, { ...reportQuery(query, range), groupBy: ["month"] });
}

function scopeName(row: Record<string, unknown>): string {
  return stringValue(row, "scopeName") ?? stringValue(row, "scopeId") ?? "未命名店別";
}

function scopeId(row: Record<string, unknown>): string | undefined {
  return stringValue(row, "scopeId");
}

function scopeValueMap(result: ReportPayoutQueryResult | null): Map<string, number> | null {
  if (!result) return null;
  const values = new Map<string, number>();
  for (const row of result.rows) {
    const id = scopeId(row);
    if (id) values.set(id, numberValue(row, "payoutAmount"));
  }
  return values;
}

function salesScopeValueMap(result: ReportSalesQueryResult | null): Map<string, { value: number; netQuantity: number }> | null {
  if (!result) return null;
  const values = new Map<string, { value: number; netQuantity: number }>();
  for (const row of result.rows) {
    const id = scopeId(row);
    if (id) values.set(id, { value: numberValue(row, "salesAmount"), netQuantity: numberValue(row, "netQuantity") });
  }
  return values;
}

function growthForScope(value: number, scopeIdValue: string, lastYearValues: Map<string, number> | null): number | null {
  const comparison = lastYearValues?.get(scopeIdValue);
  return comparison === undefined || comparison === 0 ? null : (value - comparison) / comparison;
}

export async function queryReportPayoutSummary(db: Database, query: ReportAnalyticsQuery): Promise<ReportPayoutSummary> {
  const comparison = buildReportComparisonRanges(query.range, query.today);
  const currentDays = await queryPayoutDays(db, query, comparison.current);
  const previousDays = await queryPayoutDays(db, query, comparison.previous);
  const lastYearDays = await queryPayoutDays(db, query, comparison.lastYear);
  const current = payoutRange(comparison.current, currentDays, comparison.granularity)
    ?? rangeFromPoints(comparison.current, []);
  const previous = payoutRange(comparison.previous, previousDays, comparison.granularity);
  const lastYear = payoutRange(comparison.lastYear, lastYearDays, comparison.granularity);
  const currentScopeResult = await queryPayoutScopes(db, query, comparison.current);
  const lastYearScopeResult = await queryPayoutScopes(db, query, comparison.lastYear);
  const lastYearScopeValues = scopeValueMap(lastYearScopeResult);
  const breakdown = (currentScopeResult?.rows ?? []).flatMap((row) => {
    const id = scopeId(row);
    if (!id) return [];
    const value = numberValue(row, "payoutAmount");
    return [{
      scopeId: id,
      scopeName: scopeName(row),
      channel: reportDataChannel(id),
      value,
      share: current.total === 0 ? 0 : value / current.total,
      yoy: growthForScope(value, id, lastYearScopeValues),
    }];
  }).sort((left, right) => right.value - left.value);
  const highestDay = currentDays?.reduce<{ date: string; value: number } | null>((highest, row) => (
    highest === null || row.value > highest.value ? row : highest
  ), null) ?? null;
  const dataDays = currentDays?.length ?? 0;

  return {
    status: currentDays ? "ok" : "NO_DATA_FOR_RANGE",
    period: query.range.period,
    granularity: comparison.granularity,
    complete: comparison.complete,
    ...(comparison.asOfDate ? { asOfDate: comparison.asOfDate } : {}),
    current,
    previous,
    lastYear,
    growth: {
      mom: currentDays ? calculateGrowth(current.total, previous) : null,
      yoy: currentDays ? calculateGrowth(current.total, lastYear) : null,
    },
    dailyAverage: dataDays ? current.total / dataDays : null,
    dataDays,
    highestDay,
    breakdown,
    ...(currentDays ? {} : { message: "指定區間沒有已匯入的出金資料。請到後台執行出金表下載作業。" }),
  };
}

function salesMetrics(result: ReportSalesQueryResult | null) {
  return result?.totals ?? { grossQuantity: 0, returnQuantity: 0, netQuantity: 0, salesAmount: 0 };
}

function salesRangeFromResult(range: ReportRange, result: ReportSalesQueryResult | null, granularity: AnalyticsGranularity): ReportAnalyticsRange | null {
  return salesRange(range, result, granularity);
}

function rowMetric(row: Record<string, unknown>, metric: SalesTopSkuMetric): number {
  return numberValue(row, metric);
}

export async function queryReportSalesSummary(db: Database, query: ReportAnalyticsQuery): Promise<ReportSalesSummary> {
  const comparison = buildSalesComparisonRanges(query.range, query.today);
  const topSkuBy = query.topSkuBy ?? "salesAmount";
  const currentResult = await querySalesMonths(db, query, comparison.current);
  const currentMetrics = salesMetrics(currentResult);
  const current = salesRangeFromResult(comparison.current, currentResult, salesGranularityOf(query.range))
    ?? rangeFromPoints(comparison.current, []);
  const currentQuantity = salesRange(comparison.current, currentResult, salesGranularityOf(query.range), "netQuantity")
    ?? rangeFromPoints(comparison.current, []);
  const previousResult = currentResult?.status === "UNSUPPORTED_GRANULARITY"
    ? null
    : await querySalesMonths(db, query, comparison.previous);
  const lastYearResult = currentResult?.status === "UNSUPPORTED_GRANULARITY"
    ? null
    : await querySalesMonths(db, query, comparison.lastYear);
  const previous = salesRangeFromResult(comparison.previous, previousResult, salesGranularityOf(query.range));
  const lastYear = salesRangeFromResult(comparison.lastYear, lastYearResult, salesGranularityOf(query.range));
  const previousQuantity = salesRange(comparison.previous, previousResult, salesGranularityOf(query.range), "netQuantity");
  const lastYearQuantity = salesRange(comparison.lastYear, lastYearResult, salesGranularityOf(query.range), "netQuantity");

  if (currentResult?.status === "UNSUPPORTED_GRANULARITY") {
    return {
      status: "UNSUPPORTED_GRANULARITY",
      period: query.range.period,
      granularity: salesGranularityOf(query.range),
      complete: comparison.complete,
      ...(comparison.asOfDate ? { asOfDate: comparison.asOfDate } : {}),
      current,
      trend: null,
      previous: null,
      lastYear: null,
      currentQuantity,
      trendQuantity: null,
      previousQuantity: null,
      lastYearQuantity: null,
      growth: { mom: null, yoy: null },
      quantityGrowth: { mom: null, yoy: null },
      salesAmount: 0,
      grossQuantity: 0,
      returnQuantity: 0,
      netQuantity: 0,
      returnRate: null,
      skuCount: 0,
      breakdown: [],
      byCategory: [],
      bySku: [],
      byTopSku: [],
      topSkuBy,
      message: "商品銷售統計目前只支援完整月份查詢。",
    };
  }

  const currentScopeResult = await queryReportSales(db, { ...reportQuery(query, comparison.current), groupBy: ["scope"] });
  const lastYearScopeResult = await queryReportSales(db, { ...reportQuery(query, comparison.lastYear), groupBy: ["scope"] });
  const lastYearScopeValues = salesScopeValueMap(lastYearScopeResult);
  const breakdown = (currentScopeResult?.rows ?? []).flatMap((row) => {
    const id = scopeId(row);
    if (!id) return [];
    const value = numberValue(row, "salesAmount");
    const comparisonValue = lastYearScopeValues?.get(id)?.value;
    return [{
      scopeId: id,
      scopeName: scopeName(row),
      channel: reportDataChannel(id),
      value,
      share: currentMetrics.salesAmount === 0 ? 0 : value / currentMetrics.salesAmount,
      quantityShare: currentMetrics.netQuantity === 0 ? 0 : numberValue(row, "netQuantity") / currentMetrics.netQuantity,
      yoy: comparisonValue === undefined || comparisonValue === 0 ? null : (value - comparisonValue) / comparisonValue,
      grossQuantity: numberValue(row, "grossQuantity"),
      returnQuantity: numberValue(row, "returnQuantity"),
      netQuantity: numberValue(row, "netQuantity"),
    }];
  }).sort((left, right) => right.netQuantity - left.netQuantity);

  const categoryResult = await queryReportSales(db, { ...reportQuery(query, comparison.current), groupBy: ["category"] });
  const byCategory = (categoryResult?.rows ?? []).flatMap((row) => {
    const category = stringValue(row, "category") ?? "未分類";
    const value = numberValue(row, "salesAmount");
    return [{
      category,
      value,
      share: currentMetrics.salesAmount === 0 ? 0 : value / currentMetrics.salesAmount,
      quantityShare: currentMetrics.netQuantity === 0 ? 0 : numberValue(row, "netQuantity") / currentMetrics.netQuantity,
      grossQuantity: numberValue(row, "grossQuantity"),
      returnQuantity: numberValue(row, "returnQuantity"),
      netQuantity: numberValue(row, "netQuantity"),
    }];
  }).sort((left, right) => right.netQuantity - left.netQuantity);

  const skuResult = await queryReportSales(db, { ...reportQuery(query, comparison.current), groupBy: ["sku"] });
  const skuRows = skuResult?.rows ?? [];
  const activeSkuRows = skuRows.filter((row) => (
    numberValue(row, "grossQuantity") !== 0
    || numberValue(row, "returnQuantity") !== 0
    || numberValue(row, "netQuantity") !== 0
    || numberValue(row, "salesAmount") !== 0
  ));
  const sortedSkuRows = [...activeSkuRows].sort((left, right) => {
    const difference = rowMetric(right, topSkuBy) - rowMetric(left, topSkuBy);
    if (difference !== 0) return difference;
    return (stringValue(left, "sku") ?? "").localeCompare(stringValue(right, "sku") ?? "");
  });
  const bySku: ReportSalesSkuBreakdown[] = sortedSkuRows.map((row) => {
    const salesAmount = numberValue(row, "salesAmount");
    const netQuantity = numberValue(row, "netQuantity");
    return {
      sku: stringValue(row, "sku") ?? "",
      productName: stringValue(row, "productName") ?? "未命名商品",
      value: topSkuBy === "salesAmount" ? salesAmount : netQuantity,
      salesAmount,
      grossQuantity: numberValue(row, "grossQuantity"),
      returnQuantity: numberValue(row, "returnQuantity"),
      netQuantity,
      share: currentMetrics.salesAmount === 0 ? 0 : salesAmount / currentMetrics.salesAmount,
      quantityShare: currentMetrics.netQuantity === 0 ? 0 : netQuantity / currentMetrics.netQuantity,
    };
  });
  const topSku = bySku.slice(0, 10);
  const remainingSkuRows = bySku.slice(10);
  if (remainingSkuRows.length) {
    const other = remainingSkuRows.reduce<{ salesAmount: number; grossQuantity: number; returnQuantity: number; netQuantity: number }>((summary, row) => ({
      salesAmount: summary.salesAmount + row.salesAmount,
      grossQuantity: summary.grossQuantity + row.grossQuantity,
      returnQuantity: summary.returnQuantity + row.returnQuantity,
      netQuantity: summary.netQuantity + row.netQuantity,
    }), { salesAmount: 0, grossQuantity: 0, returnQuantity: 0, netQuantity: 0 });
    topSku.push({
      sku: "__other__",
      productName: "其他",
      value: topSkuBy === "salesAmount" ? other.salesAmount : other.netQuantity,
      ...other,
      share: currentMetrics.salesAmount === 0 ? 0 : other.salesAmount / currentMetrics.salesAmount,
      quantityShare: currentMetrics.netQuantity === 0 ? 0 : other.netQuantity / currentMetrics.netQuantity,
      isOther: true,
    });
  }

  const returnRate = currentMetrics.grossQuantity === 0 ? null : currentMetrics.returnQuantity / currentMetrics.grossQuantity;
  const skuCount = activeSkuRows.length;
  const trendRange = salesTrendRange(query.range);
  const trendResult = trendRange && currentResult
    ? await querySalesMonths(db, query, trendRange)
    : null;
  const trend = currentResult
    ? trendRange
      ? salesRange(trendRange, trendResult, "month") ?? rangeFromPoints(trendRange, [])
      : current
    : null;
  const trendQuantity = currentResult
    ? trendRange
      ? salesRange(trendRange, trendResult, "month", "netQuantity") ?? rangeFromPoints(trendRange, [])
      : currentQuantity
    : null;
  const hasCurrentData = Boolean(currentResult?.rows.length);
  return {
    status: hasCurrentData ? "ok" : "NO_DATA_FOR_RANGE",
    period: query.range.period,
    granularity: salesGranularityOf(query.range),
    complete: comparison.complete,
    ...(comparison.asOfDate ? { asOfDate: comparison.asOfDate } : {}),
    current,
    trend,
    previous,
    lastYear,
    currentQuantity,
    trendQuantity,
    previousQuantity,
    lastYearQuantity,
    growth: {
      mom: hasCurrentData ? calculateGrowth(currentMetrics.salesAmount, previous) : null,
      yoy: hasCurrentData ? calculateGrowth(currentMetrics.salesAmount, lastYear) : null,
    },
    quantityGrowth: {
      mom: hasCurrentData ? calculateGrowth(currentMetrics.netQuantity, previousQuantity) : null,
      yoy: hasCurrentData ? calculateGrowth(currentMetrics.netQuantity, lastYearQuantity) : null,
    },
    salesAmount: currentMetrics.salesAmount,
    grossQuantity: currentMetrics.grossQuantity,
    returnQuantity: currentMetrics.returnQuantity,
    netQuantity: currentMetrics.netQuantity,
    returnRate,
    skuCount,
    breakdown,
    byCategory,
    bySku,
    byTopSku: topSku,
    topSkuBy,
    ...(hasCurrentData
      ? {}
      : { message: currentResult?.message ?? "指定區間沒有已匯入的商品銷售資料。請到後台執行商品銷售報表下載作業。" }),
  };
}
