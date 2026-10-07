import { hoursText, weekdayIndex } from "./overtime-entry.js";

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"] as const;

export interface OvertimePickerDay {
  date: string;
  /** 當天下班時間（台北 `YYYY-MM-DDTHH:mm`），也就是加班的起算點；沒有排班時為 null。 */
  startAt: string | null;
  hasExisting: boolean;
}

interface OvertimeDayPickerProps {
  days: readonly OvertimePickerDay[];
  assigned: Readonly<Record<string, number>>;
  disabled?: boolean;
  onToggle: (date: string) => void;
}

/**
 * 月曆上「點一下就套用目前時數」。不能加班的原因直接寫在格子裡，
 * 不放 tooltip：觸控裝置沒有 hover，那會變成只有一部分人讀得到的資訊。
 */
export function OvertimeDayPicker({ days, assigned, disabled = false, onToggle }: OvertimeDayPickerProps) {
  const leadingBlanks = days[0] ? weekdayIndex(days[0].date) : 0;
  return <div className="hr-overtime-days" role="group" aria-label="選擇加班日期">
    {WEEKDAY_LABELS.map((label) => <span key={label} className="hr-overtime-weekday" aria-hidden="true">{label}</span>)}
    {Array.from({ length: leadingBlanks }, (_, index) => <span key={`blank-${index}`} aria-hidden="true" />)}
    {days.map((day) => {
      const minutes = assigned[day.date];
      const selected = minutes !== undefined;
      // 單位另外包起來：手機一格只有四十幾 px，放不下時只藏單位，數字要留著。
      const [value, unit] = day.hasExisting ? ["已加班", ""] : day.startAt === null ? ["未排班", ""] : selected ? [`+${hoursText(minutes)}`, " 小時"] : [day.startAt.slice(11), " 下班"];
      return <button
        key={day.date}
        type="button"
        className={`hr-overtime-day${selected ? " selected" : ""}`}
        aria-pressed={selected}
        aria-label={`${Number(day.date.slice(5, 7))} 月 ${Number(day.date.slice(8))} 日，${value}${unit}`}
        disabled={disabled || day.hasExisting || day.startAt === null}
        onClick={() => onToggle(day.date)}
      >
        <strong>{Number(day.date.slice(8))}</strong>
        <small>{value}{unit ? <span className="hr-overtime-day-unit">{unit}</span> : null}</small>
      </button>;
    })}
  </div>;
}
