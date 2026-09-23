import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { countHrClockCalendarAnomalies, createDatabase, importHrCalendarYear, overridesFromGovCalendar, syncSystemRoles } from "@rueisiang/db";
import { hrCalendarDayScopes, hrCalendarDays, hrClockEvents, hrScheduleEntries, hrScheduleVersions, hrShiftTemplates, hrShiftVersions, scopes, userRoleAssignments, users } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "hr-calendar-test-secret-test-secret";
let d1: LocalD1;
let db: ReturnType<typeof createDatabase>;
let cookie: string;

async function request(path: string, method = "GET", payload?: Record<string, unknown>) {
  return app.fetch(new Request(`https://test.local/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  }), { DB: d1, AUTH_SESSION_SECRET: SECRET, GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" } as never);
}

/** 三組時間的班別；只給平日就是最常見的那種班別。 */
async function createShift(name: string, times: Array<{ dayType: string; startTime: string; endTime: string }>) {
  const response = await request("/hr/shift-templates", "POST", { scopeId: "scope", name, times });
  expect(response.status, await response.clone().text()).toBe(201);
  return await response.json() as { id: string; versionId: string };
}

async function listShifts() {
  return (await (await request("/hr/shift-templates")).json() as { shifts: Array<{ templateId: string; versionId: string; name: string; dayType: string; startSecond: number; revision: number }> }).shifts;
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  db = createDatabase(d1 as never);
  await syncSystemRoles(db);
  await db.insert(users).values({ id: "admin", email: "admin@example.test", displayName: "管理者", status: "active" });
  await db.insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  await db.insert(scopes).values({ id: "scope", sourceType: "manual", scopeKind: "store", name: "測試櫃點", normalizedName: "測試櫃點" });
  cookie = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id: "admin", email: "admin@example.test", name: "管理者", pictureUrl: "" }), SECRET))}`;
});
afterEach(() => { d1.sqlite.close(); });

describe("HR 行事曆與班別日型", () => {
  it("行事曆只存例外：跟星期幾推出來的一樣就不寫列，補班日與國定假日才留下", async () => {
    // 2026-02 的 7 日是星期六、9 日是星期一。
    const saved = await request("/hr/calendar/2026-02", "PUT", { days: [
      { date: "2026-02-07", dayType: "weekend", name: "" },
      { date: "2026-02-09", dayType: "weekday", name: "" },
      { date: "2026-02-17", dayType: "holiday", name: "春節" },
      { date: "2026-02-21", dayType: "weekday", name: "補班日" },
    ] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toMatchObject({ days: 2 });

    const rows = await db.select({ date: hrCalendarDays.date, dayType: hrCalendarDays.dayType, name: hrCalendarDays.name }).from(hrCalendarDays);
    expect(rows).toEqual([
      { date: "2026-02-17", dayType: "holiday", name: "春節" },
      { date: "2026-02-21", dayType: "weekday", name: "補班日" },
    ]);

    const listed = await (await request("/hr/calendar/2026-02")).json() as { days: Array<{ date: string; dayType: string; name: string; overridden: boolean }> };
    expect(listed.days).toHaveLength(28);
    expect(listed.days.find((day) => day.date === "2026-02-07")).toMatchObject({ dayType: "weekend", overridden: false });
    expect(listed.days.find((day) => day.date === "2026-02-17")).toMatchObject({ dayType: "holiday", name: "春節", overridden: true });
    expect(listed.days.find((day) => day.date === "2026-02-21")).toMatchObject({ dayType: "weekday", name: "補班日", overridden: true });
  });

  it("災防停班是保留排班的特殊標記，只能套用平日，且可限制適用門市", async () => {
    await db.insert(scopes).values({ id: "scope-other", sourceType: "manual", scopeKind: "store", name: "其他櫃點", normalizedName: "其他櫃點" });
    const saved = await request("/hr/calendar/2026-02", "PUT", { days: [{ date: "2026-02-17", dayType: "weekday", name: "災防停班", specialKind: "typhoon_stop", specialScopeIds: ["scope"] }] });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await db.select({ date: hrCalendarDays.date, dayType: hrCalendarDays.dayType, specialKind: hrCalendarDays.specialKind }).from(hrCalendarDays)).toEqual([
      { date: "2026-02-17", dayType: "weekday", specialKind: "typhoon_stop" },
    ]);
    expect(await db.select({ date: hrCalendarDayScopes.date, scopeId: hrCalendarDayScopes.scopeId }).from(hrCalendarDayScopes)).toEqual([{ date: "2026-02-17", scopeId: "scope" }]);
    const listed = await (await request("/hr/calendar/2026-02")).json() as { days: Array<{ date: string; dayType: string; specialKind: string; name: string; specialScopeIds: string[] }> };
    expect(listed.days.find((day) => day.date === "2026-02-17")).toMatchObject({ dayType: "weekday", specialKind: "typhoon_stop", name: "災防停班", specialScopeIds: ["scope"] });
    expect((await request("/hr/calendar/2026-02", "PUT", { days: [{ date: "2026-02-18", dayType: "holiday", name: "", specialKind: "storm" }] })).status).toBe(400);
    const invalidDayType = await request("/hr/calendar/2026-02", "PUT", { days: [{ date: "2026-02-18", dayType: "holiday", name: "災防停班", specialKind: "typhoon_stop", specialScopeIds: ["scope"] }] });
    expect(invalidDayType.status, await invalidDayType.clone().text()).toBe(400);
    expect(await invalidDayType.text()).toContain("只能套用於平日");
    expect((await request("/hr/calendar/2026-02", "PUT", { days: [{ date: "2026-02-18", dayType: "weekday", name: "災防停班", specialKind: "typhoon_stop", specialScopeIds: ["missing-scope"] }] })).status).toBe(400);
  });

  it("災防停班的適用範圍只接受門市 scope", async () => {
    await db.insert(scopes).values({ id: "channel", sourceType: "manual", scopeKind: "channel", name: "測試通路", normalizedName: "測試通路" });
    const response = await request("/hr/calendar/2026-02", "PUT", { days: [{ date: "2026-02-18", dayType: "weekday", name: "災防停班", specialKind: "typhoon_stop", specialScopeIds: ["channel"] }] });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.text()).toContain("適用門市／地區不存在");
  });

  it("重存一個月會整個換掉，取消掉的例外不會留下來", async () => {
    await request("/hr/calendar/2026-02", "PUT", { days: [{ date: "2026-02-17", dayType: "holiday", name: "春節" }] });
    const again = await request("/hr/calendar/2026-02", "PUT", { days: [{ date: "2026-02-18", dayType: "holiday", name: "春節" }] });
    expect(again.status).toBe(200);
    expect(await db.select({ date: hrCalendarDays.date }).from(hrCalendarDays)).toEqual([{ date: "2026-02-18" }]);
  });

  it("拒絕不屬於該月份的日期與不認得的日型", async () => {
    expect((await request("/hr/calendar/2026-02", "PUT", { days: [{ date: "2026-03-01", dayType: "holiday", name: "" }] })).status).toBe(400);
    expect((await request("/hr/calendar/2026-02", "PUT", { days: [{ date: "2026-02-10", dayType: "typhoon", name: "" }] })).status).toBe(400);
    expect((await request("/hr/calendar/2026-99", "PUT", { days: [] })).status).toBe(400);
  });

  it("一個班別可以有平日、週末與國定假日三組時間，版本號各自從 1 開始", async () => {
    await createShift("早班", [
      { dayType: "weekday", startTime: "09:00", endTime: "18:00" },
      { dayType: "weekend", startTime: "10:00", endTime: "20:00" },
      { dayType: "holiday", startTime: "11:00", endTime: "19:00" },
    ]);
    const shifts = await listShifts();
    expect(shifts).toHaveLength(3);
    expect(shifts.map((shift) => [shift.dayType, shift.startSecond]).sort()).toEqual([
      ["holiday", 11 * 3600],
      ["weekday", 9 * 3600],
      ["weekend", 10 * 3600],
    ]);
    // 三組時間是三個版本，但同屬一個班別：名稱只有一份。
    expect(new Set(shifts.map((shift) => shift.templateId)).size).toBe(1);
    expect(new Set(shifts.map((shift) => shift.name))).toEqual(new Set(["早班"]));
  });

  it("平日那組是必填的，因為其他日型沒設定時要沿用它", async () => {
    const response = await request("/hr/shift-templates", "POST", { scopeId: "scope", name: "只有週末", times: [{ dayType: "weekend", startTime: "10:00", endTime: "20:00" }] });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("平日");
  });

  it("同一個日型不能重複設定", async () => {
    const response = await request("/hr/shift-templates", "POST", { scopeId: "scope", name: "重複", times: [
      { dayType: "weekday", startTime: "09:00", endTime: "18:00" },
      { dayType: "weekday", startTime: "10:00", endTime: "19:00" },
    ] });
    expect(response.status).toBe(400);
  });

  it("修改班別可以補上新日型、改掉既有日型，也可以把用不到的那組移除", async () => {
    const created = await createShift("早班", [{ dayType: "weekday", startTime: "09:00", endTime: "18:00" }]);
    const added = await request(`/hr/shift-templates/${created.id}`, "PATCH", { scopeId: "scope", name: "早班", revision: 1, times: [
      { dayType: "weekday", startTime: "09:30", endTime: "18:30" },
      { dayType: "holiday", startTime: "11:00", endTime: "19:00" },
    ] });
    expect(added.status, await added.clone().text()).toBe(200);
    const afterAdd = await listShifts();
    expect(afterAdd).toHaveLength(2);
    expect(afterAdd.find((shift) => shift.dayType === "weekday")?.startSecond).toBe(9 * 3600 + 1800);
    expect(afterAdd.find((shift) => shift.dayType === "holiday")?.startSecond).toBe(11 * 3600);

    const removed = await request(`/hr/shift-templates/${created.id}`, "PATCH", { scopeId: "scope", name: "早班", revision: 2, times: [
      { dayType: "weekday", startTime: "09:30", endTime: "18:30" },
    ] });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await listShifts()).toHaveLength(1);
  });

  it("已經排進班表的那組時間移不掉，訊息要講清楚該去哪裡處理", async () => {
    const created = await createShift("早班", [
      { dayType: "weekday", startTime: "09:00", endTime: "18:00" },
      { dayType: "holiday", startTime: "11:00", endTime: "19:00" },
    ]);
    await db.insert(users).values({ id: "staff", email: "staff@example.test", displayName: "員工", status: "active" });
    expect((await request("/hr/employees", "POST", { userId: "staff", employeeNumber: "E-CAL", position: "一般職員", serviceStartOn: "2026-01-01" })).status).toBe(201);
    const detail = await (await request("/hr/employees/staff")).json() as { employments: Array<{ id: string }> };
    const employmentId = detail.employments[0]?.id;
    const holiday = (await listShifts()).find((shift) => shift.dayType === "holiday")!;
    const published = await request("/hr/schedules", "POST", { periodKey: "2026-02", entries: [
      { personKind: "employee", employmentId, scopeId: "scope", shiftVersionId: holiday.versionId, workDate: "2026-02-17" },
    ] });
    expect(published.status, await published.clone().text()).toBe(200);

    const blocked = await request(`/hr/shift-templates/${created.id}`, "PATCH", { scopeId: "scope", name: "早班", revision: 1, times: [
      { dayType: "weekday", startTime: "09:00", endTime: "18:00" },
    ] });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain("排班月曆");
    // 擋下來就要什麼都沒改：名稱、時間與那組被排到的版本都還在。
    expect(await listShifts()).toHaveLength(2);
  });

  it("排班月曆會一起帶出該月的日型，前端才不用自己推星期幾", async () => {
    await request("/hr/calendar/2026-02", "PUT", { days: [{ date: "2026-02-17", dayType: "holiday", name: "春節" }] });
    const schedule = await (await request("/hr/schedules?periodKey=2026-02")).json() as { calendar: Array<{ date: string; dayType: string; name: string }> };
    expect(schedule.calendar).toHaveLength(28);
    expect(schedule.calendar.find((day) => day.date === "2026-02-17")).toMatchObject({ dayType: "holiday", name: "春節" });
    expect(schedule.calendar.find((day) => day.date === "2026-02-16")).toMatchObject({ dayType: "weekday" });
    expect(schedule.calendar.find((day) => day.date === "2026-02-22")).toMatchObject({ dayType: "weekend" });
  });

  it("沒有 hr:schedule:write 的人改不了行事曆", async () => {
    await db.delete(userRoleAssignments);
    expect((await request("/hr/calendar/2026-02", "PUT", { days: [] })).status).toBe(403);
  });
});

describe("行事曆整年管理與出缺勤", () => {
  /** 讓「自己」這個帳號成為一般辦公模式的在職員工，出缺勤才有東西可以判。 */
  async function officeEmployee() {
    await db.insert(users).values({ id: "self", email: "self@example.test", displayName: "本人", status: "active" });
    expect((await request("/hr/employees", "POST", { userId: "self", employeeNumber: "E-CAL2", position: "一般職員", serviceStartOn: "2020-01-01" })).status).toBe(201);
    return `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id: "self", email: "self@example.test", name: "本人", pictureUrl: "" }), SECRET))}`;
  }
  async function calendarOf(selfCookie: string, year: number, month: number) {
    const previous = cookie;
    cookie = selfCookie;
    const response = await request(`/hr/me/attendance-calendar?year=${year}&month=${month}`);
    cookie = previous;
    return (await response.json() as { days: Array<{ date: string; dayType: string; status: string; eventCount: number; specialKind: string; specialScopeIds: string[] }> }).days;
  }

  it("國定假日沒打卡算休息，補班日沒打卡算缺勤", async () => {
    const selfCookie = await officeEmployee();
    // 2021-02-20 是星期六卻要補班；2021-02-11 是星期四的春節假期。
    const saved = await request("/hr/calendar/years/2021", "PUT", { days: [
      { date: "2021-02-11", dayType: "holiday", name: "春節" },
      { date: "2021-02-19", dayType: "weekday", name: "災防停班", specialKind: "typhoon_stop" },
      { date: "2021-02-20", dayType: "weekday", name: "補行上班" },
    ] });
    expect(saved.status, await saved.clone().text()).toBe(200);

    const days = await calendarOf(selfCookie, 2021, 2);
    const holiday = days.find((day) => day.date === "2021-02-11");
    const typhoon = days.find((day) => day.date === "2021-02-19");
    const makeup = days.find((day) => day.date === "2021-02-20");
    const plainSaturday = days.find((day) => day.date === "2021-02-27");
    const plainWeekday = days.find((day) => day.date === "2021-02-25");
    expect(holiday).toMatchObject({ dayType: "holiday", status: "rest" });
    expect(typhoon).toMatchObject({ dayType: "weekday", specialKind: "typhoon_stop", status: "rest" });
    expect(makeup).toMatchObject({ dayType: "weekday", status: "missing" });
    // 沒被標記的日子仍照星期幾走，行事曆不會把整個月都變成上班日。
    expect(plainSaturday).toMatchObject({ dayType: "weekend", status: "rest" });
    expect(plainWeekday).toMatchObject({ dayType: "weekday", status: "missing" });
  });

  it("混合據點排班時，停班據點的打卡不能掩蓋其他據點缺卡", async () => {
    await db.insert(scopes).values({ id: "scope-other", sourceType: "manual", scopeKind: "store", name: "其他櫃點", normalizedName: "其他櫃點" });
    const selfCookie = await officeEmployee();
    const employment = d1.sqlite.prepare("SELECT id FROM hr_employments WHERE employee_user_id=? AND archived_at IS NULL").get("self") as { id: string };
    const mode = await request(`/hr/employments/${employment.id}/attendance-mode`, "PATCH", { attendanceMode: "scheduled", monthlyRestDays: 8, revision: 1 });
    expect(mode.status, await mode.clone().text()).toBe(200);

    await db.insert(hrShiftTemplates).values([
      { id: "attendance-shift-a", code: "attendance-shift-a", name: "出勤測試 A 班", createdBy: "admin" },
      { id: "attendance-shift-b", code: "attendance-shift-b", name: "出勤測試 B 班", createdBy: "admin" },
    ]);
    await db.insert(hrShiftVersions).values([
      { id: "attendance-shift-a-v1", shiftTemplateId: "attendance-shift-a", dayType: "weekday", versionNumber: 1, startSecond: 9 * 3600, endSecond: 18 * 3600, standardMinutes: 480, breakMinutes: 60, createdBy: "admin" },
      { id: "attendance-shift-b-v1", shiftTemplateId: "attendance-shift-b", dayType: "weekday", versionNumber: 1, startSecond: 10 * 3600, endSecond: 19 * 3600, standardMinutes: 480, breakMinutes: 60, createdBy: "admin" },
    ]);
    await db.insert(hrScheduleVersions).values({ id: "attendance-schedule-2021-02", periodStart: "2021-02-01", periodEnd: "2021-03-01", versionNumber: 1, status: "published", submittedBy: "admin", approvedBy: "admin" });
    await db.insert(hrScheduleEntries).values([
      { id: "attendance-entry-a", scheduleVersionId: "attendance-schedule-2021-02", employmentId: employment.id, scopeId: "scope", shiftVersionId: "attendance-shift-a-v1", workDate: "2021-02-17", startsAt: "2021-02-17 01:00:00", endsAt: "2021-02-17 10:00:00", standardMinutes: 480, breakMinutes: 60, createdBy: "admin" },
      { id: "attendance-entry-b", scheduleVersionId: "attendance-schedule-2021-02", employmentId: employment.id, scopeId: "scope-other", shiftVersionId: "attendance-shift-b-v1", workDate: "2021-02-17", startsAt: "2021-02-17 02:00:00", endsAt: "2021-02-17 11:00:00", standardMinutes: 480, breakMinutes: 60, createdBy: "admin" },
    ]);
    await db.insert(hrClockEvents).values([
      { id: "attendance-clock-in", employeeUserId: "self", employmentId: employment.id, scopeId: "scope", idempotencyKey: "attendance-clock-in", sourceKind: "manual", eventKind: "clock_in", occurredAt: "2021-02-17 01:00:00" },
      { id: "attendance-clock-out", employeeUserId: "self", employmentId: employment.id, scopeId: "scope", idempotencyKey: "attendance-clock-out", sourceKind: "manual", eventKind: "clock_out", occurredAt: "2021-02-17 09:00:00" },
    ]);
    const saved = await request("/hr/calendar/2021-02", "PUT", { days: [{ date: "2021-02-17", dayType: "weekday", name: "災防停班", specialKind: "typhoon_stop", specialScopeIds: ["scope"] }] });
    expect(saved.status, await saved.clone().text()).toBe(200);

    const days = await calendarOf(selfCookie, 2021, 2);
    expect(days.find((day) => day.date === "2021-02-17")).toMatchObject({ status: "missing", eventCount: 2, specialKind: "typhoon_stop", specialScopeIds: ["scope"] });
    expect(await countHrClockCalendarAnomalies(db, ["self"], 2021, 2)).toBe(1);
  });

  it("整年清單只回例外，一年不是 365 列", async () => {
    await request("/hr/calendar/years/2021", "PUT", { days: [
      { date: "2021-02-11", dayType: "holiday", name: "春節" },
      { date: "2021-02-20", dayType: "weekday", name: "補行上班" },
      { date: "2021-03-08", dayType: "weekday", name: "" },
    ] });
    const listed = await (await request("/hr/calendar/years/2021")).json() as { days: Array<{ date: string; dayType: string; name: string }> };
    // 2021-03-08 是星期一、送的也是 weekday，跟預設一樣所以不存。
    expect(listed.days).toEqual([
      expect.objectContaining({ date: "2021-02-11", dayType: "holiday", name: "春節" }),
      expect.objectContaining({ date: "2021-02-20", dayType: "weekday", name: "補行上班" }),
    ]);
  });

  it("整年儲存會換掉整年，但不動到別的年份", async () => {
    await request("/hr/calendar/years/2021", "PUT", { days: [{ date: "2021-02-11", dayType: "holiday", name: "春節" }] });
    await request("/hr/calendar/years/2022", "PUT", { days: [{ date: "2022-01-01", dayType: "holiday", name: "元旦" }] });
    await request("/hr/calendar/years/2021", "PUT", { days: [{ date: "2021-10-10", dayType: "holiday", name: "國慶日" }] });
    const twentyOne = await (await request("/hr/calendar/years/2021")).json() as { days: Array<{ date: string }> };
    const twentyTwo = await (await request("/hr/calendar/years/2022")).json() as { days: Array<{ date: string }> };
    expect(twentyOne.days.map((day) => day.date)).toEqual(["2021-10-10"]);
    expect(twentyTwo.days.map((day) => day.date)).toEqual(["2022-01-01"]);
  });

  it("拒絕不是四位數的年份", async () => {
    expect((await request("/hr/calendar/years/21")).status).toBe(400);
    expect((await request("/hr/calendar/years/abcd")).status).toBe(400);
  });
});

describe("政府行事曆轉換", () => {
  it("只挑出跟星期幾推算不同的日子：平日放假與週末補班", () => {
    const overrides = overridesFromGovCalendar(2021, [
      { date: "20210211", isHoliday: true, description: "農曆除夕" },   // 星期四放假 → holiday
      { date: "20210213", isHoliday: true, description: "春節" },       // 星期六放假 → 跟預設一樣，不存
      { date: "20210220", isHoliday: false, description: "補行上班" },  // 星期六上班 → weekday
      { date: "20210222", isHoliday: false, description: "" },          // 星期一上班 → 跟預設一樣，不存
      { date: "20220101", isHoliday: true, description: "跨年度" },      // 不在這一年，丟掉
      { date: "壞掉的日期", isHoliday: true, description: "" },
    ]);
    expect(overrides).toEqual([
      { date: "2021-02-11", dayType: "holiday", name: "農曆除夕" },
      { date: "2021-02-20", dayType: "weekday", name: "補行上班" },
    ]);
  });

  it("沒有名稱時補一個講得出口的預設名，畫面上才不會出現空白的一列", () => {
    const overrides = overridesFromGovCalendar(2021, [
      { date: "20210211", isHoliday: true, description: "" },
      { date: "20210220", isHoliday: false, description: "" },
    ]);
    expect(overrides.map((day) => day.name)).toEqual(["放假", "補行上班"]);
  });

  it("補假名稱會帶出同一段連假中的週末節日事由", () => {
    const overrides = overridesFromGovCalendar(2026, [
      { date: "20260403", isHoliday: true, description: "補假" },
      { date: "20260404", isHoliday: true, description: "兒童節" },
      { date: "20260405", isHoliday: true, description: "清明節" },
      { date: "20260406", isHoliday: true, description: "補假" },
    ]);
    expect(overrides).toEqual([
      { date: "2026-04-03", dayType: "holiday", name: "兒童節補假" },
      { date: "2026-04-06", dayType: "holiday", name: "清明節補假" },
    ]);
  });

  it("補假找不到同段連假的節日時保留原本名稱", () => {
    const overrides = overridesFromGovCalendar(2027, [
      { date: "20271231", isHoliday: true, description: "補假" },
    ]);
    expect(overrides).toEqual([{ date: "2027-12-31", dayType: "holiday", name: "補假" }]);
  });

  it("匯入會整年換掉，並回報假日與補班日各幾天", async () => {
    await db.insert(users).values({ id: "importer", email: "importer@example.test", displayName: "匯入者", status: "active" });
    await request("/hr/calendar/years/2021", "PUT", { days: [{ date: "2021-06-01", dayType: "holiday", name: "舊的假日" }] });
    const result = await importHrCalendarYear(db, 2021, { id: "admin", email: "admin@example.test" }, async () => [
      { date: "20210211", isHoliday: true, description: "農曆除夕" },
      { date: "20210220", isHoliday: false, description: "補行上班" },
    ]);
    expect(result).toMatchObject({ year: 2021, days: 2, holidays: 1, makeupWorkdays: 1 });
    const listed = await (await request("/hr/calendar/years/2021")).json() as { days: Array<{ date: string }> };
    expect(listed.days.map((day) => day.date)).toEqual(["2021-02-11", "2021-02-20"]);
  });

  it("來源拿不到資料時擋下來，不會把整年的行事曆清空", async () => {
    await request("/hr/calendar/years/2021", "PUT", { days: [{ date: "2021-06-01", dayType: "holiday", name: "要保住的假日" }] });
    await expect(importHrCalendarYear(db, 2021, { id: "admin", email: "admin@example.test" }, async () => [])).rejects.toThrow(/政府行事曆/);
    const listed = await (await request("/hr/calendar/years/2021")).json() as { days: Array<{ date: string }> };
    expect(listed.days.map((day) => day.date)).toEqual(["2021-06-01"]);
  });
});

describe("review 修正", () => {
  it("整年可以存超過 31 天的例外——匯入一年就可能破 31", async () => {
    // 2021 年的一月有 31 天，全部標成假日再加一天，就是 32 筆。
    const days = Array.from({ length: 32 }, (_, index) => {
      const date = new Date(Date.UTC(2021, 0, index + 1)).toISOString().slice(0, 10);
      return { date, dayType: "holiday", name: `假日${index + 1}` };
    });
    const saved = await request("/hr/calendar/years/2021", "PUT", { days });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toMatchObject({ days: 32 });
  });

  it("月份那條路仍然只收一個月，不會因為年的上限被放寬", async () => {
    const days = Array.from({ length: 32 }, (_, index) => ({ date: `2021-01-${String(index + 1).padStart(2, "0")}`, dayType: "holiday", name: "" }));
    expect((await request("/hr/calendar/2021-01", "PUT", { days })).status).toBe(400);
  });

  it("別人先改過就擋下來，不會把對方的修改沖掉", async () => {
    await request("/hr/calendar/years/2021", "PUT", { days: [{ date: "2021-02-11", dayType: "holiday", name: "春節" }] });
    // 另一個人加了一天。
    await request("/hr/calendar/years/2021", "PUT", { days: [
      { date: "2021-02-11", dayType: "holiday", name: "春節" },
      { date: "2021-10-10", dayType: "holiday", name: "國慶日" },
    ], knownDates: ["2021-02-11"] });
    // 我拿著只有一筆的舊清單要存，應該被擋。
    const stale = await request("/hr/calendar/years/2021", "PUT", { days: [{ date: "2021-04-04", dayType: "holiday", name: "兒童節" }], knownDates: ["2021-02-11"] });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("重新整理");
    const listed = await (await request("/hr/calendar/years/2021")).json() as { days: Array<{ date: string }> };
    expect(listed.days.map((day) => day.date)).toEqual(["2021-02-11", "2021-10-10"]);
  });

  it("沒送 knownDates 就不檢查，匯入才不用先讀一次", async () => {
    await request("/hr/calendar/years/2021", "PUT", { days: [{ date: "2021-02-11", dayType: "holiday", name: "春節" }] });
    const overwrite = await request("/hr/calendar/years/2021", "PUT", { days: [{ date: "2021-10-10", dayType: "holiday", name: "國慶日" }] });
    expect(overwrite.status).toBe(200);
  });

  it("isHoliday 不是布林值就跳過，壞掉的來源不會把整年寫成假日", () => {
    const overrides = overridesFromGovCalendar(2021, [
      { date: "20210211", isHoliday: "false" as never, description: "壞掉的型別" },
      { date: "20210212", isHoliday: 1 as never, description: "也是壞的" },
      { date: "20210215", isHoliday: true, description: "正常的" },
    ]);
    expect(overrides).toEqual([{ date: "2021-02-15", dayType: "holiday", name: "正常的" }]);
  });

  it("來源有重複日期時只留第一筆，不會讓整批 INSERT 撞主鍵", async () => {
    const overrides = overridesFromGovCalendar(2021, [
      { date: "20210211", isHoliday: true, description: "農曆除夕" },
      { date: "20210211", isHoliday: true, description: "重複的一筆" },
    ]);
    expect(overrides).toEqual([{ date: "2021-02-11", dayType: "holiday", name: "農曆除夕" }]);
    // 真的寫進去也不會炸。
    const result = await importHrCalendarYear(db, 2021, { id: "admin", email: "admin@example.test" }, async () => [
      { date: "20210211", isHoliday: true, description: "農曆除夕" },
      { date: "20210211", isHoliday: true, description: "重複的一筆" },
    ]);
    expect(result).toMatchObject({ days: 1 });
  });

  it("resolveDayTypes 的區間含頭也含尾", async () => {
    await request("/hr/calendar/years/2021", "PUT", { days: [
      { date: "2021-02-01", dayType: "holiday", name: "頭" },
      { date: "2021-02-28", dayType: "weekday", name: "尾" },
    ] });
    const days = await (await request("/hr/calendar/2021-02")).json() as { days: Array<{ date: string; dayType: string }> };
    expect(days.days.find((day) => day.date === "2021-02-01")).toMatchObject({ dayType: "holiday" });
    expect(days.days.find((day) => day.date === "2021-02-28")).toMatchObject({ dayType: "weekday" });
  });
});
