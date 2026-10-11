import { createDatabase, listHrSelfToolOvertimeRequests, listHrSelfToolSchedule, listHrToolCalendar, syncSystemRoles } from "@rueisiang/db";
import {
  hrCalendarDayScopes, hrCalendarDays, hrEmploymentAttendanceSettings, hrEmployments, hrLeaveRequests, hrLeaveTypes, hrOvertimeRequests,
  hrScheduleEntries, hrScheduleVersions, hrShiftTemplates, hrShiftVersions, scopes, users,
} from "@rueisiang/db/schema";
import { HR_TOOL_DEFINITIONS, isHrToolKey, PLATFORM_TOOL_MAP, toolKeysForLineSource } from "@rueisiang/tools";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";

// 台北 2026-03-02（週一）08:00。
const NOW = Date.parse("2026-03-02T00:00:00Z");
let d1: LocalD1;
const db = () => createDatabase(d1 as never);
const shiftDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

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
    // 依加班日期查的預設區間是今天前後各 30 天：加班多半事前申請，未來的也要查得到。
    expect(result.filters).toEqual({ status: "all", dateField: "work", fromDate: "2026-01-31", toDate: "2026-04-01" });
    expect(result.requests.map((row) => row.id)).toEqual(["ot-alice-pending", "ot-alice-midnight", "ot-alice-approved"]);
    expect(result.requests[2]).toMatchObject({
      status: "approved", settlementKind: "pay",
      requestedStart: "2026-02-20 18:00", requestedEnd: "2026-02-20 20:00", requestedMinutes: 120,
      approvedStart: "2026-02-20 18:00", approvedEnd: "2026-02-20 19:00", approvedMinutes: 60,
      reviewedAt: "2026-02-21 09:30",
    });
    expect(result.requests[0]).toMatchObject({ status: "pending", requestedStart: "2026-03-03 18:00", approvedStart: null, approvedEnd: null, approvedMinutes: null, reviewedAt: null });
    expect(JSON.stringify(result)).not.toMatch(/ot-bob|不應回傳/);
  });

  it("未來已核准的加班不帶日期也查得到；依申請日期查時預設只回溯 30 天", async () => {
    await db().insert(hrOvertimeRequests).values({
      id: "ot-alice-saturday", employmentId: "employment-alice", requestedStart: "2026-03-07 02:00:00", requestedEnd: "2026-03-07 04:00:00",
      actualStart: "2026-03-07 02:00:00", actualEnd: "2026-03-07 04:00:00", settlementKind: "compensatory", status: "approved", createdBy: "alice",
    });
    const approved = await listHrSelfToolOvertimeRequests(db(), "alice", { status: "approved" }, NOW);
    expect(approved.requests.map((row) => row.id)).toEqual(["ot-alice-saturday", "ot-alice-approved"]);
    const submitted = await listHrSelfToolOvertimeRequests(db(), "alice", { dateField: "submitted" }, Date.now());
    expect(submitted.filters.toDate).toBe(submitted.asOfDate);
    expect(submitted.total).toBe(4);
  });

  it("加班沒有 cancelled 與 draft：取消是直接刪掉，查這兩個狀態直接拒絕而不是回空的", async () => {
    await expect(listHrSelfToolOvertimeRequests(db(), "alice", { status: "cancelled" as never }, NOW)).rejects.toThrow("查詢條件");
    await expect(listHrSelfToolOvertimeRequests(db(), "alice", { status: "draft" as never }, NOW)).rejects.toThrow("查詢條件");
    const schema = PLATFORM_TOOL_MAP.get("hr_get_my_overtime_requests")!.parameters.properties.status!;
    expect(schema.enum).toEqual(["all", "pending", "approved", "rejected"]);
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
    expect(result.days[0]).toEqual({ date: "2026-03-02", weekday: "週一", dayType: "weekday", holidayName: "", stopWork: null, scheduleStatus: "assigned", leaves: [], shifts: [] });
    // 03-03 只存在被取代的舊版裡。
    expect(result.days[1]!.shifts).toEqual([]);
    expect(result.days[2]).toEqual({
      date: "2026-03-04", weekday: "週三", dayType: "holiday", holidayName: "測試假日", stopWork: null, scheduleStatus: "assigned", leaves: [],
      shifts: [{ scopeName: "西門店", shiftName: "日班", startsAt: "2026-03-04 10:00", endsAt: "2026-03-04 18:00", breakMinutes: 60 }],
    });
    expect(result.days[5]).toMatchObject({ date: "2026-03-07", weekday: "週六", dayType: "weekend" });
  });

  it("還沒發布的期間標成未發布，草稿裡的班不會露出來", async () => {
    const result = await listHrSelfToolSchedule(db(), "alice", { fromDate: "2026-03-31", toDate: "2026-04-01" }, NOW);
    expect(result.days.map((day) => [day.date, day.scheduleStatus, day.shifts.length])).toEqual([["2026-03-31", "assigned", 1], ["2026-04-01", "not_published", 0]]);
    expect(result.note).toContain("還沒發布");
  });

  it("別的據點先發布、還沒排到本人的月份標成 not_assigned，不會被當成整個月沒班", async () => {
    await db().insert(users).values({ id: "carol", email: "carol@example.test", displayName: "carol", status: "active" });
    await db().insert(hrEmployments).values({ id: "employment-carol", employeeUserId: "carol", employeeNumber: "carol", legalName: "員工-carol" });
    await db().insert(hrEmploymentAttendanceSettings).values({ employmentId: "employment-carol", attendanceMode: "scheduled" });
    const carol = await listHrSelfToolSchedule(db(), "carol", { fromDate: "2026-03-02", toDate: "2026-03-03" }, NOW);
    expect(carol.days.map((day) => day.scheduleStatus)).toEqual(["not_assigned", "not_assigned"]);
    // alice 03-02、03-03 沒有班，但她這個月有被排到，所以是真的沒排班。
    const alice = await listHrSelfToolSchedule(db(), "alice", { fromDate: "2026-03-02", toDate: "2026-03-03" }, NOW);
    expect(alice.days.map((day) => [day.scheduleStatus, day.shifts.length])).toEqual([["assigned", 0], ["assigned", 0]]);
    // 只存在被取代舊版裡的人，也算還沒排到。
    await db().delete(hrScheduleEntries).where(eq(hrScheduleEntries.scheduleVersionId, "march-v2"));
    expect((await listHrSelfToolSchedule(db(), "alice", { fromDate: "2026-03-03", toDate: "2026-03-03" }, NOW)).days[0]).toMatchObject({ scheduleStatus: "not_assigned", shifts: [] });
  });

  it("當天核准或待審的假跟班次一起回，駁回與別人的假不出現", async () => {
    await db().insert(hrLeaveTypes).values({ id: "leave-type", name: "測試假", leaveKind: "other", createdBy: "admin" });
    const leave = (id: string, employmentId: string, status: "approved" | "pending" | "rejected", day: string, next: string) => ({
      id, employmentId, leaveTypeId: "leave-type", leaveType: "測試假", status,
      // 台北當天 00:00 到隔天 00:00 的整天假。
      startsAt: `${shiftDay(day)} 16:00:00`, endsAt: `${day} 16:00:00`, startsOn: day, endsOn: next,
      durationMinutes: 480, createdBy: "admin", reason: "不應回傳的請假原因",
    });
    await db().insert(hrLeaveRequests).values([
      leave("leave-approved", "employment-alice", "approved", "2026-03-04", "2026-03-05"),
      leave("leave-pending", "employment-alice", "pending", "2026-03-05", "2026-03-06"),
      leave("leave-rejected", "employment-alice", "rejected", "2026-03-06", "2026-03-07"),
      leave("leave-bob", "employment-bob", "approved", "2026-03-06", "2026-03-07"),
    ]);
    const result = await listHrSelfToolSchedule(db(), "alice", { fromDate: "2026-03-04", toDate: "2026-03-06" }, NOW);
    expect(result.days[0]).toMatchObject({
      leaves: [{ leaveType: "測試假", status: "approved", startsAt: "2026-03-04 00:00", endsAt: "2026-03-05 00:00" }],
      shifts: [{ startsAt: "2026-03-04 10:00" }],
    });
    expect(result.days[1]!.leaves).toEqual([{ leaveType: "測試假", status: "pending", startsAt: "2026-03-05 00:00", endsAt: "2026-03-06 00:00" }]);
    expect(result.days[2]!.leaves).toEqual([]);
    expect(result.note).toContain("approved 的時段不用上班");
    expect(JSON.stringify(result)).not.toContain("不應回傳");
    // 離職回任：舊任職封存了，上面的假不該掛到現在的班表。
    await db().update(hrEmployments).set({ archivedAt: "2026-03-01" }).where(eq(hrEmployments.id, "employment-alice"));
    await db().insert(hrEmployments).values({ id: "employment-alice-2", employeeUserId: "alice", employeeNumber: "alice-2", legalName: "員工-alice" });
    const rehired = await listHrSelfToolSchedule(db(), "alice", { fromDate: "2026-03-04", toDate: "2026-03-05" }, NOW);
    expect(rehired.days.map((day) => day.leaves)).toEqual([[], []]);
  });

  it("不是排班制的員工明講沒有逐日班表，也拿不到別人的班", async () => {
    await db().delete(hrScheduleEntries);
    const result = await listHrSelfToolSchedule(db(), "bob", { fromDate: "2026-03-04", toDate: "2026-03-04" }, NOW);
    expect(result.attendanceMode).toBe("general");
    expect(result.days[0]!.shifts).toEqual([]);
    expect(result.note).toContain("不是排班制");
    const noEmployment = await listHrSelfToolSchedule(db(), "admin", {}, NOW);
    expect(noEmployment.attendanceMode).toBe("no_active_employment");
    expect(noEmployment.note).toContain("沒有在職的任職資料");
  });

  it("設定還是 general 但已發布班表裡有班的人算排班制；沒有設定列等同 general", async () => {
    const bob = await listHrSelfToolSchedule(db(), "bob", { fromDate: "2026-03-04", toDate: "2026-03-04" }, NOW);
    expect(bob.attendanceMode).toBe("scheduled");
    expect(bob.days[0]).toMatchObject({ scheduleStatus: "assigned", shifts: [{ startsAt: "2026-03-04 10:00" }] });
    expect(bob.note).not.toContain("不是排班制");
    await db().delete(hrScheduleEntries);
    await db().delete(hrEmploymentAttendanceSettings);
    expect((await listHrSelfToolSchedule(db(), "bob", {}, NOW)).attendanceMode).toBe("general");
  });

  it("災防停班跟班次一起回：全公司是 all，指定據點時列出據點名稱", async () => {
    await db().insert(hrCalendarDays).values([
      { date: "2026-03-31", dayType: "weekday", name: "颱風", specialKind: "typhoon_stop", updatedBy: "admin" },
      { date: "2026-03-30", dayType: "weekday", name: "颱風", specialKind: "typhoon_stop", updatedBy: "admin" },
    ]);
    await db().insert(hrCalendarDayScopes).values({ date: "2026-03-31", scopeId: "scope-ximen" });
    const result = await listHrSelfToolSchedule(db(), "alice", { fromDate: "2026-03-29", toDate: "2026-03-31" }, NOW);
    expect(result.days.map((day) => day.stopWork)).toEqual([null, "all", ["西門店"]]);
    expect(result.days[2]).toMatchObject({ holidayName: "颱風", shifts: [{ scopeName: "西門店", startsAt: "2026-03-31 10:00" }] });
    expect(result.note).toContain("災防停班");
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
    expect(result).toMatchObject({ fromDate: "2026-03-02", toDate: "2026-04-30", note: "", holidaysNotImportedYears: [] });
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
    expect(empty.holidaysNotImportedYears).toEqual(["2027"]);
    expect(empty.note).toContain("還沒匯入");
    // 年度有匯入、只是這段本來就沒有假日：要答得出「沒有」。
    const quiet = await listHrToolCalendar(db(), { fromDate: "2026-07-01", toDate: "2026-08-31" }, NOW);
    expect(quiet).toMatchObject({ days: [], holidaysNotImportedYears: [], note: "" });
    // 只有一筆颱風停班不能證明假日匯入過；跨年時兩個年度分開判斷。
    await db().insert(hrCalendarDays).values({ date: "2027-01-05", dayType: "weekday", name: "颱風", specialKind: "typhoon_stop", updatedBy: "admin" });
    const typhoonOnly = await listHrToolCalendar(db(), { fromDate: "2026-12-20", toDate: "2027-01-10" }, NOW);
    expect(typhoonOnly.days.map((day) => day.date)).toEqual(["2027-01-05"]);
    expect(typhoonOnly.holidaysNotImportedYears).toEqual(["2027"]);
    await expect(listHrToolCalendar(db(), { fromDate: "2026-01-01", toDate: "2027-01-02" }, NOW)).rejects.toThrow("366 天");
  });

  it("不是本人工具：群組也能用、不需要授權服務，但一樣不接受多餘參數", async () => {
    const tool = PLATFORM_TOOL_MAP.get("company_calendar")!;
    expect(isHrToolKey("company_calendar")).toBe(false);
    expect(toolKeysForLineSource(["company_calendar", "hr_get_my_schedule", "hr_get_my_overtime_requests"], "group")).toEqual(["company_calendar"]);
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
