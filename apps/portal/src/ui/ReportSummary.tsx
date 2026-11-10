import type { ReactNode } from "react";

export interface ReportSummaryItem {
  label: string;
  value: ReactNode;
}

export function ReportSummary({ items }: { items: readonly ReportSummaryItem[] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {items.map(({ label, value }) => (
        <div key={label} className="flex min-w-0 flex-col gap-1 rounded-[12px] bg-canvas/74 p-3">
          <dt className="text-[12px] font-semibold text-muted">{label}</dt>
          <dd className="m-0 break-words text-[18px] font-semibold tabular-nums text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
