import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Panel } from "../../../../ui/index.js";
import { AnalyticsTooltip } from "./ChartPrimitives.js";
import type { PayoutBreakdown } from "../api.js";

interface ScopeBreakdownChartProps {
  breakdown: PayoutBreakdown[];
  valueFormatter: (value: number) => string;
}

function formatPercent(value: number): string {
  return `${(value * 100).toLocaleString("zh-TW", { maximumFractionDigits: 1 })}%`;
}

function channelLabel(value: string): string {
  if (value === "shopee") return "蝦皮";
  if (value === "cyberbiz") return "CYBERBIZ";
  return "其他通路";
}

export function ScopeBreakdownChart({ breakdown, valueFormatter }: ScopeBreakdownChartProps) {
  const data = breakdown.map((row) => ({ ...row, label: row.scopeName }));
  return (
    <Panel
      title="店別出金"
      description="依本期出金由大到小排列，佔比以本期總額計算。"
      className="analytics-chart-panel analytics-scope-panel"
    >
      <div className="analytics-chart analytics-scope-chart" role="img" aria-label="店別出金比較圖">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
            <CartesianGrid stroke="var(--color-soft-line)" horizontal={false} />
            <XAxis type="number" tick={{ fill: "var(--color-muted)", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(value: number) => valueFormatter(value)} />
            <YAxis type="category" dataKey="label" width={112} tick={{ fill: "var(--color-ink)", fontSize: 11 }} tickLine={false} axisLine={false} />
            <Tooltip content={<AnalyticsTooltip valueFormatter={valueFormatter} />} cursor={{ fill: "var(--color-brand-soft)" }} />
            <Bar dataKey="value" name="本期出金" fill="var(--color-brand)" radius={[0, 6, 6, 0]} maxBarSize={28} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="analytics-data-details">
        <summary>查看店別資料表</summary>
        <div className="table-scroll">
          <table className="data-table analytics-table">
            <thead><tr><th>店別</th><th>通路</th><th className="numeric">本期出金</th><th className="numeric">佔比</th><th className="numeric">YoY</th></tr></thead>
            <tbody>
              {breakdown.map((row) => (
                <tr key={row.scopeId}>
                  <td data-label="店別" className="cell-strong">{row.scopeName}</td>
                  <td data-label="通路">{channelLabel(row.channel)}</td>
                  <td data-label="本期出金" className="numeric">{valueFormatter(row.value)}</td>
                  <td data-label="佔比" className="numeric">{formatPercent(row.share)}</td>
                  <td data-label="YoY" className="numeric">{row.yoy === null ? <span className="muted">—</span> : formatPercent(row.yoy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Panel>
  );
}
