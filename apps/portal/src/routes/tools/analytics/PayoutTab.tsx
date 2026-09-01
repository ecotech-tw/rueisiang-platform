import { Icon } from "../../../shell/icons.js";
import { Alert, Panel } from "../../../ui/index.js";
import { AnalyticsKpiValue } from "./charts/ChartPrimitives.js";
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
      <Panel className="analytics-empty-panel">
        <span className="analytics-empty-icon"><Icon name="report" /></span>
        <h2>{scopeLabel}在這段期間沒有出金資料</h2>
        <p>{summary.message ?? "這段期間沒有已匯入的出金資料。"}</p>
        <a className="primary-button with-icon" href="/tools/payout">
          <Icon name="payments" />
          前往執行出金表
        </a>
      </Panel>
    );
  }

  const asOf = summary.complete || !summary.asOfDate ? null : `截至 ${formatDate(summary.asOfDate)}`;
  const isAnnual = /^\d{4}$/u.test(summary.period);
  return (
    <div className="analytics-results">
      <div className="analytics-result-heading">
        <div>
          <p className="analytics-eyebrow">出金脈動</p>
          <h2>{scopeLabel}</h2>
        </div>
        <div className="analytics-result-meta">
          {asOf ? <span className="analytics-as-of">{asOf}</span> : null}
          <span>僅計入啟用中的店別</span>
        </div>
      </div>

      <div className={isAnnual ? "analytics-kpi-grid annual" : "analytics-kpi-grid"}>
        <article className="analytics-kpi analytics-kpi-primary">
          <span>本期出金</span>
          <AnalyticsKpiValue>{formatCurrency(summary.current.total)}</AnalyticsKpiValue>
          <small>{summary.current.start} ～ {summary.current.end}</small>
        </article>
        {!isAnnual ? (
          <article className="analytics-kpi">
            <span>MoM</span>
            <AnalyticsKpiValue>{formatPercent(summary.growth.mom)}</AnalyticsKpiValue>
            <small title={growthHint("上期", summary.growth.mom, summary.previous)}>{growthHint("上期", summary.growth.mom, summary.previous)}</small>
          </article>
        ) : null}
        <article className="analytics-kpi">
          <span>YoY</span>
          <AnalyticsKpiValue>{formatPercent(summary.growth.yoy)}</AnalyticsKpiValue>
          <small title={growthHint("去年同期", summary.growth.yoy, summary.lastYear)}>{growthHint("去年同期", summary.growth.yoy, summary.lastYear)}</small>
        </article>
        <article className="analytics-kpi">
          <span>日均出金</span>
          <AnalyticsKpiValue>{summary.dailyAverage === null ? "—" : formatCurrency(summary.dailyAverage)}</AnalyticsKpiValue>
          <small>{summary.dataDays ? `以 ${summary.dataDays} 天有資料日計算` : "沒有可計算的資料日"}</small>
        </article>
        <article className="analytics-kpi">
          <span>最高單日</span>
          <AnalyticsKpiValue>{summary.highestDay ? formatCurrency(summary.highestDay.value) : "—"}</AnalyticsKpiValue>
          <small>{summary.highestDay ? formatDate(summary.highestDay.date) : "沒有可顯示的日期"}</small>
        </article>
      </div>

      {result.isFetching ? <p className="analytics-refreshing" role="status">正在更新統計…</p> : null}

      <div className="analytics-chart-grid">
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
