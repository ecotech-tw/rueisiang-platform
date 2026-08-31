import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Panel } from "../../../../ui/index.js";
import { AnalyticsDataDialog, AnalyticsLegend, AnalyticsTooltip, type ChartLegendEntry } from "./ChartPrimitives.js";
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

function CategoryLegend({
  payload,
  breakdown,
}: {
  payload?: readonly ChartLegendEntry[];
  breakdown: SalesCategoryBreakdown[];
}) {
  return (
    <AnalyticsLegend
      payload={payload}
      formatValue={(value) => {
        const row = breakdown.find((item) => item.category === value);
        return <>{value} <b>{formatPercent(row?.quantityShare ?? 0)}</b></>;
      }}
    />
  );
}

export function CategoryBreakdownChart({ breakdown, valueFormatter, quantityFormatter }: CategoryBreakdownChartProps) {
  const data = breakdown.map((row) => ({ ...row, label: row.category, quantity: row.netQuantity }));
  return (
    <Panel
      title="分類銷量佔比"
      description="以淨銷量呈現各分類的占比；銷售額放在資料表中作為參考。"
      actions={data.length ? (
        <AnalyticsDataDialog title="分類銷量資料" description="依本期淨銷量排序，銷售額僅作參考。">
          <table className="data-table analytics-table">
            <thead><tr><th>分類</th><th className="numeric">淨銷量</th><th className="numeric">銷量佔比</th><th className="numeric">售額（參考）</th></tr></thead>
            <tbody>
              {breakdown.map((row) => (
                <tr key={row.category}>
                  <td data-label="分類" className="cell-strong">{row.category}</td>
                  <td data-label="淨銷量" className="numeric">{quantityFormatter(row.netQuantity)}</td>
                  <td data-label="銷量佔比" className="numeric">{formatPercent(row.quantityShare)}</td>
                  <td data-label="售額（參考）" className="numeric">{valueFormatter(row.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AnalyticsDataDialog>
      ) : null}
      className="analytics-chart-panel analytics-category-panel"
    >
      {data.length ? (
        <div className="analytics-chart analytics-category-chart" role="img" aria-label="商品分類淨銷量佔比圖">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="quantity"
                nameKey="label"
                cx="50%"
                cy="45%"
                innerRadius="38%"
                outerRadius="70%"
                paddingAngle={2}
                stroke="var(--color-paper)"
                strokeWidth={2}
              >
                {data.map((row, index) => <Cell key={row.category} fill={`var(--color-tone-${TONES[index % TONES.length]})`} />)}
              </Pie>
              <Tooltip
                content={(
                  <AnalyticsTooltip
                    valueFormatter={quantityFormatter}
                    valueMeta={(entry) => {
                      const row = breakdown.find((item) => item.category === entry.name);
                      return row ? `（佔比 ${formatPercent(row.quantityShare)}）` : null;
                    }}
                  />
                )}
              />
              <Legend content={<CategoryLegend breakdown={breakdown} />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      ) : <p className="analytics-chart-empty">本期沒有分類資料。</p>}
    </Panel>
  );
}
