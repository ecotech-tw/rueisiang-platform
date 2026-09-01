import { useState, type ReactNode } from "react";
import { Button, Dialog, Tooltip } from "../../../../ui/index.js";

export interface ChartTooltipEntry {
  name?: string;
  value?: unknown;
  color?: string;
  dataKey?: string;
}

export interface ChartTooltipProps {
  active?: boolean;
  label?: unknown;
  payload?: readonly ChartTooltipEntry[];
  /** 同一張圖可能混用不同單位的系列（銷量／金額），所以格式化要看得到 entry。 */
  valueFormatter: (value: number, entry: ChartTooltipEntry) => string;
  valueMeta?: (entry: ChartTooltipEntry) => ReactNode;
}

export function AnalyticsTooltip({ active, label, payload, valueFormatter, valueMeta }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  const entries = payload.filter((entry) => entry.value !== undefined && entry.value !== null);
  if (!entries.length) return null;
  return (
    <div className="analytics-tooltip">
      <strong>{String(label ?? "")}</strong>
      {entries.map((entry) => (
        <div className="analytics-tooltip-row" key={`${entry.dataKey ?? entry.name ?? "value"}`}>
          <span>
            <i style={{ background: entry.color ?? "var(--color-brand)" }} />
            {entry.name ?? "數值"}
          </span>
          <b>
            {valueFormatter(Number(entry.value), entry)}
            {valueMeta?.(entry) ? <span className="analytics-tooltip-meta">{valueMeta(entry)}</span> : null}
          </b>
        </div>
      ))}
    </div>
  );
}

export interface ChartLegendEntry {
  value?: string;
  color?: string;
  dataKey?: string;
}

export interface AnalyticsLegendProps {
  payload?: readonly ChartLegendEntry[];
  formatValue?: (value: string, entry: ChartLegendEntry) => ReactNode;
}

export function AnalyticsLegend({ payload, formatValue }: AnalyticsLegendProps): ReactNode {
  if (!payload?.length) return null;
  return (
    <div className="analytics-legend">
      {payload.map((entry, index) => (
        <span key={`${entry.dataKey ?? entry.value ?? "series"}-${entry.value ?? ""}-${index}`}>
          <i style={{ background: entry.color ?? "var(--color-brand)" }} />
          {formatValue?.(entry.value ?? entry.dataKey ?? "", entry) ?? entry.value ?? entry.dataKey}
        </span>
      ))}
    </div>
  );
}

/**
 * KPI 卡的數字寬度固定不下來（NT$ 加七位數在窄欄一定超出），CSS 只能截斷成
 * 「NT$3,011…」，所以完整值放進 tooltip。
 */
export function AnalyticsKpiValue({ children }: { children: string }) {
  return (
    <Tooltip label={children} className="analytics-kpi-value">
      <strong>{children}</strong>
    </Tooltip>
  );
}

/** KPI 卡下方那行成長率說明，句子比欄寬長，同樣交給 tooltip。 */
export function AnalyticsKpiHint({ children }: { children: string }) {
  return (
    <Tooltip label={children} className="analytics-kpi-hint">
      <small>{children}</small>
    </Tooltip>
  );
}

export interface AnalyticsDataDialogProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  disabled?: boolean;
}

/** 圖表的明細表統一收進 dialog，避免表格高度把瀑布流卡片撐出大片空白。 */
export function AnalyticsDataDialog({ title, description, children, disabled = false }: AnalyticsDataDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="secondary"
        icon="list"
        className="analytics-data-trigger"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        查看資料表
      </Button>
      {open ? (
        <Dialog
          title={title}
          titleMeta={description}
          className="wide analytics-data-dialog"
          bodyClassName="analytics-data-dialog-body"
          onClose={() => setOpen(false)}
        >
          <div className="table-scroll analytics-data-dialog-table">{children}</div>
        </Dialog>
      ) : null}
    </>
  );
}

export function buildBucketKeys(start: string, end: string, granularity: "day" | "month" | "year"): string[] {
  if (start > end) return [];
  const keys: string[] = [];
  if (granularity === "day") {
    const date = new Date(`${start}T00:00:00Z`);
    const last = new Date(`${end}T00:00:00Z`);
    while (date <= last) {
      keys.push(date.toISOString().slice(0, 10));
      date.setUTCDate(date.getUTCDate() + 1);
    }
    return keys;
  }
  const [startYear = 0, startMonth = 1] = start.split("-").map(Number);
  const [endYear = 0, endMonth = 1] = end.split("-").map(Number);
  if (granularity === "year") {
    for (let year = startYear; year <= endYear; year += 1) keys.push(String(year));
    return keys;
  }
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return keys;
}

export function formatBucketLabel(key: string, granularity: "day" | "month" | "year"): string {
  if (granularity === "day") return key.slice(5).replace("-", "/");
  if (granularity === "month") return key.replace("-", "/");
  return key;
}

export function formatCompactValue(value: number): string {
  return value.toLocaleString("zh-TW", { maximumFractionDigits: 0 });
}

/** 金額軸改用「萬」，七位數的完整數字會把刻度撐得比圖還寬。 */
export function formatCompactAmount(value: number): string {
  if (Math.abs(value) < 10000) return formatCompactValue(value);
  return `${(value / 10000).toLocaleString("zh-TW", { maximumFractionDigits: 1 })}萬`;
}
