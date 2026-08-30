import { keepPreviousData, useQuery } from "@tanstack/react-query";

export interface ReportScopeOption {
  id: string;
  name: string;
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

export interface AnalyticsQuery {
  scopeType: "company" | "store";
  scopeId?: string;
  period?: string;
  startDate?: string;
  endDate?: string;
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
  return params.toString();
}

export function useReportScopes() {
  return useQuery({
    queryKey: ["reports", "cyberbiz", "scopes"],
    queryFn: () => call<{ scopes: ReportScopeOption[] }>("/api/reports/cyberbiz/scopes"),
    staleTime: 5 * 60 * 1000,
  });
}

export function usePayoutSummary(query: AnalyticsQuery, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["reports", "cyberbiz", "summary", "payout", query],
    queryFn: () => call<PayoutSummary>(`/api/reports/cyberbiz/summary/payout?${queryString(query)}`),
    placeholderData: keepPreviousData,
  });
}
