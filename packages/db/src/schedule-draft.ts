// 純排班資料與差異計算，供兩個前台使用；不載入資料庫或 Worker 程式碼。
export interface ScheduleShift { versionId: string; templateId: string; scopeId: string; name: string; dayType: "weekday" | "weekend" | "holiday"; revision: number; startSecond: number; endSecond: number; endDayOffset: number; standardMinutes: number; breakMinutes: number; requiredHeadcount: number }
export interface ScheduleEntry extends ScheduleDraftEntry { scheduleVersionId: string; employmentId: string | null; workerId: string | null; shiftGroupId: string | null; startsAt: string; endsAt: string; standardMinutes: number; breakMinutes: number; requiredHeadcount: number; employeeNumber: string | null; personName: string; scopeName: string; shiftName: string }
export interface ScheduleEmployee { employmentId: string; userId: string; employeeNumber: string; name: string; attendanceMode?: "general" | "scheduled"; monthlyRestDays?: number | null }
export interface ScheduleWorker { id: string; name: string; active: boolean | number }
export interface ScheduleScope { id: string; name: string }
export interface HrScheduleResponse { periodKey: string; period: { start: string; end: string }; version: { id: string; revision: number; status: "published"; locked: boolean; lockedAt: string | null } | null; scopes: ScheduleScope[]; calendar: Array<{ date: string; dayType: ScheduleShift["dayType"]; name: string; specialKind: "none" | "typhoon_stop"; specialScopeIds: string[]; overridden: boolean }>; shifts: ScheduleShift[]; employees: ScheduleEmployee[]; workers: ScheduleWorker[]; entries: ScheduleEntry[] }

export function pickShiftForDay(versions: ScheduleShift[], dayType: ScheduleShift["dayType"]) {
  return versions.find((shift) => shift.dayType === dayType) ?? versions.find((shift) => shift.dayType === "weekday");
}

export function shiftTimeRange(shift: Pick<ScheduleShift, "startSecond" | "endSecond" | "endDayOffset">) {
  const clock = (seconds: number) => `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}`;
  return `${clock(shift.startSecond)}–${clock(shift.endSecond)}${shift.endDayOffset ? " 次日" : ""}`;
}
export interface ScheduleDraftEntry {
  id: string;
  personKind: "employee" | "worker";
  employmentId?: string | null;
  workerId?: string | null;
  scopeId: string;
  shiftVersionId: string;
  workDate: string;
  attendanceStatus: "scheduled" | "present" | "absent";
  archivedAt: string | null;
}

export function outdatedScheduleIds(entries: readonly ScheduleEntry[], shifts: ScheduleShift[], calendar: HrScheduleResponse["calendar"]) {
  const dayTypes = new Map(calendar.map((day) => [day.date, day.dayType]));
  return entries.filter((entry) => {
    if (entry.archivedAt || !entry.startsAt) return false;
    const selected = shifts.find((shift) => shift.versionId === entry.shiftVersionId && shift.scopeId === entry.scopeId);
    const dayType = dayTypes.get(entry.workDate);
    if (!selected || !dayType) return false;
    const applicable = pickShiftForDay(shifts.filter((shift) => shift.templateId === selected.templateId && shift.scopeId === entry.scopeId), dayType);
    if (!applicable) return false;
    const second = (time: string) => Number(time.slice(11, 13)) * 3600 + Number(time.slice(14, 16)) * 60 + Number(time.slice(17, 19));
    return applicable.versionId !== entry.shiftVersionId || applicable.requiredHeadcount !== entry.requiredHeadcount || applicable.standardMinutes !== entry.standardMinutes || applicable.breakMinutes !== entry.breakMinutes || applicable.startSecond !== second(entry.startsAt) || applicable.endSecond !== second(entry.endsAt);
  }).map((entry) => entry.id);
}

function signature(entry: ScheduleDraftEntry) {
  return JSON.stringify([entry.personKind, entry.employmentId ?? null, entry.workerId ?? null, entry.scopeId, entry.shiftVersionId, entry.workDate, entry.attendanceStatus]);
}

export function scheduleChanges(draft: readonly ScheduleDraftEntry[], saved: readonly ScheduleDraftEntry[], refreshIds: string[] = []) {
  const remaining = new Map<string, ScheduleDraftEntry[]>();
  for (const entry of saved) {
    if (entry.archivedAt) continue;
    const key = signature(entry);
    remaining.set(key, [...(remaining.get(key) ?? []), entry]);
  }
  const entries = [];
  for (const entry of draft) {
    if (entry.archivedAt) continue;
    const match = remaining.get(signature(entry));
    if (match?.length) { match.pop(); continue; }
    entries.push({ personKind: entry.personKind, ...(entry.personKind === "employee" ? { employmentId: entry.employmentId! } : { workerId: entry.workerId! }), scopeId: entry.scopeId, shiftVersionId: entry.shiftVersionId, workDate: entry.workDate, attendanceStatus: entry.attendanceStatus });
  }
  const removedIds = [...remaining.values()].flat().map((entry) => entry.id);
  return { entries, removedIds, refreshIds: refreshIds.filter((id) => !removedIds.includes(id) && saved.some((entry) => entry.id === id && !entry.archivedAt)) };
}
