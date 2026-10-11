import { createDatabase, listHrSelfToolOvertimeRequests, listHrSelfToolSchedule, listHrToolCalendar, syncSystemRoles } from "@rueisiang/db";
import {
  hrCalendarDayScopes, hrCalendarDays, hrEmploymentAttendanceSettings, hrEmployments, hrOvertimeRequests,
  hrScheduleEntries, hrScheduleVersions, hrShiftTemplates, hrShiftVersions, scopes, users,
} from "@rueisiang/db/schema";
import { HR_TOOL_DEFINITIONS, isHrToolKey, PLATFORM_TOOL_MAP, toolKeysForLineSource } from "@rueisiang/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

// 台北 2026-03-02（週一）08:00。
const NOW = Date.parse("2026-03-02T00:00:00Z");
let d1: LocalD1;
const db = () => createDatabase(d1 as never);

beforeEach(async () => {
  d1 = createLocalD1();
  await syncSystemRoles(db());
  await db().insert(users).values(["admin", "alice", "bob"].map((id) => ({ id, email: `${id}@example.test`, displayName: id, status: "active" })));
  for (const id of ["alice", "bob"]) {
    await db().insert(hrEmployments).values({ id: `employment-${id}`, employeeUserId: id, employeeNumber: id, legalName: `員工-${id}` });
  }
  await db().insert(hrEmploymentAttendanceSettings).values([
    { employmentId: "employment-alice", attendanceMode: "scheduled" },
    { employmentId: "employment-bob", attendanceMode: "general" },
  ]);
  await db().insert(scopes).values({ id: "scope-ximen", sourceType: "manual", scopeKind: "store", name: "西門店", normalizedName: "西門店" });
});
afterEach(() => { d1.sqlite.close(); });

describe("小香 HR 工具：本人加班申請", () => {
  beforeEach(async () => {
    const base = { settlementKind: "pay" as const, reason: "不應回傳的加班原因" };
    await db().insert(hrOvertimeRequests).values([
      // 台北 03-03 18:00–20:00，待審。
      { ...base, id: "ot-alice-pending", employmentId: "employment-alice", requestedStart: "2026-03-03 10:00:00", requestedEnd: "2026-03-03 12:00:00", status: "pending", createdBy: "alice" },
      // 台北 02-20 18:00–20:00，主管只核了一小時。
      { ...base, id: "ot-alice-approved", employmentId: "employment-alice", requestedStart: "2026-02-20 10:00:00", requestedEnd: "2026-02-20 12:00:00", actualStart: "2026-02-20 10:00:00", actualEnd: "2026-02-20 11:00:00", status: "approved", reviewedBy: "admin", reviewedAt: "2026-02-21 01:30:00", createdBy: "alice" },
      // UTC 是 02-28，台北已經是 03-01 01:00–02:00。
      { ...base, id: "ot-alice-midnight", employmentId: "employment-alice", requestedStart: "2026-02-28 17:00:00", requestedEnd: "2026-02-28 18:00:00", status: "rejected", createdBy: "alice" },
      { ...base, id: "ot-bob", employmentId: "employment-bob", requestedStart: "2026-02-20 10:00:00", requestedEnd: "2026-02-20 12:00:00", status: "pending", createdBy: "bob" },
    ]);
  });

  it("只回本人的申請，時間轉成台北時間，核定時段與申請時段分開，不回原因", async () => {
    const result = await listHrSelfToolOvertimeRequests(db(), "alice", {}, NOW);
    expect(result.filters).toEqual({ status: "all", dateField: "work", fromDate: "2026-02-01", toDate: "2026-03-02" });
    expect(result.requests.map((row) => row.id)).toEqual(["ot-alice-midnight", "ot-alice-approved"]);
    expect(result.requests[1]).toMatchObject({
      status: "approved", settlementKind: "pay",
      requestedStart: "2026-02-20 18:00", requestedEnd: "2026-02-20 20:00", requestedMinutes: 120,
      approvedStart: "2026-02-20 18:00", approvedEnd: "2026-02-20 19:00", approvedMinutes: 60,
      reviewedAt: "2026-02-21 09:30",
    });
    expect(result.requests[0]).toMatchObject({ approvedStart: null, approvedEnd: null, approvedMinutes: null, reviewedAt: null });
    expect(JSON.stringify(result)).not.toMatch(/ot-bob|不應回傳/);
  });

  it("沒給日期的 pending 查全部待審，包含未來的加班", async () => {
    const result = await listHrSelfToolOvertimeRequests(db(), "alice", { status: "pending" }, NOW);
    expect(result.filters).toMatchObject({ fromDate: null, toDate: null });
    expect(result.requests.map((row) => row.id)).toEqual(["ot-alice-pending"]);
    expect(result.requests[0]).toMatchObject({ requestedStart: "2026-03-03 18:00", requestedEnd: "2026-03-03 20:00" });
  });

  it("加班日期以台北日界線判斷，跨 UTC 日的不會歸錯天", async () => {
    const ids = async (fromDate: string, toDate: string) =>
      (await listHrSelfToolOvertimeRequests(db(), "alice", { fromDate, toDate }, NOW)).requests.map((row) => row.id);
    expect(await ids("2026-03-01", "2026-03-01")).toEqual(["ot-alice-midnight"]);
    expect(await ids("2026-02-28", "2026-02-28")).toEqual([]);
  });

  it("不完整、倒過來或太長的日期區間與空的本人身分都拒絕", async () => {
    await expect(listHrSelfToolOvertimeRequests(db(), "alice", { fromDate: "2026-03-01" }, NOW)).rejects.toThrow("完整日期區間");
    await expect(listHrSelfToolOvertimeRequests(db(), "alice", { fromDate: "2026-03-02", toDate: "2026-03-01" }, NOW)).rejects.toThrow("366 天");
    await expect(listHrSelfToolOvertimeRequests(db(), "alice", { fromDate: "2025-01-01", toDate: "2026-03-01" }, NOW)).rejects.toThrow("366 天");
    await expect(listHrSelfToolOvertimeRequests(db(), "alice", { dateField: "leave" as never }, NOW)).rejects.toThrow("查詢條件");
    await expect(listHrSelfToolOvertimeRequests(db(), "", {}, NOW)).rejects.toThrow("本人 HR 授權");
  });
});

describe("小香 HR 工具：本人班表", () => {
  beforeEach(async () => {
    await db().insert(hrShiftTemplates).values({ id: "shift-day", code: "DAY", name: "日班", createdBy: "admin" });
    await db().insert(hrShiftVersions).values({ id: "shift-day-v1", shiftTemplateId: "shift-day", versionNumber: 1, startSecond: 2 * 3600, endSecond: 10 * 3600, standardMinutes: 420, breakMinutes: 60, createdBy: "admin" });
    await db().insert(hrScheduleVersions).values([
      { id: "march-v1", periodStart: "2026-03-01", periodEnd: "2026-04-01", versionNumber: 1, status: "published" },
      { id: "march-v2", periodStart: "2026-03-01", periodEnd: "2026-04-01", versionNumber: 2, status: "published" },
      { id: "april-draft", periodStart: "2026-04-01", periodEnd: "2026-05-01", versionNumber: 1, status: "draft" },
    ]);
    const entry = (id: string, scheduleVersionId: string, employmentId: string, workDate: string) => ({
      id, scheduleVersionId, employmentId, scopeId: "scope-ximen", shiftVersionId: "shift-day-v1", workDate,
      startsAt: `${workDate} 02:00:00`, endsAt: `${workDate} 10:00:00`, standardMinutes: 420, breakMinutes: 60, createdBy: "admin",
    });
    await db().insert(hrScheduleEntries).values([
      entry("old-0303", "march-v1", "employment-alice", "2026-03-03"),
      entry("new-0304", "march-v2", "employment-alice", "2026-03-04"),
      entry("new-0331", "march-v2", "employment-alice", "2026-03-31"),
      entry("draft-0401", "april-draft", "employment-alice", "2026-04-01"),
      entry("bob-0304", "march-v2", "employment-bob", "2026-03-04"),
    ]);
    await db().insert(hrCalendarDays).values({ date: "2026-03-04", dayType: "holiday", name: "測試假日", updatedBy: "admin" });
  });

  it("預設查今天起 14 天，只認最新的已發布版，時間是台北時間並帶日型", async () => {
    const result = await listHrSelfToolSchedule(db(), "alice", {}, NOW);
    expect(result).toMatchObject({ fromDate: "2026-03-02", toDate: "2026-03-15", attendanceMode: "scheduled" });
    expect(result.days).toHaveLength(14);
    expect(result.days[0]).toEqual({ date: "2026-03-02", weekday: "週一", dayType: "weekday", holidayName: "", schedulePublished: true, shifts: [] });
    // 03-03 只存在被取代的舊版裡。
    expect(result.days[1]!.shifts).toEqual([]);
    expect(result.days[2]).toEqual({
      date: "2026-03-04", weekday: "週三", dayType: "holiday", holidayName: "測試假日", schedulePublished: true,
      shifts: [{ scopeName: "西門店", shiftName: "日班", startsAt: "2026-03-04 10:00", endsAt: "2026-03-04 18:00", breakMinutes: 60 }],
    });
    expect(result.days[5]).toMatchObject({ date: "2026-03-07", weekday: "週六", dayType: "weekend" });
  });

  it("還沒發布的期間標成未發布，草稿裡的班不會露出來", async () => {
    const result = await listHrSelfToolSchedule(db(), "alice", { fromDate: "2026-03-31", toDate: "2026-04-01" }, NOW);
    expect(result.days.map((day) => [day.date, day.schedulePublished, day.shifts.length])).toEqual([["2026-03-31", true, 1], ["2026-04-01", false, 0]]);
    expect(result.note).toContain("尚未發布");
  });

  it("不是排班制的員工明講沒有逐日班表，也拿不到別人的班", async () => {
    await db().delete(hrScheduleEntries);
    const result = await listHrSelfToolSchedule(db(), "bob", { fromDate: "2026-03-04", toDate: "2026-03-04" }, NOW);
    expect(result.attendanceMode).toBe("general");
    expect(result.days[0]!.shifts).toEqual([]);
    expect(result.note).toContain("不是排班制");
    expect((await listHrSelfToolSchedule(db(), "admin", {}, NOW)).attendanceMode).toBe("unknown");
  });

  it("封存的任職不再出現在班表，區間最多 62 天", async () => {
    await db().update(hrEmployments).set({ archivedAt: "2026-03-01" });
    expect((await listHrSelfToolSchedule(db(), "alice", {}, NOW)).days.every((day) => day.shifts.length === 0)).toBe(true);
    await expect(listHrSelfToolSchedule(db(), "alice", { fromDate: "2026-03-01", toDate: "2026-05-02" }, NOW)).rejects.toThrow("62 天");
    await expect(listHrSelfToolSchedule(db(), "alice", { toDate: "2026-03-01" }, NOW)).rejects.toThrow("完整日期區間");
  });
});

describe("小香 HR 工具：公司行事曆", () => {
  beforeEach(async () => {
    await db().insert(hrCalendarDays).values([
      { date: "2026-03-04", dayType: "holiday", name: "測試假日", updatedBy: "admin" },
      { date: "2026-03-07", dayType: "weekday", name: "補班", updatedBy: "admin" },
      { date: "2026-03-10", dayType: "weekday", name: "颱風", specialKind: "typhoon_stop", updatedBy: "admin" },
      { date: "2026-03-11", dayType: "weekday", name: "颱風", specialKind: "typhoon_stop", updatedBy: "admin" },
    ]);
    await db().insert(hrCalendarDayScopes).values({ date: "2026-03-10", scopeId: "scope-ximen" });
  });

  it("只列出跟星期推算不同的日子，補班日與停班據點分開標", async () => {
    const result = await listHrToolCalendar(db(), {}, NOW);
    expect(result).toMatchObject({ fromDate: "2026-03-02", toDate: "2026-04-30", note: "" });
    expect(result.days).toEqual([
      { date: "2026-03-04", weekday: "週三", dayType: "holiday", name: "測試假日", makeupWorkday: false, stopWork: null },
      { date: "2026-03-07", weekday: "週六", dayType: "weekday", name: "補班", makeupWorkday: true, stopWork: null },
      { date: "2026-03-10", weekday: "週二", dayType: "weekday", name: "颱風", makeupWorkday: false, stopWork: ["西門店"] },
      { date: "2026-03-11", weekday: "週三", dayType: "weekday", name: "颱風", makeupWorkday: false, stopWork: "all" },
    ]);
  });

  it("整段沒有設定時提醒可能還沒匯入，區間最多 366 天", async () => {
    const empty = await listHrToolCalendar(db(), { fromDate: "2027-01-01", toDate: "2027-12-31" }, NOW);
    expect(empty.days).toEqual([]);
    expect(empty.note).toContain("還沒匯入");
    await expect(listHrToolCalendar(db(), { fromDate: "2026-01-01", toDate: "2027-01-02" }, NOW)).rejects.toThrow("366 天");
  });

  it("不是本人工具：群組也能用、不需要授權服務，但一樣不接受多餘參數", async () => {
    const tool = PLATFORM_TOOL_MAP.get("hr_get_calendar")!;
    expect(isHrToolKey("hr_get_calendar")).toBe(false);
    expect(toolKeysForLineSource(["hr_get_calendar", "hr_get_my_schedule", "hr_get_my_overtime_requests"], "group")).toEqual(["hr_get_calendar"]);
    const result = JSON.parse(await tool.execute({ fromDate: "2026-03-04", toDate: "2026-03-04" }, { surface: "line", lineSourceType: "group", db: db() }));
    expect(result.days).toHaveLength(1);
    await expect(tool.execute({ userId: "alice" }, { surface: "sandbox", db: db() })).rejects.toThrow("未定義的參數");
    await expect(tool.execute({ fromDate: 20260304 }, { surface: "sandbox", db: db() })).rejects.toThrow("參數格式");
    await expect(tool.execute({}, { surface: "sandbox" })).rejects.toThrow("資料來源");
  });
});

describe("小香 HR 工具：本人工具的入口", () => {
  it("加班與班表屬於本人 HR 工具：只限私訊、要授權服務、不能指定查詢對象", async () => {
    const keys = HR_TOOL_DEFINITIONS.map((tool) => tool.key);
    expect(keys).toEqual(["hr_authorize", "hr_get_my_leave_requests", "hr_get_my_annual_leave", "hr_get_my_overtime_requests", "hr_get_my_schedule"]);
    const calls: unknown[] = [];
    const hrSelf = {
      authorize: async () => ({}), leaveRequests: async () => ({}), annualLeave: async () => ({}),
      overtimeRequests: async (query: unknown) => { calls.push(["overtime", query]); return { requests: [] }; },
      schedule: async (query: unknown) => { calls.push(["schedule", query]); return { days: [] }; },
    };
    const context = { surface: "line", lineSourceType: "user", services: { hrSelf } } as const;
    for (const key of ["hr_get_my_overtime_requests", "hr_get_my_schedule"]) {
      const tool = PLATFORM_TOOL_MAP.get(key)!;
      expect(isHrToolKey(key)).toBe(true);
      expect(tool.lineSourceTypes).toEqual(["user"]);
      await tool.execute({ fromDate: "2026-03-01", toDate: "2026-03-02" }, context);
      await expect(tool.execute({ employeeUserId: "bob" }, context)).rejects.toThrow("不接受查詢對象");
      await expect(tool.execute({ fromDate: 1 }, context)).rejects.toThrow("參數格式");
      await expect(tool.execute({}, { surface: "line", lineSourceType: "group", services: { hrSelf } })).rejects.toThrow("僅限 LINE 本人私訊");
      await expect(tool.execute({}, { surface: "sandbox" })).rejects.toThrow("授權服務不可用");
    }
    expect(calls).toEqual([
      ["overtime", { fromDate: "2026-03-01", toDate: "2026-03-02" }],
      ["schedule", { fromDate: "2026-03-01", toDate: "2026-03-02" }],
    ]);
  });
});
