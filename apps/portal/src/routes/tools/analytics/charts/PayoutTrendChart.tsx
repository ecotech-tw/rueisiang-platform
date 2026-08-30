import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
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

interface PayoutTrendChartProps {
  current: AnalyticsRange;
  lastYear: AnalyticsRange | null;
  granularity: AnalyticsGranularity;
  valueFormatter: (value: number) => string;
}

export function PayoutTrendChart({ current, lastYear, granularity, valueFormatter }: PayoutTrendChartProps) {
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
      title="出金趨勢"
      description={lastYear ? "長條是本期，虛線是去年同期；沒有資料的日期會保留空白。" : "沒有去年同期資料時只顯示本期，缺漏日期不補成 0。"}
      className="analytics-chart-panel analytics-trend-panel"
    >
      <div className="analytics-chart" role="img" aria-label="出金趨勢圖">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
            <CartesianGrid stroke="var(--color-soft-line)" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: "var(--color-muted)", fontSize: 11 }} tickLine={false} axisLine={false} interval={granularity === "day" ? "preserveStartEnd" : 0} />
            <YAxis tick={{ fill: "var(--color-muted)", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatCompactValue} width={58} />
            <Tooltip content={<AnalyticsTooltip valueFormatter={valueFormatter} />} cursor={{ fill: "var(--color-brand-soft)" }} />
            <Legend content={<AnalyticsLegend />} />
            <Bar dataKey="current" name="本期" fill="var(--color-brand)" radius={[6, 6, 0, 0]} maxBarSize={34} />
            {lastYear ? <Line dataKey="lastYear" name="去年同期" type="monotone" stroke="var(--color-muted)" strokeWidth={2} strokeDasharray="5 5" dot={false} connectNulls={false} /> : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <details className="analytics-data-details">
        <summary>查看趨勢資料表</summary>
        <div className="table-scroll">
          <table className="data-table analytics-table">
            <thead><tr><th>期間</th><th className="numeric">本期</th><th className="numeric">去年同期</th></tr></thead>
            <tbody>
              {data.map((point) => (
                <tr key={point.key}>
                  <td data-label="期間">{point.label}</td>
                  <td data-label="本期" className="numeric">{point.current === undefined ? <span className="muted">無資料</span> : valueFormatter(point.current)}</td>
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
