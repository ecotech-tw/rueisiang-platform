import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { activityRow } from "./activity.js";
import { type Database } from "./client.js";
import { HrError, hrEmployeeName, hrEmployeeNumberOrder, type HrActor } from "./hr-people.js";
import { calendarSpecialAppliesToScope, defaultDayType } from "./hr-calendar.js";
import { getHrSchedule, getHrScheduleScopeLock, monthPeriodFromKey, saveHrScheduleChanges, setHrScheduleScopeLock, type HrScheduleChangesInput } from "./hr-scheduling.js";
import { users } from "./schema/auth.js";
import { hrEmployments, hrEmployeeScopes, hrWorkerAccountLinks } from "./schema/hr-people.js";
import { hrEmploymentAttendanceSettings } from "./schema/hr-attendance.js";
import { hrScheduleManagers } from "./schema/hr-scheduling.js";
import { scopes } from "./schema/reports.js";
import { canSchedulePerson } from "./schedule-draft.js";

export async function listHrScheduleManagers(db: Database) {
  const [stores, managers, candidates] = await Promise.all([
    db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(and(eq(scopes.scopeKind, "store"), eq(scopes.active, 1))).orderBy(asc(scopes.sortOrder), asc(scopes.name)),
    db.select().from(hrScheduleManagers),
    db.select({ userId: users.id, name: hrEmployeeName, employeeNumber: hrEmployments.employeeNumber, userStatus: users.status }).from(hrEmployments).innerJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(and(eq(hrEmployments.personKind, "employee"), isNull(hrEmployments.archivedAt))).orderBy(...hrEmployeeNumberOrder()),
  ]);
  return { scopes: stores.map((scope) => ({ ...scope, userId: managers.find((manager) => manager.scopeId === scope.id)?.userId ?? null, revision: managers.find((manager) => manager.scopeId === scope.id)?.revision ?? 0 })), candidates };
}

export async function setHrScheduleManager(db: Database, scopeId: string, input: { userId: string | null; revision: number }, actor: HrActor) {
  const [scope] = await db.select({ id: scopes.id }).from(scopes).where(and(eq(scopes.id, scopeId), eq(scopes.scopeKind, "store"), eq(scopes.active, 1)));
  if (!scope) throw new HrError(404, "找不到有效的營運據點。 ");
  if (input.userId) {
    const [candidate] = await db.select({ id: users.id }).from(users).innerJoin(hrEmployments, eq(hrEmployments.employeeUserId, users.id)).where(and(eq(users.id, input.userId), eq(hrEmployments.personKind, "employee"), isNull(hrEmployments.archivedAt)));
    if (!candidate) throw new HrError(400, "排班負責人必須是在職員工。 ");
  }
  const row = activityRow({ entityType: "hr_schedule", entityId: scopeId, source: "hr", eventType: "schedule_manager_updated", summary: "排班負責人已更新", actor, payload: { userId: input.userId } });
  const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
  const statements = [
    input.revision === 0
      ? sql`INSERT INTO hr_schedule_managers (scope_id, user_id, updated_by) VALUES (${scopeId}, ${input.userId}, ${actor.id}) ON CONFLICT(scope_id) DO NOTHING RETURNING scope_id`
      : sql`UPDATE hr_schedule_managers SET user_id=${input.userId}, updated_by=${actor.id}, updated_at=CURRENT_TIMESTAMP, revision=revision+1 WHERE scope_id=${scopeId} AND revision=${input.revision} RETURNING scope_id`,
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email, payload_json)
      SELECT ${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail}, ${row.payloadJson} WHERE changes()=1`,
  ].map((statement) => { const query = dialect.sqlToQuery(statement); return db.$client.prepare(query.sql).bind(...query.params); });
  const results = await db.$client.batch(statements);
  if (!results[0]?.results?.length) throw new HrError(409, "負責人已被其他人修改，請重新整理。 ");
  return { id: scopeId, revision: input.revision + 1 };
}

export async function listHrManagedScheduleScopes(db: Database, userId: string) {
  return db.select({ id: scopes.id, name: scopes.name }).from(hrScheduleManagers)
    .innerJoin(scopes, eq(scopes.id, hrScheduleManagers.scopeId))
    .innerJoin(users, eq(users.id, hrScheduleManagers.userId))
    .innerJoin(hrEmployments, eq(hrEmployments.employeeUserId, users.id))
    .where(and(eq(hrScheduleManagers.userId, userId), eq(users.status, "active"), isNull(hrEmployments.archivedAt), eq(scopes.active, 1), eq(scopes.scopeKind, "store")))
    .orderBy(asc(scopes.sortOrder), asc(scopes.name));
}

async function assertManagedScope(db: Database, userId: string, scopeId: string) {
  if (!(await listHrManagedScheduleScopes(db, userId)).some((scope) => scope.id === scopeId)) throw new HrError(403, "你不是這個據點的排班負責人。 ");
}

export async function getHrManagedSchedule(db: Database, userId: string, periodKey: string, scopeId: string) {
  await assertManagedScope(db, userId, scopeId);
  const data = await getHrSchedule(db, periodKey, scopeId);
  const scopeLock = await getHrScheduleScopeLock(db, periodKey, scopeId);
  const globallyLocked = Boolean(data.version?.locked);
  return { ...data, version: data.version ? { ...data.version, locked: globallyLocked || scopeLock.locked, lockedAt: globallyLocked ? data.version.lockedAt : scopeLock.lockedAt } : null, scopeLock: { ...scopeLock, globallyLocked }, employees: data.employees.filter((person) => data.shifts.some((shift) => canSchedulePerson(shift, person.employmentId))), workers: data.workers.filter((person) => data.shifts.some((shift) => canSchedulePerson(shift, person.id))), scopes: data.scopes.filter((scope) => scope.id === scopeId), calendar: data.calendar.map((day) => {
    // 空適用名單代表全域；不能先濾空別店的名單，反而讓前台判成全域特別日。
    if (day.specialKind !== "none" && !calendarSpecialAppliesToScope({ kind: day.specialKind, scopeIds: day.specialScopeIds }, scopeId)) {
      return { ...day, name: "", specialKind: "none" as const, specialScopeIds: [], overridden: day.dayType !== defaultDayType(day.date) };
    }
    return { ...day, specialScopeIds: day.specialScopeIds.filter((id) => id === scopeId) };
  }) };
}

export async function getHrSelfSchedule(db: Database, userId: string, periodKey: string, requestedScopeId?: string) {
  const period = monthPeriodFromKey(periodKey);
  const employee = (await db.select({ id: hrEmployments.id }).from(hrEmployments)
    .where(and(eq(hrEmployments.personKind, "employee"), eq(hrEmployments.employeeUserId, userId), isNull(hrEmployments.archivedAt))).limit(1))[0];
  const worker = employee ? undefined : (await db.select({ id: hrEmployments.id }).from(hrWorkerAccountLinks)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrWorkerAccountLinks.workerId))
    .where(and(eq(hrWorkerAccountLinks.userId, userId), eq(hrEmployments.personKind, "worker"), isNull(hrEmployments.archivedAt))).limit(1))[0];
  const personId = employee?.id ?? worker?.id;
  if (!personId) throw new HrError(403, "目前帳號沒有可查看的本人排班資料。 ");

  const [assignedScopes, data] = await Promise.all([
    employee ? db.select({ id: scopes.id, name: scopes.name }).from(hrEmployeeScopes)
      .innerJoin(scopes, eq(scopes.id, hrEmployeeScopes.scopeId))
      .where(and(eq(hrEmployeeScopes.employmentId, personId), sql`${hrEmployeeScopes.validFrom} < ${period.end} AND (${hrEmployeeScopes.validTo} IS NULL OR ${hrEmployeeScopes.validTo} > ${period.start})`, eq(scopes.active, 1), eq(scopes.scopeKind, "store")))
      : Promise.resolve([]),
    getHrSchedule(db, periodKey),
  ]);
  const personKind = employee ? "employee" : "worker";
  const attendanceSettings = employee ? (await db.select({ attendanceMode: hrEmploymentAttendanceSettings.attendanceMode, monthlyRestDays: hrEmploymentAttendanceSettings.monthlyRestDays }).from(hrEmploymentAttendanceSettings).where(eq(hrEmploymentAttendanceSettings.employmentId, personId)).limit(1))[0] : undefined;
  const ownEntries = data.entries.filter((entry) => entry.personKind === personKind && (personKind === "employee" ? entry.employmentId === personId : entry.workerId === personId));
  const allowedScopeIds = new Set([...assignedScopes.map((scope) => scope.id), ...ownEntries.map((entry) => entry.scopeId)]);
  if (requestedScopeId && requestedScopeId !== "all" && !allowedScopeIds.has(requestedScopeId)) throw new HrError(403, "只能查看本人所屬據點的排班。 ");
  const visibleScopeIds = requestedScopeId && requestedScopeId !== "all" ? new Set([requestedScopeId]) : allowedScopeIds;
  const visibleScopes = data.scopes.filter((scope) => visibleScopeIds.has(scope.id));
  const visibleEntries = data.entries.filter((entry) => visibleScopeIds.has(entry.scopeId));
  const managerRows = visibleScopes.length ? await db.select({ scopeId: hrScheduleManagers.scopeId, name: hrEmployeeName })
    .from(hrScheduleManagers).innerJoin(users, eq(users.id, hrScheduleManagers.userId))
    .innerJoin(hrEmployments, eq(hrEmployments.employeeUserId, users.id))
    .where(and(inArray(hrScheduleManagers.scopeId, visibleScopes.map((scope) => scope.id)), eq(users.status, "active"), isNull(hrEmployments.archivedAt))) : [];
  const managerByScope = new Map(managerRows.map((manager) => [manager.scopeId, manager.name]));

  return {
    periodKey,
    attendanceMode: attendanceSettings?.attendanceMode ?? (worker ? "scheduled" : "general"),
    monthlyRestDays: attendanceSettings?.monthlyRestDays ?? null,
    scopes: visibleScopes,
    calendar: data.calendar.map((day) => {
      const applies = day.specialKind === "none" || !day.specialScopeIds.length || day.specialScopeIds.some((id) => visibleScopeIds.has(id));
      if (!applies) return { ...day, name: "", specialKind: "none" as const, specialScopeIds: [], overridden: day.dayType !== defaultDayType(day.date) };
      return { ...day, specialScopeIds: day.specialScopeIds.filter((id) => visibleScopeIds.has(id)) };
    }),
    scheduleManagers: visibleScopes.map((scope) => ({ scopeId: scope.id, name: managerByScope.get(scope.id) ?? null })),
    entries: visibleEntries.map((entry) => ({
      workDate: entry.workDate,
      scopeId: entry.scopeId,
      scopeName: entry.scopeName,
      personKind: entry.personKind,
      personName: entry.personName,
      shiftName: entry.shiftName,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      isMine: entry.personKind === personKind && (personKind === "employee" ? entry.employmentId === personId : entry.workerId === personId),
    })),
  };
}

export async function saveHrManagedSchedule(db: Database, scopeId: string, input: HrScheduleChangesInput, actor: HrActor) {
  await assertManagedScope(db, actor.id, scopeId);
  return saveHrScheduleChanges(db, input, actor, scopeId);
}

export async function setHrManagedScheduleLock(db: Database, periodKey: string, scopeId: string, actor: HrActor, input: { revision: number; locked: boolean }) {
  await assertManagedScope(db, actor.id, scopeId);
  return setHrScheduleScopeLock(db, periodKey, scopeId, input, actor);
}
