import { Alert, ButtonLink } from "../../../ui/index.js";
import {
  ANALYTICS_CHART_GRID,
  AnalyticsEmptyPanel,
  AnalyticsKpi,
  AnalyticsKpiGrid,
  AnalyticsRefreshing,
  AnalyticsResultHeading,
} from "./charts/ChartPrimitives.js";
import { PayoutTrendChart } from "./charts/PayoutTrendChart.js";
import { ScopeBreakdownChart } from "./charts/ScopeBreakdownChart.js";
import { ReportApiError, usePayoutSummary, type AnalyticsQuery } from "./api.js";

interface PayoutTabProps {
  query: AnalyticsQuery;
  scopeLabel: string;
  enabled: boolean;
}

function formatCurrency(value: number): string {
  return `NT$${value.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}`;
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toLocaleString("zh-TW", { maximumFractionDigits: 1 })}%`;
}

function formatDate(value: string): string {
  const [year = "", month = "", day = ""] = value.split("-");
  return `${year}/${month}/${day}`;
}

function growthHint(label: string, value: number | null, comparison: { total: number } | null): string {
  if (comparison === null) return `${label}無資料，無法計算成長率`;
  if (comparison.total === 0) return `${label}為 0，無法作為成長率分母`;
  if (value === null) return `${label}無法計算成長率`;
  return `與${label}相比：${formatPercent(value)}`;
}

export function PayoutTab({ query, scopeLabel, enabled }: PayoutTabProps) {
  const result = usePayoutSummary(query, enabled);

  if (!enabled) return <Alert tone="warning">請先選擇有效的完整日期區間。</Alert>;
  if (result.isPending && !result.data) return <div className="boot">載入統計中…</div>;
  if (result.error) {
    const message = result.error instanceof ReportApiError && result.error.status === 403
      ? "你沒有檢視營運統計的權限。"
      : result.error.message;
    return <Alert tone="danger">{message}</Alert>;
  }
  const summary = result.data;
  if (!summary) return <Alert tone="danger">報表沒有回傳資料。</Alert>;
  if (summary.status === "NO_DATA_FOR_RANGE") {
    return (
      <AnalyticsEmptyPanel icon="report" title={`${scopeLabel}在這段期間沒有出金資料`} message={summary.message ?? "這段期間沒有已匯入的出金資料。"}>
        <ButtonLink icon="payments" href="/tools/payout" className="mt-1">前往執行出金表</ButtonLink>
      </AnalyticsEmptyPanel>
    );
  }

  const asOf = summary.complete || !summary.asOfDate ? null : `截至 ${formatDate(summary.asOfDate)}`;
  const isAnnual = /^\d{4}$/u.test(summary.period);
  return (
    <div className="grid gap-3.5">
      <AnalyticsResultHeading eyebrow="出金脈動" title={scopeLabel} asOf={asOf} />

      <AnalyticsKpiGrid tab="payout" annual={isAnnual}>
        <AnalyticsKpi primary label="本期出金" value={formatCurrency(summary.current.total)}>
          {summary.current.start} ～ {summary.current.end}
        </AnalyticsKpi>
        {!isAnnual ? (
          <AnalyticsKpi label="MoM" value={formatPercent(summary.growth.mom)} hint={growthHint("上期", summary.growth.mom, summary.previous)} />
        ) : null}
        <AnalyticsKpi label="YoY" value={formatPercent(summary.growth.yoy)} hint={growthHint("去年同期", summary.growth.yoy, summary.lastYear)} />
        <AnalyticsKpi label="日均出金" value={summary.dailyAverage === null ? "—" : formatCurrency(summary.dailyAverage)}>
          {summary.dataDays ? `以 ${summary.dataDays} 天有資料日計算` : "沒有可計算的資料日"}
        </AnalyticsKpi>
        <AnalyticsKpi label="最高單日" value={summary.highestDay ? formatCurrency(summary.highestDay.value) : "—"}>
          {summary.highestDay ? formatDate(summary.highestDay.date) : "沒有可顯示的日期"}
        </AnalyticsKpi>
      </AnalyticsKpiGrid>

      {result.isFetching ? <AnalyticsRefreshing /> : null}

      <div className={ANALYTICS_CHART_GRID}>
        <PayoutTrendChart
          current={summary.current}
          lastYear={summary.lastYear}
          granularity={summary.granularity}
          valueFormatter={formatCurrency}
        />
        <ScopeBreakdownChart breakdown={summary.breakdown} valueFormatter={formatCurrency} />
      </div>
    </div>
  );
}
