import { useState } from "react";
import { Icon } from "../../../shell/icons.js";
import { Alert, Panel } from "../../../ui/index.js";
import { CategoryBreakdownChart } from "./charts/CategoryBreakdownChart.js";
import { ChannelBreakdownChart } from "./charts/ChannelBreakdownChart.js";
import { SalesTrendChart } from "./charts/SalesTrendChart.js";
import { TopSkuChart } from "./charts/TopSkuChart.js";
import {
  ReportApiError,
  useSalesSummary,
  type AnalyticsQuery,
  type SalesTopSkuMetric,
} from "./api.js";

interface SalesTabProps {
  query: AnalyticsQuery;
  scopeLabel: string;
  enabled: boolean;
}

function formatCurrency(value: number): string {
  return `NT$${value.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}`;
}

function formatQuantity(value: number): string {
  return value.toLocaleString("zh-TW", { maximumFractionDigits: 0 });
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toLocaleString("zh-TW", { maximumFractionDigits: 1 })}%`;
}

function formatRate(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toLocaleString("zh-TW", { maximumFractionDigits: 1 })}%`;
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

export function SalesTab({ query, scopeLabel, enabled }: SalesTabProps) {
  const [topSkuBy, setTopSkuBy] = useState<SalesTopSkuMetric>("salesAmount");
  const result = useSalesSummary(query, topSkuBy, enabled);

  if (!enabled) return <Alert tone="warning">請先選擇有效的完整日期區間。</Alert>;
  if (result.isPending && !result.data) return <div className="boot">載入商品銷售統計中…</div>;
  if (result.error) {
    const message = result.error instanceof ReportApiError && result.error.status === 403
      ? "你沒有檢視營運統計的權限。"
      : result.error.message;
    return <Alert tone="danger">{message}</Alert>;
  }

  const summary = result.data;
  if (!summary) return <Alert tone="danger">報表沒有回傳資料。</Alert>;
  if (summary.status === "UNSUPPORTED_GRANULARITY") {
    return (
      <Panel className="analytics-empty-panel">
        <span className="analytics-empty-icon"><Icon name="analytics" /></span>
        <h2>商品銷售只支援完整月份</h2>
        <p>{summary.message ?? "請改用 YYYY-MM、YYYY 或完整月份的自訂日期區間。"}</p>
        <p className="muted">商品銷售資料是按月匯入，無法用不完整月份計算。</p>
      </Panel>
    );
  }
  if (summary.status === "NO_DATA_FOR_RANGE") {
    return (
      <Panel className="analytics-empty-panel">
        <span className="analytics-empty-icon"><Icon name="analytics" /></span>
        <h2>{scopeLabel}在這段期間沒有商品銷售資料</h2>
        <p>{summary.message ?? "這段期間沒有已匯入的商品銷售資料。"}</p>
        <a className="primary-button with-icon" href="/tools/cyberbiz-sales">
          <Icon name="report" />
          前往執行商品銷售報表
        </a>
      </Panel>
    );
  }

  const isAnnual = /^\d{4}$/u.test(summary.period);
  const asOf = summary.complete || !summary.asOfDate ? null : `截至 ${formatDate(summary.asOfDate)}`;
  return (
    <div className="analytics-results">
      <div className="analytics-result-heading">
        <div>
          <p className="analytics-eyebrow">商品銷售脈動</p>
          <h2>{scopeLabel}</h2>
        </div>
        <div className="analytics-result-meta">
          {asOf ? <span className="analytics-as-of">{asOf}</span> : null}
          <span>僅計入啟用中的店別</span>
        </div>
      </div>

      <div className={`analytics-kpi-grid analytics-sales-kpi-grid${isAnnual ? " annual" : ""}`}>
        <article className="analytics-kpi analytics-kpi-primary">
          <span>本期售額</span>
          <strong>{formatCurrency(summary.salesAmount)}</strong>
          <small>{summary.current.start} ～ {summary.current.end}</small>
        </article>
        {!isAnnual ? (
          <article className="analytics-kpi">
            <span>MoM</span>
            <strong>{formatPercent(summary.growth.mom)}</strong>
            <small title={growthHint("上期", summary.growth.mom, summary.previous)}>{growthHint("上期", summary.growth.mom, summary.previous)}</small>
          </article>
        ) : null}
        <article className="analytics-kpi">
          <span>YoY</span>
          <strong>{formatPercent(summary.growth.yoy)}</strong>
          <small title={growthHint("去年同期", summary.growth.yoy, summary.lastYear)}>{growthHint("去年同期", summary.growth.yoy, summary.lastYear)}</small>
        </article>
        <article className="analytics-kpi">
          <span>淨銷量</span>
          <strong>{formatQuantity(summary.netQuantity)}</strong>
          <small>毛銷量 {formatQuantity(summary.grossQuantity)}，退貨 {formatQuantity(summary.returnQuantity)}</small>
        </article>
        <article className="analytics-kpi">
          <span>退貨率</span>
          <strong>{formatRate(summary.returnRate)}</strong>
          <small>退貨量 ÷ 毛銷量</small>
        </article>
        <article className="analytics-kpi">
          <span>有銷售 SKU</span>
          <strong>{formatQuantity(summary.skuCount)}</strong>
          <small>本期有交易的商品</small>
        </article>
      </div>

      {result.isFetching ? <p className="analytics-refreshing" role="status">正在更新統計…</p> : null}

      <div className="analytics-chart-grid analytics-sales-chart-grid">
        <SalesTrendChart
          current={summary.current}
          trend={summary.trend}
          lastYear={summary.lastYear}
          granularity={summary.granularity}
          valueFormatter={formatCurrency}
        />
        <CategoryBreakdownChart breakdown={summary.byCategory} valueFormatter={formatCurrency} quantityFormatter={formatQuantity} />
        <TopSkuChart
          rows={summary.byTopSku}
          metric={topSkuBy}
          onMetricChange={setTopSkuBy}
          valueFormatter={formatCurrency}
          quantityFormatter={formatQuantity}
        />
        <ChannelBreakdownChart breakdown={summary.breakdown} valueFormatter={formatCurrency} quantityFormatter={formatQuantity} />
      </div>
    </div>
  );
}
