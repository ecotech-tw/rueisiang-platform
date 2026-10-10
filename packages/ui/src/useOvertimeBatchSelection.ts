import { useCallback, useMemo, useState } from "react";
import type { OvertimePickerDay } from "./OvertimeDayPicker.js";
import { buildOvertimeEntries, isValidOvertimeMinutes, selectedUnscheduledDates, summarizeAssignments } from "./overtime-entry.js";

/**
 * 多日加班「先選時數、再點日期」的選擇狀態。後台代登與前台本人申請共用同一份，
 * 兩邊各寫一份時送出條件已經漂移過一次。
 *
 * `minutes` 由呼叫端提供：後台的時數欄位單日與多日共用，不能鎖在這裡。
 */
export function useOvertimeBatchSelection(days: readonly OvertimePickerDay[], minutes: number | null) {
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [unscheduledStartTime, setUnscheduledStartTime] = useState("");

  // 送出被擋下（409）後重抓的班表，可能把選好的日子變成「已有申請」。那一格已經點不掉，
  // 留在送出內容裡會每次重送都再被擋，所以選擇一律以最新的班表為準。
  const takenDates = useMemo(() => days.filter((day) => day.hasExisting && picked[day.date] !== undefined).map((day) => day.date), [days, picked]);
  const assigned = useMemo(() => Object.fromEntries(Object.entries(picked).filter(([date]) => !takenDates.includes(date))), [picked, takenDates]);
  const entries = buildOvertimeEntries(days, assigned, unscheduledStartTime);
  const summary = summarizeAssignments(assigned);
  const unscheduledDates = selectedUnscheduledDates(days, assigned);
  // 任何一天組不出時段就不能送；否則按鈕寫 N 筆、實際少送。
  const complete = summary.days > 0 && entries.length === summary.days;

  const toggleDay = useCallback((date: string) => {
    if (!isValidOvertimeMinutes(minutes)) return;
    setPicked((current) => {
      const next = { ...current };
      if (next[date] === minutes) delete next[date];
      else next[date] = minutes;
      return next;
    });
  }, [minutes]);

  /** 換對象或換月份後，選好的日子屬於上一份班表，留著會送出畫面上看不到的時段。 */
  const reset = useCallback(() => {
    setPicked({});
    setUnscheduledStartTime("");
  }, []);

  return {
    assigned,
    entries,
    summary,
    takenDates,
    unscheduledDates,
    unscheduledStartTime,
    setUnscheduledStartTime,
    missingUnscheduledStart: unscheduledDates.length > 0 && !complete,
    complete,
    toggleDay,
    reset,
  };
}
