import type { ReactNode } from "react";

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
  valueFormatter: (value: number) => string;
}

export function AnalyticsTooltip({ active, label, payload, valueFormatter }: ChartTooltipProps) {
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
          <b>{valueFormatter(Number(entry.value))}</b>
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

export function AnalyticsLegend({ payload }: { payload?: readonly ChartLegendEntry[] }): ReactNode {
  if (!payload?.length) return null;
  return (
    <div className="analytics-legend">
      {payload.map((entry) => (
        <span key={`${entry.dataKey ?? entry.value ?? "series"}`}>
          <i style={{ background: entry.color ?? "var(--color-brand)" }} />
          {entry.value ?? entry.dataKey}
        </span>
      ))}
    </div>
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
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(granularity === "month" ? `${year}-${String(month).padStart(2, "0")}` : String(year));
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
