import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { activityRow } from "./activity.js";
import { type Database } from "./client.js";
import { HrError, hrEmployeeName, hrEmployeeNumberOrder, type HrActor } from "./hr-people.js";
import { getHrSchedule, saveHrScheduleChanges, type HrScheduleChangesInput } from "./hr-scheduling.js";
import { users } from "./schema/auth.js";
import { hrEmployments } from "./schema/hr-people.js";
import { hrScheduleManagers } from "./schema/hr-scheduling.js";
import { scopes } from "./schema/reports.js";

export async function listHrScheduleManagers(db: Database) {
  const [stores, managers, candidates] = await Promise.all([
    db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(and(eq(scopes.scopeKind, "store"), eq(scopes.active, 1))).orderBy(asc(scopes.sortOrder), asc(scopes.name)),
    db.select().from(hrScheduleManagers),
    db.select({ userId: users.id, name: hrEmployeeName, employeeNumber: hrEmployments.employeeNumber }).from(hrEmployments).innerJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(and(isNull(hrEmployments.archivedAt), eq(users.status, "active"))).orderBy(...hrEmployeeNumberOrder()),
  ]);
  return { scopes: stores.map((scope) => ({ ...scope, userId: managers.find((manager) => manager.scopeId === scope.id)?.userId ?? null, revision: managers.find((manager) => manager.scopeId === scope.id)?.revision ?? 0 })), candidates };
}

export async function setHrScheduleManager(db: Database, scopeId: string, input: { userId: string | null; revision: number }, actor: HrActor) {
  const [scope] = await db.select({ id: scopes.id }).from(scopes).where(and(eq(scopes.id, scopeId), eq(scopes.scopeKind, "store"), eq(scopes.active, 1)));
  if (!scope) throw new HrError(404, "找不到有效的營運據點。 ");
  if (input.userId) {
    const [candidate] = await db.select({ id: users.id }).from(users).innerJoin(hrEmployments, eq(hrEmployments.employeeUserId, users.id)).where(and(eq(users.id, input.userId), eq(users.status, "active"), isNull(hrEmployments.archivedAt)));
    if (!candidate) throw new HrError(400, "排班負責人必須是在職且帳號啟用的員工。 ");
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
  return { ...data, scopes: data.scopes.filter((scope) => scope.id === scopeId), calendar: data.calendar.map((day) => ({ ...day, specialScopeIds: day.specialScopeIds.filter((id) => id === scopeId) })) };
}

export async function saveHrManagedSchedule(db: Database, scopeId: string, input: HrScheduleChangesInput, actor: HrActor) {
  await assertManagedScope(db, actor.id, scopeId);
  return saveHrScheduleChanges(db, input, actor, scopeId);
}
