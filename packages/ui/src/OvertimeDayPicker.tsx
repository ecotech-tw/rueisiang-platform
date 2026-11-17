import type { ReactNode } from "react";
import { hoursText, weekdayIndex } from "./overtime-entry.js";

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"] as const;

export interface OvertimePickerDay {
  date: string;
  /** 當天下班時間（台北 `YYYY-MM-DDTHH:mm`），也就是加班的起算點；未排班日由表單另外指定。 */
  startAt: string | null;
  hasExisting: boolean;
}

interface OvertimeDayPickerProps {
  days: readonly OvertimePickerDay[];
  assigned: Readonly<Record<string, number>>;
  disabled?: boolean;
  onToggle: (date: string) => void;
}

/*
 * 格子是可點的列，所以用膠囊以外的小元件圓角，選中走色調容器。
 * 停用（整個月曆停用或當天已申請）優先於選中：已經選了的格子在時數不合法時也要看起來按不下去。
 */
const DAY = "grid min-h-14 content-center justify-items-center gap-0.5 rounded-xl border-none px-0.5 py-1.5 [transition-property:background-color,box-shadow,color,scale] duration-150 [transition-timing-function:ease-out] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary motion-reduce:[transition:none]";
const DAY_ENABLED = "cursor-pointer hover:bg-brand/7 active:[scale:.96] motion-reduce:active:[scale:1]";
const DAY_SURFACE = {
  disabled: "cursor-not-allowed bg-transparent text-muted [box-shadow:none]",
  selected: `bg-brand-soft text-brand-dark [box-shadow:0_0_0_1px_--alpha(var(--color-brand)/28%)_inset] ${DAY_ENABLED}`,
  idle: `bg-paper text-ink [box-shadow:0_0_0_1px_var(--color-soft-line)_inset] ${DAY_ENABLED}`,
};
const DAY_NOTE = "text-[11px] whitespace-nowrap tabular-nums max-[620px]:text-[10px]";

/**
 * 月曆上「點一下就套用目前時數」。不能加班的原因直接寫在格子裡，
 * 不放 tooltip：觸控裝置沒有 hover，那會變成只有一部分人讀得到的資訊。
 */
export function OvertimeDayPicker({ days, assigned, disabled = false, onToggle }: OvertimeDayPickerProps) {
  const leadingBlanks = days[0] ? weekdayIndex(days[0].date) : 0;
  return <div className="grid grid-cols-7 gap-1.5 max-[620px]:gap-1" role="group" aria-label="選擇加班日期">
    {WEEKDAY_LABELS.map((label) => <span key={label} className="pb-0.5 text-center text-[12px] font-medium text-muted" aria-hidden="true">{label}</span>)}
    {Array.from({ length: leadingBlanks }, (_, index) => <span key={`blank-${index}`} aria-hidden="true" />)}
    {days.map((day) => {
      const minutes = assigned[day.date];
      const selected = minutes !== undefined;
      const dayDisabled = disabled || day.hasExisting;
      // 單位另外包起來：手機一格只有四十幾 px，放不下時只藏單位，數字要留著。
      const isUnscheduled = day.startAt === null;
      const [value, unit] = day.hasExisting ? ["已申請", ""] : isUnscheduled ? [selected ? `+${hoursText(minutes)}` : "未排班", selected ? " 小時" : ""] : selected ? [`+${hoursText(minutes)}`, " 小時"] : [day.startAt?.slice(11) ?? "", " 下班"];
      const note = `${DAY_NOTE} ${selected ? "font-bold text-brand-dark" : "text-muted"}`;
      return <button
        key={day.date}
        type="button"
        className={`${DAY} ${DAY_SURFACE[dayDisabled ? "disabled" : selected ? "selected" : "idle"]}`}
        aria-pressed={selected}
        aria-label={`${Number(day.date.slice(5, 7))} 月 ${Number(day.date.slice(8))} 日，${isUnscheduled ? "未排班，" : ""}${value}${unit}`}
        disabled={dayDisabled}
        onClick={() => onToggle(day.date)}
      >
        <strong className="text-[14px] font-bold tabular-nums">{Number(day.date.slice(8))}</strong>
        <small className={note}>{value}{unit ? <span className="max-[620px]:hidden">{unit}</span> : null}</small>
        {isUnscheduled && selected ? <small className={`${note} leading-none`}>未排班</small> : null}
      </button>;
    })}
  </div>;
}

/** 月曆下方的小計（已選幾天、共幾小時）。數字要等寬，改選日期時才不會左右跳。 */
export function OvertimeSummary({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[13px] text-muted tabular-nums [&_strong]:font-bold [&_strong]:text-ink" aria-live="polite">{children}</p>;
}

/** 送出前確認框裡的未排班日期清單。preflight 會清掉清單符號，這裡要自己寫回來。 */
export function OvertimeUnscheduledDates({ dates }: { dates: readonly string[] }) {
  return <ul className="mt-2 grid list-disc gap-1 ps-5">{dates.map((day) => <li key={day} className="tabular-nums">{day}</li>)}</ul>;
}
