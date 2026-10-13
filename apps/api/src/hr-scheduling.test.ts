import { DEVICE_SESSION_COOKIE, SESSION_COOKIE, newSessionClaims, serializeDeviceToken, signSession } from "@rueisiang/auth";
import { createDatabase, createDeviceSession, getHrSchedule, syncSystemRoles } from "@rueisiang/db";
import { hrEmployments, hrScheduleManagers, hrScheduleVersions, scopes, userRoleAssignments, users } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const SECRET = "schedule-test-secret-test-secret-test";
let d1: LocalD1;
let db: ReturnType<typeof createDatabase>;
let cookies: Record<string, string>;
let shiftId: string;
async function request(path: string, method = "GET", payload?: Record<string, unknown>, user = "admin") {
  return app.fetch(new Request(`https://test.local/api/hr${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookies[user]! }, ...(payload ? { body: JSON.stringify(payload) } : {}) }), { DB: d1, AUTH_SESSION_SECRET: SECRET } as never);
}
function entry(workerId: string, workDate = "2026-02-06", scopeId = "store-a") {
  return { personKind: "worker", workerId, workDate, scopeId, shiftVersionId: shiftId };
}
async function changes(values: Record<string, unknown> = {}, user = "admin") {
  const current = await getHrSchedule(db, "2026-02");
  return request(user === "admin" ? "/schedules" : "/me/schedules", "PATCH", { periodKey: "2026-02", revision: current.version?.revision ?? 0, scopeId: "store-a", entries: [], removedIds: [], refreshIds: [], ...values }, user);
}
async function assign(userId: string | null, revision = 0) {
  return request("/schedule-managers/store-a", "PUT", { userId, revision });
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  db = createDatabase(d1 as never);
  await syncSystemRoles(db);
  cookies = {};
  for (const id of ["admin", "scheduler", "other"]) {
    await db.insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: "active" });
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET))}`;
    await db.insert(hrEmployments).values({ id: `employment-${id}`, employeeUserId: id, employeeNumber: `E-${id}`, legalName: id, position: "同仁" });
  }
  await db.insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  await db.insert(scopes).values(["store-a", "store-b"].map((id) => ({ id, name: id, normalizedName: id, sourceType: "manual" as const, scopeKind: "store" as const })));
  await db.insert(hrEmployments).values(["worker-1", "worker-2"].map((id) => ({ id, employeeNumber: id, legalName: id, position: "支援", personKind: "worker" as const })));
  const created = await request("/shift-templates", "POST", { scopeId: "store-a", name: "早班", times: [{ dayType: "weekday", startTime: "09:00", endTime: "18:00" }, { dayType: "weekend", startTime: "10:00", endTime: "19:00", requiredHeadcount: 2 }] });
  expect(created.status).toBe(201);
  shiftId = (await created.json() as { versionId: string }).versionId;
});
afterEach(() => { vi.restoreAllMocks(); d1.sqlite.close(); });

async function setMembers(allowedPersonIds: string[] | null | undefined, revision?: number) {
  const current = await getHrSchedule(db, "2026-02");
  const shift = current.shifts.find((shift) => shift.versionId === shiftId)!;
  return request(`/shift-templates/${shift.templateId}`, "PATCH", { scopeId: "store-a", name: "早班", revision: revision ?? shift.revision, allowedPersonIds, times: [{ dayType: "weekday", startTime: "09:00", endTime: "18:00" }, { dayType: "weekend", startTime: "10:00", endTime: "19:00", requiredHeadcount: 2 }] });
}

describe("班別前台可排人員", () => {
  it("只回傳納入人員，正式員工與支援人員都由 API 限制，HR 可安排跨櫃支援", async () => {
    await assign("scheduler");
    expect((await setMembers(["employment-other", "worker-1"])).status).toBe(200);
    const data = await (await request("/me/schedules?periodKey=2026-02&scopeId=store-a", "GET", undefined, "scheduler")).json() as { employees: Array<{ employmentId: string }>; workers: Array<{ id: string }> };
    expect(data.employees.map((person) => person.employmentId)).toEqual(["employment-other"]);
    expect(data.workers.map((person) => person.id)).toEqual(["worker-1"]);
    expect((await changes({ entries: [entry("worker-2")] }, "scheduler")).status).toBe(403);
    expect((await changes({ entries: [{ personKind: "employee", employmentId: "employment-admin", scopeId: "store-a", shiftVersionId: shiftId, workDate: "2026-02-06" }] }, "scheduler")).status).toBe(403);
    expect((await changes({ entries: [entry("worker-1")] }, "scheduler")).status).toBe(200);
    expect((await changes({ entries: [entry("worker-2")] })).status).toBe(200);
  });

  it("空名單不能新增；既有排班仍可查看、重新套用與移除；null 恢復不限制", async () => {
    await assign("scheduler");
    await changes({ entries: [entry("worker-1")] }, "scheduler");
    const original = await getHrSchedule(db, "2026-02");
    expect((await setMembers([])).status).toBe(200);
    const data = await (await request("/me/schedules?periodKey=2026-02&scopeId=store-a", "GET", undefined, "scheduler")).json() as { employees: unknown[]; workers: unknown[]; entries: unknown[] };
    expect(data.employees).toEqual([]); expect(data.workers).toEqual([]); expect(data.entries).toHaveLength(1);
    expect((await changes({ entries: [entry("worker-1", "2026-02-08")] }, "scheduler")).status).toBe(403);
    expect((await changes({ refreshIds: [original.entries[0]!.id] }, "scheduler")).status).toBe(200);
    expect((await changes({ removedIds: [(await getHrSchedule(db, "2026-02")).entries[0]!.id] }, "scheduler")).status).toBe(200);
    expect((await setMembers(null)).status).toBe(200);
    expect((await changes({ entries: [entry("worker-2")] }, "scheduler")).status).toBe(200);
  });

  it("錯誤名單拒絕、舊 API 省略名單保留原值、過期 revision 不覆寫", async () => {
    expect((await setMembers(["missing"])).status).toBe(400);
    expect((await setMembers(["worker-1", "worker-1"])).status).toBe(400);
    expect((await setMembers(["worker-1"])).status).toBe(200);
    expect((await setMembers(undefined)).status).toBe(200);
    expect((await setMembers(["worker-2"], 1)).status).toBe(409);
    expect((await getHrSchedule(db, "2026-02")).shifts.every((shift) => JSON.stringify(shift.allowedPersonIds) === '["worker-1"]')).toBe(true);
    const created = await request("/shift-templates", "POST", { scopeId: "store-b", name: "B班", allowedPersonIds: ["worker-2"], times: [{ dayType: "weekday", startTime: "09:00", endTime: "18:00" }] });
    expect(created.status).toBe(201);
    expect((await getHrSchedule(db, "2026-02")).shifts.find((shift) => shift.scopeId === "store-b")?.allowedPersonIds).toEqual(["worker-2"]);
  });

  it("驗證後名單撤銷，原子守衛仍擋下整批且不留下發布版本", async () => {
    await assign("scheduler"); await setMembers(["worker-1"]);
    const batch = d1.batch.bind(d1);
    vi.spyOn(d1, "batch").mockImplementation(async (statements) => {
      d1.sqlite.prepare("UPDATE hr_shift_templates SET allowed_person_ids='[]'").run();
      return batch(statements);
    });
    expect((await changes({ entries: [entry("worker-1")] }, "scheduler")).status).toBe(409);
    expect((await getHrSchedule(db, "2026-02")).version).toBeNull();
    expect((await getHrSchedule(db, "2026-02")).entries).toEqual([]);
  });
});

describe("據點負責人的 HR 前台排班", () => {
  it("保留公司節慶與適用特別日，但不把別店的災防名單濾空成全域", async () => {
    await assign("scheduler");
    expect((await request("/calendar/2026-02", "PUT", { days: [
      { date: "2026-02-05", dayType: "weekday", name: "別店災防停班", specialKind: "typhoon_stop", specialScopeIds: ["store-b"] },
      { date: "2026-02-06", dayType: "weekday", name: "本店災防停班", specialKind: "typhoon_stop", specialScopeIds: ["store-a"] },
      { date: "2026-02-09", dayType: "weekday", name: "全公司特別日", specialKind: "typhoon_stop", specialScopeIds: [] },
      { date: "2026-02-10", dayType: "holiday", name: "公司節慶" },
    ] })).status).toBe(200);
    const response = await request("/me/schedules?periodKey=2026-02&scopeId=store-a", "GET", undefined, "scheduler");
    expect(response.status).toBe(200);
    const data = await response.json() as { calendar: Array<{ date: string; name: string; specialKind: string; specialScopeIds: string[]; overridden: boolean }> };
    expect(data.calendar.find((day) => day.date === "2026-02-05")).toMatchObject({ name: "", specialKind: "none", specialScopeIds: [], overridden: false });
    expect(data.calendar.find((day) => day.date === "2026-02-06")).toMatchObject({ name: "本店災防停班", specialKind: "typhoon_stop", specialScopeIds: ["store-a"], overridden: true });
    expect(data.calendar.find((day) => day.date === "2026-02-09")).toMatchObject({ name: "全公司特別日", specialKind: "typhoon_stop", specialScopeIds: [], overridden: true });
    expect(data.calendar.find((day) => day.date === "2026-02-10")).toMatchObject({ name: "公司節慶", specialKind: "none", overridden: true });
  });

  it("指派後可用本人裝置 session 排班，但不能讀寫其他據點或後台", async () => {
    expect((await assign("scheduler")).status).toBe(200);
    cookies.scheduler = `${DEVICE_SESSION_COOKIE}=${serializeDeviceToken(await createDeviceSession(db, "scheduler", "測試手機"))}`;
    expect(await (await request("/me/schedule-scopes", "GET", undefined, "scheduler")).json()).toEqual({ scopes: [{ id: "store-a", name: "store-a" }] });
    const data = await (await request("/me/schedules?periodKey=2026-02&scopeId=store-a", "GET", undefined, "scheduler")).json() as { scopes: Array<{ id: string }>; shifts: Array<{ scopeId: string }>; employees: unknown[] };
    expect(data.scopes.map((scope) => scope.id)).toEqual(["store-a"]);
    expect(data.shifts.every((shift) => shift.scopeId === "store-a")).toBe(true);
    const saved = await changes({ entries: [{ personKind: "employee", employmentId: "employment-other", scopeId: "store-a", shiftVersionId: shiftId, workDate: "2026-02-07" }] }, "scheduler");
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect((await getHrSchedule(db, "2026-02")).entries[0]).toMatchObject({ startsAt: "2026-02-07 10:00:00", requiredHeadcount: 2 });
    expect((await request("/me/schedules?periodKey=2026-02&scopeId=store-b", "GET", undefined, "scheduler")).status).toBe(403);
    expect((await changes({ scopeId: "store-b", entries: [entry("worker-1", undefined, "store-b")] }, "scheduler")).status).toBe(403);
    expect((await request("/schedules?periodKey=2026-02", "GET", undefined, "scheduler")).status).toBe(401);
  });

  it("無全域權限的負責人不能越界新增、移除、重新套用或偽造出勤狀態", async () => {
    await assign("scheduler");
    expect((await changes({ entries: [entry("worker-1", undefined, "store-b")] }, "scheduler")).status).toBe(403);
    expect((await changes({ entries: [{ ...entry("worker-1"), attendanceStatus: "present" }] }, "scheduler")).status).toBe(403);
    const shiftB = await request("/shift-templates", "POST", { scopeId: "store-b", name: "B早班", times: [{ dayType: "weekday", startTime: "09:00", endTime: "18:00" }] });
    const versionB = (await shiftB.json() as { versionId: string }).versionId;
    expect((await changes({ entries: [{ ...entry("worker-1", undefined, "store-b"), shiftVersionId: versionB }] })).status).toBe(200);
    const id = (await getHrSchedule(db, "2026-02")).entries[0]!.id;
    expect((await changes({ removedIds: [id] }, "scheduler")).status).toBe(403);
    expect((await changes({ refreshIds: [id] }, "scheduler")).status).toBe(403);
    expect((await request("/schedules", "PATCH", { periodKey: "2026-02", revision: 2, entries: [], removedIds: [id], refreshIds: [] }, "scheduler")).status).toBe(403);
    expect((await getHrSchedule(db, "2026-02")).entries).toHaveLength(1);
  });

  it.each(["employee", "worker"] as const)("%s 的已確認出勤狀態不可用同次或分次刪增清除，但可重新套用快照", async (personKind) => {
    await assign("scheduler");
    const scheduled = personKind === "worker" ? entry("worker-1") : { personKind, employmentId: "employment-other", scopeId: "store-a", shiftVersionId: shiftId, workDate: "2026-02-06" };
    for (const attendanceStatus of ["present", "absent"] as const) {
      const before = await getHrSchedule(db, "2026-02");
      expect((await changes({ entries: [{ ...scheduled, attendanceStatus }], removedIds: before.entries.map((entry) => entry.id) })).status).toBe(200);
      const original = await getHrSchedule(db, "2026-02");
      expect((await changes({ removedIds: [original.entries[0]!.id], entries: [scheduled] }, "scheduler")).status).toBe(403);
      expect((await changes({ removedIds: [original.entries[0]!.id] }, "scheduler")).status).toBe(403);
      expect((await changes({ entries: [scheduled] }, "scheduler")).status).toBe(409);
      expect(await getHrSchedule(db, "2026-02")).toEqual(original);
      expect((await changes({ refreshIds: [original.entries[0]!.id] }, "scheduler")).status).toBe(200);
      expect((await getHrSchedule(db, "2026-02")).entries[0]!.attendanceStatus).toBe(attendanceStatus);
    }
  });

  it("驗證後出勤狀態才確認，原子守衛仍禁止負責人移除", async () => {
    await assign("scheduler");
    await changes({ entries: [entry("worker-1")] });
    const original = await getHrSchedule(db, "2026-02");
    const batch = d1.batch.bind(d1);
    vi.spyOn(d1, "batch").mockImplementation(async (statements) => {
      d1.sqlite.prepare("UPDATE hr_schedule_worker_entries SET attendance_status='absent' WHERE id=?").run(original.entries[0]!.id);
      return batch(statements);
    });
    expect((await changes({ removedIds: [original.entries[0]!.id], entries: [entry("worker-1")] }, "scheduler")).status).toBe(409);
    const after = await getHrSchedule(db, "2026-02");
    expect(after.entries[0]).toMatchObject({ id: original.entries[0]!.id, attendanceStatus: "absent" });
    expect(after.version).toEqual(original.version);
  });

  it("撤銷、更換、停權、封存與停用據點會立即收回資格", async () => {
    await assign("scheduler");
    expect((await assign("other", 1)).status).toBe(200);
    expect((await changes({ entries: [entry("worker-1")] }, "scheduler")).status).toBe(403);
    expect((await assign(null, 2)).status).toBe(200);
    expect((await changes({ entries: [entry("worker-1")] }, "other")).status).toBe(403);
    expect((await assign("scheduler", 1)).status).toBe(409);
    expect((await assign("scheduler", 3)).status).toBe(200);
    d1.sqlite.prepare("UPDATE users SET status='disabled' WHERE id='scheduler'").run();
    expect((await changes({ entries: [entry("worker-1")] }, "scheduler")).status).toBe(403);
    d1.sqlite.prepare("UPDATE users SET status='active' WHERE id='scheduler';").run();
    d1.sqlite.prepare("UPDATE hr_employments SET archived_at=CURRENT_TIMESTAMP WHERE id='employment-scheduler'").run();
    expect((await changes({ entries: [entry("worker-1")] }, "scheduler")).status).toBe(403);
    d1.sqlite.prepare("UPDATE hr_employments SET archived_at=NULL WHERE id='employment-scheduler'").run();
    d1.sqlite.prepare("UPDATE scopes SET active=0 WHERE id='store-a'").run();
    expect((await changes({ entries: [entry("worker-1")] }, "scheduler")).status).toBe(403);
  });

  it.each(["active", "invited", "disabled"] as const)("任一未封存員工可被指定（帳號 %s），但不繞過帳號啟用檢查", async (status) => {
    d1.sqlite.prepare("UPDATE users SET status=? WHERE id='other'").run(status);
    const data = await (await request("/schedule-managers")).json() as { candidates: Array<{ userId: string; userStatus: string }> };
    expect(data.candidates).toContainEqual(expect.objectContaining({ userId: "other", userStatus: status }));
    expect((await assign("other")).status).toBe(200);
    const own = await request("/me/schedule-scopes", "GET", undefined, "other");
    if (status === "active") expect(await own.json()).toEqual({ scopes: [{ id: "store-a", name: "store-a" }] });
    else expect(own.status).toBe(403);
    expect((await request("/me/schedules?periodKey=2026-02&scopeId=store-b", "GET", undefined, "scheduler")).status).toBe(403);
  });

  it("候選限未封存員工，不把非員工帳號或支援人員當負責人", async () => {
    await db.insert(users).values({ id: "nonemployee", email: "nonemployee@example.test", displayName: "非員工", status: "active" });
    d1.sqlite.prepare("UPDATE hr_employments SET archived_at=CURRENT_TIMESTAMP WHERE id='employment-other'").run();
    const data = await (await request("/schedule-managers")).json() as { candidates: Array<{ userId: string }> };
    expect(data.candidates.map((person) => person.userId).sort()).toEqual(["admin", "scheduler"]);
    for (const id of ["other", "nonemployee", "worker-1"]) expect((await assign(id)).status).toBe(400);
  });

  it("據點負責人只能鎖定自己的單店月份，且不影響其他據點或全域鎖定範圍", async () => {
    await assign("scheduler");
    expect((await changes({ entries: [entry("worker-1")] })).status).toBe(200);
    const locked = await request("/me/schedules/lock", "POST", { periodKey: "2026-02", scopeId: "store-a", revision: 0, locked: true }, "scheduler");
    expect(locked.status, await locked.clone().text()).toBe(200);
    expect(await locked.json()).toMatchObject({ scopeId: "store-a", revision: 1, locked: true });
    const own = await request("/me/schedules?periodKey=2026-02&scopeId=store-a", "GET", undefined, "scheduler");
    expect(await own.json()).toMatchObject({ version: { locked: true }, scopeLock: { revision: 1, locked: true } });
    expect((await changes({ entries: [entry("worker-2", "2026-02-09")] }, "scheduler")).status).toBe(409);
    expect((await request("/me/schedules/lock", "POST", { periodKey: "2026-02", scopeId: "store-b", revision: 0, locked: true }, "scheduler")).status).toBe(403);

    const otherShift = await request("/shift-templates", "POST", { scopeId: "store-b", name: "B早班", times: [{ dayType: "weekday", startTime: "09:00", endTime: "18:00" }] });
    const otherShiftId = (await otherShift.json() as { versionId: string }).versionId;
    expect((await changes({ entries: [{ ...entry("worker-2", "2026-02-09", "store-b"), shiftVersionId: otherShiftId }] })).status).toBe(200);
    const globalWriteToLockedScope = await changes({ entries: [entry("worker-2", "2026-02-10")] });
    expect(globalWriteToLockedScope.status).toBe(409);
    expect((await getHrSchedule(db, "2026-02")).entries.map((row) => row.scopeId).sort()).toEqual(["store-a", "store-b"]);

    const unlocked = await request("/me/schedules/lock", "POST", { periodKey: "2026-02", scopeId: "store-a", revision: 1, locked: false }, "scheduler");
    expect(unlocked.status).toBe(200);
    expect(await unlocked.json()).toMatchObject({ scopeId: "store-a", revision: 2, locked: false });
    expect((await changes({ entries: [entry("worker-2", "2026-02-11")] }, "scheduler")).status).toBe(200);
  });

  it("負責人指派限全域管理權限、有效員工及有效門市", async () => {
    expect((await request("/schedule-managers/store-a", "PUT", { userId: "scheduler", revision: 0 }, "scheduler")).status).toBe(403);
    expect((await assign("missing")).status).toBe(400);
    expect((await request("/schedule-managers/missing", "PUT", { userId: "scheduler", revision: 0 })).status).toBe(404);
    expect((await assign("scheduler")).status).toBe(200);
    expect((await assign("other")).status).toBe(409);
    expect((await db.select().from(hrScheduleManagers))[0]).toMatchObject({ userId: "scheduler", revision: 1 });
  });
});

describe("排班差異儲存", () => {
  it("只增刪指定列，未改列的 ID、群組、工時及歷史快照不變", async () => {
    expect((await changes({ entries: [entry("worker-1")] })).status).toBe(200);
    const original = (await getHrSchedule(db, "2026-02")).entries[0]!;
    expect((await changes({ entries: [entry("worker-2")] })).status).toBe(200);
    const withSecond = await getHrSchedule(db, "2026-02");
    expect(withSecond.entries.find((entry) => entry.id === original.id)).toEqual(original);
    expect(new Set(withSecond.entries.map((entry) => entry.shiftGroupId)).size).toBe(1);
    const added = withSecond.entries.find((entry) => entry.id !== original.id)!;
    expect((await changes({ removedIds: [added.id] })).status).toBe(200);
    expect((await getHrSchedule(db, "2026-02")).entries).toEqual([original]);
  });

  it("重疊檢查會納入 API 查到的未變更排班，任一錯誤不留下部分資料", async () => {
    await changes({ entries: [entry("worker-1")] });
    const original = await getHrSchedule(db, "2026-02");
    expect((await changes({ entries: [entry("worker-2", "2026-02-09"), entry("worker-1")] })).status).toBe(409);
    expect((await getHrSchedule(db, "2026-02")).entries).toEqual(original.entries);
    expect((await changes({ removedIds: ["missing"], entries: [entry("worker-2")] })).status).toBe(409);
    expect((await changes({ entries: [entry("worker-2", "2026-03-01")] })).status).toBe(400);
    expect((await changes({ revision: 0, entries: [entry("worker-2")] })).status).toBe(409);
    expect((await getHrSchedule(db, "2026-02")).version).toEqual(original.version);
  });

  it("鎖定月份、封存人員及重複 ID 都拒絕變更", async () => {
    await changes({ entries: [entry("worker-1")] });
    const original = await getHrSchedule(db, "2026-02");
    const id = original.entries[0]!.id;
    expect((await changes({ removedIds: [id, id] })).status).toBe(400);
    expect((await changes({ removedIds: [id], refreshIds: [id] })).status).toBe(400);
    d1.sqlite.prepare("UPDATE hr_employments SET archived_at=CURRENT_TIMESTAMP WHERE id='worker-1'").run();
    expect((await changes({ removedIds: [id] })).status).toBe(409);
    expect((await changes({ entries: [entry("worker-1", "2026-02-09")] })).status).toBe(400);
    await request("/schedules/2026-02/lock", "POST", { revision: original.version!.revision, locked: true });
    expect((await changes({ entries: [entry("worker-2")] })).status).toBe(409);
    expect((await getHrSchedule(db, "2026-02")).entries).toHaveLength(1);
  });

  it("重新套用只送 ID，由 API 重選日型；其他日期保持快照", async () => {
    await changes({ entries: [entry("worker-1", "2026-02-06"), entry("worker-1", "2026-02-09")] });
    const before = await getHrSchedule(db, "2026-02");
    await request("/calendar/2026-02", "PUT", { days: [{ date: "2026-02-06", dayType: "weekend", name: "調整" }] });
    expect((await changes({ refreshIds: [before.entries.find((entry) => entry.workDate === "2026-02-06")!.id] })).status).toBe(200);
    const after = await getHrSchedule(db, "2026-02");
    expect(after.entries.find((entry) => entry.workDate === "2026-02-06")).toMatchObject({ startsAt: "2026-02-06 10:00:00", requiredHeadcount: 2 });
    expect(after.entries.find((entry) => entry.workDate === "2026-02-09")).toEqual(before.entries.find((entry) => entry.workDate === "2026-02-09"));
  });

  it("同班不同日型的人力不一致時拒絕部分更新，一併 refresh 後才發布", async () => {
    await changes({ entries: [entry("worker-1")] });
    const original = await getHrSchedule(db, "2026-02");
    await request("/calendar/2026-02", "PUT", { days: [{ date: "2026-02-06", dayType: "weekend", name: "調整" }] });
    const partial = await changes({ entries: [entry("worker-2")] });
    expect(partial.status).toBe(409);
    expect(await partial.text()).toContain("一併重新套用");
    expect((await getHrSchedule(db, "2026-02")).entries).toEqual(original.entries);
    expect((await changes({ entries: [entry("worker-2")], refreshIds: [original.entries[0]!.id] })).status).toBe(200);
    const after = await getHrSchedule(db, "2026-02");
    expect(after.entries.every((entry) => entry.requiredHeadcount === 2 && entry.startsAt === "2026-02-06 10:00:00")).toBe(true);
    expect(new Set(after.entries.map((entry) => entry.shiftGroupId)).size).toBe(1);
  });

  it("不同日型的封存快照不阻擋活動人員的新設定，仍共用同班群組", async () => {
    await changes({ entries: [entry("worker-1")] });
    const original = (await getHrSchedule(db, "2026-02")).entries[0]!;
    d1.sqlite.prepare("UPDATE hr_employments SET archived_at=CURRENT_TIMESTAMP WHERE id='worker-1'").run();
    await request("/calendar/2026-02", "PUT", { days: [{ date: "2026-02-06", dayType: "weekend", name: "調整" }] });
    expect((await changes({ entries: [entry("worker-2")] })).status).toBe(200);
    const after = await getHrSchedule(db, "2026-02");
    expect(after.entries.find((entry) => entry.workerId === "worker-1")).toMatchObject({ id: original.id, requiredHeadcount: 1 });
    expect(after.entries.find((entry) => entry.workerId === "worker-2")).toMatchObject({ requiredHeadcount: 2, shiftGroupId: original.shiftGroupId });
  });

  it("資料庫 CAS 過期時不會因為別人的 revision+1 而刪寫資料", async () => {
    await changes({ entries: [entry("worker-1")] });
    const original = await getHrSchedule(db, "2026-02");
    const batch = d1.batch.bind(d1);
    vi.spyOn(d1, "batch").mockImplementation(async (statements) => {
      d1.sqlite.prepare("UPDATE hr_schedule_versions SET revision=revision+1 WHERE id=?").run(original.version!.id);
      return batch(statements);
    });
    expect((await changes({ removedIds: [original.entries[0]!.id], entries: [entry("worker-2")] })).status).toBe(409);
    expect((await getHrSchedule(db, "2026-02")).entries).toEqual(original.entries);
    expect(d1.sqlite.prepare("SELECT count(*) AS total FROM activity_events WHERE event_type='schedule_saved'").get()).toMatchObject({ total: 1 });
  });

  it("驗證後負責人被撤銷，寫入的原子守衛仍拒絕變更", async () => {
    await assign("scheduler");
    await changes({ entries: [entry("worker-1")] });
    const original = await getHrSchedule(db, "2026-02");
    const batch = d1.batch.bind(d1);
    vi.spyOn(d1, "batch").mockImplementation(async (statements) => {
      d1.sqlite.prepare("UPDATE hr_schedule_managers SET user_id=NULL WHERE scope_id='store-a'").run();
      return batch(statements);
    });
    expect((await changes({ removedIds: [original.entries[0]!.id] }, "scheduler")).status).toBe(409);
    expect((await getHrSchedule(db, "2026-02")).entries).toEqual(original.entries);
  });

  it("驗證後人員才封存，不會靜默略過移除或重新寫入歷史排班", async () => {
    await changes({ entries: [entry("worker-1")] });
    const original = await getHrSchedule(db, "2026-02");
    const batch = d1.batch.bind(d1);
    vi.spyOn(d1, "batch").mockImplementation(async (statements) => {
      d1.sqlite.prepare("UPDATE hr_employments SET archived_at=CURRENT_TIMESTAMP WHERE id='worker-1'").run();
      return batch(statements);
    });
    expect((await changes({ removedIds: [original.entries[0]!.id], entries: [entry("worker-2")] })).status).toBe(409);
    const after = await getHrSchedule(db, "2026-02");
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]!.id).toBe(original.entries[0]!.id);
    expect(after.version).toEqual(original.version);
  });

  it("首次月份發布前負責人被撤銷，版本、排班與發布稽核都不建立", async () => {
    await assign("scheduler");
    expect((await getHrSchedule(db, "2026-02")).version).toBeNull();
    const batch = d1.batch.bind(d1);
    vi.spyOn(d1, "batch").mockImplementation(async (statements) => {
      d1.sqlite.prepare("UPDATE hr_schedule_managers SET user_id=NULL WHERE scope_id='store-a'").run();
      return batch(statements);
    });
    expect((await changes({ entries: [entry("worker-1")] }, "scheduler")).status).toBe(409);
    expect((await getHrSchedule(db, "2026-02")).version).toBeNull();
    expect(d1.sqlite.prepare("SELECT count(*) AS total FROM activity_events WHERE event_type='schedule_saved'").get()).toMatchObject({ total: 0 });
  });

  it.each(["PATCH", "POST"])("%s 首次發布前人員封存，不留下空月份", async (method) => {
    const batch = d1.batch.bind(d1);
    vi.spyOn(d1, "batch").mockImplementation(async (statements) => {
      d1.sqlite.prepare("UPDATE hr_employments SET archived_at=CURRENT_TIMESTAMP WHERE id='worker-1'").run();
      return batch(statements);
    });
    const result = method === "PATCH" ? await changes({ entries: [entry("worker-1")] }) : await request("/schedules", "POST", { periodKey: "2026-02", entries: [entry("worker-1")] });
    expect(result.status).toBe(409);
    expect((await getHrSchedule(db, "2026-02")).version).toBeNull();
    expect((await db.select().from(hrScheduleVersions))).toHaveLength(0);
  });

  it("首次批次 INSERT 中途失敗，版本與稽核也一併回滾", async () => {
    const batch = d1.batch.bind(d1);
    vi.spyOn(d1, "batch").mockImplementation(async (statements) => batch([...statements.slice(0, -1), d1.prepare("INSERT INTO hr_schedule_worker_entries(id) VALUES('invalid')")]));
    expect((await changes({ entries: [entry("worker-1")] })).status).toBe(500);
    expect((await getHrSchedule(db, "2026-02")).version).toBeNull();
    expect(d1.sqlite.prepare("SELECT count(*) AS total FROM activity_events WHERE event_type='schedule_saved'").get()).toMatchObject({ total: 0 });
  });

  it("首次發布競態只接受先提交者，另一方不留下版本、排班或稽核", async () => {
    const batch = d1.batch.bind(d1);
    vi.spyOn(d1, "batch").mockImplementationOnce(async (statements) => {
      expect((await changes({ entries: [entry("worker-2")] })).status).toBe(200);
      return batch(statements);
    });
    expect((await changes({ entries: [entry("worker-1")] })).status).toBe(409);
    const after = await getHrSchedule(db, "2026-02");
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]!.workerId).toBe("worker-2");
    expect(after.version!.revision).toBe(2);
    expect((await db.select().from(hrScheduleVersions))).toHaveLength(1);
    expect(d1.sqlite.prepare("SELECT count(*) AS total FROM activity_events WHERE event_type='schedule_saved'").get()).toMatchObject({ total: 1 });
  });

  it("1000 筆排班以固定 6 條 SQL 批次寫入，不隨筆數逐筆查詢", async () => {
    const workers = Array.from({ length: 40 }, (_, index) => `bulk-${index}`);
    for (const id of workers) await db.insert(hrEmployments).values({ id, personKind: "worker", employeeNumber: id, legalName: id, position: "支援" });
    const entries = workers.flatMap((workerId) => Array.from({ length: 25 }, (_, index) => entry(workerId, `2026-02-${String(index + 1).padStart(2, "0")}`)));
    const batch = vi.spyOn(d1, "batch");
    const saved = await changes({ entries });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0]![0]).toHaveLength(6);
    expect((await getHrSchedule(db, "2026-02")).entries).toHaveLength(1000);
    expect((await db.select().from(hrScheduleVersions))).toHaveLength(1);
  });
});
