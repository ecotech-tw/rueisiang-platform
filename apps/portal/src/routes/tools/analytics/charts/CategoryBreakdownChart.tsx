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
  amount: number;
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
      current.amount += row.value;
      continue;
    }
    grouped.set(label, {
      ...row,
      category: label,
      categoryParent: null,
      label,
      quantity: row.netQuantity,
      amount: row.value,
    });
  }
  return [...grouped.values()].sort((left, right) => right.quantity - left.quantity);
}

function CategoryLegend({
  payload,
  rows,
  shareKey,
  canDrill,
  childParentNames,
  onSelectParent,
}: {
  payload?: readonly ChartLegendEntry[];
  rows: CategoryChartRow[];
  shareKey: "quantityShare" | "share";
  canDrill: boolean;
  childParentNames: ReadonlySet<string>;
  onSelectParent: (parent: string) => void;
}) {
  return (
    <AnalyticsLegend
      payload={payload}
      formatValue={(value) => {
        const row = rows.find((item) => item.label === value);
        return <>{value} <b>{formatPercent(row?.[shareKey] ?? 0)}</b></>;
      }}
      selectableValue={(value) => canDrill && childParentNames.has(value)}
      onSelectValue={(value) => onSelectParent(value)}
    />
  );
}

function CategoryPie({
  title,
  ariaLabel,
  dataKey,
  shareKey,
  valueFormatter,
  selectedParent,
  parentRows,
  breakdown,
  childParentNames,
  onSelectParent,
}: {
  title: string;
  ariaLabel: string;
  dataKey: "quantity" | "amount";
  shareKey: "quantityShare" | "share";
  valueFormatter: (value: number) => string;
  selectedParent: string | null;
  parentRows: CategoryChartRow[];
  breakdown: SalesCategoryBreakdown[];
  childParentNames: ReadonlySet<string>;
  onSelectParent: (parent: string | null) => void;
}) {
  const activeParent = selectedParent && childParentNames.has(selectedParent) ? selectedParent : null;
  const rows = activeParent
    ? breakdown
      .filter((row) => row.categoryParent === activeParent || (row.categoryParent === null && row.category === activeParent))
      .map((row) => ({ ...row, label: row.category, quantity: row.netQuantity, amount: row.value }))
      .sort((left, right) => right[dataKey] - left[dataKey])
    : [...parentRows].sort((left, right) => right[dataKey] - left[dataKey]);
  const canDrill = !activeParent && childParentNames.size > 0;

  function openChildren(entry: unknown) {
    const label = chartEntryLabel(entry);
    if (canDrill && label && childParentNames.has(label)) onSelectParent(label);
  }

  return (
    <div className="analytics-category-chart-card">
      <div className="analytics-category-chart-heading">
        <h3>{activeParent ? `${title}・${activeParent}` : title}</h3>
        {activeParent ? <Button variant="link" onClick={() => onSelectParent(null)}>返回母分類</Button> : null}
      </div>
      <div className="analytics-chart analytics-category-chart" role="img" aria-label={ariaLabel}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows}
              dataKey={dataKey}
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
              {rows.map((row, index) => <Cell key={row.label} fill={`var(--color-tone-${TONES[index % TONES.length]})`} />)}
            </Pie>
            <Tooltip
              content={(
                <AnalyticsTooltip
                  valueFormatter={valueFormatter}
                  valueMeta={(entry) => {
                    const row = rows.find((item) => item.label === entry.name);
                    return row ? `（佔比 ${formatPercent(row[shareKey])}）` : null;
                  }}
                />
              )}
            />
            <Legend
              content={(
                <CategoryLegend
                  rows={rows}
                  shareKey={shareKey}
                  canDrill={canDrill}
                  childParentNames={childParentNames}
                  onSelectParent={onSelectParent}
                />
              )}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function chartEntryLabel(entry: unknown): string | null {
  if (!entry || typeof entry !== "object" || !("name" in entry)) return null;
  const name = (entry as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

export function CategoryBreakdownChart({ breakdown, valueFormatter, quantityFormatter }: CategoryBreakdownChartProps) {
  const [quantityParent, setQuantityParent] = useState<string | null>(null);
  const [amountParent, setAmountParent] = useState<string | null>(null);
  const parentRows = useMemo(() => aggregateParentRows(breakdown), [breakdown]);
  const childParentNames = useMemo(
    () => new Set(breakdown.flatMap((row) => row.categoryParent ? [row.categoryParent] : [])),
    [breakdown],
  );

  return (
    <Panel
      title="分類銷量與銷售額佔比"
      description="同時呈現母分類在本期淨銷量與銷售額的占比；兩張圖可各自點選有子分類的母分類下鑽。"
      actions={parentRows.length ? (
        <AnalyticsDataDialog title="分類銷量與銷售額資料" description="依本期淨銷量排序，並列銷售額佔比。">
          <table className="data-table analytics-table">
            <thead><tr><th>分類</th><th className="numeric">淨銷量</th><th className="numeric">銷量佔比</th><th className="numeric">銷售額</th><th className="numeric">銷售額佔比</th></tr></thead>
            <tbody>
              {parentRows.map((row) => (
                <tr key={`${row.categoryParent ?? "root"}:${row.category}`}>
                  <td data-label="分類" className="cell-strong">{row.category}</td>
                  <td data-label="淨銷量" className="numeric">{quantityFormatter(row.netQuantity)}</td>
                  <td data-label="銷量佔比" className="numeric">{formatPercent(row.quantityShare)}</td>
                  <td data-label="銷售額" className="numeric">{valueFormatter(row.value)}</td>
                  <td data-label="銷售額佔比" className="numeric">{formatPercent(row.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AnalyticsDataDialog>
      ) : null}
      className="analytics-chart-panel analytics-category-panel"
    >
      {parentRows.length ? (
        <div className="analytics-category-chart-duo">
          <CategoryPie
            title="分類銷量"
            ariaLabel="商品分類淨銷量佔比圖"
            dataKey="quantity"
            shareKey="quantityShare"
            valueFormatter={quantityFormatter}
            selectedParent={quantityParent}
            parentRows={parentRows}
            breakdown={breakdown}
            childParentNames={childParentNames}
            onSelectParent={setQuantityParent}
          />
          <CategoryPie
            title="分類銷售額"
            ariaLabel="商品分類銷售額佔比圖"
            dataKey="amount"
            shareKey="share"
            valueFormatter={valueFormatter}
            selectedParent={amountParent}
            parentRows={parentRows}
            breakdown={breakdown}
            childParentNames={childParentNames}
            onSelectParent={setAmountParent}
          />
        </div>
      ) : <p className="analytics-chart-empty">本期沒有分類資料。</p>}
    </Panel>
  );
}
