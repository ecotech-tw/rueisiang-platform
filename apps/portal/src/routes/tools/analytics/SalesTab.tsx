import { useState } from "react";
import { Icon } from "../../../shell/icons.js";
import { Alert, Button, Panel } from "../../../ui/index.js";
import { CategoryBreakdownChart } from "./charts/CategoryBreakdownChart.js";
import { ChannelBreakdownChart } from "./charts/ChannelBreakdownChart.js";
import { SalesTrendChart } from "./charts/SalesTrendChart.js";
import { AnalyticsKpiHint, AnalyticsKpiValue } from "./charts/ChartPrimitives.js";
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
  productQuery: string;
  /**
   * 還在 debounce、尚未送進 URL 的商品關鍵字；沒有待送出的關鍵字時是 null。
   * 那半秒也要遮住圖表，不然畫面看起來像沒反應，而且提示要寫使用者正在打的字，
   * 不是上一次套用的 productQuery。
   */
  pendingProduct: string | null;
  onClearProduct: () => void;
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

type SalesImporterKey = "cyberbiz" | "shopee";

const SALES_IMPORTERS: Record<SalesImporterKey, { href: string; label: string; icon: "report" | "shoppingBag" }> = {
  cyberbiz: { href: "/tools/cyberbiz-sales", label: "前往執行商品銷售報表", icon: "report" },
  shopee: { href: "/tools/shopee-sales", label: "前往執行蝦皮銷售報表", icon: "shoppingBag" },
};

function importerKeys(query: AnalyticsQuery): SalesImporterKey[] {
  const scopeId = query.scopeId?.toLowerCase() ?? "";
  if (!scopeId) return ["cyberbiz", "shopee"];
  if (scopeId.startsWith("shopee:")) return ["shopee"];
  if (scopeId.startsWith("cyberbiz:") || scopeId.startsWith("store-")) return ["cyberbiz"];
  return ["cyberbiz", "shopee"];
}

function ChartMask({ label }: { label: string }) {
  return (
    <div className="analytics-chart-mask" role="status" aria-live="polite">
      <span className="analytics-chart-mask-card">
        <Icon name="search" />
        {label}
      </span>
    </div>
  );
}

export function SalesTab({ query, scopeLabel, enabled, productQuery, pendingProduct, onClearProduct }: SalesTabProps) {
  const [topSkuBy, setTopSkuBy] = useState<SalesTopSkuMetric>("netQuantity");
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

  /*
   * 只有查詢條件（店別、期間、商品）換掉時才遮罩。切換 Top SKU 排序也會 refetch，
   * 但那顆鈕就在遮罩底下，蓋住的話使用者按完就再也按不到；那個狀態交給
   * TopSkuChart 自己的 loading。
   */
  const busy = pendingProduct !== null || (result.isFetching && summary.topSkuBy === topSkuBy);
  const busyKeyword = pendingProduct ?? productQuery;
  const busyLabel = busyKeyword ? `正在搜尋「${busyKeyword}」…` : "正在更新圖表…";

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
      <div className="analytics-chart-region">
        <Panel className="analytics-empty-panel" aria-busy={busy}>
          <span className="analytics-empty-icon"><Icon name="analytics" /></span>
          <h2>{productQuery ? `找不到符合「${productQuery}」的商品銷售資料` : `${scopeLabel}在這段期間沒有商品銷售資料`}</h2>
          <p>{summary.message ?? "這段期間沒有已匯入的商品銷售資料。"}</p>
          <div className="analytics-empty-actions">
            {productQuery ? (
              <Button variant="secondary" icon="close" onClick={onClearProduct}>清除商品篩選</Button>
            ) : importerKeys(query).map((key) => {
                const importer = SALES_IMPORTERS[key];
                return (
                  <a className="primary-button with-icon" href={importer.href} key={key}>
                    <Icon name={importer.icon} />
                    {importer.label}
                  </a>
                );
              })}
          </div>
        </Panel>
        {busy ? <ChartMask label={busyLabel} /> : null}
      </div>
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
          {productQuery ? <span className="analytics-product-pill">商品：{productQuery}</span> : null}
        </div>
        <div className="analytics-result-meta">
          {asOf ? <span className="analytics-as-of">{asOf}</span> : null}
          <span>僅計入啟用中的店別</span>
        </div>
      </div>

      <div className={`analytics-kpi-grid analytics-sales-kpi-grid${isAnnual ? " annual" : ""}`}>
        <article className="analytics-kpi analytics-kpi-primary">
          <span>本期淨銷量</span>
          <AnalyticsKpiValue>{formatQuantity(summary.netQuantity)}</AnalyticsKpiValue>
          <small>毛銷量 {formatQuantity(summary.grossQuantity)}，退貨 {formatQuantity(summary.returnQuantity)}</small>
        </article>
        {!isAnnual ? (
          <article className="analytics-kpi">
            <span>銷量 MoM</span>
            <AnalyticsKpiValue>{formatPercent(summary.quantityGrowth.mom)}</AnalyticsKpiValue>
            <AnalyticsKpiHint>{growthHint("上期淨銷量", summary.quantityGrowth.mom, summary.previousQuantity)}</AnalyticsKpiHint>
          </article>
        ) : null}
        <article className="analytics-kpi">
          <span>銷量 YoY</span>
          <AnalyticsKpiValue>{formatPercent(summary.quantityGrowth.yoy)}</AnalyticsKpiValue>
          <AnalyticsKpiHint>{growthHint("去年同期淨銷量", summary.quantityGrowth.yoy, summary.lastYearQuantity)}</AnalyticsKpiHint>
        </article>
        <article className="analytics-kpi">
          <span>銷售額</span>
          <AnalyticsKpiValue>{formatCurrency(summary.salesAmount)}</AnalyticsKpiValue>
          <small>{summary.current.start} ～ {summary.current.end}，僅作參考</small>
        </article>
        <article className="analytics-kpi">
          <span>退貨率</span>
          <AnalyticsKpiValue>{formatRate(summary.returnRate)}</AnalyticsKpiValue>
          <small>退貨量 ÷ 毛銷量</small>
        </article>
        <article className="analytics-kpi">
          <span>有銷售 SKU</span>
          <AnalyticsKpiValue>{formatQuantity(summary.skuCount)}</AnalyticsKpiValue>
          <small>本期有交易的商品</small>
        </article>
      </div>

      {result.isFetching ? <p className="analytics-refreshing" role="status">正在更新統計…</p> : null}

      <div className="analytics-chart-region">
        <div className="analytics-chart-grid analytics-sales-chart-grid" aria-busy={busy}>
          <SalesTrendChart
            quantity={{ current: summary.currentQuantity, trend: summary.trendQuantity, lastYear: summary.lastYearQuantity }}
            amount={{ current: summary.current, trend: summary.trend, lastYear: summary.lastYear }}
            granularity={summary.granularity}
            quantityFormatter={formatQuantity}
            amountFormatter={formatCurrency}
          />
          <div className="analytics-chart-column">
            <CategoryBreakdownChart breakdown={summary.byCategory} valueFormatter={formatCurrency} quantityFormatter={formatQuantity} />
            <ChannelBreakdownChart metric="quantity" breakdown={summary.breakdown} valueFormatter={formatCurrency} quantityFormatter={formatQuantity} />
          </div>
          <div className="analytics-chart-column">
            <TopSkuChart
              rows={summary.byTopSku}
              allRows={summary.bySku}
              metric={topSkuBy}
              loading={summary.topSkuBy !== topSkuBy}
              onMetricChange={setTopSkuBy}
              valueFormatter={formatCurrency}
              quantityFormatter={formatQuantity}
            />
            <ChannelBreakdownChart metric="amount" breakdown={summary.breakdown} valueFormatter={formatCurrency} quantityFormatter={formatQuantity} />
          </div>
        </div>
        {busy ? <ChartMask label={busyLabel} /> : null}
      </div>
    </div>
  );
}
