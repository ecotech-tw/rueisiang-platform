import { and, asc, count, desc, eq, isNull, like, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { inJsonArray } from "./sql-lists.js";
import { hrEmployeePersonalData, hrEmploymentServicePeriods, hrEmployments, hrEmployeeScopes } from "./schema/hr-people.js";
import { HR_PROFILE_FIELDS, emptyHrPersonalData, type HrPersonalData, type HrProfileField } from "./hr-profile-fields.js";
import { hrAttendanceLocations, hrClockEvents, hrEmployeeAttendanceLocations, hrEmploymentAttendanceSettings } from "./schema/hr-attendance.js";
import { hrAnnualLeaveEntitlements, hrCompensationItems, hrCompensationVersions, hrInsuranceVersions, hrLeaveRequests, hrWorkerCompensationVersions } from "./schema/hr-payroll.js";
import { scopes } from "./schema/reports.js";
import { authLineAccountLinks, roles, userRoleAssignments, users } from "./schema/auth.js";

export class HrError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}
export interface HrActor { id: string; email: string }

/** 共用 HR 稽核預設只放操作種類與 ID；物理刪除需要保留名稱快照時由呼叫端顯式提供。 */
interface HrMutationOptions {
  allowEmptyMutationIndexes?: ReadonlySet<number>;
  activity?: {
    entityLabel?: string;
    payload?: unknown;
    summary?: string;
    /** 同一次異動還動到的其他實體。每個各留一筆同樣的活動紀錄，用它們的 ID 查才查得到是誰在何時做的。 */
    alsoEntityIds?: readonly string[];
  };
}

async function write(db: Database, statement: SQL | SQL[], id: string, actor: HrActor, action: string, conflictMessage = "此使用者已是員工、員工編號已使用，或關聯資料不存在。", options: HrMutationOptions = {}) {
  const activityRows = [id, ...(options.activity?.alsoEntityIds ?? [])].map((entityId) => activityRow({ entityType: "hr_personnel", entityId, entityLabel: options.activity?.entityLabel, payload: options.activity?.payload, source: "hr", eventType: action, summary: options.activity?.summary ?? "人事資料異動", actor }));
  try {
    const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
    const mutations = Array.isArray(statement) ? statement : [statement];
    const guardStatements = mutations.flatMap((mutation, index) => [
      mutation,
      sql`INSERT INTO hr_mutation_guards (id, ok) VALUES (${crypto.randomUUID()}, CASE WHEN changes() > 0 OR ${options.allowEmptyMutationIndexes?.has(index) ? 1 : 0} = 1 THEN 1 ELSE 0 END)`,
    ]);
    const statements = [...guardStatements, ...activityRows.map((row) => sql`INSERT INTO activity_events (id, entity_type, entity_id, entity_label, event_type, summary, source, actor_type, actor_id, actor_email, payload_json)
        VALUES (${row.id}, ${row.entityType}, ${row.entityId}, ${row.entityLabel}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail}, ${row.payloadJson})`),
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
    if (messages.some((message) => /UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed|attendance_monthly_rest_days_invalid|daily_leave_capacity_exceeded|monthly_leave_validation_failed|monthly_hourly_validation_failed|payroll_period_closed|payroll_period_not_ready|payroll_run_closed|payroll_run_snapshot_invalid|payroll_adjustment_amount_invalid|bonus_performance_idempotency_required|special_workday_source_server_determined|overtime_rate_server_determined|payroll_run_withdrawal_invalid|payroll_run_withdrawal_immutable/.test(message))) {
      throw new HrError(409, conflictMessage);
    }
    throw error;
  }
}

export { write as writeHrMutation };

/**
 * 審核的寫入被擋下之後，依重讀到的現況講出原因。請假與加班共用，兩邊才不會各自長出不同的分類。
 *
 * 寫入被擋的原因不只一種；併成一句的話審核者分不出是該重看內容、還是這筆已經被處理掉，
 * 只會對著同一個錯一直重按。分不出來的才回原本的錯誤。
 */
export function reviewWriteConflict(original: HrError, latest: { status: string; revision: number } | undefined, read: { revision: number }, messages: { gone: string; changed: string }) {
  if (!latest || latest.status !== "pending") return new HrError(409, messages.gone);
  if (latest.revision !== read.revision) return new HrError(409, messages.changed);
  return original;
}

export async function isHrAdministrator(db: Database, userId: string): Promise<boolean> {
  const [row] = await db.select({ userId: userRoleAssignments.userId }).from(userRoleAssignments)
    .innerJoin(roles, eq(roles.id, userRoleAssignments.roleId))
    .where(and(eq(userRoleAssignments.userId, userId), eq(roles.roleKey, "admin"), eq(roles.isSystem, true)))
    .limit(1);
  return Boolean(row);
}

const displayName = sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`;
/** HRIS 名稱與登入帳號名稱分開；正式姓名由 HR 維護，Google 名稱只作資料回填與候選提示。 */
export const hrEmployeeName = sql<string>`coalesce(nullif(trim(${hrEmployments.legalName}), ''), ${displayName}, '未命名人員')`;
const supervisorName = sql<string | null>`(
  SELECT coalesce(
    nullif((SELECT trim(supervisor_employment.legal_name)
      FROM hr_employments AS supervisor_employment
      WHERE supervisor_employment.employee_user_id = supervisor.id AND supervisor_employment.archived_at IS NULL
      LIMIT 1), ''),
    nullif(supervisor.display_name, ''), nullif(supervisor.google_name, ''), supervisor.email
  )
  FROM users AS supervisor
  WHERE supervisor.id = ${hrEmployments.supervisorUserId}
)`;

/** 啟用中或邀請中的帳號可以成為員工；在職狀態則由 hr_employments.archived_at 判定。 */
export const hrEmployableUser = sql`${users.status} IN ('active', 'invited')`;

const employmentStatus = sql<"active" | "inactive">`CASE WHEN ${hrEmployments.archivedAt} IS NULL THEN 'active' ELSE 'inactive' END`;

const employeeFields = {
  personKind: hrEmployments.personKind,
  userId: sql<string>`${hrEmployments.employeeUserId}`.as("employee_user_id"),
  employmentId: hrEmployments.id,
  employeeNumber: hrEmployments.employeeNumber,
  legalName: hrEmployments.legalName,
  displayName: hrEmployeeName,
  accountName: displayName,
  position: hrEmployments.position,
  supervisorUserId: hrEmployments.supervisorUserId,
  supervisorName,
  archivedAt: hrEmployments.archivedAt,
  employmentStatus,
  email: users.email,
  userStatus: users.status,
  revision: hrEmployments.revision,
};

const lineLinkedAt = sql<string | null>`(SELECT ${authLineAccountLinks.linkedAt} FROM ${authLineAccountLinks} WHERE ${authLineAccountLinks.userId} = ${hrEmployments.employeeUserId})`;

const EMPLOYEE_SORT_COLUMNS = {
  employeeNumber: hrEmployments.employeeNumber,
  name: hrEmployeeName,
  email: users.email,
  status: users.status,
} as const;

/** Employee numbers are usually a prefix plus a numeric suffix (E2, E10). Keep paginated SQL results in the same natural order as the UI. */
export function hrEmployeeNumberOrder(direction: "asc" | "desc" = "asc") {
  const prefix = sql<string>`CASE WHEN ${hrEmployments.employeeNumber} GLOB '*[0-9]' THEN rtrim(${hrEmployments.employeeNumber}, '0123456789') ELSE ${hrEmployments.employeeNumber} END`;
  const suffix = sql<number>`CASE WHEN ${hrEmployments.employeeNumber} GLOB '*[0-9]' THEN CAST(substr(${hrEmployments.employeeNumber}, length(rtrim(${hrEmployments.employeeNumber}, '0123456789')) + 1) AS INTEGER) ELSE -1 END`;
  return direction === "asc"
    ? [asc(prefix), asc(suffix), asc(hrEmployments.employeeNumber)]
    : [desc(prefix), desc(suffix), desc(hrEmployments.employeeNumber)];
}
export type HrEmployeeSortField = keyof typeof EMPLOYEE_SORT_COLUMNS;
export const HR_EMPLOYEE_PAGE_SIZES = [10, 25, 50, 100] as const;
export type HrEmploymentStatus = "active" | "inactive";

export interface HrEmployeeListQuery {
  page: number;
  pageSize: number;
  /** 共用清單也用於申請審核；綁定資訊只能由人事讀取入口明確啟用。 */
  includeLineBinding?: boolean;
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
      notExists(db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(eq(hrEmployments.personKind, "employee"), eq(hrEmployments.employeeUserId, users.id), isNull(hrEmployments.archivedAt)))),
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

/** 列表以每位 User 的在職列為準；沒有在職列時才退回最近一筆未在職歷史。 */
function canonicalEmploymentCondition() {
  return sql`${hrEmployments.personKind} = 'employee' AND ${hrEmployments.id} = (
    SELECT candidate.id
    FROM hr_employments AS candidate
    WHERE candidate.person_kind = 'employee' AND candidate.employee_user_id = ${hrEmployments.employeeUserId}
    ORDER BY candidate.archived_at IS NULL DESC, candidate.archived_at DESC, candidate.updated_at DESC, candidate.id DESC
    LIMIT 1
  )`;
}

export async function listHrEmployees(db: Database, query: HrEmployeeListQuery) {
  const activeCondition = employmentActiveCondition();
  const employmentStatusCondition = query.employmentStatus === "active" ? activeCondition : query.employmentStatus === "inactive" ? sql`NOT (${activeCondition})` : undefined;
  const conditions = [
    eq(hrEmployments.personKind, "employee"),
    canonicalEmploymentCondition(),
    query.status === "all" ? undefined : query.status === "employable" ? hrEmployableUser : eq(users.status, query.status),
    employmentStatusCondition,
    query.search ? or(
      like(hrEmployments.employeeNumber, `%${query.search}%`),
      like(hrEmployments.legalName, `%${query.search}%`),
      like(hrEmployments.position, `%${query.search}%`),
      like(users.email, `%${query.search}%`),
      like(users.displayName, `%${query.search}%`),
      like(users.googleName, `%${query.search}%`),
    ) : undefined,
  ];
  const where = and(...conditions);
  const sortColumn = EMPLOYEE_SORT_COLUMNS[query.sortField];
  const orderColumns = query.sortField === "employeeNumber"
    ? hrEmployeeNumberOrder(query.sortDirection)
    : [query.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn), asc(hrEmployments.employeeNumber)];
  const selectFields = { ...employeeFields, ...(query.includeLineBinding ? { lineLinkedAt } : {}), employmentStatus: employmentStatusExpression() };
  const baseConditions = conditions.filter((condition) => condition !== employmentStatusCondition);
  const activeWhere = and(...baseConditions, activeCondition);
  const inactiveWhere = and(...baseConditions, sql`NOT (${activeCondition})`);
  const [employees, [totalRow], [activeRow], [inactiveRow]] = await Promise.all([
    db.select(selectFields).from(hrEmployments).innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
      .where(where).orderBy(...orderColumns, asc(hrEmployments.employeeUserId))
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(hrEmployments).innerJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(where),
    db.select({ value: count() }).from(hrEmployments).innerJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(activeWhere),
    db.select({ value: count() }).from(hrEmployments).innerJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(inactiveWhere),
  ]);
  const total = totalRow?.value ?? 0;
  return { employees, total, page: query.page, pageSize: query.pageSize, hasMore: query.page * query.pageSize < total, counts: { active: activeRow?.value ?? 0, inactive: inactiveRow?.value ?? 0 } };
}

export type HrPersonKind = "employee" | "worker";
export interface HrPersonnelListQuery extends HrEmployeeListQuery {
  personKind: "all" | HrPersonKind;
}

const personnelFields = {
  personKind: hrEmployments.personKind,
  userId: hrEmployments.employeeUserId,
  employmentId: hrEmployments.id,
  employeeNumber: hrEmployments.employeeNumber,
  legalName: hrEmployments.legalName,
  displayName: hrEmployeeName,
  accountName: sql<string>`coalesce(${users.displayName}, '')`,
  position: hrEmployments.position,
  supervisorUserId: hrEmployments.supervisorUserId,
  supervisorName,
  archivedAt: hrEmployments.archivedAt,
  employmentStatus,
  email: sql<string>`coalesce(${users.email}, '')`,
  userStatus: sql<"invited" | "active" | "disabled">`coalesce(${users.status}, 'disabled')`,
  revision: hrEmployments.revision,
};

/** 正式員工與排班支援人員共用 roster；支援人員沒有 User，所以必須 left join。 */
export async function listHrPersonnel(db: Database, query: HrPersonnelListQuery) {
  const activeCondition = employmentActiveCondition();
  const employmentStatusCondition = query.employmentStatus === "active" ? activeCondition : query.employmentStatus === "inactive" ? sql`NOT (${activeCondition})` : undefined;
  const personKindCondition = query.personKind === "all" ? undefined : eq(hrEmployments.personKind, query.personKind);
  // 正式員工可能有多筆封存任職，但 roster 只呈現每個人的 canonical 一列；支援人員本身只有一列。
  const canonicalPersonCondition = query.personKind === "worker" ? undefined : query.personKind === "employee" ? canonicalEmploymentCondition() : or(eq(hrEmployments.personKind, "worker"), canonicalEmploymentCondition());
  const accountStatusCondition = query.status === "all"
    ? undefined
    : query.status === "employable"
      ? and(eq(hrEmployments.personKind, "employee"), hrEmployableUser)
      : and(eq(hrEmployments.personKind, "employee"), eq(users.status, query.status));
  const conditions = [
    personKindCondition,
    canonicalPersonCondition,
    accountStatusCondition,
    employmentStatusCondition,
    query.search ? or(
      like(hrEmployments.employeeNumber, `%${query.search}%`),
      like(hrEmployments.legalName, `%${query.search}%`),
      like(hrEmployments.position, `%${query.search}%`),
      like(users.email, `%${query.search}%`),
      like(users.displayName, `%${query.search}%`),
      like(users.googleName, `%${query.search}%`),
    ) : undefined,
  ];
  const where = and(...conditions);
  const sortColumn = query.sortField === "email" ? sql<string>`coalesce(${users.email}, '')` : query.sortField === "status" ? sql<string>`coalesce(${users.status}, CASE WHEN ${hrEmployments.archivedAt} IS NULL THEN 'active' ELSE 'inactive' END)` : EMPLOYEE_SORT_COLUMNS[query.sortField];
  const orderColumns = query.sortField === "employeeNumber"
    ? hrEmployeeNumberOrder(query.sortDirection)
    : [query.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn), asc(hrEmployments.employeeNumber)];
  const baseConditions = conditions.filter((condition) => condition !== employmentStatusCondition);
  const activeWhere = and(...baseConditions, activeCondition);
  const inactiveWhere = and(...baseConditions, sql`NOT (${activeCondition})`);
  const [employees, [totalRow], [activeRow], [inactiveRow]] = await Promise.all([
    db.select({ ...personnelFields, ...(query.includeLineBinding ? { lineLinkedAt } : {}) }).from(hrEmployments).leftJoin(users, eq(users.id, hrEmployments.employeeUserId))
      .where(where).orderBy(...orderColumns, asc(hrEmployments.id))
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(hrEmployments).leftJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(where),
    db.select({ value: count() }).from(hrEmployments).leftJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(activeWhere),
    db.select({ value: count() }).from(hrEmployments).leftJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(inactiveWhere),
  ]);
  const total = totalRow?.value ?? 0;
  return { employees, total, page: query.page, pageSize: query.pageSize, hasMore: query.page * query.pageSize < total, counts: { active: activeRow?.value ?? 0, inactive: inactiveRow?.value ?? 0 } };
}

export async function listHrSupervisorCandidates(db: Database, userId: string) {
  return db.select({ id: hrEmployments.employeeUserId, name: hrEmployeeName, employeeNumber: hrEmployments.employeeNumber }).from(hrEmployments).innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(and(eq(hrEmployments.personKind, "employee"), isNull(hrEmployments.archivedAt), ne(hrEmployments.employeeUserId, userId), eq(users.status, "active")))
    .orderBy(...hrEmployeeNumberOrder(), asc(hrEmployeeName));
}

export interface HrEmployeeDetailOptions {
  includePersonalData?: boolean;
  includeScopeAssignments?: boolean;
  includeCompensation?: boolean;
  includeInsurance?: boolean;
  includeLeave?: boolean;
  includeAttendanceEvents?: boolean;
  /** 舊 consumer 可傳入，但任職不再有可復原操作。 */
  includeEmploymentActions?: boolean;
}

async function employmentRows(db: Database, userId: string) {
  return db.select({ employment: hrEmployments, attendanceMode: hrEmploymentAttendanceSettings.attendanceMode, monthlyRestDays: hrEmploymentAttendanceSettings.monthlyRestDays, serviceStartOn: hrEmploymentServicePeriods.serviceStartOn })
    .from(hrEmployments).leftJoin(hrEmploymentAttendanceSettings, eq(hrEmploymentAttendanceSettings.employmentId, hrEmployments.id)).leftJoin(hrEmploymentServicePeriods, eq(hrEmploymentServicePeriods.employmentId, hrEmployments.id))
    .where(and(eq(hrEmployments.personKind, "employee"), eq(hrEmployments.employeeUserId, userId)))
    .orderBy(sql`${hrEmployments.archivedAt} IS NULL DESC`, desc(hrEmployments.archivedAt), desc(hrEmployments.updatedAt), desc(hrEmployments.id));
}

export async function getHrEmployee(db: Database, userId: string, options: HrEmployeeDetailOptions = {}) {
  const rows = await employmentRows(db, userId);
  const row = rows[0];
  if (!row) throw new HrError(404, "此使用者尚未被指派為員工。");
  const current = row.employment;
  const employmentIds = rows.map(({ employment }) => employment.id);
  const supervisorIds = [...new Set(rows.map(({ employment }) => employment.supervisorUserId).filter((id): id is string => Boolean(id)))];
  const supervisorRows = supervisorIds.length ? await db.select({
    id: users.id,
    name: sql<string>`coalesce(nullif((SELECT trim(supervisor_employment.legal_name) FROM hr_employments AS supervisor_employment WHERE supervisor_employment.employee_user_id = ${users.id} AND supervisor_employment.archived_at IS NULL LIMIT 1), ''), nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`,
  }).from(users).where(inJsonArray(users.id, supervisorIds)) : [];
  const supervisorNames = new Map(supervisorRows.map((supervisor) => [supervisor.id, supervisor.name]));
  const [account] = await db.select({ accountName: displayName, email: users.email, userStatus: users.status }).from(users).where(eq(users.id, userId)).limit(1);
  const employments = rows.map(({ employment, attendanceMode, monthlyRestDays, serviceStartOn }) => ({
    ...employment,
    supervisorName: employment.supervisorUserId ? supervisorNames.get(employment.supervisorUserId) ?? null : null,
    attendanceMode: attendanceMode ?? "general" as const,
    monthlyRestDays,
    serviceStartOn,
  }));
  const assignments = options.includeScopeAssignments === false ? undefined : await db.select({
    id: hrEmployeeScopes.id, employmentId: hrEmployeeScopes.employmentId, scopeId: hrEmployeeScopes.scopeId,
    scopeName: scopes.name, validFrom: hrEmployeeScopes.validFrom, validTo: hrEmployeeScopes.validTo, revision: hrEmployeeScopes.revision,
  }).from(hrEmployeeScopes).innerJoin(scopes, eq(scopes.id, hrEmployeeScopes.scopeId)).where(inJsonArray(hrEmployeeScopes.employmentId, employmentIds)).orderBy(asc(hrEmployeeScopes.validFrom), asc(hrEmployeeScopes.employmentId));
  const attendanceAssignments = await db.select({
    id: hrEmployeeAttendanceLocations.id, employmentId: hrEmployeeAttendanceLocations.employmentId,
    locationId: hrEmployeeAttendanceLocations.locationId, locationName: hrAttendanceLocations.name,
    validFrom: hrEmployeeAttendanceLocations.validFrom, validTo: hrEmployeeAttendanceLocations.validTo,
    revision: hrEmployeeAttendanceLocations.revision,
  }).from(hrEmployeeAttendanceLocations)
    .innerJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrEmployeeAttendanceLocations.locationId))
    .where(inJsonArray(hrEmployeeAttendanceLocations.employmentId, employmentIds)).orderBy(asc(hrEmployeeAttendanceLocations.validFrom), asc(hrEmployeeAttendanceLocations.employmentId));
  const attendanceSettings = await db.select({ employmentId: hrEmploymentAttendanceSettings.employmentId, primaryAssignmentId: hrEmploymentAttendanceSettings.primaryAssignmentId })
    .from(hrEmploymentAttendanceSettings).where(inJsonArray(hrEmploymentAttendanceSettings.employmentId, employmentIds));
  const primaryAssignmentIds = new Set(attendanceSettings.map(({ primaryAssignmentId }) => primaryAssignmentId).filter((id): id is string => Boolean(id)));
  const withPrimary = attendanceAssignments.map((assignment) => ({ ...assignment, isPrimary: primaryAssignmentIds.has(assignment.id) }));
  const compensationRows = options.includeCompensation ? await db.select({
    id: hrCompensationVersions.id, employmentId: hrCompensationVersions.employmentId, versionNumber: hrCompensationVersions.versionNumber,
    validFrom: hrCompensationVersions.validFrom, validTo: hrCompensationVersions.validTo, payBasis: hrCompensationVersions.payBasis,
    baseAmountMinor: hrCompensationVersions.baseAmountMinor, overtimeHourlyMinor: hrCompensationVersions.overtimeHourlyMinor, note: hrCompensationVersions.note, voidedAt: hrCompensationVersions.voidedAt, voidedBy: hrCompensationVersions.voidedBy,
    createdAt: hrCompensationVersions.createdAt, createdBy: hrCompensationVersions.createdBy,
  }).from(hrCompensationVersions).where(inJsonArray(hrCompensationVersions.employmentId, employmentIds)).orderBy(desc(hrCompensationVersions.validFrom)) : undefined;
  const compensationItems = compensationRows?.length ? await db.select().from(hrCompensationItems).where(inJsonArray(hrCompensationItems.compensationVersionId, compensationRows.map((item) => item.id))) : [];
  const insuranceRows = options.includeInsurance ? await db.select({
    id: hrInsuranceVersions.id, employmentId: hrInsuranceVersions.employmentId, scheme: hrInsuranceVersions.scheme, versionNumber: hrInsuranceVersions.versionNumber,
    status: hrInsuranceVersions.status, validFrom: hrInsuranceVersions.validFrom, validTo: hrInsuranceVersions.validTo, insuredAmountMinor: hrInsuranceVersions.insuredAmountMinor,
    dependentCount: hrInsuranceVersions.dependentCount, rateYear: hrInsuranceVersions.rateYear, sourceKind: hrInsuranceVersions.sourceKind, sourceUrl: hrInsuranceVersions.sourceUrl,
    note: hrInsuranceVersions.note, voidedAt: hrInsuranceVersions.voidedAt, voidedBy: hrInsuranceVersions.voidedBy,
    createdAt: hrInsuranceVersions.createdAt, createdBy: hrInsuranceVersions.createdBy,
  }).from(hrInsuranceVersions).where(inJsonArray(hrInsuranceVersions.employmentId, employmentIds)).orderBy(desc(hrInsuranceVersions.validFrom), asc(hrInsuranceVersions.scheme)) : undefined;
  const leaveRows = options.includeLeave ? await db.select({
    id: hrLeaveRequests.id, employmentId: hrLeaveRequests.employmentId, leaveType: hrLeaveRequests.leaveType, status: hrLeaveRequests.status,
    startsAt: hrLeaveRequests.startsAt, endsAt: hrLeaveRequests.endsAt,
    startsOn: hrLeaveRequests.startsOn, endsOn: hrLeaveRequests.endsOn, durationMinutes: hrLeaveRequests.durationMinutes, payRatePpm: hrLeaveRequests.payRatePpm,
    reason: hrLeaveRequests.reason, reviewedBy: hrLeaveRequests.reviewedBy, reviewedAt: hrLeaveRequests.reviewedAt,
    reviewComment: hrLeaveRequests.reviewComment, createdAt: hrLeaveRequests.createdAt, createdBy: hrLeaveRequests.createdBy,
  }).from(hrLeaveRequests).where(inJsonArray(hrLeaveRequests.employmentId, employmentIds)).orderBy(desc(hrLeaveRequests.startsOn)) : undefined;
  const compensation = compensationRows?.map((item) => ({ ...item, items: compensationItems.filter((child) => child.compensationVersionId === item.id) }));
  const attendanceEvents = options.includeAttendanceEvents ? await db.select({
    id: hrClockEvents.id, eventKind: hrClockEvents.eventKind, occurredAt: hrClockEvents.occurredAt,
    locationName: sql<string | null>`coalesce(nullif(${hrClockEvents.locationNameSnapshot}, ''), ${hrAttendanceLocations.name})`, distanceMeters: hrClockEvents.distanceMeters,
  }).from(hrClockEvents)
    .leftJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrClockEvents.attendanceLocationId))
    .where(inJsonArray(hrClockEvents.employmentId, employmentIds)).orderBy(desc(hrClockEvents.occurredAt)).limit(200) : undefined;
  const accountName = account?.accountName || userId;
  const employeeName = current.legalName.trim() || accountName;
  const employeeRecord = {
    personKind: "employee" as const,
    employmentId: current.id, userId: current.employeeUserId, employeeNumber: current.employeeNumber, legalName: employeeName, displayName: employeeName, accountName, position: current.position, supervisorUserId: current.supervisorUserId,
    archivedAt: current.archivedAt, revision: current.revision, email: account?.email ?? "", userStatus: account?.userStatus ?? "disabled",
    employmentStatus: current.archivedAt === null ? "active" as const : "inactive" as const,
    supervisorName: current.supervisorUserId ? supervisorNames.get(current.supervisorUserId) ?? null : null,
  };
  const [personalData] = options.includePersonalData ? await db.select().from(hrEmployeePersonalData).where(eq(hrEmployeePersonalData.employmentId, current.id)).limit(1) : [];
  return {
    ...(options.includePersonalData ? { personalData: personalData ?? emptyHrPersonalData() } : {}),
    employee: employeeRecord,
    employments,
    ...(assignments ? { assignments } : {}), attendanceAssignments: withPrimary,
    ...(compensation ? { compensation } : {}), ...(insuranceRows ? { insurance: insuranceRows } : {}), ...(leaveRows ? { leave: leaveRows } : {}),
    ...(attendanceEvents ? { attendanceEvents } : {}),
  };
}

/** 以 employmentId 或既有 userId 讀取 roster 內頁；支援人員沒有帳號與正式人事區塊。 */
export async function getHrPerson(db: Database, id: string, options: HrEmployeeDetailOptions = {}) {
  const [row] = await db.select({ employment: hrEmployments, email: users.email, userStatus: users.status, accountName: displayName })
    .from(hrEmployments).leftJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(or(eq(hrEmployments.id, id), eq(hrEmployments.employeeUserId, id))).limit(1);
  if (!row) throw new HrError(404, "找不到人員資料。");
  if (row.employment.personKind === "employee") return getHrEmployee(db, row.employment.employeeUserId!, options);
  const workerCompensation = options.includeCompensation ? await db.select().from(hrWorkerCompensationVersions)
    .where(eq(hrWorkerCompensationVersions.workerId, row.employment.id)).orderBy(desc(hrWorkerCompensationVersions.validFrom), desc(hrWorkerCompensationVersions.versionNumber)) : undefined;
  const employment = {
    ...row.employment,
    supervisorName: null,
    attendanceMode: "scheduled" as const,
    monthlyRestDays: null,
    serviceStartOn: null,
  };
  const employee = {
    personKind: "worker" as const,
    employmentId: row.employment.id,
    userId: null,
    employeeNumber: row.employment.employeeNumber,
    legalName: row.employment.legalName,
    displayName: row.employment.legalName,
    accountName: "",
    position: row.employment.position,
    supervisorUserId: null,
    supervisorName: null,
    archivedAt: row.employment.archivedAt,
    revision: row.employment.revision,
    email: "",
    userStatus: "disabled" as const,
    employmentStatus: row.employment.archivedAt === null ? "active" as const : "inactive" as const,
  };
  const compensation = workerCompensation?.map((version) => ({
    id: version.id,
    employmentId: version.workerId,
    versionNumber: version.versionNumber,
    validFrom: version.validFrom,
    validTo: version.validTo,
    payBasis: version.payBasis,
    baseAmountMinor: version.baseAmountMinor,
    overtimeRatePpm: version.overtimeRatePpm,
    overtimeHourlyMinor: version.overtimeHourlyMinor,
    note: version.note,
    voidedAt: null,
    voidedBy: null,
    createdAt: version.createdAt,
    createdBy: version.createdBy,
    items: [],
  }));
  return { employee, employments: [employment], assignments: [], attendanceAssignments: [], ...(compensation ? { compensation } : {}) };
}

export async function getHrSelf(db: Database, userId: string) {
  if (!await isHrEmployee(db, userId)) return null;
  return getHrEmployee(db, userId);
}

export async function isHrEmployee(db: Database, userId: string) {
  const [employee] = await db.select({ id: hrEmployments.id }).from(hrEmployments)
    .where(and(eq(hrEmployments.personKind, "employee"), eq(hrEmployments.employeeUserId, userId), isNull(hrEmployments.archivedAt))).limit(1);
  return Boolean(employee);
}

export async function listHrScopes(db: Database) {
  return db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(and(eq(scopes.active, 1), eq(scopes.scopeKind, "store"), sql`${scopes.sourceType} <> 'shopee'`)).orderBy(asc(scopes.name));
}

function normalizeEmployeeLegalName(value: string) {
  const name = value.trim();
  if (!name || name.length > 100) throw new HrError(400, "正式姓名必須是 1～100 字。 ");
  return name;
}

export async function assignHrEmployee(db: Database, input: { userId: string; legalName: string; employeeNumber: string; position: string; attendanceMode?: "general" | "scheduled"; serviceStartOn?: string; revision?: number }, actor: HrActor) {
  const legalName = normalizeEmployeeLegalName(input.legalName);
  const [existing] = await db.select({ id: hrEmployments.id, archivedAt: hrEmployments.archivedAt, attendanceMode: hrEmploymentAttendanceSettings.attendanceMode }).from(hrEmployments)
    .leftJoin(hrEmploymentAttendanceSettings, eq(hrEmploymentAttendanceSettings.employmentId, hrEmployments.id))
    .where(and(eq(hrEmployments.personKind, "employee"), eq(hrEmployments.employeeUserId, input.userId)))
    .orderBy(sql`${hrEmployments.archivedAt} IS NULL DESC`, desc(hrEmployments.archivedAt), desc(hrEmployments.updatedAt), desc(hrEmployments.id))
    .limit(1);
  if (existing?.archivedAt === null) throw new HrError(409, "員工目前已在職，請改用編輯員工資料或出勤設定。 ");
  if (existing && input.revision === undefined) throw new HrError(409, "恢復在職或修改既有員工需要 revision，請重新整理後再試。");
  const employmentId = existing?.id ?? crypto.randomUUID();
  const nextAttendanceMode = input.attendanceMode ?? existing?.attendanceMode ?? "general";
  const revisionGuard = input.revision === undefined ? sql`` : sql` AND revision=${input.revision}`;
  const attendanceSettings = sql`INSERT INTO hr_employment_attendance_settings (employment_id, attendance_mode)
    VALUES (${employmentId}, ${nextAttendanceMode})
    ON CONFLICT (employment_id) DO UPDATE SET
      attendance_mode=excluded.attendance_mode,
      monthly_rest_days=CASE WHEN excluded.attendance_mode='general' THEN NULL ELSE hr_employment_attendance_settings.monthly_rest_days END,
      updated_at=CURRENT_TIMESTAMP
    RETURNING employment_id AS id`;
  const servicePeriod = sql`INSERT INTO hr_employment_service_periods (employment_id, service_start_on)
    SELECT ${employmentId}, COALESCE(${input.serviceStartOn ?? null}, substr(CURRENT_TIMESTAMP, 1, 10))
    WHERE NOT EXISTS (SELECT 1 FROM hr_employment_service_periods WHERE employment_id=${employmentId})
    RETURNING employment_id AS id`;
  const mutations: SQL[] = existing
    ? [sql`UPDATE hr_employments SET employee_number=${input.employeeNumber}, legal_name=${legalName}, position=${input.position}, archived_at=NULL, revision=revision+1, updated_at=CURRENT_TIMESTAMP
        WHERE id=${employmentId} AND archived_at IS NOT NULL${revisionGuard} RETURNING id`, attendanceSettings, servicePeriod]
    : [sql`INSERT INTO hr_employments (id, employee_user_id, employee_number, legal_name, position)
        SELECT ${employmentId}, id, ${input.employeeNumber}, ${legalName}, ${input.position} FROM users
        WHERE id=${input.userId} AND status IN ('active', 'invited') RETURNING id`, attendanceSettings, servicePeriod];
  const mutationOptions: HrMutationOptions = { activity: { payload: { employmentId, userId: input.userId, legalName }, summary: "員工已指派" }, allowEmptyMutationIndexes: new Set([2]) };
  await write(db, mutations, employmentId, actor, "employee_assigned", "無法指派員工，資料可能已變更或已存在。", mutationOptions);
  return { id: input.userId, employmentId };
}

function supervisorCondition(userId: string, supervisorUserId: string | null) {
  return sql`(${supervisorUserId} IS NULL OR (${supervisorUserId} <> ${userId}
    AND EXISTS (SELECT 1 FROM hr_employments AS supervisor_employee INNER JOIN users AS supervisor_user ON supervisor_user.id=supervisor_employee.employee_user_id
      WHERE supervisor_employee.employee_user_id=${supervisorUserId} AND supervisor_employee.archived_at IS NULL AND supervisor_user.status='active'))) `;
}

function normalizePersonalData(input: unknown): Partial<HrPersonalData> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HrError(400, "員工個資格式不正確。");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !HR_PROFILE_FIELDS.some((field) => field.key === key))) throw new HrError(400, "員工個資包含未知欄位。");
  const result: Partial<HrPersonalData> = {};
  for (const definition of HR_PROFILE_FIELDS) {
    const field: HrProfileField = definition;
    const raw = record[definition.key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") throw new HrError(400, `${field.label}必須是文字。`);
    const value = raw.trim();
    if (value.length > (field.maxLength ?? 100)) throw new HrError(400, `${field.label}過長。`);
    if (value && field.options && !field.options.includes(value)) throw new HrError(400, `${field.label}選項不正確。`);
    if (value && field.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) throw new HrError(400, `${field.label}日期不正確。`);
    if (value && field.type === "month" && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new HrError(400, `${field.label}年月不正確。`);
    if (value && field.type === "number" && (!/^\d+(\.\d{1,2})?$/.test(value) || Number(value) <= 0 || Number(value) > 500)) throw new HrError(400, `${field.label}請填 0～500 之間的正數，最多兩位小數。`);
    if (value && field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new HrError(400, `${field.label}格式不正確。`);
    result[definition.key] = value;
  }
  return result;
}

export async function updateHrEmployee(db: Database, userId: string, input: { legalName: string; employeeNumber: string; position: string; supervisorUserId?: string | null; serviceStartOn?: string; personalData?: unknown; revision: number }, actor: HrActor) {
  const legalName = normalizeEmployeeLegalName(input.legalName);
  const personalData = input.personalData === undefined ? undefined : normalizePersonalData(input.personalData);
  const [current] = await db.select({ id: hrEmployments.id, serviceStartOn: hrEmploymentServicePeriods.serviceStartOn }).from(hrEmployments)
    .leftJoin(hrEmploymentServicePeriods, eq(hrEmploymentServicePeriods.employmentId, hrEmployments.id))
    .where(and(eq(hrEmployments.personKind, "employee"), eq(hrEmployments.employeeUserId, userId), isNull(hrEmployments.archivedAt))).limit(1);
  const serviceStartChanged = Boolean(current && input.serviceStartOn !== undefined && current.serviceStartOn !== input.serviceStartOn);
  if (serviceStartChanged) {
    const [existingEntitlement] = await db.select({ id: hrAnnualLeaveEntitlements.id }).from(hrAnnualLeaveEntitlements)
      .where(eq(hrAnnualLeaveEntitlements.employmentId, current?.id ?? "")).limit(1);
    if (existingEntitlement) throw new HrError(409, "員工已有特休週期，不能直接修改服務年資起算日；請先依特休／薪資調整流程處理。");
  }
  const supervisorSet = input.supervisorUserId === undefined ? sql`` : sql`, supervisor_user_id=${input.supervisorUserId}`;
  const supervisorGuard = input.supervisorUserId === undefined ? sql`` : sql` AND ${supervisorCondition(userId, input.supervisorUserId)}`;
  const servicePeriodGuard = serviceStartChanged ? sql` AND NOT EXISTS (SELECT 1 FROM hr_annual_leave_entitlements WHERE employment_id=${current?.id})` : sql``;
  const mutations: SQL[] = [sql`UPDATE hr_employments SET employee_number=${input.employeeNumber}, legal_name=${legalName}, position=${input.position}${supervisorSet}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE person_kind='employee' AND employee_user_id=${userId} AND revision=${input.revision} AND archived_at IS NULL${supervisorGuard}${servicePeriodGuard} RETURNING id`];
  if (serviceStartChanged) mutations.push(sql`INSERT INTO hr_employment_service_periods (employment_id, service_start_on)
    VALUES (${current?.id}, ${input.serviceStartOn})
    ON CONFLICT (employment_id) DO UPDATE SET service_start_on=excluded.service_start_on, updated_at=CURRENT_TIMESTAMP
    RETURNING employment_id AS id`);
  if (personalData && Object.keys(personalData).length) mutations.push(db.insert(hrEmployeePersonalData).values({ employmentId: current?.id ?? "", ...personalData })
    .onConflictDoUpdate({ target: hrEmployeePersonalData.employmentId, set: { ...personalData, updatedAt: sql`CURRENT_TIMESTAMP` } }).returning({ id: hrEmployeePersonalData.employmentId }).getSQL());
  // 稽核只記異動欄位名稱，不複製身分證、地址與聯絡電話。
  const payload = { legalName, ...(personalData ? { personalFields: Object.keys(personalData) } : {}), ...(input.supervisorUserId === undefined ? {} : { supervisorUserId: input.supervisorUserId }), ...(serviceStartChanged ? { beforeServiceStartOn: current?.serviceStartOn ?? null, serviceStartOn: input.serviceStartOn } : {}) };
  return write(db, mutations, userId, actor, "employee_updated", "員工不存在、已是未在職或資料已變更，請重新整理後再試。", { activity: { payload, summary: "員工資料已更新" } });
}

export function updateHrEmployeeSupervisor(db: Database, userId: string, input: { supervisorUserId: string | null; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employments SET supervisor_user_id=${input.supervisorUserId}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE person_kind='employee' AND employee_user_id=${userId} AND revision=${input.revision} AND archived_at IS NULL
      AND ${supervisorCondition(userId, input.supervisorUserId)}
    RETURNING id`, userId, actor, "employee_supervisor_updated", "主管不存在、不可指定自己、員工已是未在職或資料已變更，請重新整理後再試。");
}

export function updateHrEmploymentPosition(db: Database, id: string, input: { position: string; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employments SET position=${input.position}, revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND person_kind='employee' AND revision=${input.revision} AND archived_at IS NULL RETURNING id`, id, actor, "employment_position_updated", "員工不存在、已是未在職或資料已變更，請重新整理後再試。", { activity: { payload: { employmentId: id, position: input.position }, summary: "職位已更新" } });
}

export async function updateHrEmploymentServicePeriod(db: Database, id: string, input: { serviceStartOn: string; revision: number }, actor: HrActor) {
  const [currentServicePeriod] = await db.select({ serviceStartOn: hrEmploymentServicePeriods.serviceStartOn }).from(hrEmploymentServicePeriods)
    .where(eq(hrEmploymentServicePeriods.employmentId, id)).limit(1);
  const [existingEntitlement] = await db.select({ id: hrAnnualLeaveEntitlements.id }).from(hrAnnualLeaveEntitlements)
    .where(eq(hrAnnualLeaveEntitlements.employmentId, id)).limit(1);
  if (existingEntitlement) throw new HrError(409, "員工已有特休週期，不能直接修改服務年資起算日；請先依特休／薪資調整流程處理。");
  return write(db, [
    sql`UPDATE hr_employments SET revision=revision+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=${id} AND person_kind='employee' AND revision=${input.revision} AND archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM hr_annual_leave_entitlements WHERE employment_id=${id}) RETURNING id`,
    sql`INSERT INTO hr_employment_service_periods (employment_id, service_start_on)
      VALUES (${id}, ${input.serviceStartOn})
      ON CONFLICT (employment_id) DO UPDATE SET service_start_on=excluded.service_start_on, updated_at=CURRENT_TIMESTAMP
      RETURNING employment_id AS id`,
  ], id, actor, "employment_service_period_updated", "員工不存在、已是未在職、版本已過期或服務年資資料已變更，請重新整理後再試。", {
    activity: { payload: { employmentId: id, beforeServiceStartOn: currentServicePeriod?.serviceStartOn ?? null, serviceStartOn: input.serviceStartOn }, summary: "服務年資起算日已更新" },
  });
}

export function archiveHrEmployment(db: Database, id: string, revision: number, actor: HrActor) {
  // 設為未在職不改寫業務資料，但 updated_at 要跟著前進，讓多筆未在職歷史能按最近一次狀態穩定選取。
  return write(db, sql`UPDATE hr_employments SET archived_at=CURRENT_TIMESTAMP, revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND person_kind='employee' AND revision=${revision} AND archived_at IS NULL RETURNING id`, id, actor, "employment_archived", "員工不存在、已是未在職或資料已變更，請重新整理後再試。", { activity: { payload: { employmentId: id }, summary: "員工已設為未在職" } });
}

export function updateHrEmploymentAttendanceMode(db: Database, id: string, input: { attendanceMode: "general" | "scheduled"; monthlyRestDays: number | null | undefined; revision: number }, actor: HrActor) {
  const monthlyRestDays = input.attendanceMode === "general" ? sql`NULL` : input.monthlyRestDays === undefined ? sql`monthly_rest_days` : sql`${input.monthlyRestDays}`;
  return write(db, [sql`UPDATE hr_employments SET revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND person_kind='employee' AND revision=${input.revision} AND archived_at IS NULL RETURNING id`, sql`UPDATE hr_employment_attendance_settings SET attendance_mode=${input.attendanceMode}, monthly_rest_days=${monthlyRestDays}, updated_at=CURRENT_TIMESTAMP WHERE employment_id=${id} RETURNING employment_id AS id`], id, actor, "employment_attendance_mode_updated", "員工不存在、已是未在職、版本已過期或出勤設定不存在，請重新整理後再試。");
}

export function createHrAssignment(db: Database, input: { employmentId: string; scopeId: string; validFrom: string; validTo: string | null }, actor: HrActor) {
  const id = crypto.randomUUID();
  return write(db, sql`INSERT INTO hr_employee_scopes (id, employment_id, scope_id, valid_from, valid_to)
    SELECT ${id}, ${input.employmentId}, ${input.scopeId}, ${input.validFrom}, ${input.validTo}
    WHERE EXISTS (SELECT 1 FROM hr_employments WHERE id=${input.employmentId} AND person_kind='employee' AND archived_at IS NULL)
    AND EXISTS (SELECT 1 FROM scopes WHERE id=${input.scopeId} AND active=1 AND scope_kind='store' AND source_type <> 'shopee')
    AND NOT EXISTS (SELECT 1 FROM hr_employee_scopes WHERE employment_id=${input.employmentId} AND scope_id=${input.scopeId}
      AND (${input.validTo} IS NULL OR valid_from < ${input.validTo}) AND (valid_to IS NULL OR valid_to > ${input.validFrom})) RETURNING id`, id, actor, "assignment_created");
}

export function endHrAssignment(db: Database, id: string, input: { validTo: string; revision: number }, actor: HrActor) {
  return write(db, sql`UPDATE hr_employee_scopes SET valid_to=${input.validTo}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND revision=${input.revision} AND (valid_to IS NULL OR valid_to > ${input.validTo}) AND valid_from < ${input.validTo} RETURNING id`, id, actor, "assignment_ended");
}
