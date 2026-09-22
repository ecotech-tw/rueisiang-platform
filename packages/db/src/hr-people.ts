import { and, asc, count, desc, eq, inArray, isNull, like, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { hrEmployments, hrEmployeeScopes } from "./schema/hr-people.js";
import { hrAttendanceLocations, hrClockEvents, hrEmployeeAttendanceLocations, hrEmploymentAttendanceSettings } from "./schema/hr-attendance.js";
import { hrCompensationItems, hrCompensationVersions, hrInsuranceVersions, hrLeaveRequests } from "./schema/hr-payroll.js";
import { scopes } from "./schema/reports.js";
import { roles, userRoleAssignments, users } from "./schema/auth.js";

export class HrError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) { super(message); }
}
export interface HrActor { id: string; email: string }

interface HrMutationOptions {
  allowEmptyMutationIndexes?: ReadonlySet<number>;
  activity?: { payload?: unknown; summary?: string };
}

async function write(db: Database, statement: SQL | SQL[], id: string, actor: HrActor, action: string, conflictMessage = "此使用者已是員工、員工編號已使用，或關聯資料不存在。", options: HrMutationOptions = {}) {
  const row = activityRow({ entityType: "hr_personnel", entityId: id, source: "hr", eventType: action, summary: options.activity?.summary ?? "人事資料異動", payload: options.activity?.payload, actor });
  try {
    const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
    const mutations = Array.isArray(statement) ? statement : [statement];
    const guardStatements = mutations.flatMap((mutation, index) => [
      mutation,
      sql`INSERT INTO hr_mutation_guards (id, ok) VALUES (${crypto.randomUUID()}, CASE WHEN changes() > 0 OR ${options.allowEmptyMutationIndexes?.has(index) ? 1 : 0} = 1 THEN 1 ELSE 0 END)`,
    ]);
    const statements = [...guardStatements, sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, payload_json, source, actor_type, actor_id, actor_email)
        VALUES (${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.payloadJson}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail})`,
      sql`DELETE FROM hr_mutation_guards`].map((query) => {
      const compiled = dialect.sqlToQuery(query);
      return db.$client.prepare(compiled.sql).bind(...compiled.params);
    });
    const results = await db.$client.batch(statements);
    if (mutations.some((_, index) => !options.allowEmptyMutationIndexes?.has(index) && !results[index * 2]?.results.length)) {
      throw new HrError(409, "資料已變更或使用者不可指派，請重新整理後確認。");
    }
    return { id };
  } catch (error) {
    if (error instanceof HrError) throw error;
    const messages: string[] = [];
    let cause: unknown = error;
    for (let depth = 0; depth < 5 && cause instanceof Error; depth += 1) { messages.push(cause.message); cause = cause.cause; }
    if (messages.some((message) => /UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed|daily_leave_capacity_exceeded|monthly_leave_validation_failed|monthly_hourly_validation_failed|payroll_period_closed|payroll_period_not_ready|payroll_run_closed|payroll_run_snapshot_invalid|bonus_performance_idempotency_required|special_workday_source_server_determined|overtime_rate_server_determined/.test(message))) {
      throw new HrError(409, conflictMessage);
    }
    throw error;
  }
}

export { write as writeHrMutation };

export async function isHrAdministrator(db: Database, userId: string): Promise<boolean> {
  const [row] = await db.select({ userId: userRoleAssignments.userId }).from(userRoleAssignments)
    .innerJoin(roles, eq(roles.id, userRoleAssignments.roleId))
    .where(and(eq(userRoleAssignments.userId, userId), eq(roles.roleKey, "admin"), eq(roles.isSystem, true)))
    .limit(1);
  return Boolean(row);
}

const displayName = sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`;

/** 啟用中或邀請中的帳號可以成為員工；封存狀態則由 hr_employments.archived_at 判定。 */
export const hrEmployableUser = sql`${users.status} IN ('active', 'invited')`;

const employeeFields = {
  userId: hrEmployments.employeeUserId,
  employeeNumber: hrEmployments.employeeNumber,
  position: hrEmployments.position,
  supervisorUserId: hrEmployments.supervisorUserId,
  archivedAt: hrEmployments.archivedAt,
  displayName,
  email: users.email,
  userStatus: users.status,
  revision: hrEmployments.revision,
};

const EMPLOYEE_SORT_COLUMNS = {
  employeeNumber: hrEmployments.employeeNumber,
  name: displayName,
  email: users.email,
  status: users.status,
} as const;
export type HrEmployeeSortField = keyof typeof EMPLOYEE_SORT_COLUMNS;
export const HR_EMPLOYEE_PAGE_SIZES = [10, 25, 50, 100] as const;
export type HrEmploymentStatus = "active" | "inactive";

export interface HrEmployeeListQuery {
  page: number;
  pageSize: number;
  search: string;
  status: "all" | "employable" | "active" | "invited" | "disabled";
  employmentStatus?: HrEmploymentStatus;
  /** 保留參數形狀供既有 API consumer 相容；員工狀態不再依日期推導。 */
  today?: string;
  sortField: HrEmployeeSortField;
  sortDirection: "asc" | "desc";
}

export async function listHrCandidates(db: Database, input: { page: number; search: string; userId?: string }) {
  const rows = await db.select({ userId: users.id, displayName, email: users.email, status: users.status }).from(users)
    .where(and(
      hrEmployableUser,
      notExists(db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(eq(hrEmployments.employeeUserId, users.id), isNull(hrEmployments.archivedAt)))),
      input.userId ? eq(users.id, input.userId) : undefined,
      input.search ? or(like(users.email, `%${input.search}%`), like(users.displayName, `%${input.search}%`), like(users.googleName, `%${input.search}%`)) : undefined,
    )).orderBy(asc(users.email)).limit(51).offset((input.page - 1) * 50);
  return { users: rows.slice(0, 50), hasMore: rows.length > 50 };
}

function employmentActiveCondition() {
  return isNull(hrEmployments.archivedAt);
}

function employmentStatusExpression() {
  return sql<HrEmploymentStatus>`CASE WHEN ${hrEmployments.archivedAt} IS NULL THEN 'active' ELSE 'inactive' END`;
}

export async function listHrEmployees(db: Database, query: HrEmployeeListQuery) {
  const activeCondition = employmentActiveCondition();
  const employmentStatusCondition = query.employmentStatus === "active" ? activeCondition : query.employmentStatus === "inactive" ? sql`NOT (${activeCondition})` : undefined;
  const conditions = [
    query.status === "all" ? undefined : query.status === "employable" ? hrEmployableUser : eq(users.status, query.status),
    employmentStatusCondition,
    query.search ? or(
      like(hrEmployments.employeeNumber, `%${query.search}%`),
      like(hrEmployments.position, `%${query.search}%`),
      like(users.email, `%${query.search}%`),
      like(users.displayName, `%${query.search}%`),
      like(users.googleName, `%${query.search}%`),
    ) : undefined,
  ];
  const where = and(...conditions);
  const sortColumn = EMPLOYEE_SORT_COLUMNS[query.sortField];
  const orderColumn = query.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
  const selectFields = { ...employeeFields, employmentStatus: employmentStatusExpression() };
  const activeWhere = and(...conditions.filter((condition) => condition !== employmentStatusCondition), activeCondition);
  const inactiveWhere = and(...conditions.filter((condition) => condition !== employmentStatusCondition), sql`NOT (${activeCondition})`);
  const [employees, [totalRow], [activeRow], [inactiveRow]] = await Promise.all([
    db.select(selectFields).from(hrEmployments).innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
      .where(where).orderBy(orderColumn, asc(hrEmployments.employeeNumber), asc(hrEmployments.employeeUserId))
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(hrEmployments).innerJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(where),
    db.select({ value: count() }).from(hrEmployments).innerJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(activeWhere),
    db.select({ value: count() }).from(hrEmployments).innerJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(inactiveWhere),
  ]);
  const total = totalRow?.value ?? 0;
  return { employees, total, page: query.page, pageSize: query.pageSize, hasMore: query.page * query.pageSize < total, counts: { active: activeRow?.value ?? 0, inactive: inactiveRow?.value ?? 0 } };
}

export async function listHrSupervisorCandidates(db: Database, userId: string) {
  return db.select({ id: hrEmployments.employeeUserId, name: displayName }).from(hrEmployments).innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(and(isNull(hrEmployments.archivedAt), ne(hrEmployments.employeeUserId, userId), eq(users.status, "active")))
    .orderBy(asc(displayName));
}

export interface HrEmployeeDetailOptions {
  includeScopeAssignments?: boolean;
  includeCompensation?: boolean;
  includeInsurance?: boolean;
  includeLeave?: boolean;
  includeAttendanceEvents?: boolean;
  /** 舊 consumer 可傳入，但任職不再有可復原操作。 */
  includeEmploymentActions?: boolean;
}

async function currentEmployment(db: Database, userId: string) {
  const [row] = await db.select({ employment: hrEmployments, attendanceMode: hrEmploymentAttendanceSettings.attendanceMode, monthlyRestDays: hrEmploymentAttendanceSettings.monthlyRestDays })
    .from(hrEmployments).leftJoin(hrEmploymentAttendanceSettings, eq(hrEmploymentAttendanceSettings.employmentId, hrEmployments.id))
    .where(eq(hrEmployments.employeeUserId, userId))
    .orderBy(sql`${hrEmployments.archivedAt} IS NULL DESC`, desc(hrEmployments.updatedAt))
    .limit(1);
  return row;
}

export async function getHrEmployee(db: Database, userId: string, options: HrEmployeeDetailOptions = {}) {
  const row = await currentEmployment(db, userId);
  if (!row) throw new HrError(404, "此使用者尚未被指派為員工。");
  const employee = {
    ...employeeFields,
    userId: row.employment.employeeUserId,
    employeeNumber: row.employment.employeeNumber,
    position: row.employment.position,
    supervisorUserId: row.employment.supervisorUserId,
    archivedAt: row.employment.archivedAt,
    displayName: undefined as unknown as string,
    email: "",
    userStatus: "active" as string,
  };
  const [account] = await db.select({ displayName, email: users.email, userStatus: users.status }).from(users).where(eq(users.id, userId)).limit(1);
  const [supervisor] = row.employment.supervisorUserId
    ? await db.select({ displayName }).from(users).where(eq(users.id, row.employment.supervisorUserId)).limit(1)
    : [];
  const employment = { ...row.employment, attendanceMode: row.attendanceMode ?? "general", monthlyRestDays: row.monthlyRestDays };
  const employmentId = row.employment.id;
  const assignments = options.includeScopeAssignments === false ? undefined : await db.select({
    id: hrEmployeeScopes.id, employmentId: hrEmployeeScopes.employmentId, scopeId: hrEmployeeScopes.scopeId,
    scopeName: scopes.name, validFrom: hrEmployeeScopes.validFrom, validTo: hrEmployeeScopes.validTo, revision: hrEmployeeScopes.revision,
  }).from(hrEmployeeScopes).innerJoin(scopes, eq(scopes.id, hrEmployeeScopes.scopeId)).where(eq(hrEmployeeScopes.employmentId, employmentId)).orderBy(asc(hrEmployeeScopes.validFrom));
  const attendanceAssignments = await db.select({
    id: hrEmployeeAttendanceLocations.id, employmentId: hrEmployeeAttendanceLocations.employmentId,
    locationId: hrEmployeeAttendanceLocations.locationId, locationName: hrAttendanceLocations.name,
    validFrom: hrEmployeeAttendanceLocations.validFrom, validTo: hrEmployeeAttendanceLocations.validTo,
    revision: hrEmployeeAttendanceLocations.revision,
  }).from(hrEmployeeAttendanceLocations)
    .innerJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrEmployeeAttendanceLocations.locationId))
    .where(eq(hrEmployeeAttendanceLocations.employmentId, employmentId)).orderBy(asc(hrEmployeeAttendanceLocations.validFrom));
  const [attendanceSettings] = await db.select({ primaryAssignmentId: hrEmploymentAttendanceSettings.primaryAssignmentId })
    .from(hrEmploymentAttendanceSettings).where(eq(hrEmploymentAttendanceSettings.employmentId, employmentId)).limit(1);
  const primaryByEmployment = attendanceSettings?.primaryAssignmentId ?? null;
  const withPrimary = attendanceAssignments.map((assignment) => ({ ...assignment, isPrimary: primaryByEmployment === assignment.id }));
  const compensationRows = options.includeCompensation ? await db.select({
    id: hrCompensationVersions.id, employmentId: hrCompensationVersions.employmentId, versionNumber: hrCompensationVersions.versionNumber,
    validFrom: hrCompensationVersions.validFrom, validTo: hrCompensationVersions.validTo, payBasis: hrCompensationVersions.payBasis,
    baseAmountMinor: hrCompensationVersions.baseAmountMinor, note: hrCompensationVersions.note, voidedAt: hrCompensationVersions.voidedAt, voidedBy: hrCompensationVersions.voidedBy,
    createdAt: hrCompensationVersions.createdAt, createdBy: hrCompensationVersions.createdBy,
  }).from(hrCompensationVersions).where(eq(hrCompensationVersions.employmentId, employmentId)).orderBy(desc(hrCompensationVersions.validFrom)) : undefined;
  const compensationItems = compensationRows?.length ? await db.select().from(hrCompensationItems).where(inArray(hrCompensationItems.compensationVersionId, compensationRows.map((item) => item.id))) : [];
  const insuranceRows = options.includeInsurance ? await db.select({
    id: hrInsuranceVersions.id, employmentId: hrInsuranceVersions.employmentId, scheme: hrInsuranceVersions.scheme, versionNumber: hrInsuranceVersions.versionNumber,
    status: hrInsuranceVersions.status, validFrom: hrInsuranceVersions.validFrom, validTo: hrInsuranceVersions.validTo, insuredAmountMinor: hrInsuranceVersions.insuredAmountMinor,
    dependentCount: hrInsuranceVersions.dependentCount, rateYear: hrInsuranceVersions.rateYear, sourceKind: hrInsuranceVersions.sourceKind, sourceUrl: hrInsuranceVersions.sourceUrl,
    note: hrInsuranceVersions.note, createdAt: hrInsuranceVersions.createdAt, createdBy: hrInsuranceVersions.createdBy,
  }).from(hrInsuranceVersions).where(eq(hrInsuranceVersions.employmentId, employmentId)).orderBy(desc(hrInsuranceVersions.validFrom), asc(hrInsuranceVersions.scheme)) : undefined;
  const leaveRows = options.includeLeave ? await db.select({
    id: hrLeaveRequests.id, employmentId: hrLeaveRequests.employmentId, leaveType: hrLeaveRequests.leaveType, status: hrLeaveRequests.status,
    startsOn: hrLeaveRequests.startsOn, endsOn: hrLeaveRequests.endsOn, durationMinutes: hrLeaveRequests.durationMinutes, payRatePpm: hrLeaveRequests.payRatePpm,
    reason: hrLeaveRequests.reason, reviewedBy: hrLeaveRequests.reviewedBy, reviewedAt: hrLeaveRequests.reviewedAt,
    reviewComment: hrLeaveRequests.reviewComment, createdAt: hrLeaveRequests.createdAt, createdBy: hrLeaveRequests.createdBy,
  }).from(hrLeaveRequests).where(eq(hrLeaveRequests.employmentId, employmentId)).orderBy(desc(hrLeaveRequests.startsOn)) : undefined;
  const compensation = compensationRows?.map((item) => ({ ...item, items: compensationItems.filter((child) => child.compensationVersionId === item.id) }));
  const attendanceEvents = options.includeAttendanceEvents ? await db.select({
    id: hrClockEvents.id, eventKind: hrClockEvents.eventKind, occurredAt: hrClockEvents.occurredAt,
    locationName: sql<string | null>`coalesce(nullif(${hrClockEvents.locationNameSnapshot}, ''), ${hrAttendanceLocations.name})`, distanceMeters: hrClockEvents.distanceMeters,
  }).from(hrClockEvents)
    .leftJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrClockEvents.attendanceLocationId))
    .where(eq(hrClockEvents.employmentId, employmentId)).orderBy(desc(hrClockEvents.occurredAt)).limit(200) : undefined;
  const employeeRecord = {
    userId: employee.userId, employeeNumber: employee.employeeNumber, position: employee.position, supervisorUserId: employee.supervisorUserId,
    archivedAt: employee.archivedAt, revision: row.employment.revision, displayName: account?.displayName ?? userId, email: account?.email ?? "", userStatus: account?.userStatus ?? "disabled",
    employmentStatus: employee.archivedAt === null ? "active" as const : "inactive" as const,
    supervisorName: supervisor?.displayName ?? null,
  };
  return {
    employee: employeeRecord,
    employments: [employment],
    ...(assignments ? { assignments } : {}), attendanceAssignments: withPrimary,
    ...(compensation ? { compensation } : {}), ...(insuranceRows ? { insurance: insuranceRows } : {}), ...(leaveRows ? { leave: leaveRows } : {}),
    ...(attendanceEvents ? { attendanceEvents } : {}),
  };
}

export async function getHrSelf(db: Database, userId: string) {
  if (!await isHrEmployee(db, userId)) return null;
  return getHrEmployee(db, userId);
}

export async function isHrEmployee(db: Database, userId: string) {
  const [employee] = await db.select({ id: hrEmployments.id }).from(hrEmployments)
    .where(and(eq(hrEmployments.employeeUserId, userId), isNull(hrEmployments.archivedAt))).limit(1);
  return Boolean(employee);
}

export async function listHrScopes(db: Database) {
  return db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(and(eq(scopes.active, 1), eq(scopes.scopeKind, "store"), sql`${scopes.sourceType} <> 'shopee'`)).orderBy(asc(scopes.name));
}

export async function assignHrEmployee(db: Database, input: { userId: string; employeeNumber: string; position: string; attendanceMode: "general" | "scheduled"; revision?: number }, actor: HrActor) {
  const existing = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(eq(hrEmployments.employeeUserId, input.userId)).orderBy(desc(hrEmployments.updatedAt)).limit(1);
  if (existing.length && input.revision === undefined) throw new HrError(409, "重新啟用或修改既有員工需要 revision，請重新整理後再試。");
  const employmentId = existing[0]?.id ?? crypto.randomUUID();
  const revisionGuard = input.revision === undefined ? sql`` : sql` AND revision=${input.revision}`;
  const mutations: SQL[] = existing.length
    ? [sql`UPDATE hr_employments SET employee_number=${input.employeeNumber}, position=${input.position}, archived_at=NULL, revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${employmentId}${revisionGuard} RETURNING id`, sql`INSERT INTO hr_employment_attendance_settings (employment_id, attendance_mode) VALUES (${employmentId}, ${input.attendanceMode}) ON CONFLICT (employment_id) DO UPDATE SET attendance_mode=excluded.attendance_mode RETURNING employment_id AS id`]
    : [sql`INSERT INTO hr_employments (id, employee_user_id, employee_number, position) SELECT ${employmentId}, id, ${input.employeeNumber}, ${input.position} FROM users WHERE id=${input.userId} AND status IN ('active', 'invited') RETURNING id`, sql`INSERT INTO hr_employment_attendance_settings (employment_id, attendance_mode) VALUES (${employmentId}, ${input.attendanceMode}) RETURNING employment_id AS id`];
  await write(db, mutations, employmentId, actor, "employee_assigned", "無法指派員工，資料可能已變更或已存在。", { allowEmptyMutationIndexes: new Set([1]), activity: { payload: { employmentId, userId: input.userId }, summary: "員工已指派" } });
  return { id: input.userId, employmentId };
}

export function updateHrEmployee(db: Database, userId: string, input: { employeeNumber: string; position: string; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employments SET employee_number=${input.employeeNumber}, position=${input.position}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE employee_user_id=${userId} AND revision=${input.revision} AND archived_at IS NULL RETURNING id`, userId, actor, "employee_updated", "員工不存在、已封存或資料已變更，請重新整理後再試。");
}

export function updateHrEmployeeSupervisor(db: Database, userId: string, input: { supervisorUserId: string | null; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employments SET supervisor_user_id=${input.supervisorUserId}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE employee_user_id=${userId} AND revision=${input.revision} AND archived_at IS NULL
      AND (${input.supervisorUserId} IS NULL OR (${input.supervisorUserId} <> ${userId}
        AND EXISTS (SELECT 1 FROM hr_employments AS supervisor_employee INNER JOIN users AS supervisor_user ON supervisor_user.id=supervisor_employee.employee_user_id
          WHERE supervisor_employee.employee_user_id=${input.supervisorUserId} AND supervisor_employee.archived_at IS NULL AND supervisor_user.status='active')))
    RETURNING id`, userId, actor, "employee_supervisor_updated", "主管不存在、不可指定自己、員工已封存或資料已變更，請重新整理後再試。");
}

export function updateHrEmploymentPosition(db: Database, id: string, input: { position: string; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employments SET position=${input.position}, revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND revision=${input.revision} AND archived_at IS NULL RETURNING id`, id, actor, "employment_position_updated", "員工不存在、已封存或資料已變更，請重新整理後再試。", { activity: { payload: { employmentId: id, position: input.position }, summary: "職位已更新" } });
}

export function archiveHrEmployment(db: Database, id: string, revision: number, actor: HrActor) {
  // 封存只改變 archived_at；revision 是並行控制用的 metadata，必須同步前進以失效舊的重新啟用請求。
  return write(db, sql`UPDATE hr_employments SET archived_at=CURRENT_TIMESTAMP, revision=revision+1 WHERE id=${id} AND revision=${revision} AND archived_at IS NULL RETURNING id`, id, actor, "employment_archived", "員工不存在、已封存或資料已變更，請重新整理後再試。", { activity: { payload: { employmentId: id }, summary: "員工已封存" } });
}

export function updateHrEmploymentAttendanceMode(db: Database, id: string, input: { attendanceMode: "general" | "scheduled"; monthlyRestDays: number | null | undefined; revision: number }, actor: HrActor) {
  return write(db, [sql`UPDATE hr_employments SET revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND revision=${input.revision} AND archived_at IS NULL RETURNING id`, sql`UPDATE hr_employment_attendance_settings SET attendance_mode=${input.attendanceMode}, monthly_rest_days=${input.monthlyRestDays === undefined ? sql`monthly_rest_days` : input.monthlyRestDays}, updated_at=CURRENT_TIMESTAMP WHERE employment_id=${id} RETURNING employment_id AS id`], id, actor, "employment_attendance_mode_updated", "員工不存在、已封存、版本已過期或出勤設定不存在，請重新整理後再試。");
}

export function createHrAssignment(db: Database, input: { employmentId: string; scopeId: string; validFrom: string; validTo: string | null }, actor: HrActor) {
  const id = crypto.randomUUID();
  return write(db, sql`INSERT INTO hr_employee_scopes (id, employment_id, scope_id, valid_from, valid_to)
    SELECT ${id}, ${input.employmentId}, ${input.scopeId}, ${input.validFrom}, ${input.validTo}
    WHERE EXISTS (SELECT 1 FROM hr_employments WHERE id=${input.employmentId} AND archived_at IS NULL)
    AND EXISTS (SELECT 1 FROM scopes WHERE id=${input.scopeId} AND active=1 AND scope_kind='store' AND source_type <> 'shopee')
    AND NOT EXISTS (SELECT 1 FROM hr_employee_scopes WHERE employment_id=${input.employmentId} AND scope_id=${input.scopeId}
      AND (${input.validTo} IS NULL OR valid_from < ${input.validTo}) AND (valid_to IS NULL OR valid_to > ${input.validFrom})) RETURNING id`, id, actor, "assignment_created");
}

export function endHrAssignment(db: Database, id: string, input: { validTo: string; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employee_scopes SET valid_to=${input.validTo}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND revision=${input.revision} AND (valid_to IS NULL OR valid_to > ${input.validTo}) AND valid_from < ${input.validTo} RETURNING id`, id, actor, "assignment_ended");
}
