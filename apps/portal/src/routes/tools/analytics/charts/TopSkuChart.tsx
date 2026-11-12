import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Chip, DataTable, Panel } from "../../../../ui/index.js";
import { ANALYTICS_CHART_EMPTY, ANALYTICS_CHART_PANEL, ANALYTICS_TABLE, AnalyticsDataDialog, AnalyticsTooltip } from "./ChartPrimitives.js";
import type { SalesSkuBreakdown, SalesTopSkuMetric } from "../api.js";

interface TopSkuChartProps {
  rows: SalesSkuBreakdown[];
  allRows: SalesSkuBreakdown[];
  metric: SalesTopSkuMetric;
  loading: boolean;
  onMetricChange: (metric: SalesTopSkuMetric) => void;
  valueFormatter: (value: number) => string;
  quantityFormatter: (value: number) => string;
}

/** 十列長條加上「其他」，比其他圖表高；排序更新中的提示佔同樣高度，畫面才不會跳。 */
const SKU_CHART = "h-[360px] min-h-[240px] w-full";

function formatPercent(value: number): string {
  return `${(value * 100).toLocaleString("zh-TW", { maximumFractionDigits: 1 })}%`;
}

export function TopSkuChart({ rows, allRows, metric, loading, onMetricChange, valueFormatter, quantityFormatter }: TopSkuChartProps) {
  const data = rows.map((row) => ({
    ...row,
    label: row.isOther ? "其他" : `${row.productName} · ${row.sku}`,
  }));
  const metricLabel = metric === "salesAmount" ? "售額" : "淨銷量";
  const metricFormatter = metric === "salesAmount" ? valueFormatter : quantityFormatter;
  return (
    <Panel
      title="Top 10 SKU"
      description="圖表顯示前十名；查看資料表可展開全部商品。"
      actions={(
        <div className="flex flex-wrap items-center justify-end gap-2 max-[760px]:items-start max-[760px]:justify-start">
          <div className="flex flex-wrap justify-end gap-1 max-[760px]:mt-2 max-[760px]:justify-start" role="group" aria-label="Top SKU 排序方式">
            <Chip size="sm" selected={metric === "netQuantity"} onClick={() => onMetricChange("netQuantity")}>依淨銷量</Chip>
            <Chip size="sm" selected={metric === "salesAmount"} onClick={() => onMetricChange("salesAmount")}>依售額</Chip>
          </div>
          <AnalyticsDataDialog
            title={`商品銷售資料（依${metricLabel}）`}
            description="依目前選定指標排序，列出這段期間所有有銷售的商品。"
            disabled={loading || !allRows.length}
          >
            <DataTable className={ANALYTICS_TABLE} scroll={false}>
              <thead><tr><th>商品</th><th>SKU</th><th className="numeric">淨銷量</th><th className="numeric">售額（參考）</th><th className="numeric">銷量佔比</th></tr></thead>
              <tbody>
                {allRows.map((row) => (
                  <tr key={row.sku}>
                    <td data-label="商品" className="cell-strong">{row.productName}</td>
                    <td data-label="SKU">{row.sku}</td>
                    <td data-label="淨銷量" className="numeric">{quantityFormatter(row.netQuantity)}</td>
                    <td data-label="售額（參考）" className="numeric">{valueFormatter(row.salesAmount)}</td>
                    <td data-label="銷量佔比" className="numeric">{formatPercent(row.quantityShare)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </AnalyticsDataDialog>
        </div>
      )}
      headerClassName="mb-3" titleClassName="text-[14px]"
      className={ANALYTICS_CHART_PANEL}
    >
      {loading ? (
        <div className={`${SKU_CHART} m-0 grid place-items-center text-[13px] text-muted`} role="status">正在更新 Top 10 SKU 排序…</div>
      ) : data.length ? (
        <div className={SKU_CHART} role="img" aria-label={`Top 10 SKU（依${metricLabel}）`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid stroke="var(--color-soft-line)" horizontal={false} />
              <XAxis type="number" tick={{ fill: "var(--color-muted)", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(value: number) => metricFormatter(value)} />
              <YAxis type="category" dataKey="label" width={188} tick={{ fill: "var(--color-ink)", fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip content={<AnalyticsTooltip valueFormatter={metricFormatter} />} cursor={{ fill: "var(--color-brand-soft)" }} />
              <Bar dataKey="value" name={metricLabel} fill="var(--color-brand)" radius={[0, 6, 6, 0]} maxBarSize={26} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : <p className={ANALYTICS_CHART_EMPTY}>本期沒有 SKU 資料。</p>}
    </Panel>
  );
}
