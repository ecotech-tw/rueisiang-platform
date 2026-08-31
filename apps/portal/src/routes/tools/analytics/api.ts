import { keepPreviousData, useQuery } from "@tanstack/react-query";

export interface ReportScopeOption {
  id: string;
  name: string;
  latestSalesPeriod: string | null;
}

export interface ReportScopesResponse {
  latestSalesPeriod: string | null;
  scopes: ReportScopeOption[];
}

export type AnalyticsGranularity = "day" | "month" | "year";

export interface AnalyticsPoint {
  key: string;
  value: number;
}

export interface AnalyticsRange {
  start: string;
  end: string;
  total: number;
  points: AnalyticsPoint[];
}

export interface ReportGrowth {
  mom: number | null;
  yoy: number | null;
}

export interface PayoutBreakdown {
  scopeId: string;
  scopeName: string;
  channel: string;
  value: number;
  share: number;
  yoy: number | null;
}

export interface PayoutSummary {
  status: "ok" | "NO_DATA_FOR_RANGE";
  period: string;
  granularity: AnalyticsGranularity;
  complete: boolean;
  asOfDate?: string;
  current: AnalyticsRange;
  previous: AnalyticsRange | null;
  lastYear: AnalyticsRange | null;
  growth: ReportGrowth;
  dailyAverage: number | null;
  dataDays: number;
  highestDay: { date: string; value: number } | null;
  breakdown: PayoutBreakdown[];
  message?: string;
}

export type SalesTopSkuMetric = "salesAmount" | "netQuantity";

export interface SalesBreakdown {
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

export interface SalesCategoryBreakdown {
  category: string;
  value: number;
  share: number;
  quantityShare: number;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
}

export interface SalesSkuBreakdown {
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

export interface SalesSummary {
  status: "ok" | "NO_DATA_FOR_RANGE" | "UNSUPPORTED_GRANULARITY";
  period: string;
  granularity: AnalyticsGranularity;
  complete: boolean;
  asOfDate?: string;
  current: AnalyticsRange;
  trend: AnalyticsRange | null;
  previous: AnalyticsRange | null;
  lastYear: AnalyticsRange | null;
  currentQuantity: AnalyticsRange;
  trendQuantity: AnalyticsRange | null;
  previousQuantity: AnalyticsRange | null;
  lastYearQuantity: AnalyticsRange | null;
  growth: ReportGrowth;
  quantityGrowth: ReportGrowth;
  salesAmount: number;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  returnRate: number | null;
  skuCount: number;
  breakdown: SalesBreakdown[];
  byCategory: SalesCategoryBreakdown[];
  byTopSku: SalesSkuBreakdown[];
  topSkuBy: SalesTopSkuMetric;
  message?: string;
}

export interface AnalyticsQuery {
  scopeType: "company" | "store";
  scopeId?: string;
  period?: string;
  startDate?: string;
  endDate?: string;
  productQuery?: string;
  topSkuBy?: SalesTopSkuMetric;
}

export class ReportApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ReportApiError";
    this.status = status;
  }
}

async function call<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ReportApiError(response.status, body?.error ?? `讀取報表失敗（${response.status}）。`);
  }
  return (await response.json()) as T;
}

function queryString(query: AnalyticsQuery): string {
  const params = new URLSearchParams({ scopeType: query.scopeType });
  if (query.scopeId) params.set("scopeId", query.scopeId);
  if (query.period) params.set("period", query.period);
  if (query.startDate) params.set("startDate", query.startDate);
  if (query.endDate) params.set("endDate", query.endDate);
  if (query.productQuery) params.set("product", query.productQuery);
  if (query.topSkuBy) params.set("topSkuBy", query.topSkuBy);
  return params.toString();
}

export function useReportScopes() {
  return useQuery({
    queryKey: ["reports", "analytics", "scopes"],
    queryFn: () => call<ReportScopesResponse>("/api/reports/cyberbiz/scopes"),
    staleTime: 5 * 60 * 1000,
  });
}

export function usePayoutSummary(query: AnalyticsQuery, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["reports", "analytics", "summary", "payout", query],
    queryFn: () => call<PayoutSummary>(`/api/reports/cyberbiz/summary/payout?${queryString(query)}`),
    placeholderData: keepPreviousData,
  });
}

export function useSalesSummary(query: AnalyticsQuery, topSkuBy: SalesTopSkuMetric, enabled: boolean) {
  const requestQuery = { ...query, topSkuBy };
  return useQuery({
    enabled,
    queryKey: ["reports", "analytics", "summary", "sales", query, topSkuBy],
    queryFn: () => call<SalesSummary>(`/api/reports/cyberbiz/summary/sales?${queryString(requestQuery)}`),
    placeholderData: keepPreviousData,
  });
}
