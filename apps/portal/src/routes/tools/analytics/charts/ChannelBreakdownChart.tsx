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

/** 銷量與銷售額是同一份 breakdown 的兩種讀法，圖表本身完全一樣，只有取值與文案不同。 */
export type ChannelMetric = "quantity" | "amount";

interface ChannelBreakdownChartProps {
  breakdown: SalesBreakdown[];
  metric: ChannelMetric;
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

export function ChannelBreakdownChart({
  breakdown,
  metric,
  valueFormatter,
  quantityFormatter,
}: ChannelBreakdownChartProps) {
  const isAmount = metric === "amount";
  const metricFormatter = isAmount ? valueFormatter : quantityFormatter;
  const metricOf = (row: SalesBreakdown) => (isAmount ? row.value : row.netQuantity);
  const shareOf = (row: SalesBreakdown) => (isAmount ? row.share : row.quantityShare);
  const metricLabel = isAmount ? "銷售額" : "淨銷量";
  const shareLabel = isAmount ? "銷售額佔比" : "銷量佔比";
  const referenceLabel = isAmount ? "銷量（參考）" : "售額（參考）";

  const data = breakdown
    .map((row) => ({
      ...row,
      label: `${row.scopeName} · ${channelLabel(row.channel)}`,
    }))
    .sort((left, right) => metricOf(right) - metricOf(left));

  return (
    <Panel
      title={isAmount ? "通路銷售額比較" : "通路銷量比較"}
      description={isAmount
        ? "展開各店別與通路的銷售額；淨銷量放在資料表中作為參考。"
        : "展開各店別與通路的淨銷量；銷售額放在資料表中作為參考。"}
      actions={data.length ? (
        <AnalyticsDataDialog
          title={isAmount ? "通路銷售額資料" : "通路銷量資料"}
          description={isAmount
            ? "依本期銷售額排序，列出所有店別與通路；YoY 為相同店別比較。"
            : "依本期淨銷量排序，列出所有店別與通路；銷售額僅作參考。"}
        >
          <table className="data-table analytics-table">
            <thead>
              <tr>
                <th>店別</th>
                <th>通路</th>
                <th className="numeric">{metricLabel}</th>
                <th className="numeric">{shareLabel}</th>
                {isAmount ? <th className="numeric">YoY</th> : null}
                <th className="numeric">{referenceLabel}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.scopeId}>
                  <td data-label="店別" className="cell-strong">{row.scopeName}</td>
                  <td data-label="通路">{channelLabel(row.channel)}</td>
                  <td data-label={metricLabel} className="numeric">{metricFormatter(metricOf(row))}</td>
                  <td data-label={shareLabel} className="numeric">{formatPercent(shareOf(row))}</td>
                  {isAmount ? (
                    <td data-label="YoY" className="numeric">{row.yoy === null ? <span className="muted">—</span> : formatPercent(row.yoy)}</td>
                  ) : null}
                  <td data-label={referenceLabel} className="numeric">
                    {isAmount ? quantityFormatter(row.netQuantity) : valueFormatter(row.value)}
                  </td>
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
          aria-label={isAmount ? "通路商品銷售額比較圖" : "通路商品淨銷量比較圖"}
          style={{ height: Math.max(260, data.length * 40 + 24) }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
              <CartesianGrid stroke="var(--color-soft-line)" horizontal={false} />
              <XAxis type="number" tick={{ fill: "var(--color-muted)", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(value: number) => metricFormatter(value)} />
              <YAxis type="category" dataKey="label" width={180} interval={0} tick={{ fill: "var(--color-ink)", fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip content={<AnalyticsTooltip valueFormatter={metricFormatter} />} cursor={{ fill: "var(--color-brand-soft)" }} />
              <Bar dataKey={isAmount ? "value" : "netQuantity"} name={metricLabel} radius={[0, 6, 6, 0]} maxBarSize={28}>
                {data.map((row) => <Cell key={row.scopeId} fill={CHANNEL_COLORS[row.channel] ?? CHANNEL_COLORS.other} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : <p className="analytics-chart-empty">本期沒有通路資料。</p>}
    </Panel>
  );
}
