import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Panel } from "../../../../ui/index.js";
import {
  AnalyticsLegend,
  AnalyticsTooltip,
  buildBucketKeys,
  formatBucketLabel,
  formatCompactValue,
} from "./ChartPrimitives.js";
import type { AnalyticsGranularity, AnalyticsRange } from "../api.js";

interface SalesTrendChartProps {
  current: AnalyticsRange;
  trend: AnalyticsRange | null;
  lastYear: AnalyticsRange | null;
  granularity: AnalyticsGranularity;
  valueFormatter: (value: number) => string;
}

function hasSingleMonth(range: AnalyticsRange): boolean {
  return range.start.slice(0, 7) === range.end.slice(0, 7);
}

export function SalesTrendChart({ current, trend, lastYear, granularity, valueFormatter }: SalesTrendChartProps) {
  const isSingleMonth = hasSingleMonth(current);
  if (isSingleMonth && trend) {
    const keys = buildBucketKeys(trend.start, trend.end, "month");
    const values = new Map(trend.points.map((point) => [point.key, point.value]));
    const selectedKey = current.points[0]?.key ?? current.start.slice(0, 7);
    const data = keys.map((key) => ({
      key,
      label: formatBucketLabel(key, "month"),
      value: values.get(key),
    }));

    return (
      <Panel
        title="近 13 個月售額趨勢"
        description="選取月份以外的月份沒有資料時保留斷點；標線是目前選取的月份。"
        className="analytics-chart-panel analytics-trend-panel analytics-sales-trend-panel"
      >
        <div className="analytics-chart" role="img" aria-label="近十三個月商品售額趨勢圖">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid stroke="var(--color-soft-line)" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "var(--color-muted)", fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "var(--color-muted)", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatCompactValue} width={58} />
              <Tooltip content={<AnalyticsTooltip valueFormatter={valueFormatter} />} cursor={{ fill: "var(--color-brand-soft)" }} />
              <ReferenceLine x={formatBucketLabel(selectedKey, "month")} stroke="var(--color-secondary)" strokeDasharray="4 4" />
              <Line dataKey="value" name="售額" type="monotone" stroke="var(--color-brand)" strokeWidth={3} dot={{ r: 3, fill: "var(--color-brand)" }} activeDot={{ r: 5 }} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <details className="analytics-data-details">
          <summary>查看月度資料表</summary>
          <div className="table-scroll">
            <table className="data-table analytics-table">
              <thead><tr><th>月份</th><th className="numeric">售額</th></tr></thead>
              <tbody>
                {data.map((point) => (
                  <tr key={point.key} className={point.key === selectedKey ? "analytics-table-selected" : undefined}>
                    <td data-label="月份">{point.label}{point.key === selectedKey ? "（目前）" : ""}</td>
                    <td data-label="售額" className="numeric">{point.value === undefined ? <span className="muted">無資料</span> : valueFormatter(point.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Panel>
    );
  }

  const currentKeys = buildBucketKeys(current.start, current.end, granularity);
  const comparisonKeys = lastYear ? buildBucketKeys(lastYear.start, lastYear.end, granularity) : [];
  const currentValues = new Map(current.points.map((point) => [point.key, point.value]));
  const comparisonValues = new Map(lastYear?.points.map((point) => [point.key, point.value]));
  const data = currentKeys.map((key, index) => ({
    key,
    label: formatBucketLabel(key, granularity),
    current: currentValues.get(key),
    lastYear: lastYear ? comparisonValues.get(comparisonKeys[index] ?? "") : undefined,
  }));

  return (
    <Panel
      title="商品售額趨勢"
      description={lastYear ? "長條是本期，虛線是去年同期；沒有資料的月份會保留空白。" : "沒有去年同期資料時只顯示本期，缺漏月份不補成 0。"}
      className="analytics-chart-panel analytics-trend-panel analytics-sales-trend-panel"
    >
      <div className="analytics-chart" role="img" aria-label="商品售額趨勢圖">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
            <CartesianGrid stroke="var(--color-soft-line)" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: "var(--color-muted)", fontSize: 11 }} tickLine={false} axisLine={false} interval={granularity === "year" ? 0 : "preserveStartEnd"} />
            <YAxis tick={{ fill: "var(--color-muted)", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatCompactValue} width={58} />
            <Tooltip content={<AnalyticsTooltip valueFormatter={valueFormatter} />} cursor={{ fill: "var(--color-brand-soft)" }} />
            <Legend content={<AnalyticsLegend />} />
            <Bar dataKey="current" name="本期售額" fill="var(--color-brand)" radius={[6, 6, 0, 0]} maxBarSize={34} />
            {lastYear ? <Line dataKey="lastYear" name="去年同期" type="monotone" stroke="var(--color-muted)" strokeWidth={2} strokeDasharray="5 5" dot={false} connectNulls={false} /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <details className="analytics-data-details">
        <summary>查看趨勢資料表</summary>
        <div className="table-scroll">
          <table className="data-table analytics-table">
            <thead><tr><th>期間</th><th className="numeric">本期售額</th><th className="numeric">去年同期</th></tr></thead>
            <tbody>
              {data.map((point) => (
                <tr key={point.key}>
                  <td data-label="期間">{point.label}</td>
                  <td data-label="本期售額" className="numeric">{point.current === undefined ? <span className="muted">無資料</span> : valueFormatter(point.current)}</td>
                  <td data-label="去年同期" className="numeric">{point.lastYear === undefined ? <span className="muted">無資料</span> : valueFormatter(point.lastYear)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Panel>
  );
}
