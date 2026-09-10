import { and, asc, eq, like, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { hrEmployees, hrEmployments, hrEmployeeScopes, hrManagementScopes } from "./schema/hr-people.js";
import { hrAttendanceLocations, hrEmployeeAttendanceLocations } from "./schema/hr-attendance.js";
import { scopes } from "./schema/reports.js";
import { roles, userRoleAssignments, users } from "./schema/auth.js";

export class HrError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) { super(message); }
}
export interface HrActor { id: string; email: string }

/** 共用稽核只放操作種類與 ID，不放姓名、任職日期等人事內容。 */
async function write(db: Database, statement: SQL | SQL[], id: string, actor: HrActor, action: string, conflictMessage = "此使用者已是員工、員工編號已使用，或關聯資料不存在。") {
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
      throw new HrError(409, conflictMessage);
    }
    throw error;
  }
}

export { write as writeHrMutation };

/** 管理員角色是唯一的全平台 HR 範圍；空的管理範圍不代表全權。 */
export async function isHrAdministrator(db: Database, userId: string): Promise<boolean> {
  const [row] = await db.select({ userId: userRoleAssignments.userId }).from(userRoleAssignments)
    .innerJoin(roles, eq(roles.id, userRoleAssignments.roleId))
    .where(and(eq(userRoleAssignments.userId, userId), eq(roles.roleKey, "admin"), eq(roles.isSystem, true)))
    .limit(1);
  return Boolean(row);
}

/** 範圍授權本身不會授予功能，但可用來限制員工櫃點指派不能擴大管理者權限。 */
export async function hasHrManagementScopeAccess(db: Database, actorUserId: string, scopeId: string): Promise<boolean> {
  if (await isHrAdministrator(db, actorUserId)) return true;
  const [row] = await db.select({ scopeId: hrManagementScopes.scopeId }).from(hrManagementScopes)
    .where(and(eq(hrManagementScopes.userId, actorUserId), eq(hrManagementScopes.scopeId, scopeId))).limit(1);
  return Boolean(row);
}

/** 以任一歷史／目前櫃點歸屬判斷管理範圍，避免把已結束的歷史資料暴露給新範圍。 */
export async function hasHrManagementAccess(db: Database, actorUserId: string, employeeUserId: string): Promise<boolean> {
  if (await isHrAdministrator(db, actorUserId)) return true;
  const [row] = await db.select({ userId: hrEmployees.userId }).from(hrEmployees).where(and(
    eq(hrEmployees.userId, employeeUserId),
    sql`EXISTS (
      SELECT 1 FROM hr_employments AS employment
      INNER JOIN hr_employee_scopes AS assignment ON assignment.employment_id = employment.id
      INNER JOIN hr_management_scopes AS managed ON managed.scope_id = assignment.scope_id
      WHERE employment.employee_user_id = hr_employees.user_id
        AND managed.user_id = ${actorUserId}
    )`,
  )).limit(1);
  return Boolean(row);
}

/** 任職／櫃點／辦公位置寫入都要先用同一條規則驗證目標員工。 */
export async function hasHrEmploymentManagementAccess(db: Database, actorUserId: string, employmentId: string): Promise<boolean> {
  if (await isHrAdministrator(db, actorUserId)) return true;
  const [row] = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(
    eq(hrEmployments.id, employmentId),
    sql`EXISTS (
      SELECT 1 FROM hr_employee_scopes AS assignment
      INNER JOIN hr_management_scopes AS managed ON managed.scope_id = assignment.scope_id
      WHERE assignment.employment_id = hr_employments.id
        AND managed.user_id = ${actorUserId}
    )`,
  )).limit(1);
  return Boolean(row);
}

export async function hasHrAssignmentManagementAccess(db: Database, actorUserId: string, assignmentId: string): Promise<boolean> {
  if (await isHrAdministrator(db, actorUserId)) return true;
  const [row] = await db.select({ id: hrEmployeeScopes.id }).from(hrEmployeeScopes).where(and(
    eq(hrEmployeeScopes.id, assignmentId),
    sql`EXISTS (
      SELECT 1 FROM hr_management_scopes AS managed
      WHERE managed.scope_id = hr_employee_scopes.scope_id
        AND managed.user_id = ${actorUserId}
    )`,
  )).limit(1);
  return Boolean(row);
}

export async function hasHrAttendanceAssignmentManagementAccess(db: Database, actorUserId: string, assignmentId: string): Promise<boolean> {
  if (await isHrAdministrator(db, actorUserId)) return true;
  const [row] = await db.select({ id: hrEmployeeAttendanceLocations.id }).from(hrEmployeeAttendanceLocations)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrEmployeeAttendanceLocations.employmentId))
    .where(and(
      eq(hrEmployeeAttendanceLocations.id, assignmentId),
      sql`EXISTS (
        SELECT 1 FROM hr_employee_scopes AS scope_assignment
        INNER JOIN hr_management_scopes AS managed ON managed.scope_id = scope_assignment.scope_id
        WHERE scope_assignment.employment_id = hr_employee_attendance_locations.employment_id
          AND managed.user_id = ${actorUserId}
      )`,
    )).limit(1);
  return Boolean(row);
}

const displayName = sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`;
const employeeFields = { userId: hrEmployees.userId, employeeNumber: hrEmployees.employeeNumber, supervisorUserId: hrEmployees.supervisorUserId, displayName, email: users.email, userStatus: users.status, revision: hrEmployees.revision };

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
export async function listHrEmployees(db: Database, page: number, actorUserId?: string) {
  const isAdmin = !actorUserId || await isHrAdministrator(db, actorUserId);
  const rows = await db.select(employeeFields).from(hrEmployees).innerJoin(users, eq(users.id, hrEmployees.userId))
    .where(isAdmin ? undefined : sql`EXISTS (
      SELECT 1 FROM hr_employments AS employment
      INNER JOIN hr_employee_scopes AS assignment ON assignment.employment_id = employment.id
      INNER JOIN hr_management_scopes AS managed ON managed.scope_id = assignment.scope_id
      WHERE employment.employee_user_id = hr_employees.user_id
        AND managed.user_id = ${actorUserId}
    )`)
    .orderBy(asc(hrEmployees.employeeNumber)).limit(51).offset((page - 1) * 50);
  return { employees: rows.slice(0, 50), hasMore: rows.length > 50, page };
}
export async function listHrSupervisorCandidates(db: Database, userId: string, actorUserId?: string) {
  const isAdmin = !actorUserId || await isHrAdministrator(db, actorUserId);
  return db.select({ id: hrEmployees.userId, name: displayName }).from(hrEmployees).innerJoin(users, eq(users.id, hrEmployees.userId))
    .where(and(
      ne(hrEmployees.userId, userId),
      eq(users.status, "active"),
      isAdmin ? undefined : sql`EXISTS (
        SELECT 1 FROM hr_employments AS employment
        INNER JOIN hr_employee_scopes AS assignment ON assignment.employment_id = employment.id
        INNER JOIN hr_management_scopes AS managed ON managed.scope_id = assignment.scope_id
        WHERE employment.employee_user_id = hr_employees.user_id
          AND managed.user_id = ${actorUserId}
      )`,
    ))
    .orderBy(asc(displayName));
}
export async function getHrEmployee(db: Database, userId: string, actorUserId?: string) {
  const isAdmin = !actorUserId || await isHrAdministrator(db, actorUserId);
  const [employee] = await db.select(employeeFields).from(hrEmployees).innerJoin(users, eq(users.id, hrEmployees.userId)).where(eq(hrEmployees.userId, userId));
  if (!employee) throw new HrError(404, "此使用者尚未被指派為員工。");
  const [supervisor] = employee.supervisorUserId
    ? await db.select({ displayName }).from(users).where(eq(users.id, employee.supervisorUserId)).limit(1)
    : [];
  const employments = await db.select().from(hrEmployments).where(and(
    eq(hrEmployments.employeeUserId, userId),
    isAdmin ? undefined : sql`EXISTS (
      SELECT 1 FROM hr_employee_scopes AS scope_assignment
      INNER JOIN hr_management_scopes AS managed ON managed.scope_id = scope_assignment.scope_id
      WHERE scope_assignment.employment_id = hr_employments.id
        AND managed.user_id = ${actorUserId}
    )`,
  )).orderBy(asc(hrEmployments.hiredOn));
  const assignments = await db.select({
    id: hrEmployeeScopes.id, employmentId: hrEmployeeScopes.employmentId, scopeId: hrEmployeeScopes.scopeId,
    scopeName: scopes.name, validFrom: hrEmployeeScopes.validFrom, validTo: hrEmployeeScopes.validTo, revision: hrEmployeeScopes.revision,
  }).from(hrEmployeeScopes).innerJoin(hrEmployments, eq(hrEmployments.id, hrEmployeeScopes.employmentId))
    .innerJoin(scopes, eq(scopes.id, hrEmployeeScopes.scopeId)).where(and(
      eq(hrEmployments.employeeUserId, userId),
      isAdmin ? undefined : sql`EXISTS (
        SELECT 1 FROM hr_management_scopes AS managed
        WHERE managed.scope_id = hr_employee_scopes.scope_id
          AND managed.user_id = ${actorUserId}
      )`,
    )).orderBy(asc(hrEmployeeScopes.validFrom));
  const attendanceAssignments = await db.select({
    id: hrEmployeeAttendanceLocations.id, employmentId: hrEmployeeAttendanceLocations.employmentId,
    locationId: hrEmployeeAttendanceLocations.locationId, locationName: hrAttendanceLocations.name,
    validFrom: hrEmployeeAttendanceLocations.validFrom, validTo: hrEmployeeAttendanceLocations.validTo,
    revision: hrEmployeeAttendanceLocations.revision,
  }).from(hrEmployeeAttendanceLocations)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrEmployeeAttendanceLocations.employmentId))
    .innerJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrEmployeeAttendanceLocations.locationId))
    .where(and(
      eq(hrEmployments.employeeUserId, userId),
      isAdmin ? undefined : sql`EXISTS (
        SELECT 1 FROM hr_employee_scopes AS scope_assignment
        INNER JOIN hr_management_scopes AS managed ON managed.scope_id = scope_assignment.scope_id
        WHERE scope_assignment.employment_id = hr_employee_attendance_locations.employment_id
          AND managed.user_id = ${actorUserId}
      )`,
    )).orderBy(asc(hrEmployeeAttendanceLocations.validFrom));
  return { employee: { ...employee, supervisorName: supervisor?.displayName ?? null }, employments, assignments, attendanceAssignments };
}
export async function getHrSelf(db: Database, userId: string) {
  const employee = await isHrEmployee(db, userId);
  return employee ? getHrEmployee(db, userId) : null;
}
export async function isHrEmployee(db: Database, userId: string) {
  const [employee] = await db.select({ userId: hrEmployees.userId }).from(hrEmployees).where(eq(hrEmployees.userId, userId)).limit(1);
  return Boolean(employee);
}
export async function listHrScopes(db: Database, actorUserId?: string) {
  const isAdmin = !actorUserId || await isHrAdministrator(db, actorUserId);
  return db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(and(
    eq(scopes.active, 1),
    eq(scopes.scopeKind, "store"),
    sql`${scopes.sourceType} <> 'shopee'`,
    isAdmin ? undefined : sql`EXISTS (
      SELECT 1 FROM hr_management_scopes AS managed
      WHERE managed.scope_id = scopes.id
        AND managed.user_id = ${actorUserId}
    )`,
  )).orderBy(asc(scopes.name));
}

export interface HrManagementScopeRow {
  userId: string;
  userName: string;
  userEmail: string;
  scopeId: string;
  scopeName: string;
  createdAt: string;
}

export async function listHrManagementScopes(db: Database): Promise<HrManagementScopeRow[]> {
  const rows = await db.select({
    userId: hrManagementScopes.userId,
    userName: sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`,
    userEmail: users.email,
    scopeId: hrManagementScopes.scopeId,
    scopeName: scopes.name,
    createdAt: hrManagementScopes.createdAt,
  }).from(hrManagementScopes)
    .innerJoin(users, eq(users.id, hrManagementScopes.userId))
    .innerJoin(scopes, eq(scopes.id, hrManagementScopes.scopeId))
    .orderBy(asc(users.email), asc(scopes.name));
  return rows;
}

export async function listHrManagementOptions(db: Database) {
  const usersForGrant = await db.select({
    id: users.id,
    name: sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`,
    email: users.email,
  }).from(users).where(eq(users.status, "active")).orderBy(asc(users.email));
  return { users: usersForGrant, scopes: await listHrScopes(db), assignments: await listHrManagementScopes(db) };
}

export function grantHrManagementScope(db: Database, input: { userId: string; scopeId: string }, actor: HrActor) {
  return write(db, sql`INSERT INTO hr_management_scopes (user_id, scope_id)
    SELECT ${input.userId}, ${input.scopeId}
    WHERE EXISTS (SELECT 1 FROM users WHERE id=${input.userId} AND status='active')
      AND EXISTS (SELECT 1 FROM scopes WHERE id=${input.scopeId} AND active=1 AND scope_kind='store' AND source_type <> 'shopee')
    RETURNING user_id AS id`, input.userId, actor, "management_scope_granted", "只能把啟用中的帳號授予有效的營運櫃點範圍。" );
}

export function revokeHrManagementScope(db: Database, input: { userId: string; scopeId: string }, actor: HrActor) {
  return write(db, sql`DELETE FROM hr_management_scopes WHERE user_id=${input.userId} AND scope_id=${input.scopeId} RETURNING user_id AS id`, input.userId, actor, "management_scope_revoked", "找不到這筆 HR 範圍授權。" );
}

export function assignHrEmployee(db: Database, input: { userId: string; employeeNumber: string; hiredOn: string; seniorityStartOn: string }, actor: HrActor) {
  const employmentId = crypto.randomUUID();
  // 指派員工與第一筆任職是同一操作；帳號、姓名與初次任職不分成三次建檔。
  return write(db, [
    sql`INSERT INTO hr_employees (user_id, employee_number)
      SELECT id, ${input.employeeNumber} FROM users WHERE id=${input.userId} AND status IN ('active', 'invited') RETURNING user_id AS id`,
    sql`INSERT INTO hr_employments (id, employee_user_id, hired_on, seniority_start_on)
      SELECT ${employmentId}, employee.user_id, ${input.hiredOn}, ${input.seniorityStartOn}
      FROM hr_employees AS employee INNER JOIN users AS account ON account.id=employee.user_id
      WHERE employee.user_id=${input.userId} AND employee.employee_number=${input.employeeNumber}
        AND account.status IN ('active', 'invited')
      RETURNING id`,
  ], input.userId, actor, "employee_assigned");
}
export function updateHrEmployee(db: Database, userId: string, input: { employeeNumber: string; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employees SET employee_number=${input.employeeNumber}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE user_id=${userId} AND revision=${input.revision} RETURNING user_id AS id`, userId, actor, "employee_updated");
}
export function updateHrEmployeeSupervisor(db: Database, userId: string, input: { supervisorUserId: string | null; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employees SET supervisor_user_id=${input.supervisorUserId}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE user_id=${userId} AND revision=${input.revision}
      AND (${input.supervisorUserId} IS NULL OR (${input.supervisorUserId} <> ${userId}
        AND EXISTS (SELECT 1 FROM hr_employees AS supervisor_employee
          INNER JOIN users AS supervisor_user ON supervisor_user.id=supervisor_employee.user_id
          WHERE supervisor_employee.user_id=${input.supervisorUserId} AND supervisor_user.status='active')))
    RETURNING user_id AS id`, userId, actor, "employee_supervisor_updated", "主管不存在、不可指定自己，或資料已變更，請重新整理。");
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
      AND NOT EXISTS (SELECT 1 FROM hr_employee_attendance_locations WHERE employment_id=${id} AND (valid_to IS NULL OR valid_to > ${input.endedOn}))
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
