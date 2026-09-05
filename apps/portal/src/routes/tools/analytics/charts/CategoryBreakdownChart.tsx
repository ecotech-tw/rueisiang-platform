import { useMemo, useState } from "react";
import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Button, Panel } from "../../../../ui/index.js";
import { AnalyticsDataDialog, AnalyticsLegend, AnalyticsTooltip, type ChartLegendEntry } from "./ChartPrimitives.js";
import type { SalesCategoryBreakdown } from "../api.js";

const TONES = ["rose", "sky", "mint", "amber", "violet", "teal", "peach", "slate", "lime", "sand"] as const;

interface CategoryBreakdownChartProps {
  breakdown: SalesCategoryBreakdown[];
  valueFormatter: (value: number) => string;
  quantityFormatter: (value: number) => string;
}

interface CategoryChartRow extends SalesCategoryBreakdown {
  label: string;
  quantity: number;
}

function formatPercent(value: number): string {
  return `${(value * 100).toLocaleString("zh-TW", { maximumFractionDigits: 1 })}%`;
}

function aggregateParentRows(breakdown: SalesCategoryBreakdown[]): CategoryChartRow[] {
  const grouped = new Map<string, CategoryChartRow>();
  for (const row of breakdown) {
    const label = row.categoryParent ?? row.category;
    const current = grouped.get(label);
    if (current) {
      current.value += row.value;
      current.share += row.share;
      current.quantityShare += row.quantityShare;
      current.grossQuantity += row.grossQuantity;
      current.returnQuantity += row.returnQuantity;
      current.netQuantity += row.netQuantity;
      current.quantity += row.netQuantity;
      continue;
    }
    grouped.set(label, {
      ...row,
      category: label,
      categoryParent: null,
      label,
      quantity: row.netQuantity,
    });
  }
  return [...grouped.values()].sort((left, right) => right.quantity - left.quantity);
}

function CategoryLegend({
  payload,
  rows,
}: {
  payload?: readonly ChartLegendEntry[];
  rows: CategoryChartRow[];
}) {
  return (
    <AnalyticsLegend
      payload={payload}
      formatValue={(value) => {
        const row = rows.find((item) => item.label === value);
        return <>{value} <b>{formatPercent(row?.quantityShare ?? 0)}</b></>;
      }}
    />
  );
}

function chartEntryLabel(entry: unknown): string | null {
  if (!entry || typeof entry !== "object" || !("name" in entry)) return null;
  const name = (entry as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

export function CategoryBreakdownChart({ breakdown, valueFormatter, quantityFormatter }: CategoryBreakdownChartProps) {
  const [selectedParent, setSelectedParent] = useState<string | null>(null);
  const parentRows = useMemo(() => aggregateParentRows(breakdown), [breakdown]);
  const childParentNames = useMemo(
    () => new Set(breakdown.flatMap((row) => row.categoryParent ? [row.categoryParent] : [])),
    [breakdown],
  );
  const activeParent = selectedParent && childParentNames.has(selectedParent) ? selectedParent : null;
  const rows = useMemo(
    () => activeParent
      ? breakdown
        .filter((row) => row.categoryParent === activeParent || (row.categoryParent === null && row.category === activeParent))
        .map((row) => ({ ...row, label: row.category, quantity: row.netQuantity }))
        .sort((left, right) => right.quantity - left.quantity)
      : parentRows,
    [activeParent, breakdown, parentRows],
  );
  const data = rows.map((row) => ({ ...row, label: row.label, quantity: row.netQuantity }));
  const canDrill = !activeParent && childParentNames.size > 0;

  function openChildren(entry: unknown) {
    const label = chartEntryLabel(entry);
    if (canDrill && label && childParentNames.has(label)) setSelectedParent(label);
  }

  return (
    <Panel
      title={activeParent ? `分類銷量佔比・${activeParent}` : "分類銷量佔比"}
      description={activeParent ? "目前顯示子分類；點選返回可回到母分類。" : "以淨銷量呈現母分類占比；點選有子分類的母分類可繼續下鑽。"}
      actions={data.length ? (
        <div className="analytics-panel-actions">
          {activeParent ? <Button variant="link" onClick={() => setSelectedParent(null)}>返回母分類</Button> : null}
          <AnalyticsDataDialog title={activeParent ? `${activeParent}・子分類資料` : "分類銷量資料"} description="依本期淨銷量排序，銷售額僅作參考。">
            <table className="data-table analytics-table">
              <thead><tr><th>分類</th><th className="numeric">淨銷量</th><th className="numeric">銷量佔比</th><th className="numeric">售額（參考）</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.categoryParent ?? "root"}:${row.category}`}>
                    <td data-label="分類" className="cell-strong">{row.category}</td>
                    <td data-label="淨銷量" className="numeric">{quantityFormatter(row.netQuantity)}</td>
                    <td data-label="銷量佔比" className="numeric">{formatPercent(row.quantityShare)}</td>
                    <td data-label="售額（參考）" className="numeric">{valueFormatter(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </AnalyticsDataDialog>
        </div>
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
                cursor={canDrill ? "pointer" : "default"}
                onClick={openChildren}
              >
                {data.map((row, index) => <Cell key={row.label} fill={`var(--color-tone-${TONES[index % TONES.length]})`} />)}
              </Pie>
              <Tooltip
                content={(
                  <AnalyticsTooltip
                    valueFormatter={quantityFormatter}
                    valueMeta={(entry) => {
                      const row = rows.find((item) => item.label === entry.name);
                      return row ? `（佔比 ${formatPercent(row.quantityShare)}）` : null;
                    }}
                  />
                )}
              />
              <Legend content={<CategoryLegend rows={rows} />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      ) : <p className="analytics-chart-empty">本期沒有分類資料。</p>}
    </Panel>
  );
}
