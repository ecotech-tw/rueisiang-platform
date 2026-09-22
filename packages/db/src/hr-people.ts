import { and, asc, count, desc, eq, inArray, like, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { formatTaipeiDate } from "./taipei-time.js";
import { hrEmployees, hrEmploymentActions, hrEmployments, hrEmployeeScopes } from "./schema/hr-people.js";
import { hrAttendanceLocations, hrClockEvents, hrEmployeeAttendanceLocations, hrEmploymentAttendanceSettings } from "./schema/hr-attendance.js";
import { hrCompensationItems, hrCompensationVersions, hrInsuranceVersions, hrLeaveRequests } from "./schema/hr-payroll.js";
import { scopes } from "./schema/reports.js";
import { roles, userRoleAssignments, users } from "./schema/auth.js";

export class HrError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) { super(message); }
}
export interface HrActor { id: string; email: string }

/** 共用稽核只放操作種類與 ID；可復原異動另外保存必要的操作識別碼。 */
interface HrMutationOptions {
  allowEmptyMutationIndexes?: ReadonlySet<number>;
  activity?: { payload?: unknown; summary?: string };
}

async function write(db: Database, statement: SQL | SQL[], id: string, actor: HrActor, action: string, conflictMessage = "此使用者已是員工、員工編號已使用，或關聯資料不存在。", options: HrMutationOptions = {}) {
  const row = activityRow({ entityType: "hr_personnel", entityId: id, source: "hr", eventType: action, summary: options.activity?.summary ?? "人事資料異動", payload: options.activity?.payload, actor });
  try {
    // 零列寫入不是 SQL 失敗。後續依賴寫入與稽核都必須跟著 changes() guard。
    const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
    const mutations = Array.isArray(statement) ? statement : [statement];
    const guardStatements = mutations.flatMap((mutation, index) => [
      mutation,
      // D1 會在 batch commit 後才回傳各 statement 的結果；用同一交易內的 CHECK
      // 將零列 mutation 轉成 rollback，避免後續步驟留下 partial write。
      sql`INSERT INTO hr_mutation_guards (id, ok) VALUES (${crypto.randomUUID()}, CASE WHEN changes() > 0 OR ${options.allowEmptyMutationIndexes?.has(index) ? 1 : 0} = 1 THEN 1 ELSE 0 END)`,
    ]);
    const statements = [...guardStatements, sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, payload_json, source, actor_type, actor_id, actor_email)
        VALUES (${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.payloadJson}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail})`,
      sql`DELETE FROM hr_mutation_guards`].map((query) => {
      const compiled = dialect.sqlToQuery(query);
      return db.$client.prepare(compiled.sql).bind(...compiled.params);
    });
    // Drizzle raw run 不具 D1 batch 所需的 prepared statement，使用原 binding 執行安全綁參數的 SQL。
    const results = await db.$client.batch(statements);
    // 每個 mutation 都帶 RETURNING；多步指派不能只檢查第一步，否則可能留下沒有任職的員工。
    if (mutations.some((_, index) => !options.allowEmptyMutationIndexes?.has(index) && !results[index * 2]?.results.length)) {
      throw new HrError(409, "資料已變更、期間重疊或使用者不可指派，請重新整理後確認。");
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

/** 系統 admin 角色代表全平台 HR 管理者，用於保護薪資等敏感明細。 */
export async function isHrAdministrator(db: Database, userId: string): Promise<boolean> {
  const [row] = await db.select({ userId: userRoleAssignments.userId }).from(userRoleAssignments)
    .innerJoin(roles, eq(roles.id, userRoleAssignments.roleId))
    .where(and(eq(userRoleAssignments.userId, userId), eq(roles.roleKey, "admin"), eq(roles.isSystem, true)))
    .limit(1);
  return Boolean(row);
}

const displayName = sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`;

/**
 * 人事上還算數的帳號：啟用中或邀請中。
 *
 * 帳號狀態只管能不能登入平台；在不在職看任職期間。邀請中的員工還沒登入過，
 * 但敘薪、投保與薪資都照常要處理，只排除已停用的帳號。管理頁名單、薪資試算與
 * 概覽都用這一個條件，不要在各處另寫 `status = 'active'`。
 */
export const hrEmployableUser = sql`${users.status} IN ('active', 'invited')`;

const employeeFields = { userId: hrEmployees.userId, employeeNumber: hrEmployees.employeeNumber, supervisorUserId: hrEmployees.supervisorUserId, displayName, email: users.email, userStatus: users.status, revision: hrEmployees.revision };

const EMPLOYEE_SORT_COLUMNS = {
  employeeNumber: hrEmployees.employeeNumber,
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
  /** employable＝啟用中或邀請中，見 hrEmployableUser。 */
  status: "all" | "employable" | "active" | "invited" | "disabled";
  employmentStatus?: HrEmploymentStatus;
  /** 由 API 以 Asia/Taipei 計算，避免瀏覽器日期與 Worker 跨日不一致。 */
  today: string;
  sortField: HrEmployeeSortField;
  sortDirection: "asc" | "desc";
}

export async function listHrCandidates(db: Database, input: { page: number; search: string; userId?: string }) {
  const rows = await db.select({ userId: users.id, displayName, email: users.email, status: users.status }).from(users)
    .where(and(
      hrEmployableUser,
      notExists(db.select({ id: hrEmployees.userId }).from(hrEmployees).where(eq(hrEmployees.userId, users.id))),
      input.userId ? eq(users.id, input.userId) : undefined,
      input.search ? or(like(users.email, `%${input.search}%`), like(users.displayName, `%${input.search}%`), like(users.googleName, `%${input.search}%`)) : undefined,
    )).orderBy(asc(users.email)).limit(51).offset((input.page - 1) * 50);
  return { users: rows.slice(0, 50), hasMore: rows.length > 50 };
}
function employmentActiveCondition(today: string) {
  return sql`EXISTS (
    SELECT 1 FROM hr_employments
    WHERE employee_user_id=${hrEmployees.userId}
      AND revoked_at IS NULL
      AND hired_on <= ${today}
      AND (ended_on IS NULL OR ended_on > ${today})
  )`;
}

function employmentStatusExpression(today: string) {
  return sql<HrEmploymentStatus>`CASE WHEN ${employmentActiveCondition(today)} THEN 'active' ELSE 'inactive' END`;
}

export async function listHrEmployees(db: Database, query: HrEmployeeListQuery) {
  const activeCondition = employmentActiveCondition(query.today);
  const employmentStatusCondition = query.employmentStatus === "active" ? activeCondition : query.employmentStatus === "inactive" ? sql`NOT (${activeCondition})` : undefined;
  const conditions = [
    query.status === "all" ? undefined : query.status === "employable" ? hrEmployableUser : eq(users.status, query.status),
    employmentStatusCondition,
    query.search ? or(
      like(hrEmployees.employeeNumber, `%${query.search}%`),
      like(users.email, `%${query.search}%`),
      like(users.displayName, `%${query.search}%`),
      like(users.googleName, `%${query.search}%`),
    ) : undefined,
  ];
  const where = and(...conditions);
  const sortColumn = EMPLOYEE_SORT_COLUMNS[query.sortField];
  const orderColumn = query.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
  const selectFields = { ...employeeFields, employmentStatus: employmentStatusExpression(query.today) };
  const activeWhere = and(...conditions.filter((condition) => condition !== employmentStatusCondition), activeCondition);
  const inactiveWhere = and(...conditions.filter((condition) => condition !== employmentStatusCondition), sql`NOT (${activeCondition})`);
  const [employees, [totalRow], [activeRow], [inactiveRow]] = await Promise.all([
    db.select(selectFields).from(hrEmployees).innerJoin(users, eq(users.id, hrEmployees.userId))
      .where(where).orderBy(orderColumn, asc(hrEmployees.employeeNumber), asc(hrEmployees.userId))
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(hrEmployees).innerJoin(users, eq(users.id, hrEmployees.userId)).where(where),
    db.select({ value: count() }).from(hrEmployees).innerJoin(users, eq(users.id, hrEmployees.userId)).where(activeWhere),
    db.select({ value: count() }).from(hrEmployees).innerJoin(users, eq(users.id, hrEmployees.userId)).where(inactiveWhere),
  ]);
  const total = totalRow?.value ?? 0;
  return {
    employees, total, page: query.page, pageSize: query.pageSize, hasMore: query.page * query.pageSize < total,
    counts: { active: activeRow?.value ?? 0, inactive: inactiveRow?.value ?? 0 },
  };
}
export async function listHrSupervisorCandidates(db: Database, userId: string) {
  return db.select({ id: hrEmployees.userId, name: displayName }).from(hrEmployees).innerJoin(users, eq(users.id, hrEmployees.userId))
    .where(and(ne(hrEmployees.userId, userId), eq(users.status, "active")))
    .orderBy(asc(displayName));
}
export interface HrEmployeeDetailOptions {
  /** 營運 scope 歸屬屬於員工資料；只有出勤權限的人（出勤範圍管理）不該拿到。預設回傳。 */
  includeScopeAssignments?: boolean;
  includeCompensation?: boolean;
  includeInsurance?: boolean;
  includeLeave?: boolean;
  includeAttendanceEvents?: boolean;
  includeEmploymentActions?: boolean;
  /** 覆寫日期只供測試或批次重播；未提供時使用 Worker 的 Taipei 當地日。 */
  today?: string;
}

export type HrEmploymentActionKind = "employee_assigned" | "employment_created" | "employment_ended";
export interface HrEmploymentAction {
  id: string;
  employeeUserId: string;
  employmentId: string;
  actionKind: HrEmploymentActionKind;
  beforeEndedOn: string | null;
  afterEndedOn: string | null;
  expectedRevision: number;
  createdAt: string;
  undoneAt: string | null;
}

const employmentActionFields = {
  id: hrEmploymentActions.id,
  employeeUserId: hrEmploymentActions.employeeUserId,
  employmentId: hrEmploymentActions.employmentId,
  actionKind: hrEmploymentActions.actionKind,
  beforeEndedOn: hrEmploymentActions.beforeEndedOn,
  afterEndedOn: hrEmploymentActions.afterEndedOn,
  expectedRevision: hrEmploymentActions.expectedRevision,
  createdAt: hrEmploymentActions.createdAt,
  undoneAt: hrEmploymentActions.undoneAt,
};

const employmentActionUndoFields = {
  ...employmentActionFields,
  endedScopeAssignments: hrEmploymentActions.endedScopeAssignments,
  endedAttendanceAssignments: hrEmploymentActions.endedAttendanceAssignments,
  beforePrimaryAssignmentId: hrEmploymentActions.beforePrimaryAssignmentId,
};

interface EmploymentAssignmentSnapshot { id: string; revision: number; validTo: string | null }
function assignmentSnapshots(value: string): EmploymentAssignmentSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is EmploymentAssignmentSnapshot => Boolean(item) && typeof item === "object"
      && typeof (item as { id?: unknown }).id === "string"
      && Number.isSafeInteger((item as { revision?: unknown }).revision)
      && ((item as { validTo?: unknown }).validTo === null || typeof (item as { validTo?: unknown }).validTo === "string"));
  } catch {
    return [];
  }
}

async function latestHrEmploymentAction(db: Database, userId: string): Promise<HrEmploymentAction | null> {
  const [row] = await db.select(employmentActionFields).from(hrEmploymentActions)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrEmploymentActions.employmentId))
    .where(and(eq(hrEmploymentActions.employeeUserId, userId), sql`${hrEmployments.revokedAt} IS NULL`)).orderBy(desc(sql`hr_employment_actions.rowid`)).limit(1);
  if (!row || row.undoneAt) return null;
  return { ...row, actionKind: row.actionKind as HrEmploymentActionKind };
}

export async function getHrEmployee(db: Database, userId: string, options: HrEmployeeDetailOptions = {}) {
  const [employee] = await db.select(employeeFields).from(hrEmployees).innerJoin(users, eq(users.id, hrEmployees.userId)).where(eq(hrEmployees.userId, userId));
  if (!employee) throw new HrError(404, "此使用者尚未被指派為員工。");
  const [supervisor] = employee.supervisorUserId
    ? await db.select({ displayName }).from(users).where(eq(users.id, employee.supervisorUserId)).limit(1)
    : [];
  const employmentRows = await db.select({ employment: hrEmployments, attendanceMode: hrEmploymentAttendanceSettings.attendanceMode, monthlyRestDays: hrEmploymentAttendanceSettings.monthlyRestDays })
    .from(hrEmployments).leftJoin(hrEmploymentAttendanceSettings, eq(hrEmploymentAttendanceSettings.employmentId, hrEmployments.id))
    .where(eq(hrEmployments.employeeUserId, userId)).orderBy(asc(hrEmployments.hiredOn));
  const employments = employmentRows.map(({ employment, attendanceMode: mode, monthlyRestDays }) => ({ ...employment, attendanceMode: mode ?? "general", monthlyRestDays }));
  const today = options.today ?? formatTaipeiDate(new Date());
  const employmentStatus: HrEmploymentStatus = employments.some((employment) => employment.revokedAt === null && employment.hiredOn <= today && (employment.endedOn === null || employment.endedOn > today)) ? "active" : "inactive";
  const lastEmploymentAction = options.includeEmploymentActions ? await latestHrEmploymentAction(db, userId) : undefined;
  const assignments = options.includeScopeAssignments === false ? undefined : await db.select({
    id: hrEmployeeScopes.id, employmentId: hrEmployeeScopes.employmentId, scopeId: hrEmployeeScopes.scopeId,
    scopeName: scopes.name, validFrom: hrEmployeeScopes.validFrom, validTo: hrEmployeeScopes.validTo, revision: hrEmployeeScopes.revision,
  }).from(hrEmployeeScopes).innerJoin(hrEmployments, eq(hrEmployments.id, hrEmployeeScopes.employmentId))
    .innerJoin(scopes, eq(scopes.id, hrEmployeeScopes.scopeId)).where(eq(hrEmployments.employeeUserId, userId)).orderBy(asc(hrEmployeeScopes.validFrom));
  const attendanceAssignments = await db.select({
    id: hrEmployeeAttendanceLocations.id, employmentId: hrEmployeeAttendanceLocations.employmentId,
    locationId: hrEmployeeAttendanceLocations.locationId, locationName: hrAttendanceLocations.name,
    validFrom: hrEmployeeAttendanceLocations.validFrom, validTo: hrEmployeeAttendanceLocations.validTo,
    revision: hrEmployeeAttendanceLocations.revision,
  }).from(hrEmployeeAttendanceLocations)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrEmployeeAttendanceLocations.employmentId))
    .innerJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrEmployeeAttendanceLocations.locationId))
    .where(eq(hrEmployments.employeeUserId, userId)).orderBy(asc(hrEmployeeAttendanceLocations.validFrom));
  const attendanceSettings = await db.select({ employmentId: hrEmploymentAttendanceSettings.employmentId, primaryAssignmentId: hrEmploymentAttendanceSettings.primaryAssignmentId })
    .from(hrEmploymentAttendanceSettings).where(sql`EXISTS (SELECT 1 FROM hr_employments WHERE id = hr_employment_attendance_settings.employment_id AND employee_user_id = ${userId})`);
  const primaryByEmployment = new Map(attendanceSettings.map((setting) => [setting.employmentId, setting.primaryAssignmentId]));
  const withPrimary = attendanceAssignments.map((assignment) => ({ ...assignment, isPrimary: primaryByEmployment.get(assignment.employmentId) === assignment.id }));
  // Join 時不要用 select() 取兩張表的完整欄位：SQLite/D1 的重複欄名會讓 compensation id 被 employment id 覆蓋。
  const compensationRows = options.includeCompensation ? await db.select({
    id: hrCompensationVersions.id, employmentId: hrCompensationVersions.employmentId, versionNumber: hrCompensationVersions.versionNumber,
    validFrom: hrCompensationVersions.validFrom, validTo: hrCompensationVersions.validTo, payBasis: hrCompensationVersions.payBasis,
    baseAmountMinor: hrCompensationVersions.baseAmountMinor, note: hrCompensationVersions.note, voidedAt: hrCompensationVersions.voidedAt, voidedBy: hrCompensationVersions.voidedBy,
    createdAt: hrCompensationVersions.createdAt, createdBy: hrCompensationVersions.createdBy,
  }).from(hrCompensationVersions).innerJoin(hrEmployments, eq(hrEmployments.id, hrCompensationVersions.employmentId))
    .where(eq(hrEmployments.employeeUserId, userId)).orderBy(desc(hrCompensationVersions.validFrom)) : undefined;
  const compensationItems = compensationRows?.length ? await db.select().from(hrCompensationItems).where(inArray(hrCompensationItems.compensationVersionId, compensationRows.map((row) => row.id))) : [];
  const insuranceRows = options.includeInsurance ? await db.select({
    id: hrInsuranceVersions.id, employmentId: hrInsuranceVersions.employmentId, scheme: hrInsuranceVersions.scheme, versionNumber: hrInsuranceVersions.versionNumber,
    status: hrInsuranceVersions.status, validFrom: hrInsuranceVersions.validFrom, validTo: hrInsuranceVersions.validTo, insuredAmountMinor: hrInsuranceVersions.insuredAmountMinor,
    dependentCount: hrInsuranceVersions.dependentCount, rateYear: hrInsuranceVersions.rateYear, sourceKind: hrInsuranceVersions.sourceKind, sourceUrl: hrInsuranceVersions.sourceUrl,
    note: hrInsuranceVersions.note, createdAt: hrInsuranceVersions.createdAt, createdBy: hrInsuranceVersions.createdBy,
  }).from(hrInsuranceVersions).innerJoin(hrEmployments, eq(hrEmployments.id, hrInsuranceVersions.employmentId))
    .where(eq(hrEmployments.employeeUserId, userId)).orderBy(desc(hrInsuranceVersions.validFrom), asc(hrInsuranceVersions.scheme)) : undefined;
  const leaveRows = options.includeLeave ? await db.select({
    id: hrLeaveRequests.id, employmentId: hrLeaveRequests.employmentId, leaveType: hrLeaveRequests.leaveType, status: hrLeaveRequests.status,
    startsOn: hrLeaveRequests.startsOn, endsOn: hrLeaveRequests.endsOn, durationMinutes: hrLeaveRequests.durationMinutes, payRatePpm: hrLeaveRequests.payRatePpm,
    reason: hrLeaveRequests.reason, reviewedBy: hrLeaveRequests.reviewedBy, reviewedAt: hrLeaveRequests.reviewedAt,
    reviewComment: hrLeaveRequests.reviewComment, createdAt: hrLeaveRequests.createdAt, createdBy: hrLeaveRequests.createdBy,
  }).from(hrLeaveRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
    .where(eq(hrEmployments.employeeUserId, userId)).orderBy(desc(hrLeaveRequests.startsOn)) : undefined;
  const compensation = compensationRows?.map((row) => ({ ...row, items: compensationItems.filter((item) => item.compensationVersionId === row.id) }));
  const insurance = insuranceRows;
  const leave = leaveRows;
  const attendanceEvents = options.includeAttendanceEvents ? await db.select({
    id: hrClockEvents.id, eventKind: hrClockEvents.eventKind, occurredAt: hrClockEvents.occurredAt,
    locationName: sql<string | null>`coalesce(nullif(${hrClockEvents.locationNameSnapshot}, ''), ${hrAttendanceLocations.name})`, distanceMeters: hrClockEvents.distanceMeters,
  }).from(hrClockEvents).leftJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrClockEvents.attendanceLocationId))
    .where(eq(hrClockEvents.employeeUserId, userId)).orderBy(desc(hrClockEvents.occurredAt)).limit(200) : undefined;
  return {
    employee: { ...employee, employmentStatus, supervisorName: supervisor?.displayName ?? null }, employments, ...(assignments ? { assignments } : {}), attendanceAssignments: withPrimary,
    ...(compensation ? { compensation } : {}), ...(insurance ? { insurance } : {}), ...(leave ? { leave } : {}), ...(attendanceEvents ? { attendanceEvents } : {}),
    ...(lastEmploymentAction !== undefined ? { lastEmploymentAction } : {}),
  };
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
  return db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(and(
    eq(scopes.active, 1), eq(scopes.scopeKind, "store"), sql`${scopes.sourceType} <> 'shopee'`,
  )).orderBy(asc(scopes.name));
}

export async function assignHrEmployee(db: Database, input: { userId: string; employeeNumber: string; hiredOn: string; seniorityStartOn: string; attendanceMode: "general" | "scheduled" }, actor: HrActor) {
  const employmentId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  // 指派員工與第一筆任職是同一操作；帳號、姓名與初次任職不分成三次建檔。
  await write(db, [
    sql`INSERT INTO hr_employees (user_id, employee_number)
      SELECT id, ${input.employeeNumber} FROM users WHERE id=${input.userId} AND status IN ('active', 'invited') RETURNING user_id AS id`,
    sql`INSERT INTO hr_employments (id, employee_user_id, hired_on, seniority_start_on)
      SELECT ${employmentId}, employee.user_id, ${input.hiredOn}, ${input.seniorityStartOn}
      FROM hr_employees AS employee INNER JOIN users AS account ON account.id=employee.user_id
      WHERE employee.user_id=${input.userId} AND employee.employee_number=${input.employeeNumber}
        AND account.status IN ('active', 'invited')
      RETURNING id`,
    sql`INSERT INTO hr_employment_attendance_settings (employment_id, attendance_mode)
      VALUES (${employmentId}, ${input.attendanceMode}) RETURNING employment_id AS id`,
    sql`INSERT INTO hr_employment_actions (id, employee_user_id, employment_id, action_kind, before_ended_on, after_ended_on, expected_revision)
      VALUES (${operationId}, ${input.userId}, ${employmentId}, 'employee_assigned', NULL, NULL, 1) RETURNING id`,
  ], input.userId, actor, "employee_assigned", "無法指派員工，資料可能已變更或已存在。", { activity: { payload: { operationId, employmentId }, summary: "員工已指派" } });
  return { id: input.userId, operationId };
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
export async function createHrEmployment(db: Database, input: { userId: string; hiredOn: string; endedOn: string | null; seniorityStartOn: string; attendanceMode: "general" | "scheduled" }, actor: HrActor) {
  const id = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  await write(db, [sql`INSERT INTO hr_employments (id, employee_user_id, hired_on, ended_on, seniority_start_on)
    SELECT ${id}, ${input.userId}, ${input.hiredOn}, ${input.endedOn}, ${input.seniorityStartOn}
    WHERE NOT EXISTS (SELECT 1 FROM hr_employments WHERE employee_user_id=${input.userId} AND revoked_at IS NULL
      AND (${input.endedOn} IS NULL OR hired_on < ${input.endedOn}) AND (ended_on IS NULL OR ended_on > ${input.hiredOn})) RETURNING id`,
    sql`INSERT INTO hr_employment_attendance_settings (employment_id, attendance_mode)
      VALUES (${id}, ${input.attendanceMode}) RETURNING employment_id AS id`,
    sql`INSERT INTO hr_employment_actions (id, employee_user_id, employment_id, action_kind, before_ended_on, after_ended_on, expected_revision)
      VALUES (${operationId}, ${input.userId}, ${id}, 'employment_created', NULL, ${input.endedOn}, 1) RETURNING id`,
  ], id, actor, "employment_created", "任職期間重疊、員工不存在或資料已變更，請重新整理後再試。", { activity: { payload: { operationId, employmentId: id }, summary: "任職已新增" } });
  return { id, operationId };
}
export function updateHrEmploymentAttendanceMode(db: Database, id: string, input: { attendanceMode: "general" | "scheduled"; /** undefined 表示保留原值。 */ monthlyRestDays: number | null | undefined; revision: number }, actor: HrActor) {
  return write(db, [sql`UPDATE hr_employments SET revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND revision=${input.revision} AND revoked_at IS NULL RETURNING id`,
    sql`UPDATE hr_employment_attendance_settings SET attendance_mode=${input.attendanceMode}, monthly_rest_days=${input.monthlyRestDays === undefined ? sql`monthly_rest_days` : input.monthlyRestDays}, updated_at=CURRENT_TIMESTAMP
      WHERE employment_id=${id} RETURNING employment_id AS id`], id, actor, "employment_attendance_mode_updated", "任職資料已變更，請重新整理後再試。");
}
export async function endHrEmployment(db: Database, id: string, input: { endedOn: string; revision: number }, actor: HrActor) {
  const [current] = await db.select({ employeeUserId: hrEmployments.employeeUserId, hiredOn: hrEmployments.hiredOn, endedOn: hrEmployments.endedOn, revokedAt: hrEmployments.revokedAt }).from(hrEmployments).where(eq(hrEmployments.id, id)).limit(1);
  if (!current || current.revokedAt !== null) throw new HrError(409, "這段任職已被撤銷，請重新整理後再試。");
  if (input.endedOn <= current.hiredOn) throw new HrError(400, "離職生效日必須晚於到職日。");

  // 離職是任職的生命週期操作；仍有效的據點／辦公位置會在同一交易自動收合到離職生效日，
  // 不刪除歷史列。若有人同時修改其中一筆指派，revision guard 會讓整筆離職一起回滾。
  const endingScopes = await db.select({ id: hrEmployeeScopes.id, revision: hrEmployeeScopes.revision, validTo: hrEmployeeScopes.validTo }).from(hrEmployeeScopes)
    .where(and(eq(hrEmployeeScopes.employmentId, id), sql`(valid_to IS NULL OR valid_to > ${input.endedOn}) AND valid_from < ${input.endedOn}`));
  const endingAttendanceLocations = await db.select({ id: hrEmployeeAttendanceLocations.id, revision: hrEmployeeAttendanceLocations.revision, validTo: hrEmployeeAttendanceLocations.validTo }).from(hrEmployeeAttendanceLocations)
    .where(and(eq(hrEmployeeAttendanceLocations.employmentId, id), sql`(valid_to IS NULL OR valid_to > ${input.endedOn}) AND valid_from < ${input.endedOn}`));
  const [attendanceSettings] = endingAttendanceLocations.length
    ? await db.select({ primaryAssignmentId: hrEmploymentAttendanceSettings.primaryAssignmentId }).from(hrEmploymentAttendanceSettings).where(eq(hrEmploymentAttendanceSettings.employmentId, id)).limit(1)
    : [];
  const operationId = crypto.randomUUID();
  const mutations: SQL[] = [
    ...endingScopes.map((assignment) => sql`UPDATE hr_employee_scopes SET valid_to=${input.endedOn}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=${assignment.id} AND employment_id=${id} AND revision=${assignment.revision} AND (valid_to IS NULL OR valid_to > ${input.endedOn}) AND valid_from < ${input.endedOn} RETURNING id`),
    ...endingAttendanceLocations.map((assignment) => sql`UPDATE hr_employee_attendance_locations SET valid_to=${input.endedOn}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=${assignment.id} AND employment_id=${id} AND revision=${assignment.revision} AND (valid_to IS NULL OR valid_to > ${input.endedOn}) AND valid_from < ${input.endedOn} RETURNING id`),
  ];
  if (attendanceSettings?.primaryAssignmentId && endingAttendanceLocations.some((assignment) => assignment.id === attendanceSettings.primaryAssignmentId)) {
    mutations.push(sql`UPDATE hr_employment_attendance_settings SET primary_assignment_id=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE employment_id=${id} RETURNING employment_id AS id`);
  }
  mutations.push(
    sql`UPDATE hr_employments SET ended_on=${input.endedOn}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=${id} AND revision=${input.revision} AND revoked_at IS NULL AND ended_on IS NULL AND hired_on < ${input.endedOn} RETURNING id`,
    sql`INSERT INTO hr_employment_actions (id, employee_user_id, employment_id, action_kind, before_ended_on, after_ended_on, expected_revision, ended_scope_assignments, ended_attendance_assignments, before_primary_assignment_id)
      VALUES (${operationId}, ${current.employeeUserId}, ${id}, 'employment_ended', ${current.endedOn}, ${input.endedOn}, ${input.revision + 1},
        ${JSON.stringify(endingScopes.map((assignment) => ({ id: assignment.id, revision: assignment.revision, validTo: assignment.validTo })))},
        ${JSON.stringify(endingAttendanceLocations.map((assignment) => ({ id: assignment.id, revision: assignment.revision, validTo: assignment.validTo })))},
        ${attendanceSettings?.primaryAssignmentId ?? null}) RETURNING id`,
  );
  await write(db, mutations, id, actor, "employment_ended", "任職不存在、版本已過期或指派資料已變更，請重新整理後再試。", { activity: { payload: {
    operationId, employmentId: id, endedOn: input.endedOn,
    endedScopeAssignmentIds: endingScopes.map((assignment) => assignment.id),
    endedAttendanceAssignmentIds: endingAttendanceLocations.map((assignment) => assignment.id),
  }, summary: "任職已結束" } });
  return { id, operationId };
}

function employmentDependencyCondition(id: string) {
  return sql`EXISTS (SELECT 1 FROM hr_employee_scopes WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_employee_attendance_locations WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_clock_events WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_compensation_versions WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_insurance_versions WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_monthly_leave_entries WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_monthly_hourly_entries WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_leave_requests WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_form_requests WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_overtime_requests WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_bonus_policy_members WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_schedule_entries WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_special_workday_assignments WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_payroll_adjustments WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_payroll_closed_employees WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_payroll_run_employees WHERE employment_id=${id})
    OR EXISTS (SELECT 1 FROM hr_payslips WHERE employment_id=${id})`;
}

async function firstEmploymentDependency(db: Database, id: string) {
  const query = sql`SELECT dependency FROM (
    SELECT '營運據點歸屬' AS dependency WHERE EXISTS (SELECT 1 FROM hr_employee_scopes WHERE employment_id=${id})
    UNION ALL SELECT '辦公位置指派' WHERE EXISTS (SELECT 1 FROM hr_employee_attendance_locations WHERE employment_id=${id})
    UNION ALL SELECT '打卡紀錄' WHERE EXISTS (SELECT 1 FROM hr_clock_events WHERE employment_id=${id})
    UNION ALL SELECT '薪資資料' WHERE EXISTS (SELECT 1 FROM hr_compensation_versions WHERE employment_id=${id})
    UNION ALL SELECT '勞健保資料' WHERE EXISTS (SELECT 1 FROM hr_insurance_versions WHERE employment_id=${id})
    UNION ALL SELECT '假勤資料' WHERE EXISTS (SELECT 1 FROM hr_monthly_leave_entries WHERE employment_id=${id})
    UNION ALL SELECT '工時資料' WHERE EXISTS (SELECT 1 FROM hr_monthly_hourly_entries WHERE employment_id=${id})
    UNION ALL SELECT '請假申請' WHERE EXISTS (SELECT 1 FROM hr_leave_requests WHERE employment_id=${id})
    UNION ALL SELECT '補打卡申請' WHERE EXISTS (SELECT 1 FROM hr_form_requests WHERE employment_id=${id})
    UNION ALL SELECT '加班申請' WHERE EXISTS (SELECT 1 FROM hr_overtime_requests WHERE employment_id=${id})
    UNION ALL SELECT '獎金指派' WHERE EXISTS (SELECT 1 FROM hr_bonus_policy_members WHERE employment_id=${id})
    UNION ALL SELECT '排班資料' WHERE EXISTS (SELECT 1 FROM hr_schedule_entries WHERE employment_id=${id})
    UNION ALL SELECT '特殊上班日資料' WHERE EXISTS (SELECT 1 FROM hr_special_workday_assignments WHERE employment_id=${id})
    UNION ALL SELECT '薪資結算資料' WHERE EXISTS (SELECT 1 FROM hr_payroll_adjustments WHERE employment_id=${id}
      OR employment_id IN (SELECT employment_id FROM hr_payroll_closed_employees WHERE employment_id=${id})
      OR employment_id IN (SELECT employment_id FROM hr_payroll_run_employees WHERE employment_id=${id})
      OR employment_id IN (SELECT employment_id FROM hr_payslips WHERE employment_id=${id}))
  ) LIMIT 1`;
  const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
  const compiled = dialect.sqlToQuery(query);
  return db.$client.prepare(compiled.sql).bind(...compiled.params).first<{ dependency: string }>();
}

/** 撤銷輸入錯誤的任職，但保留任職列與 employmentId；只允許沒有下游資料的任職。 */
export async function revokeHrEmployment(db: Database, id: string, input: { revision: number }, actor: HrActor) {
  const [current] = await db.select({ employeeUserId: hrEmployments.employeeUserId, revokedAt: hrEmployments.revokedAt, revision: hrEmployments.revision }).from(hrEmployments).where(eq(hrEmployments.id, id)).limit(1);
  if (!current || current.revokedAt !== null) throw new HrError(409, "這段任職已被撤銷或不存在，請重新整理後再試。");
  if (current.revision !== input.revision) throw new HrError(409, "這段任職資料已被其他人修改，請重新整理後再試。");
  const dependency = await firstEmploymentDependency(db, id);
  if (dependency) throw new HrError(409, `這段任職已有${dependency.dependency}歷史，為保留歷史不能撤銷；即使結束關聯也不能繞過撤銷限制。若需更正，請保留此任職並建立正確的後續任職。`);
  await write(db, sql`UPDATE hr_employments SET revoked_at=CURRENT_TIMESTAMP, revoked_by=${actor.id}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND revision=${input.revision} AND revoked_at IS NULL AND NOT (${employmentDependencyCondition(id)})
    RETURNING id`, id, actor, "employment_revoked", "任職已被其他人修改或新增關聯，請重新整理後再試。", { activity: { payload: { employmentId: id }, summary: "任職已撤銷" } });
  return { id };
}

function endedOnCondition(column: SQL, value: string | null) {
  return value === null ? sql`${column} IS NULL` : sql`${column}=${value}`;
}

export async function undoHrEmploymentAction(db: Database, operationId: string, actor: HrActor) {
  const [action] = await db.select({ ...employmentActionUndoFields, rowId: sql<number>`rowid` }).from(hrEmploymentActions)
    .where(eq(hrEmploymentActions.id, operationId)).limit(1);
  if (!action || action.undoneAt) throw new HrError(409, "這筆異動已復原或已無法復原，請重新整理後確認。");
  const [latest] = await db.select({ id: hrEmploymentActions.id }).from(hrEmploymentActions)
    .where(eq(hrEmploymentActions.employeeUserId, action.employeeUserId)).orderBy(desc(sql`rowid`)).limit(1);
  if (!latest || latest.id !== operationId) throw new HrError(409, "這不是該員工最近一次任職異動，請重新整理後確認。");

  const actionKind = action.actionKind as HrEmploymentActionKind;
  const activity = { payload: { operationId, employmentId: action.employmentId, undoneAction: actionKind }, summary: "任職異動已復原" };
  if (actionKind === "employment_ended") {
    const scopeSnapshots = assignmentSnapshots(action.endedScopeAssignments);
    const attendanceSnapshots = assignmentSnapshots(action.endedAttendanceAssignments);
    const restoreStatements: SQL[] = [
      ...scopeSnapshots.map((assignment) => sql`UPDATE hr_employee_scopes SET valid_to=${assignment.validTo}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
        WHERE id=${assignment.id} AND employment_id=${action.employmentId} AND revision=${assignment.revision + 1} RETURNING id`),
      ...attendanceSnapshots.map((assignment) => sql`UPDATE hr_employee_attendance_locations SET valid_to=${assignment.validTo}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
        WHERE id=${assignment.id} AND employment_id=${action.employmentId} AND revision=${assignment.revision + 1} RETURNING id`),
    ];
    if (action.beforePrimaryAssignmentId) restoreStatements.push(sql`UPDATE hr_employment_attendance_settings SET primary_assignment_id=${action.beforePrimaryAssignmentId}, updated_at=CURRENT_TIMESTAMP
      WHERE employment_id=${action.employmentId} AND primary_assignment_id IS NULL RETURNING employment_id AS id`);
    restoreStatements.push(
      sql`UPDATE hr_employments SET ended_on=${action.beforeEndedOn}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
        WHERE id=${action.employmentId} AND employee_user_id=${action.employeeUserId} AND revision=${action.expectedRevision} AND revoked_at IS NULL
          AND ${endedOnCondition(sql`ended_on`, action.afterEndedOn)} RETURNING id`,
      sql`UPDATE hr_employment_actions SET undone_at=CURRENT_TIMESTAMP, undone_by=${actor.id}
        WHERE id=${operationId} AND undone_at IS NULL RETURNING id`,
    );
    await write(db, restoreStatements, action.employmentId, actor, "employment_action_undone", "這筆任職資料在復原前已被其他人修改，請重新整理後確認。", { activity });
    return { id: action.employmentId, operationId };
  }

  const deleteStatements: SQL[] = [
    sql`DELETE FROM hr_employment_attendance_settings WHERE employment_id=${action.employmentId} RETURNING employment_id AS id`,
    sql`DELETE FROM hr_employments
      WHERE id=${action.employmentId} AND employee_user_id=${action.employeeUserId} AND revision=${action.expectedRevision} AND revoked_at IS NULL
        AND ${endedOnCondition(sql`ended_on`, action.afterEndedOn)} RETURNING id`,
  ];
  if (actionKind === "employee_assigned") {
    deleteStatements.push(sql`DELETE FROM hr_employees WHERE user_id=${action.employeeUserId} AND revision=1 RETURNING user_id AS id`);
  }
  deleteStatements.push(sql`UPDATE hr_employment_actions SET undone_at=CURRENT_TIMESTAMP, undone_by=${actor.id}
    WHERE id=${operationId} AND undone_at IS NULL RETURNING id`);
  await write(db, deleteStatements, action.employmentId, actor, "employment_action_undone", "此任職已有後續資料或版本已變更，無法直接復原。", { activity });
  return { id: action.employmentId, operationId };
}
export function createHrAssignment(db: Database, input: { employmentId: string; scopeId: string; validFrom: string; validTo: string | null }, actor: HrActor) {
  const id = crypto.randomUUID();
  return write(db, sql`INSERT INTO hr_employee_scopes (id, employment_id, scope_id, valid_from, valid_to)
    SELECT ${id}, ${input.employmentId}, ${input.scopeId}, ${input.validFrom}, ${input.validTo}
    WHERE EXISTS (SELECT 1 FROM hr_employments WHERE id=${input.employmentId} AND revoked_at IS NULL AND hired_on <= ${input.validFrom}
      AND (ended_on IS NULL OR (${input.validTo} IS NOT NULL AND ${input.validTo} <= ended_on)))
    AND EXISTS (SELECT 1 FROM scopes WHERE id=${input.scopeId} AND active=1 AND scope_kind='store' AND source_type <> 'shopee')
    AND NOT EXISTS (SELECT 1 FROM hr_employee_scopes WHERE employment_id=${input.employmentId} AND scope_id=${input.scopeId}
      AND (${input.validTo} IS NULL OR valid_from < ${input.validTo}) AND (valid_to IS NULL OR valid_to > ${input.validFrom})) RETURNING id`, id, actor, "assignment_created");
}
export function endHrAssignment(db: Database, id: string, input: { validTo: string; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employee_scopes SET valid_to=${input.validTo}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND revision=${input.revision} AND (valid_to IS NULL OR valid_to > ${input.validTo}) AND valid_from < ${input.validTo} RETURNING id`, id, actor, "assignment_ended");
}
