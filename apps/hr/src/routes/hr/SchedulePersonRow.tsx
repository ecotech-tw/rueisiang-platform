import type { ReactNode } from "react";

/** 排班管理與本人排班共用的人員明細列，避免 Dialog 內各自長出不同間距與結構。 */
export function SchedulePersonRow({ title, details, trailing, highlighted = false }: { title: ReactNode; details: ReactNode; trailing?: ReactNode; highlighted?: boolean }) {
  return <div className="flex min-w-0 items-center justify-between gap-2 py-2">
    <div className="grid min-w-0 gap-0.5">
      <strong className={`break-words ${highlighted ? "text-brand-dark" : ""}`}>{title}</strong>
      <small className="text-muted">{details}</small>
    </div>
    {trailing ? <div className="shrink-0">{trailing}</div> : null}
  </div>;
}
