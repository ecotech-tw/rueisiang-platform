import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { hrCalendarDays, scopes, userRoleAssignments, users } from "@rueisiang/db/schema";
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
    expect((await request("/hr/employees", "POST", { userId: "staff", employeeNumber: "E-CAL", hiredOn: "2026-01-01", seniorityStartOn: "2026-01-01" })).status).toBe(201);
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
