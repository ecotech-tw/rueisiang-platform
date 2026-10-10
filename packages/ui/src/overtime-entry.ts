/** 與後端 `validateOvertimeInput` 同一個單位；畫面先擋，使用者才不用送出後才知道。 */
export const OVERTIME_UNIT_MINUTES = 30;
export const OVERTIME_HOUR_PRESETS = [0.5, 1, 1.5, 2] as const;
const DAY_MINUTES = 24 * 60;

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** 借 UTC 做進位而已：台北沒有日光節約，本地時間加減分鐘不會有落差。 */
function localTimestamp(value: string) {
  if (!LOCAL_DATE_TIME.test(value)) return null;
  const timestamp = Date.parse(`${value}:00Z`);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function addMinutes(value: string, minutes: number) {
  const timestamp = localTimestamp(value);
  return timestamp === null ? "" : new Date(timestamp + minutes * 60_000).toISOString().slice(0, 16);
}

/** 結束時間只填幾點幾分；早於或等於開始就當成隔天，跨午夜的加班才填得進去。 */
export function minutesUntil(start: string, endTime: string) {
  const end = localTimestamp(`${start.slice(0, 10)}T${endTime}`);
  const begin = localTimestamp(start);
  if (begin === null || end === null) return null;
  const minutes = (end - begin) / 60_000;
  return minutes > 0 ? minutes : minutes + DAY_MINUTES;
}

export function parseHours(text: string) {
  const hours = text.trim() ? Number(text) : NaN;
  return Number.isFinite(hours) && hours > 0 ? Math.round(hours * 60) : null;
}

export function hoursText(minutes: number) {
  return String(Math.round((minutes / 60) * 100) / 100);
}

export function isValidOvertimeMinutes(minutes: number | null): minutes is number {
  return minutes !== null && minutes >= OVERTIME_UNIT_MINUTES && minutes <= DAY_MINUTES && minutes % OVERTIME_UNIT_MINUTES === 0;
}

/** 回傳月初與「下個月月初」；後端的 endsOn 是不含當天的邊界。 */
export function monthRange(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return { startsOn: `${month}-01`, endsOn: new Date(Date.UTC(year, monthIndex + 1, 1)).toISOString().slice(0, 10) };
}

export function nextDate(date: string) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MINUTES * 60_000).toISOString().slice(0, 10);
}

export interface OvertimeEntryDay {
  date: string;
  startAt: string | null;
}

export function selectedUnscheduledDates(days: readonly OvertimeEntryDay[], assigned: Readonly<Record<string, number>>) {
  return days.filter((day) => day.startAt === null && assigned[day.date] !== undefined).map((day) => day.date);
}

export function buildOvertimeEntries(days: readonly OvertimeEntryDay[], assigned: Readonly<Record<string, number>>, unscheduledStartTime: string) {
  return days.flatMap((day) => {
    const minutes = assigned[day.date];
    if (minutes === undefined) return [];
    const startAt = day.startAt ?? (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(unscheduledStartTime) ? `${day.date}T${unscheduledStartTime}` : "");
    const requestedEnd = startAt ? addMinutes(startAt, minutes) : "";
    return requestedEnd ? [{ requestedStart: startAt, requestedEnd }] : [];
  });
}

export function weekdayIndex(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** 「0.5 小時 × 5 天、1 小時 × 5 天」：送出前讓 HR 對一眼，不用自己數格子。 */
export function summarizeAssignments(assigned: Readonly<Record<string, number>>) {
  const groups = new Map<number, number>();
  for (const minutes of Object.values(assigned)) groups.set(minutes, (groups.get(minutes) ?? 0) + 1);
  const entries = [...groups.entries()].sort(([a], [b]) => a - b);
  return {
    days: Object.keys(assigned).length,
    totalMinutes: entries.reduce((total, [minutes, days]) => total + minutes * days, 0),
    breakdown: entries.map(([minutes, days]) => `${hoursText(minutes)} 小時 × ${days} 天`).join("、"),
  };
}
