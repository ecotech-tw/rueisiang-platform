import { and, asc, eq, like, notExists, or, sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { hrEmployees, hrEmployments, hrEmployeeScopes } from "./schema/hr-people.js";
import { scopes } from "./schema/reports.js";
import { users } from "./schema/auth.js";

export class HrError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) { super(message); }
}
export interface HrActor { id: string; email: string }

/** 共用稽核只放操作種類與 ID，不放姓名、任職日期等人事內容。 */
async function write(db: Database, statement: SQL | SQL[], id: string, actor: HrActor, action: string) {
  const row = activityRow({ entityType: "hr_personnel", entityId: id, source: "hr", eventType: action, summary: "人事資料異動", actor });
  try {
    // 零列寫入不是 SQL 失敗。後續依賴寫入與稽核都必須跟著 changes() guard。
    const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
    const mutations = Array.isArray(statement) ? statement : [statement];
    const statements = [...mutations, sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email)
        SELECT ${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail}
        WHERE changes() = 1`].map((query) => {
      const compiled = dialect.sqlToQuery(query);
      return db.$client.prepare(compiled.sql).bind(...compiled.params);
    });
    // Drizzle raw run 不具 D1 batch 所需的 prepared statement，使用原 binding 執行安全綁參數的 SQL。
    const results = await db.$client.batch(statements);
    // 每個 mutation 都帶 RETURNING；多步指派不能只檢查第一步，否則可能留下沒有任職的員工。
    if (results.slice(0, mutations.length).some((result) => !result.results.length)) {
      throw new HrError(409, "資料已變更、期間重疊或使用者不可指派，請重新整理後確認。");
    }
    return { id };
  } catch (error) {
    if (error instanceof HrError) throw error;
    const messages: string[] = [];
    let cause: unknown = error;
    for (let depth = 0; depth < 5 && cause instanceof Error; depth += 1) { messages.push(cause.message); cause = cause.cause; }
    if (messages.some((message) => /UNIQUE constraint failed|FOREIGN KEY constraint failed/.test(message))) {
      throw new HrError(409, "此使用者已是員工、員工編號已使用，或關聯資料不存在。");
    }
    throw error;
  }
}

const displayName = sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`;
const employeeFields = { userId: hrEmployees.userId, employeeNumber: hrEmployees.employeeNumber, displayName, email: users.email, userStatus: users.status, revision: hrEmployees.revision };

export async function listHrCandidates(db: Database, input: { page: number; search: string; userId?: string }) {
  const rows = await db.select({ userId: users.id, displayName, email: users.email, status: users.status }).from(users)
    .where(and(
      sql`${users.status} IN ('active', 'invited')`,
      notExists(db.select({ id: hrEmployees.userId }).from(hrEmployees).where(eq(hrEmployees.userId, users.id))),
      input.userId ? eq(users.id, input.userId) : undefined,
      input.search ? or(like(users.email, `%${input.search}%`), like(users.displayName, `%${input.search}%`), like(users.googleName, `%${input.search}%`)) : undefined,
    )).orderBy(asc(users.email)).limit(51).offset((input.page - 1) * 50);
  return { users: rows.slice(0, 50), hasMore: rows.length > 50 };
}
export async function listHrEmployees(db: Database, page: number) {
  const rows = await db.select(employeeFields).from(hrEmployees).innerJoin(users, eq(users.id, hrEmployees.userId))
    .orderBy(asc(hrEmployees.employeeNumber)).limit(51).offset((page - 1) * 50);
  return { employees: rows.slice(0, 50), hasMore: rows.length > 50, page };
}
export async function getHrEmployee(db: Database, userId: string) {
  const [employee] = await db.select(employeeFields).from(hrEmployees).innerJoin(users, eq(users.id, hrEmployees.userId)).where(eq(hrEmployees.userId, userId));
  if (!employee) throw new HrError(404, "此使用者尚未被指派為員工。");
  const employments = await db.select().from(hrEmployments).where(eq(hrEmployments.employeeUserId, userId)).orderBy(asc(hrEmployments.hiredOn));
  const assignments = await db.select({
    id: hrEmployeeScopes.id, employmentId: hrEmployeeScopes.employmentId, scopeId: hrEmployeeScopes.scopeId,
    scopeName: scopes.name, validFrom: hrEmployeeScopes.validFrom, validTo: hrEmployeeScopes.validTo, revision: hrEmployeeScopes.revision,
  }).from(hrEmployeeScopes).innerJoin(hrEmployments, eq(hrEmployments.id, hrEmployeeScopes.employmentId))
    .innerJoin(scopes, eq(scopes.id, hrEmployeeScopes.scopeId)).where(eq(hrEmployments.employeeUserId, userId)).orderBy(asc(hrEmployeeScopes.validFrom));
  return { employee, employments, assignments };
}
export async function getHrSelf(db: Database, userId: string) {
  const employee = await isHrEmployee(db, userId);
  return employee ? getHrEmployee(db, userId) : null;
}
export async function isHrEmployee(db: Database, userId: string) {
  const [employee] = await db.select({ userId: hrEmployees.userId }).from(hrEmployees).where(eq(hrEmployees.userId, userId)).limit(1);
  return Boolean(employee);
}
export async function listHrScopes(db: Database) {
  return db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(and(eq(scopes.active, 1), eq(scopes.scopeKind, "store"), sql`${scopes.sourceType} <> 'shopee'`)).orderBy(asc(scopes.name));
}

export function assignHrEmployee(db: Database, input: { userId: string; employeeNumber: string; hiredOn: string; seniorityStartOn: string }, actor: HrActor) {
  const employmentId = crypto.randomUUID();
  // 指派員工與第一筆任職是同一操作；帳號、姓名與初次任職不分成三次建檔。
  return write(db, [
    sql`INSERT INTO hr_employees (user_id, employee_number)
      SELECT id, ${input.employeeNumber} FROM users WHERE id=${input.userId} AND status IN ('active', 'invited') RETURNING user_id AS id`,
    sql`INSERT INTO hr_employments (id, employee_user_id, hired_on, seniority_start_on)
      SELECT ${employmentId}, ${input.userId}, ${input.hiredOn}, ${input.seniorityStartOn} WHERE changes()=1 RETURNING id`,
  ], input.userId, actor, "employee_assigned");
}
export function updateHrEmployee(db: Database, userId: string, input: { employeeNumber: string; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employees SET employee_number=${input.employeeNumber}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE user_id=${userId} AND revision=${input.revision} RETURNING user_id AS id`, userId, actor, "employee_updated");
}
export function createHrEmployment(db: Database, input: { userId: string; hiredOn: string; endedOn: string | null; seniorityStartOn: string }, actor: HrActor) {
  const id = crypto.randomUUID();
  return write(db, sql`INSERT INTO hr_employments (id, employee_user_id, hired_on, ended_on, seniority_start_on)
    SELECT ${id}, ${input.userId}, ${input.hiredOn}, ${input.endedOn}, ${input.seniorityStartOn}
    WHERE NOT EXISTS (SELECT 1 FROM hr_employments WHERE employee_user_id=${input.userId}
      AND (${input.endedOn} IS NULL OR hired_on < ${input.endedOn}) AND (ended_on IS NULL OR ended_on > ${input.hiredOn})) RETURNING id`, id, actor, "employment_created");
}
export function endHrEmployment(db: Database, id: string, input: { endedOn: string; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employments SET ended_on=${input.endedOn}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND revision=${input.revision} AND ended_on IS NULL AND hired_on < ${input.endedOn}
      AND NOT EXISTS (SELECT 1 FROM hr_employee_scopes WHERE employment_id=${id} AND (valid_to IS NULL OR valid_to > ${input.endedOn}))
    RETURNING id`, id, actor, "employment_ended");
}
export function createHrAssignment(db: Database, input: { employmentId: string; scopeId: string; validFrom: string; validTo: string | null }, actor: HrActor) {
  const id = crypto.randomUUID();
  return write(db, sql`INSERT INTO hr_employee_scopes (id, employment_id, scope_id, valid_from, valid_to)
    SELECT ${id}, ${input.employmentId}, ${input.scopeId}, ${input.validFrom}, ${input.validTo}
    WHERE EXISTS (SELECT 1 FROM hr_employments WHERE id=${input.employmentId} AND hired_on <= ${input.validFrom}
      AND (ended_on IS NULL OR (${input.validTo} IS NOT NULL AND ${input.validTo} <= ended_on)))
    AND EXISTS (SELECT 1 FROM scopes WHERE id=${input.scopeId} AND active=1 AND scope_kind='store' AND source_type <> 'shopee')
    AND NOT EXISTS (SELECT 1 FROM hr_employee_scopes WHERE employment_id=${input.employmentId} AND scope_id=${input.scopeId}
      AND (${input.validTo} IS NULL OR valid_from < ${input.validTo}) AND (valid_to IS NULL OR valid_to > ${input.validFrom})) RETURNING id`, id, actor, "assignment_created");
}
export function endHrAssignment(db: Database, id: string, input: { validTo: string; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employee_scopes SET valid_to=${input.validTo}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND revision=${input.revision} AND valid_to IS NULL AND valid_from < ${input.validTo} RETURNING id`, id, actor, "assignment_ended");
}
