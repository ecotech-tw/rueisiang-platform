import { describe, expect, it } from "vitest";
import { firstQuickPersonId, outdatedScheduleShiftCount, sameDayMultiScopeSchedules } from "./Scheduling.js";
import type { HrCalendarDay, ScheduleEntry, ScheduleShift } from "./api.js";

describe("同日跨據點排班提醒", () => {
  const entry = (overrides: Partial<{ personKind: "employee" | "worker"; employmentId: string | null; workerId: string | null; workDate: string; scopeId: string; scopeName: string; personName: string; archivedAt: string | null }> = {}) => ({
    personKind: "employee" as const, employmentId: "employment-1", workerId: null, workDate: "2026-09-30", scopeId: "scope-a", scopeName: "西門櫃", personName: "王小明", archivedAt: null, ...overrides,
  });

  it("只提醒同一人同一天出現在多個據點，且忽略封存排班", () => {
    expect(sameDayMultiScopeSchedules([
      entry(),
      entry({ scopeId: "scope-b", scopeName: "信義櫃" }),
      entry({ workDate: "2026-10-01", scopeId: "scope-b", scopeName: "信義櫃" }),
      entry({ personKind: "worker", employmentId: null, workerId: "worker-1", scopeId: "scope-b", scopeName: "信義櫃", personName: "支援人員" }),
      entry({ scopeId: "scope-c", scopeName: "封存櫃", archivedAt: "2026-09-01" }),
    ])).toEqual([expect.objectContaining({ personId: "employment-1", personName: "王小明", workDate: "2026-09-30", scopeNames: ["西門櫃", "信義櫃"] })]);
  });
});

describe("已發布排班的日型與需求人力更新提示", () => {
  const shifts: ScheduleShift[] = [
    { versionId: "weekday", templateId: "early", scopeId: "scope", name: "早班", dayType: "weekday", revision: 2, startSecond: 32_400, endSecond: 64_800, endDayOffset: 0, standardMinutes: 480, breakMinutes: 60, requiredHeadcount: 1 },
    { versionId: "weekend", templateId: "early", scopeId: "scope", name: "早班", dayType: "weekend", revision: 2, startSecond: 32_400, endSecond: 64_800, endDayOffset: 0, standardMinutes: 480, breakMinutes: 60, requiredHeadcount: 2 },
  ];
  const calendar: HrCalendarDay[] = [{ date: "2026-09-05", dayType: "weekend", name: "", specialKind: "none", specialScopeIds: [], overridden: false }];
  const entry = (patch: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
    id: "entry", scheduleVersionId: "published", personKind: "employee", employmentId: "employee", workerId: null, scopeId: "scope", shiftVersionId: "weekday", shiftGroupId: "group", workDate: "2026-09-05", startsAt: "2026-09-05 09:00:00", endsAt: "2026-09-05 18:00:00", standardMinutes: 480, breakMinutes: 60, requiredHeadcount: 1, attendanceStatus: "scheduled", employeeNumber: "E1", personName: "測試", archivedAt: null, scopeName: "據點", shiftName: "早班", ...patch,
  });

  it("週末仍用平日版或同版本人力快照不同時，提示並允許重新儲存", () => {
    expect(outdatedScheduleShiftCount([entry(), entry({ shiftVersionId: "weekend" }), entry({ shiftVersionId: "weekend", requiredHeadcount: 2 })], shifts, calendar)).toBe(2);
  });

  it("新草稿與封存歷史不列為需更新的已發布快照", () => {
    expect(outdatedScheduleShiftCount([entry({ startsAt: "" }), entry({ archivedAt: "2026-09-01" })], shifts, calendar)).toBe(0);
  });

  it("未設定週末時正確沿用平日；沒有該日行事曆不猜日型", () => {
    expect(outdatedScheduleShiftCount([entry()], shifts.slice(0, 1), calendar)).toBe(0);
    expect(outdatedScheduleShiftCount([entry()], shifts, [])).toBe(0);
  });
});

describe("快速排班的人員預設值", () => {
  const data = {
    employees: [{ employmentId: "employment-1" }],
    workers: [{ id: "worker-1" }],
  };

  it("切換到臨時支援時記住第一位支援人員", () => {
    expect(firstQuickPersonId(data, "worker")).toBe("worker-1");
  });

  it("切換回正式員工時沿用第一位員工，沒有名單則保持空值", () => {
    expect(firstQuickPersonId(data, "employee")).toBe("employment-1");
    expect(firstQuickPersonId({ employees: [], workers: [] }, "worker")).toBe("");
  });
});
