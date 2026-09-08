import { asc, eq, sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { hrEmployees, hrEmployers, hrEmployments, hrEmployeeScopes } from "./schema/hr-people.js";
import { scopes } from "./schema/reports.js";
import { users } from "./schema/auth.js";

export class HrError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) { super(message); }
}
export interface HrActor { id: string; email: string }

/** 共用稽核只放操作種類與 ID，不放員工姓名、任職日期或帳號綁定內容。 */
async function write(db: Database, statement: SQL, id: string, actor: HrActor, action: string) {
  const row = activityRow({ entityType: "hr_personnel", entityId: id, source: "hr", eventType: action, summary: "人事資料異動", actor });
  try {
    // batch 內相鄰執行；零列寫入不可產生成功稽核。不能將零列當作 SQL 失敗回滾。
    // Drizzle 的 raw run 不具 D1 batch 所需的 prepared statement；仍用其 dialect 安全綁參數。
    const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
    const statements = [statement, sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email)
        SELECT ${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail}
        WHERE changes() = 1`].map((query) => {
      const compiled = dialect.sqlToQuery(query);
      return db.$client.prepare(compiled.sql).bind(...compiled.params);
    });
    const [result] = await db.$client.batch(statements);
    if (!result?.results.length) throw new HrError(409, "資料已變更、期間重疊或關聯不存在，請重新整理後確認。");
    return { id };
  } catch (error) {
    if (error instanceof HrError) throw error;
    const messages: string[] = [];
    let cause: unknown = error;
    for (let depth = 0; depth < 5 && cause instanceof Error; depth += 1) {
      messages.push(cause.message); cause = cause.cause;
    }
    if (messages.some((message) => /UNIQUE constraint failed|FOREIGN KEY constraint failed/.test(message))) {
      throw new HrError(409, "編號、統編或帳號已使用，或關聯資料不存在。");
    }
    throw error;
  }
}

export async function listHrEmployers(db: Database) {
  return db.select().from(hrEmployers).orderBy(asc(hrEmployers.name));
}
export async function listHrEmployees(db: Database, page: number) {
  const rows = await db.select().from(hrEmployees).orderBy(asc(hrEmployees.employeeNumber)).limit(51).offset((page - 1) * 50);
  return { employees: rows.slice(0, 50), hasMore: rows.length > 50, page };
}
export async function getHrEmployee(db: Database, id: string) {
  const [person] = await db.select({ employee: hrEmployees, userEmail: users.email }).from(hrEmployees)
    .leftJoin(users, eq(users.id, hrEmployees.userId)).where(eq(hrEmployees.id, id));
  if (!person) throw new HrError(404, "找不到員工資料。");
  const employee = { ...person.employee, userEmail: person.userEmail };
  const employments = await db.select({
    id: hrEmployments.id, employeeId: hrEmployments.employeeId, employerId: hrEmployments.employerId,
    employerName: hrEmployers.name, hiredOn: hrEmployments.hiredOn, endedOn: hrEmployments.endedOn,
    seniorityStartOn: hrEmployments.seniorityStartOn, revision: hrEmployments.revision,
  }).from(hrEmployments).innerJoin(hrEmployers, eq(hrEmployers.id, hrEmployments.employerId))
    .where(eq(hrEmployments.employeeId, id)).orderBy(asc(hrEmployments.hiredOn));
  const assignments = await db.select({
    id: hrEmployeeScopes.id, employmentId: hrEmployeeScopes.employmentId, scopeId: hrEmployeeScopes.scopeId,
    scopeName: scopes.name, validFrom: hrEmployeeScopes.validFrom, validTo: hrEmployeeScopes.validTo, revision: hrEmployeeScopes.revision,
  }).from(hrEmployeeScopes).innerJoin(hrEmployments, eq(hrEmployments.id, hrEmployeeScopes.employmentId))
    .innerJoin(scopes, eq(scopes.id, hrEmployeeScopes.scopeId)).where(eq(hrEmployments.employeeId, id))
    .orderBy(asc(hrEmployeeScopes.validFrom));
  return { employee, employments, assignments };
}
export async function getHrSelf(db: Database, userId: string) {
  const [employee] = await db.select({ id: hrEmployees.id }).from(hrEmployees).where(eq(hrEmployees.userId, userId));
  return employee ? getHrEmployee(db, employee.id) : null;
}
export async function listHrScopes(db: Database) {
  return db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(eq(scopes.active, 1)).orderBy(asc(scopes.name));
}

export function createHrEmployer(db: Database, input: { name: string; registrationNumber: string | null }, actor: HrActor) {
  const id = crypto.randomUUID();
  return write(db, sql`INSERT INTO hr_employers (id, name, registration_number) VALUES (${id}, ${input.name}, ${input.registrationNumber}) RETURNING id`, id, actor, "employer_created");
}
export function createHrEmployee(db: Database, input: { employeeNumber: string; displayName: string }, actor: HrActor) {
  const id = crypto.randomUUID();
  return write(db, sql`INSERT INTO hr_employees (id, employee_number, display_name) VALUES (${id}, ${input.employeeNumber}, ${input.displayName}) RETURNING id`, id, actor, "employee_created");
}
export function updateHrEmployee(db: Database, id: string, input: { employeeNumber: string; displayName: string; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employees SET employee_number=${input.employeeNumber}, display_name=${input.displayName}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND revision=${input.revision} RETURNING id`, id, actor, "employee_updated");
}
export function bindHrUser(db: Database, id: string, input: { userEmail: string | null; revision: number }, actor: HrActor) {
  // 帳號綁定會改變本人資料可見性，API 額外要求獨立 binding 權限；停用帳號也不能綁定。
  return write(db, sql`UPDATE hr_employees SET user_id=(SELECT id FROM users WHERE email=${input.userEmail} AND status='active'), revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND revision=${input.revision}
      AND (${input.userEmail} IS NULL OR EXISTS (SELECT 1 FROM users WHERE email=${input.userEmail} AND status='active')) RETURNING id`, id, actor, "employee_account_bound");
}
export function createHrEmployment(db: Database, input: { employeeId: string; employerId: string; hiredOn: string; endedOn: string | null; seniorityStartOn: string }, actor: HrActor) {
  const id = crypto.randomUUID();
  // NOT EXISTS 與 INSERT 同一個 SQL，避免兩個請求都先讀到「沒有重疊」。
  return write(db, sql`INSERT INTO hr_employments (id, employee_id, employer_id, hired_on, ended_on, seniority_start_on)
    SELECT ${id}, ${input.employeeId}, ${input.employerId}, ${input.hiredOn}, ${input.endedOn}, ${input.seniorityStartOn}
    WHERE NOT EXISTS (SELECT 1 FROM hr_employments WHERE employee_id=${input.employeeId} AND employer_id=${input.employerId}
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
    AND EXISTS (SELECT 1 FROM scopes WHERE id=${input.scopeId} AND active=1)
    AND NOT EXISTS (SELECT 1 FROM hr_employee_scopes WHERE employment_id=${input.employmentId} AND scope_id=${input.scopeId}
      AND (${input.validTo} IS NULL OR valid_from < ${input.validTo}) AND (valid_to IS NULL OR valid_to > ${input.validFrom})) RETURNING id`, id, actor, "assignment_created");
}
export function endHrAssignment(db: Database, id: string, input: { validTo: string; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employee_scopes SET valid_to=${input.validTo}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND revision=${input.revision} AND valid_to IS NULL AND valid_from < ${input.validTo} RETURNING id`, id, actor, "assignment_ended");
}
