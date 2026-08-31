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
import type { SalesBreakdown } from "../api.js";

const CHANNEL_COLORS: Record<string, string> = {
  cyberbiz: "var(--color-tone-sky)",
  shopee: "var(--color-tone-amber)",
  other: "var(--color-tone-slate)",
};

interface ChannelBreakdownChartProps {
  breakdown: SalesBreakdown[];
  valueFormatter: (value: number) => string;
  quantityFormatter: (value: number) => string;
}

function channelLabel(value: string): string {
  if (value === "shopee") return "蝦皮";
  if (value === "cyberbiz") return "CYBERBIZ";
  return "其他通路";
}

function formatPercent(value: number): string {
  return `${(value * 100).toLocaleString("zh-TW", { maximumFractionDigits: 1 })}%`;
}

export function ChannelBreakdownChart({ breakdown, valueFormatter, quantityFormatter }: ChannelBreakdownChartProps) {
  const total = breakdown.reduce((sum, row) => sum + row.value, 0);
  const grouped = new Map<string, { channel: string; label: string; value: number; share: number; netQuantity: number }>();
  for (const row of breakdown) {
    const existing = grouped.get(row.channel) ?? {
      channel: row.channel,
      label: channelLabel(row.channel),
      value: 0,
      share: 0,
      netQuantity: 0,
    };
    existing.value += row.value;
    existing.netQuantity += row.netQuantity;
    existing.share = total === 0 ? 0 : existing.value / total;
    grouped.set(row.channel, existing);
  }
  const data = [...grouped.values()].sort((left, right) => right.value - left.value);

  return (
    <Panel
      title="通路銷售比較"
      description="公司查詢按通路合計；單店查詢會顯示該店所屬通路。"
      className="analytics-chart-panel analytics-channel-panel"
    >
      {data.length ? (
        <div className="analytics-chart analytics-channel-chart" role="img" aria-label="通路商品售額比較圖">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid stroke="var(--color-soft-line)" horizontal={false} />
              <XAxis type="number" tick={{ fill: "var(--color-muted)", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(value: number) => valueFormatter(value)} />
              <YAxis type="category" dataKey="label" width={92} tick={{ fill: "var(--color-ink)", fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip content={<AnalyticsTooltip valueFormatter={valueFormatter} />} cursor={{ fill: "var(--color-brand-soft)" }} />
              <Bar dataKey="value" name="售額" radius={[0, 6, 6, 0]} maxBarSize={28}>
                {data.map((row) => <Cell key={row.channel} fill={CHANNEL_COLORS[row.channel] ?? CHANNEL_COLORS.other} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : <p className="analytics-chart-empty">本期沒有通路資料。</p>}
      <details className="analytics-data-details">
        <summary>查看通路資料表</summary>
        <div className="table-scroll">
          <table className="data-table analytics-table">
            <thead><tr><th>通路</th><th className="numeric">售額</th><th className="numeric">佔比</th><th className="numeric">淨銷量</th></tr></thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.channel}>
                  <td data-label="通路" className="cell-strong">{row.label}</td>
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
