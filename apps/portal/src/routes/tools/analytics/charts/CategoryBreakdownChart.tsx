import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Panel } from "../../../../ui/index.js";
import { AnalyticsTooltip } from "./ChartPrimitives.js";
import type { SalesCategoryBreakdown } from "../api.js";

const TONES = ["rose", "sky", "mint", "amber", "violet", "teal", "peach", "slate", "lime", "sand"] as const;

interface CategoryBreakdownChartProps {
  breakdown: SalesCategoryBreakdown[];
  valueFormatter: (value: number) => string;
  quantityFormatter: (value: number) => string;
}

function formatPercent(value: number): string {
  return `${(value * 100).toLocaleString("zh-TW", { maximumFractionDigits: 1 })}%`;
}

export function CategoryBreakdownChart({ breakdown, valueFormatter, quantityFormatter }: CategoryBreakdownChartProps) {
  const data = breakdown.map((row) => ({ ...row, label: row.category }));
  return (
    <Panel
      title="分類佔比"
      description="依本期售額由大到小排列，配色沿用既有分類色票。"
      className="analytics-chart-panel analytics-category-panel"
    >
      {data.length ? (
        <div className="analytics-chart analytics-category-chart" role="img" aria-label="商品分類售額佔比圖">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid stroke="var(--color-soft-line)" horizontal={false} />
              <XAxis type="number" tick={{ fill: "var(--color-muted)", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(value: number) => valueFormatter(value)} />
              <YAxis type="category" dataKey="label" width={92} tick={{ fill: "var(--color-ink)", fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip content={<AnalyticsTooltip valueFormatter={valueFormatter} />} cursor={{ fill: "var(--color-brand-soft)" }} />
              <Bar dataKey="value" name="售額" radius={[0, 6, 6, 0]} maxBarSize={28}>
                {data.map((row, index) => <Cell key={row.category} fill={`var(--color-tone-${TONES[index % TONES.length]})`} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : <p className="analytics-chart-empty">本期沒有分類資料。</p>}
      <details className="analytics-data-details">
        <summary>查看分類資料表</summary>
        <div className="table-scroll">
          <table className="data-table analytics-table">
            <thead><tr><th>分類</th><th className="numeric">售額</th><th className="numeric">佔比</th><th className="numeric">淨銷量</th></tr></thead>
            <tbody>
              {breakdown.map((row) => (
                <tr key={row.category}>
                  <td data-label="分類" className="cell-strong">{row.category}</td>
                  <td data-label="售額" className="numeric">{valueFormatter(row.value)}</td>
                  <td data-label="佔比" className="numeric">{formatPercent(row.share)}</td>
                  <td data-label="淨銷量" className="numeric">{quantityFormatter(row.netQuantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Panel>
  );
}
