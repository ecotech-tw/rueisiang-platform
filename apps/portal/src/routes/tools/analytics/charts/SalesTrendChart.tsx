import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Panel } from "../../../../ui/index.js";
import {
  AnalyticsDataDialog,
  AnalyticsLegend,
  AnalyticsTooltip,
  buildBucketKeys,
  formatBucketLabel,
  formatCompactAmount,
  formatCompactValue,
  type ChartTooltipEntry,
} from "./ChartPrimitives.js";
import type { AnalyticsGranularity, AnalyticsRange } from "../api.js";

export interface SalesTrendSeries {
  current: AnalyticsRange;
  trend: AnalyticsRange | null;
  lastYear: AnalyticsRange | null;
}

interface SalesTrendChartProps {
  quantity: SalesTrendSeries;
  amount: SalesTrendSeries;
  granularity: AnalyticsGranularity;
  quantityFormatter: (value: number) => string;
  amountFormatter: (value: number) => string;
}

/** 銷量與金額差好幾個數量級，共用一條軸的話銷量長條會被壓成看不見，所以分左右兩軸。 */
const AMOUNT_KEYS = new Set(["amount"]);

function hasSingleMonth(range: AnalyticsRange): boolean {
  return range.start.slice(0, 7) === range.end.slice(0, 7);
}

function pointValues(range: AnalyticsRange | null): Map<string, number> {
  return new Map(range?.points.map((point) => [point.key, point.value]));
}

export function SalesTrendChart({
  quantity,
  amount,
  granularity,
  quantityFormatter,
  amountFormatter,
}: SalesTrendChartProps) {
  const tooltipFormatter = (value: number, entry: ChartTooltipEntry) =>
    AMOUNT_KEYS.has(entry.dataKey ?? "") ? amountFormatter(value) : quantityFormatter(value);

  const axes = (
    <>
      <YAxis
        yAxisId="quantity"
        tick={{ fill: "var(--color-muted)", fontSize: 11 }}
        tickLine={false}
        axisLine={false}
        tickFormatter={formatCompactValue}
        width={58}
      />
      <YAxis
        yAxisId="amount"
        orientation="right"
        tick={{ fill: "var(--color-muted)", fontSize: 11 }}
        tickLine={false}
        axisLine={false}
        tickFormatter={formatCompactAmount}
        width={58}
      />
    </>
  );

  const isSingleMonth = hasSingleMonth(quantity.current);
  if (isSingleMonth && quantity.trend) {
    const keys = buildBucketKeys(quantity.trend.start, quantity.trend.end, "month");
    const quantityValues = pointValues(quantity.trend);
    const amountValues = pointValues(amount.trend);
    const selectedKey = quantity.current.points[0]?.key ?? quantity.current.start.slice(0, 7);
    const data = keys.map((key) => ({
      key,
      label: formatBucketLabel(key, "month"),
      quantity: quantityValues.get(key),
      amount: amountValues.get(key),
    }));

    return (
      <Panel
        title="近 13 個月銷量與銷售額趨勢"
        description="左軸是淨銷量、右軸是銷售額；沒有匯入資料的月份不畫長條，標線是目前選取的月份。"
        actions={(
          <AnalyticsDataDialog title="近 13 個月銷量與銷售額資料" description="沒有匯入資料的月份會保留為空白。">
            <table className="data-table analytics-table">
              <thead><tr><th>月份</th><th className="numeric">淨銷量</th><th className="numeric">銷售額</th></tr></thead>
              <tbody>
                {data.map((point) => (
                  <tr key={point.key} className={point.key === selectedKey ? "analytics-table-selected" : undefined}>
                    <td data-label="月份">{point.label}{point.key === selectedKey ? "（目前）" : ""}</td>
                    <td data-label="淨銷量" className="numeric">{point.quantity === undefined ? <span className="muted">無資料</span> : quantityFormatter(point.quantity)}</td>
                    <td data-label="銷售額" className="numeric">{point.amount === undefined ? <span className="muted">無資料</span> : amountFormatter(point.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </AnalyticsDataDialog>
        )}
        className="analytics-chart-panel analytics-trend-panel analytics-sales-trend-panel"
      >
        <div className="analytics-chart" role="img" aria-label="近十三個月商品淨銷量與銷售額趨勢圖">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid stroke="var(--color-soft-line)" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "var(--color-muted)", fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              {axes}
              <Tooltip content={<AnalyticsTooltip valueFormatter={tooltipFormatter} />} cursor={{ fill: "var(--color-brand-soft)" }} />
              <Legend content={<AnalyticsLegend />} />
              <ReferenceLine yAxisId="quantity" x={formatBucketLabel(selectedKey, "month")} stroke="var(--color-secondary)" strokeDasharray="4 4" />
              <Bar yAxisId="quantity" dataKey="quantity" name="淨銷量" fill="var(--color-brand)" radius={[6, 6, 0, 0]} maxBarSize={22} />
              <Bar yAxisId="amount" dataKey="amount" name="銷售額" fill="var(--color-tone-sky)" radius={[6, 6, 0, 0]} maxBarSize={22} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Panel>
    );
  }

  const currentKeys = buildBucketKeys(quantity.current.start, quantity.current.end, granularity);
  const comparisonKeys = quantity.lastYear
    ? buildBucketKeys(quantity.lastYear.start, quantity.lastYear.end, granularity)
    : [];
  const quantityValues = pointValues(quantity.current);
  const amountValues = pointValues(amount.current);
  const lastYearValues = pointValues(quantity.lastYear);
  const data = currentKeys.map((key, index) => ({
    key,
    label: formatBucketLabel(key, granularity),
    quantity: quantityValues.get(key),
    amount: amountValues.get(key),
    lastYear: quantity.lastYear ? lastYearValues.get(comparisonKeys[index] ?? "") : undefined,
  }));

  return (
    <Panel
      title="商品銷量與銷售額趨勢"
      description={quantity.lastYear
        ? "紅色長條是本期淨銷量（左軸）、藍色長條是銷售額（右軸）；虛線是去年同期淨銷量，沒有資料的期間會保留空白。"
        : "紅色長條是本期淨銷量（左軸）、藍色長條是銷售額（右軸）；缺漏月份不補成 0。"}
      actions={(
        <AnalyticsDataDialog title="商品銷量與銷售額資料" description="沒有匯入資料的期間會保留為空白。">
          <table className="data-table analytics-table">
            <thead><tr><th>期間</th><th className="numeric">本期淨銷量</th><th className="numeric">本期銷售額</th><th className="numeric">去年同期淨銷量</th></tr></thead>
            <tbody>
              {data.map((point) => (
                <tr key={point.key}>
                  <td data-label="期間">{point.label}</td>
                  <td data-label="本期淨銷量" className="numeric">{point.quantity === undefined ? <span className="muted">無資料</span> : quantityFormatter(point.quantity)}</td>
                  <td data-label="本期銷售額" className="numeric">{point.amount === undefined ? <span className="muted">無資料</span> : amountFormatter(point.amount)}</td>
                  <td data-label="去年同期淨銷量" className="numeric">{point.lastYear === undefined ? <span className="muted">無資料</span> : quantityFormatter(point.lastYear)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AnalyticsDataDialog>
      )}
      className="analytics-chart-panel analytics-trend-panel analytics-sales-trend-panel"
    >
      <div className="analytics-chart" role="img" aria-label="商品淨銷量與銷售額趨勢圖">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
            <CartesianGrid stroke="var(--color-soft-line)" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: "var(--color-muted)", fontSize: 11 }} tickLine={false} axisLine={false} interval={granularity === "year" ? 0 : "preserveStartEnd"} />
            {axes}
            <Tooltip content={<AnalyticsTooltip valueFormatter={tooltipFormatter} />} cursor={{ fill: "var(--color-brand-soft)" }} />
            <Legend content={<AnalyticsLegend />} />
            <Bar yAxisId="quantity" dataKey="quantity" name="本期淨銷量" fill="var(--color-brand)" radius={[6, 6, 0, 0]} maxBarSize={22} />
            <Bar yAxisId="amount" dataKey="amount" name="本期銷售額" fill="var(--color-tone-sky)" radius={[6, 6, 0, 0]} maxBarSize={22} />
            {quantity.lastYear ? <Line yAxisId="quantity" dataKey="lastYear" name="去年同期淨銷量" type="monotone" stroke="var(--color-muted)" strokeWidth={2} strokeDasharray="5 5" dot={false} connectNulls={false} /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}
