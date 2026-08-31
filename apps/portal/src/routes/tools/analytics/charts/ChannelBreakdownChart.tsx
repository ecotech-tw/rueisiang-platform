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
import { AnalyticsDataDialog, AnalyticsTooltip } from "./ChartPrimitives.js";
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
  const data = breakdown
    .map((row) => ({
      ...row,
      label: `${row.scopeName} · ${channelLabel(row.channel)}`,
    }))
    .sort((left, right) => right.netQuantity - left.netQuantity);

  return (
    <Panel
      title="通路銷量比較"
      description="展開各店別與通路的淨銷量；銷售額放在資料表中作為參考。"
      actions={data.length ? (
        <AnalyticsDataDialog title="通路銷量資料" description="依本期淨銷量排序，列出所有店別與通路；銷售額僅作參考。">
          <table className="data-table analytics-table">
            <thead><tr><th>店別</th><th>通路</th><th className="numeric">淨銷量</th><th className="numeric">銷量佔比</th><th className="numeric">售額（參考）</th></tr></thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.scopeId}>
                  <td data-label="店別" className="cell-strong">{row.scopeName}</td>
                  <td data-label="通路">{channelLabel(row.channel)}</td>
                  <td data-label="淨銷量" className="numeric">{quantityFormatter(row.netQuantity)}</td>
                  <td data-label="銷量佔比" className="numeric">{formatPercent(row.quantityShare)}</td>
                  <td data-label="售額（參考）" className="numeric">{valueFormatter(row.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AnalyticsDataDialog>
      ) : null}
      className="analytics-chart-panel analytics-channel-panel"
    >
      {data.length ? (
        <div
          className="analytics-chart analytics-channel-chart"
          role="img"
          aria-label="通路商品淨銷量比較圖"
          style={{ height: Math.max(260, data.length * 40 + 24) }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid stroke="var(--color-soft-line)" horizontal={false} />
              <XAxis type="number" tick={{ fill: "var(--color-muted)", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(value: number) => quantityFormatter(value)} />
              <YAxis type="category" dataKey="label" width={180} tick={{ fill: "var(--color-ink)", fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip content={<AnalyticsTooltip valueFormatter={quantityFormatter} />} cursor={{ fill: "var(--color-brand-soft)" }} />
              <Bar dataKey="netQuantity" name="淨銷量" radius={[0, 6, 6, 0]} maxBarSize={28}>
                {data.map((row) => <Cell key={row.scopeId} fill={CHANNEL_COLORS[row.channel] ?? CHANNEL_COLORS.other} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : <p className="analytics-chart-empty">本期沒有通路資料。</p>}
    </Panel>
  );
}
