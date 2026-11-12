import { useState } from "react";
import { Icon } from "../../../shell/icons.js";
import { Alert, Button, ButtonLink } from "../../../ui/index.js";
import { CategoryBreakdownChart } from "./charts/CategoryBreakdownChart.js";
import { ChannelBreakdownChart } from "./charts/ChannelBreakdownChart.js";
import { SalesTrendChart } from "./charts/SalesTrendChart.js";
import {
  ANALYTICS_CHART_COLUMN,
  ANALYTICS_CHART_GRID,
  AnalyticsEmptyPanel,
  AnalyticsKpi,
  AnalyticsKpiGrid,
  AnalyticsRefreshing,
  AnalyticsResultHeading,
} from "./charts/ChartPrimitives.js";
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

const CHART_REGION = "relative min-w-0";

/*
 * 搜尋期間舊圖表還留在畫面上（keepPreviousData），沒有遮罩的話使用者會以為
 * 那就是新結果。提示卡靠上排，圖表區很高時不用捲動也看得到。
 */
function ChartMask({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 z-2 grid rounded-card bg-canvas/72 pt-14 [place-items:start_center] [backdrop-filter:blur(2px)]" role="status" aria-live="polite">
      <span className="sticky top-14 inline-flex items-center gap-2 rounded-full border border-line bg-paper px-[18px] py-2.5 text-[13px] font-semibold text-ink [box-shadow:var(--shadow-panel)]">
        <Icon name="search" className="size-[18px] text-brand" />
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
      <AnalyticsEmptyPanel
        icon="analytics"
        title="商品銷售只支援完整月份"
        message={summary.message ?? "請改用 YYYY-MM、YYYY 或完整月份的自訂日期區間。"}
        note="商品銷售資料是按月匯入，無法用不完整月份計算。"
      />
    );
  }
  if (summary.status === "NO_DATA_FOR_RANGE") {
    return (
      <div className={CHART_REGION}>
        <AnalyticsEmptyPanel
          icon="analytics"
          title={productQuery ? `找不到符合「${productQuery}」的商品銷售資料` : `${scopeLabel}在這段期間沒有商品銷售資料`}
          message={summary.message ?? "這段期間沒有已匯入的商品銷售資料。"}
        >
          <div className="mt-2.5 flex flex-wrap gap-2">
            {productQuery ? (
              <Button variant="secondary" icon="close" onClick={onClearProduct}>清除商品篩選</Button>
            ) : importerKeys(query).map((key) => {
                const importer = SALES_IMPORTERS[key];
                return (
                  <ButtonLink icon={importer.icon} href={importer.href} key={key} className="mt-1">{importer.label}</ButtonLink>
                );
              })}
          </div>
        </AnalyticsEmptyPanel>
        {busy ? <ChartMask label={busyLabel} /> : null}
      </div>
    );
  }

  const isAnnual = /^\d{4}$/u.test(summary.period);
  const asOf = summary.complete || !summary.asOfDate ? null : `截至 ${formatDate(summary.asOfDate)}`;
  return (
    <div className="grid gap-3.5">
      <AnalyticsResultHeading eyebrow="商品銷售脈動" title={scopeLabel} asOf={asOf}>
        {productQuery ? <span>商品：{productQuery}</span> : null}
      </AnalyticsResultHeading>

      <AnalyticsKpiGrid tab="sales" annual={isAnnual}>
        <AnalyticsKpi primary label="本期淨銷量" value={formatQuantity(summary.netQuantity)}>
          毛銷量 {formatQuantity(summary.grossQuantity)}，退貨 {formatQuantity(summary.returnQuantity)}
        </AnalyticsKpi>
        {!isAnnual ? (
          <AnalyticsKpi label="銷量 MoM" value={formatPercent(summary.quantityGrowth.mom)} hint={growthHint("上期淨銷量", summary.quantityGrowth.mom, summary.previousQuantity)} />
        ) : null}
        <AnalyticsKpi label="銷量 YoY" value={formatPercent(summary.quantityGrowth.yoy)} hint={growthHint("去年同期淨銷量", summary.quantityGrowth.yoy, summary.lastYearQuantity)} />
        <AnalyticsKpi label="銷售額" value={formatCurrency(summary.salesAmount)}>
          {summary.current.start} ～ {summary.current.end}，僅作參考
        </AnalyticsKpi>
        <AnalyticsKpi label="退貨率" value={formatRate(summary.returnRate)}>退貨量 ÷ 毛銷量</AnalyticsKpi>
        <AnalyticsKpi label="有銷售 SKU" value={formatQuantity(summary.skuCount)}>本期有交易的商品</AnalyticsKpi>
      </AnalyticsKpiGrid>

      {result.isFetching ? <AnalyticsRefreshing /> : null}

      <div className={CHART_REGION}>
        <div className={ANALYTICS_CHART_GRID} aria-busy={busy}>
          <SalesTrendChart
            quantity={{ current: summary.currentQuantity, trend: summary.trendQuantity, lastYear: summary.lastYearQuantity }}
            amount={{ current: summary.current, trend: summary.trend, lastYear: summary.lastYear }}
            granularity={summary.granularity}
            quantityFormatter={formatQuantity}
            amountFormatter={formatCurrency}
          />
          <div className={ANALYTICS_CHART_COLUMN}>
            <CategoryBreakdownChart breakdown={summary.byCategory} valueFormatter={formatCurrency} quantityFormatter={formatQuantity} />
            <ChannelBreakdownChart metric="quantity" breakdown={summary.breakdown} valueFormatter={formatCurrency} quantityFormatter={formatQuantity} />
          </div>
          <div className={ANALYTICS_CHART_COLUMN}>
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
