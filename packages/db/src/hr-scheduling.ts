import { and, asc, count, desc, eq, inArray, isNotNull, isNull, like, sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { inJsonArray } from "./sql-lists.js";
import { HR_DAY_TYPE_LABELS, isHrDayType, listHrCalendarMonth, resolveDayTypes } from "./hr-calendar.js";
import { HrError, hrEmployeeName, hrEmployeeNumberOrder, type HrActor } from "./hr-people.js";
import { hrEmploymentAttendanceSettings } from "./schema/hr-attendance.js";
import { hrEmployments } from "./schema/hr-people.js";
import { hrWorkerCompensationVersions } from "./schema/hr-payroll.js";
import {
  hrScheduleEntries,
  hrScheduleScopeLocks,
  hrScheduleVersions,
  hrScheduleWorkerEntries,
  hrScheduleWorkers,
  hrScopeShiftAssignments,
  hrShiftTemplates,
  hrShiftVersions,
  type HrDayType,
} from "./schema/hr-scheduling.js";
import { scopes } from "./schema/reports.js";
import { users } from "./schema/auth.js";

const DAY_SECONDS = 86_400;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

export const HR_SCHEDULE_ATTENDANCE_STATUSES = ["scheduled", "present", "absent"] as const;
export type HrScheduleAttendanceStatus = (typeof HR_SCHEDULE_ATTENDANCE_STATUSES)[number];

export interface ScheduleEntryInput {
  personKind: "employee" | "worker";
  employmentId?: string;
  workerId?: string;
  scopeId: string;
  shiftVersionId: string;
  workDate: string;
  /** scheduled=尚未確認；present=有效出勤；absent=未出勤，不取得班別薪資單位。 */
  attendanceStatus?: HrScheduleAttendanceStatus;
}

type EnrichedScheduleEntry = ScheduleEntryInput & {
  startsAt: string;
  endsAt: string;
  enforceMembership?: boolean;
  standardMinutes: number;
  breakMinutes: number;
  shiftTemplateId: string;
  requiredHeadcount: number;
  attendanceStatus: HrScheduleAttendanceStatus;
};

export interface SaveHrScheduleInput {
  periodKey: string;
  scheduleVersionId?: string;
  revision?: number;
  entries: ScheduleEntryInput[];
}

/*
 * 月份字串轉成半開區間。排班、行事曆與各自的路由共用，三邊的「一個月」才是同一個定義。
 *
 * 名字帶 month 是因為 hr-payroll-calculation.ts 另有一個私有的 periodFromKey，形狀不同
 * （多回 year 與 month）。兩份都私有時相安無事，但這一份要 export 出去給路由用，
 * 同名同輸入卻回不同東西的公開 API 遲早會被拿錯一個。
 */
/**
 * 讀已發布班表時要認哪一版：同一期間重新發布會留下舊的已發布版，一律只認版本號最大的那一個。
 * 查詢要自己 join hr_schedule_versions。
 */
export function latestPublishedScheduleVersion() {
  return and(
    eq(hrScheduleVersions.status, "published"),
    sql`${hrScheduleVersions.versionNumber} = (SELECT max(latest_schedule_version.version_number) FROM hr_schedule_versions AS latest_schedule_version WHERE latest_schedule_version.period_start = ${hrScheduleVersions.periodStart} AND latest_schedule_version.period_end = ${hrScheduleVersions.periodEnd} AND latest_schedule_version.status = 'published')`,
  );
}

export function monthPeriodFromKey(periodKey: string) {
  if (!PERIOD_KEY.test(periodKey)) throw new HrError(400, "排班月份格式不正確。 ");
  const [yearText, monthText] = periodKey.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return { start: `${periodKey}-01`, end: next };
}

function addDays(date: string, amount: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function dateToDayNumber(date: string) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function wallTime(date: string, seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${date} ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function datePeriodContains(date: string, period: { start: string; end: string }) {
  return LOCAL_DATE.test(date) && date >= period.start && date < period.end;
}

/** 每個「班別 × 據點 × 日型」各自取最新版本；日型要進 key，否則三組時間只會活下來一組。 */
function latestShiftVersions<T extends { templateId: string; scopeId: string; dayType: HrDayType; versionNumber: number }>(rows: T[]) {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.templateId}:${row.scopeId}:${row.dayType}`;
    const current = latest.get(key);
    if (!current || row.versionNumber > current.versionNumber) latest.set(key, row);
  }
  return rows.filter((row) => latest.get(`${row.templateId}:${row.scopeId}:${row.dayType}`) === row);
}

function assertShiftMinutes(input: { standardMinutes: number; breakMinutes: number }, durationSeconds: number) {
  if (!Number.isInteger(input.standardMinutes) || input.standardMinutes < 0 || input.standardMinutes > 1440 || !Number.isInteger(input.breakMinutes) || input.breakMinutes < 0 || input.breakMinutes > 1440 || (input.standardMinutes + input.breakMinutes) * 60 > durationSeconds) throw new HrError(400, "班別的計薪工時與休息時間不正確。 ");
}

async function latestScheduleVersion(db: Database, period: { start: string; end: string }) {
  const [version] = await db.select().from(hrScheduleVersions).where(and(
    eq(hrScheduleVersions.periodStart, period.start),
    eq(hrScheduleVersions.periodEnd, period.end),
    eq(hrScheduleVersions.status, "published"),
  )).orderBy(desc(hrScheduleVersions.versionNumber)).limit(1);
  return version;
}

async function runRawBatch(db: Database, statements: Array<{ sql: string; params: unknown[] }>, expectedUpdate: boolean, conflictMessage = "排班已被其他人修改或目前已鎖定，請重新整理。 ") {
  const prepared = statements.map((compiled) => db.$client.prepare(compiled.sql).bind(...compiled.params));
  const results = await db.$client.batch(prepared);
  if (expectedUpdate && !results[0]?.results?.length) throw new HrError(409, conflictMessage);
  return results;
}

function compileStatements(statements: SQL[]) {
  const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
  return statements.map((statement) => dialect.sqlToQuery(statement));
}

async function saveEntriesAtomically(db: Database, version: { id: string; revision: number; lockedAt: string | null }, entries: EnrichedScheduleEntry[], actor: HrActor, removed?: { employee: string[]; worker: string[]; scheduledOnlyIds?: string[] }, authorizedScopeId?: string, retainedGroups: Array<{ scopeId: string; shiftTemplateId: string; workDate: string; shiftGroupId: string | null }> = [], newPeriod?: { start: string; end: string }, scopeLockGuard?: { periodStart: string; scopeIds: string[] }) {
  const nextRevision = version.revision + 1;
  const row = activityRow({ entityType: "hr_schedule", entityId: version.id, source: "hr", eventType: "schedule_saved", summary: "排班已發布", actor });
  // revision+1 可能是別人的更新；以本次獨有的稽核列守衛，CAS 失敗時後續 SQL 才會全部略過。
  const guard = sql`EXISTS (SELECT 1 FROM activity_events WHERE id=${row.id})`;
  // 同班需求人力會決定分攤單位池，所以所有指派必須共用同一群組。
  // group id 不直接暴露給輸入端，由發布動作一次建立，避免前端偽造跨月或跨班別的群組。
  const groupIds = new Map(retainedGroups.filter((entry) => entry.shiftGroupId).map((entry) => [`${entry.scopeId}:${entry.shiftTemplateId}:${entry.workDate}`, entry.shiftGroupId!]));
  const groupIdFor = (entry: EnrichedScheduleEntry) => {
    const key = `${entry.scopeId}:${entry.shiftTemplateId}:${entry.workDate}`;
    const existing = groupIds.get(key);
    if (existing) return existing;
    const id = crypto.randomUUID();
    groupIds.set(key, id);
    return id;
  };
  const personIds = JSON.stringify(entries.map((entry) => entry.personKind === "employee" ? entry.employmentId : entry.workerId));
  const scopeIds = JSON.stringify([...new Set(entries.map((entry) => entry.scopeId))]);
  const membershipEntries = JSON.stringify(entries.filter((entry) => entry.enforceMembership).map((entry) => ({ templateId: entry.shiftTemplateId, personId: entry.personKind === "employee" ? entry.employmentId : entry.workerId })));
  const eligible = sql`NOT EXISTS (SELECT 1 FROM hr_employments WHERE id IN (SELECT value FROM json_each(${personIds})) AND archived_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM scopes WHERE id IN (SELECT value FROM json_each(${scopeIds})) AND (active<>1 OR scope_kind<>'store'))
      ${scopeLockGuard?.scopeIds.length ? sql`AND NOT EXISTS (SELECT 1 FROM hr_schedule_scope_locks WHERE period_start=${scopeLockGuard.periodStart} AND locked_at IS NOT NULL AND scope_id IN (SELECT value FROM json_each(${JSON.stringify(scopeLockGuard.scopeIds)})))` : sql``}
      ${removed ? sql`AND NOT EXISTS (SELECT 1 FROM hr_schedule_entries AS entry INNER JOIN hr_employments AS person ON person.id=entry.employment_id WHERE entry.id IN (SELECT value FROM json_each(${JSON.stringify(removed.employee)})) AND person.archived_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM hr_schedule_worker_entries AS entry INNER JOIN hr_employments AS person ON person.id=entry.worker_id WHERE entry.id IN (SELECT value FROM json_each(${JSON.stringify(removed.worker)})) AND person.archived_at IS NOT NULL)` : sql``}
      ${authorizedScopeId ? sql`AND EXISTS (SELECT 1 FROM hr_schedule_managers AS manager INNER JOIN users ON users.id=manager.user_id INNER JOIN hr_employments ON hr_employments.employee_user_id=users.id INNER JOIN scopes ON scopes.id=manager.scope_id WHERE manager.scope_id=${authorizedScopeId} AND manager.user_id=${actor.id} AND users.status='active' AND hr_employments.archived_at IS NULL AND scopes.active=1 AND scopes.scope_kind='store')` : sql``}
      ${authorizedScopeId ? sql`AND NOT EXISTS (SELECT 1 FROM json_each(${membershipEntries}) AS proposed INNER JOIN hr_shift_templates AS template ON template.id=json_extract(proposed.value, '$.templateId') WHERE template.allowed_person_ids IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(template.allowed_person_ids) AS member WHERE member.value=json_extract(proposed.value, '$.personId')))` : sql``}
      ${removed?.scheduledOnlyIds?.length ? sql`AND NOT EXISTS (SELECT 1 FROM hr_schedule_entries WHERE id IN (SELECT value FROM json_each(${JSON.stringify(removed.scheduledOnlyIds)})) AND attendance_status<>'scheduled')
        AND NOT EXISTS (SELECT 1 FROM hr_schedule_worker_entries WHERE id IN (SELECT value FROM json_each(${JSON.stringify(removed.scheduledOnlyIds)})) AND attendance_status<>'scheduled')` : sql``}`;
  // 首次發布也必須同批建立月份；守衛失敗或任何 INSERT 失敗都不能留下空的已發布版本。
  const writeVersion = newPeriod
    ? sql`INSERT INTO hr_schedule_versions (id, period_start, period_end, version_number, status, submitted_by, approved_by, decision_reason, revision)
        SELECT ${version.id}, ${newPeriod.start}, ${newPeriod.end}, 1, 'published', ${actor.id}, ${actor.id}, '直接發布', ${nextRevision}
        WHERE ${eligible} AND NOT EXISTS (SELECT 1 FROM hr_schedule_versions WHERE period_start=${newPeriod.start} AND period_end=${newPeriod.end} AND status='published')
        ON CONFLICT DO NOTHING RETURNING id`
    : sql`UPDATE hr_schedule_versions SET revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${version.id} AND revision=${version.revision} AND locked_at IS NULL AND ${eligible} RETURNING id`;
  const statements = [
    writeVersion,
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email)
      SELECT ${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail} WHERE changes()=1`,
    // 已封存員工的排班是歷史快照；只替換仍可編輯的活動員工，避免儲存其他人時連帶刪除歷史。
    sql`DELETE FROM hr_schedule_entries
      WHERE schedule_version_id=${version.id}
        AND EXISTS (SELECT 1 FROM hr_employments AS employment WHERE employment.id=hr_schedule_entries.employment_id AND employment.archived_at IS NULL)
        ${removed ? sql`AND id IN (SELECT value FROM json_each(${JSON.stringify(removed.employee)}))` : sql``}
        AND ${guard}`,
    // 封存支援人員的班表同樣是歷史薪資來源；保留其既有列，只替換活動支援人員的排班。
    sql`DELETE FROM hr_schedule_worker_entries
      WHERE schedule_version_id=${version.id}
        AND EXISTS (SELECT 1 FROM hr_employments AS worker WHERE worker.id=hr_schedule_worker_entries.worker_id AND worker.archived_at IS NULL)
        ${removed ? sql`AND id IN (SELECT value FROM json_each(${JSON.stringify(removed.worker)}))` : sql``}
        AND ${guard}`,
    ...(["employee", "worker"] as const).map((kind) => {
      const values = JSON.stringify(entries.filter((entry) => entry.personKind === kind).map((entry) => ({ ...entry, id: crypto.randomUUID(), shiftGroupId: groupIdFor(entry) })));
      const table = kind === "employee" ? sql`hr_schedule_entries` : sql`hr_schedule_worker_entries`;
      const personColumn = kind === "employee" ? sql`employment_id` : sql`worker_id`;
      const personPath = kind === "employee" ? "$.employmentId" : "$.workerId";
      // JSON 陣列每種人員只需一條 INSERT，避免單月上千筆耗盡 D1 每次請求的查詢額度。
      return sql`INSERT INTO ${table} (id, schedule_version_id, ${personColumn}, scope_id, shift_version_id, shift_group_id, work_date, starts_at, ends_at, standard_minutes, break_minutes, required_headcount, attendance_status, created_by)
        SELECT json_extract(value, '$.id'), ${version.id}, json_extract(value, ${personPath}), json_extract(value, '$.scopeId'), json_extract(value, '$.shiftVersionId'), json_extract(value, '$.shiftGroupId'), json_extract(value, '$.workDate'), json_extract(value, '$.startsAt'), json_extract(value, '$.endsAt'), json_extract(value, '$.standardMinutes'), json_extract(value, '$.breakMinutes'), json_extract(value, '$.requiredHeadcount'), json_extract(value, '$.attendanceStatus'), ${actor.id}
        FROM json_each(${values}) WHERE ${guard}`;
    }),
  ];
  await runRawBatch(db, compileStatements(statements), true);
  return { id: version.id, revision: nextRevision };
}

async function validateAndEnrichEntries(db: Database, period: { start: string; end: string }, entries: ScheduleEntryInput[]) {
  if (!Array.isArray(entries) || entries.length > 1_000) throw new HrError(400, "單月排班筆數不正確。 ");
  const scopeRows = await db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(and(eq(scopes.scopeKind, "store"), eq(scopes.active, 1)));
  const scopeIds = new Set(scopeRows.map((scope) => scope.id));
  const shiftRows = await db.select({
    versionId: sql<string>`${hrShiftVersions.id}`.as("schedule_shift_version_id"),
    templateId: sql<string>`${hrShiftTemplates.id}`.as("schedule_shift_template_id"),
    scopeId: sql<string>`${hrScopeShiftAssignments.scopeId}`.as("schedule_shift_scope_id"),
    name: sql<string>`${hrShiftTemplates.name}`.as("schedule_shift_name"),
    dayType: sql<HrDayType>`${hrShiftVersions.dayType}`.as("schedule_shift_day_type"),
    versionNumber: sql<number>`${hrShiftVersions.versionNumber}`.as("schedule_shift_version_number"),
    startSecond: hrShiftVersions.startSecond,
    endSecond: hrShiftVersions.endSecond,
    endDayOffset: hrShiftVersions.endDayOffset,
    standardMinutes: hrShiftVersions.standardMinutes,
    breakMinutes: hrShiftVersions.breakMinutes,
    requiredHeadcount: hrShiftVersions.requiredHeadcount,
  }).from(hrScopeShiftAssignments)
    .innerJoin(hrShiftTemplates, eq(hrShiftTemplates.id, hrScopeShiftAssignments.shiftTemplateId))
    .innerJoin(hrShiftVersions, eq(hrShiftVersions.shiftTemplateId, hrShiftTemplates.id))
    .where(eq(hrShiftTemplates.active, 1));
  const currentShifts = latestShiftVersions(shiftRows);
  const shiftMap = new Map(currentShifts.map((shift) => [`${shift.versionId}:${shift.scopeId}`, shift]));
  const shiftsByTemplateAndScope = new Map<string, typeof currentShifts>();
  for (const shift of currentShifts) {
    const key = `${shift.templateId}:${shift.scopeId}`;
    shiftsByTemplateAndScope.set(key, [...(shiftsByTemplateAndScope.get(key) ?? []), shift]);
  }
  const dayTypes = await resolveDayTypes(db, [...new Set(entries.map((entry) => entry.workDate).filter((date) => datePeriodContains(date, period)))]);
  const employmentRows = await db.select({ id: hrEmployments.id }).from(hrEmployments)
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(sql`${hrEmployments.archivedAt} IS NULL`);
  const employmentMap = new Map(employmentRows.map((employment) => [employment.id, employment]));
  const workers = await db.select({ id: hrEmployments.id, active: sql<number>`CASE WHEN ${hrEmployments.archivedAt} IS NULL THEN 1 ELSE 0 END` }).from(hrEmployments)
    .where(eq(hrEmployments.personKind, "worker"));
  const workerMap = new Map(workers.map((worker) => [worker.id, worker]));
  const enriched: EnrichedScheduleEntry[] = [];
  // 跨據點代班由現場自行安排；只有同一據點的重疊會阻擋排班。
  const occupied = new Map<string, Array<{ start: number; end: number }>>();
  for (const entry of entries) {
    if (!datePeriodContains(entry.workDate, period)) throw new HrError(400, "排班日期必須位於指定月份。 ");
    const attendanceStatus = entry.attendanceStatus ?? "scheduled";
    if (!HR_SCHEDULE_ATTENDANCE_STATUSES.includes(attendanceStatus)) throw new HrError(400, "排班出勤狀態不正確。 ");
    if (!scopeIds.has(entry.scopeId)) throw new HrError(404, "找不到有效的營運據點。 ");
    const selectedShift = shiftMap.get(`${entry.shiftVersionId}:${entry.scopeId}`);
    if (!selectedShift || selectedShift.scopeId !== entry.scopeId) throw new HrError(400, "班別未設定在這個營運據點。 ");
    // 舊班表或行事曆修改後仍可能帶平日版 id；發布時以當日日型重選同一班別，避免假日沿用平日人力。
    const versions = shiftsByTemplateAndScope.get(`${selectedShift.templateId}:${entry.scopeId}`)!;
    const dayType = dayTypes.get(entry.workDate);
    const shift = versions.find((version) => version.dayType === dayType) ?? versions.find((version) => version.dayType === "weekday");
    if (!shift) throw new HrError(400, "班別缺少適用的日型設定。 ");
    if (entry.personKind === "employee") {
      const employment = entry.employmentId ? employmentMap.get(entry.employmentId) : undefined;
      if (!employment) throw new HrError(400, "排班人員不是目前有效的員工。 ");
    } else {
      const worker = entry.workerId ? workerMap.get(entry.workerId) : undefined;
      if (!worker || !worker.active) throw new HrError(400, "臨時支援人員不存在或已停用。 ");
    }
    const durationSeconds = shift.endDayOffset === 1
      ? DAY_SECONDS - shift.startSecond + shift.endSecond
      : shift.endSecond - shift.startSecond;
    assertShiftMinutes(shift, durationSeconds);
    const startsAt = wallTime(entry.workDate, shift.startSecond);
    const endsAt = wallTime(addDays(entry.workDate, shift.endDayOffset), shift.endSecond);
    const personId = entry.personKind === "employee" ? `employee:${entry.employmentId}` : `worker:${entry.workerId}`;
    const personAtScope = `${personId}:${entry.scopeId}`;
    const interval = { start: dateToDayNumber(entry.workDate) * DAY_SECONDS + shift.startSecond, end: dateToDayNumber(entry.workDate) * DAY_SECONDS + shift.endDayOffset * DAY_SECONDS + shift.endSecond };
    const personIntervals = occupied.get(personAtScope) ?? [];
    if (personIntervals.some((current) => interval.start < current.end && current.start < interval.end)) throw new HrError(409, "同一人員在同一營運據點的排班時段重疊。 ");
    personIntervals.push(interval);
    occupied.set(personAtScope, personIntervals);
    enriched.push({ ...entry, shiftVersionId: shift.versionId, startsAt, endsAt, standardMinutes: shift.standardMinutes, breakMinutes: shift.breakMinutes, shiftTemplateId: shift.templateId, requiredHeadcount: shift.requiredHeadcount, attendanceStatus });
  }
  // 月休是薪資結算的基準，允許實際排班日數與約定不同，差額由薪資引擎補發或扣回。
  return enriched;
}

/** 可以排班的營運據點。排班月曆與班別管理共用，兩頁看到的店才會一致。 */
function listHrScheduleScopes(db: Database) {
  return db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(and(eq(scopes.scopeKind, "store"), eq(scopes.active, 1))).orderBy(asc(scopes.sortOrder), asc(scopes.name));
}

/** 每個據點掛的班別與所有版本；呼叫端再用 latestShiftVersions 取最新版。 */
function listHrScopeShiftRows(db: Database) {
  return db.select({
      versionId: sql<string>`${hrShiftVersions.id}`.as("schedule_shift_version_id"),
      templateId: sql<string>`${hrShiftTemplates.id}`.as("schedule_shift_template_id"),
      scopeId: sql<string>`${hrScopeShiftAssignments.scopeId}`.as("schedule_shift_scope_id"),
      code: sql<string>`${hrShiftTemplates.code}`.as("schedule_shift_code"),
      name: sql<string>`${hrShiftTemplates.name}`.as("schedule_shift_name"),
      revision: sql<number>`${hrShiftTemplates.revision}`.as("schedule_shift_revision"),
      allowedPersonIds: hrShiftTemplates.allowedPersonIds,
      dayType: sql<HrDayType>`${hrShiftVersions.dayType}`.as("schedule_shift_day_type"),
      versionNumber: sql<number>`${hrShiftVersions.versionNumber}`.as("schedule_shift_version_number"),
      startSecond: hrShiftVersions.startSecond,
      endSecond: hrShiftVersions.endSecond,
      endDayOffset: hrShiftVersions.endDayOffset,
      standardMinutes: hrShiftVersions.standardMinutes,
      breakMinutes: hrShiftVersions.breakMinutes,
      requiredHeadcount: hrShiftVersions.requiredHeadcount,
    }).from(hrScopeShiftAssignments)
      .innerJoin(hrShiftTemplates, eq(hrShiftTemplates.id, hrScopeShiftAssignments.shiftTemplateId))
      .innerJoin(hrShiftVersions, eq(hrShiftVersions.shiftTemplateId, hrShiftTemplates.id))
      .where(eq(hrShiftTemplates.active, 1))
      .orderBy(asc(hrShiftTemplates.name), asc(hrShiftVersions.startSecond));
}

/** 班別管理頁：店與每家店目前生效的班別。 */
export async function listHrShifts(db: Database) {
  const [scopeRows, shiftRows] = await Promise.all([listHrScheduleScopes(db), listHrScopeShiftRows(db)]);
  const people = await db.select({ id: hrEmployments.id, name: hrEmployments.legalName, employeeNumber: hrEmployments.employeeNumber, personKind: hrEmployments.personKind }).from(hrEmployments).where(isNull(hrEmployments.archivedAt)).orderBy(...hrEmployeeNumberOrder());
  return { scopes: scopeRows, shifts: latestShiftVersions(shiftRows).map(({ versionNumber: _versionNumber, code: _code, ...shift }) => shift), people };
}

export async function getHrSchedule(db: Database, periodKey: string, scopeId?: string) {
  const period = monthPeriodFromKey(periodKey);
  const version = await latestScheduleVersion(db, period);
  const [scopeRows, workerRows, shiftRows, calendar] = await Promise.all([
    listHrScheduleScopes(db),
    db.select({ id: hrEmployments.id, name: hrEmployments.legalName, active: sql<number>`CASE WHEN ${hrEmployments.archivedAt} IS NULL THEN 1 ELSE 0 END` }).from(hrEmployments)
      .where(and(eq(hrEmployments.personKind, "worker"), isNull(hrEmployments.archivedAt))).orderBy(asc(hrEmployments.legalName)),
    listHrScopeShiftRows(db),
    listHrCalendarMonth(db, period),
  ]);
  const selectedScopeId = scopeId && scopeId !== "all" ? scopeId : undefined;
  const [employeeEntries, workerEntries] = version ? await Promise.all([
    db.select({ entry: hrScheduleEntries, employeeNumber: hrEmployments.employeeNumber, employeeName: hrEmployeeName, archivedAt: hrEmployments.archivedAt, scopeName: scopes.name, shiftName: hrShiftTemplates.name, shiftTemplateId: hrShiftTemplates.id }).from(hrScheduleEntries)
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrScheduleEntries.employmentId))
      .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
      .innerJoin(scopes, eq(scopes.id, hrScheduleEntries.scopeId))
      .innerJoin(hrShiftVersions, eq(hrShiftVersions.id, hrScheduleEntries.shiftVersionId))
      .innerJoin(hrShiftTemplates, eq(hrShiftTemplates.id, hrShiftVersions.shiftTemplateId))
      .where(and(eq(hrScheduleEntries.scheduleVersionId, version.id), selectedScopeId ? eq(hrScheduleEntries.scopeId, selectedScopeId) : undefined)),
    db.select({ entry: hrScheduleWorkerEntries, workerName: hrEmployments.legalName, archivedAt: hrEmployments.archivedAt, scopeName: scopes.name, shiftName: hrShiftTemplates.name, shiftTemplateId: hrShiftTemplates.id }).from(hrScheduleWorkerEntries)
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrScheduleWorkerEntries.workerId))
      .innerJoin(scopes, eq(scopes.id, hrScheduleWorkerEntries.scopeId))
      .innerJoin(hrShiftVersions, eq(hrShiftVersions.id, hrScheduleWorkerEntries.shiftVersionId))
      .innerJoin(hrShiftTemplates, eq(hrShiftTemplates.id, hrShiftVersions.shiftTemplateId))
      .where(and(eq(hrScheduleWorkerEntries.scheduleVersionId, version.id), eq(hrEmployments.personKind, "worker"), selectedScopeId ? eq(hrScheduleWorkerEntries.scopeId, selectedScopeId) : undefined)),
  ]) : [[], []];
  const employees = await db.select({ employmentId: hrEmployments.id, userId: hrEmployments.employeeUserId, employeeNumber: hrEmployments.employeeNumber, name: hrEmployeeName, attendanceMode: hrEmploymentAttendanceSettings.attendanceMode, monthlyRestDays: hrEmploymentAttendanceSettings.monthlyRestDays }).from(hrEmployments)
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .leftJoin(hrEmploymentAttendanceSettings, eq(hrEmploymentAttendanceSettings.employmentId, hrEmployments.id))
    .where(sql`${hrEmployments.archivedAt} IS NULL`)
    .orderBy(...hrEmployeeNumberOrder());
  return {
    periodKey,
    period,
    version: version ? { id: version.id, revision: version.revision, status: "published" as const, locked: version.lockedAt !== null, lockedAt: version.lockedAt } : null,
    scopes: scopeRows,
    calendar,
    shifts: (selectedScopeId ? latestShiftVersions(shiftRows).filter((shift) => shift.scopeId === selectedScopeId) : latestShiftVersions(shiftRows)).map(({ versionNumber: _versionNumber, ...shift }) => shift),
    employees,
    workers: workerRows,
    entries: [
      ...employeeEntries.map(({ entry, employeeNumber, employeeName, archivedAt, scopeName, shiftName, shiftTemplateId }) => ({ ...entry, shiftTemplateId, personKind: "employee" as const, workerId: null, employeeNumber, personName: employeeName, archivedAt, scopeName, shiftName })),
      ...workerEntries.map(({ entry, workerName, archivedAt, scopeName, shiftName, shiftTemplateId }) => ({ ...entry, shiftTemplateId, personKind: "worker" as const, employmentId: null, employeeNumber: null, personName: workerName, archivedAt, scopeName, shiftName })),
    ],
  };
}

export async function saveHrSchedule(db: Database, input: SaveHrScheduleInput, actor: HrActor) {
  const period = monthPeriodFromKey(input.periodKey);
  const entries = await validateAndEnrichEntries(db, period, input.entries);
  const version = input.scheduleVersionId ? (await db.select().from(hrScheduleVersions).where(eq(hrScheduleVersions.id, input.scheduleVersionId)).limit(1))[0] : await latestScheduleVersion(db, period);
  if (input.scheduleVersionId && !version || version && (version.periodStart !== period.start || version.periodEnd !== period.end || version.status !== "published")) throw new HrError(404, "找不到指定月份的排班版本。 ");
  if (input.revision !== undefined && input.revision !== (version?.revision ?? 1)) throw new HrError(409, "排班已被其他人修改，請重新整理。 ");
  const current = await getHrSchedule(db, input.periodKey);
  const affectedScopeIds = [...new Set([...current.entries.map((entry) => entry.scopeId), ...entries.map((entry) => entry.scopeId)])];
  const lockedScopes = await listLockedScheduleScopes(db, period.start, affectedScopeIds);
  if (lockedScopes.length) throw new HrError(409, `「${lockedScopes.join("、")}」據點的排班已鎖定。 `);
  return saveEntriesAtomically(db, version ?? { id: crypto.randomUUID(), revision: 1, lockedAt: null }, entries, actor, undefined, undefined, [], version ? undefined : period, { periodStart: period.start, scopeIds: affectedScopeIds });
}

export interface HrScheduleChangesInput {
  periodKey: string;
  /** 未建立月份以 0 表示；已建立月份必須提供讀取到的 revision。 */
  revision: number;
  entries: ScheduleEntryInput[];
  removedIds: string[];
  refreshIds: string[];
}

export async function saveHrScheduleChanges(db: Database, input: HrScheduleChangesInput, actor: HrActor, authorizedScopeId?: string) {
  const period = monthPeriodFromKey(input.periodKey);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new HrError(400, "排班版本不正確。 ");
  for (const ids of [input.removedIds, input.refreshIds]) {
    if (!Array.isArray(ids) || ids.length > 1000 || ids.some((id) => typeof id !== "string" || !id || id.length > 200) || new Set(ids).size !== ids.length) throw new HrError(400, "排班變更清單不正確。 ");
  }
  if (input.refreshIds.some((id) => input.removedIds.includes(id))) throw new HrError(400, "移除與重新套用不可指定同一筆排班。 ");
  const current = await getHrSchedule(db, input.periodKey);
  if ((current.version?.revision ?? 0) !== input.revision) throw new HrError(409, "排班已被其他人修改，請重新整理。 ");
  if (current.version?.locked) throw new HrError(409, "排班目前已鎖定。 ");
  const byId = new Map(current.entries.map((entry) => [entry.id, entry]));
  const touchedIds = new Set([...input.removedIds, ...input.refreshIds]);
  for (const id of touchedIds) {
    const entry = byId.get(id);
    if (!entry || entry.archivedAt) throw new HrError(409, "排班不存在或人員已封存，請重新整理。 ");
    if (authorizedScopeId && entry.scopeId !== authorizedScopeId) throw new HrError(403, "只能修改負責據點的排班。 ");
    if (authorizedScopeId && input.removedIds.includes(id) && entry.attendanceStatus !== "scheduled") throw new HrError(403, "已確認出勤狀態的排班不可移除，請聯絡 HR 調整。 ");
  }
  if (authorizedScopeId && input.entries.some((entry) => entry.scopeId !== authorizedScopeId || entry.attendanceStatus && entry.attendanceStatus !== "scheduled")) throw new HrError(403, "只能安排負責據點的排班，不能設定出勤狀態。 ");
  const affectedScopeIds = [...new Set([...(authorizedScopeId ? [authorizedScopeId] : []), ...input.entries.map((entry) => entry.scopeId), ...[...touchedIds].map((id) => byId.get(id)?.scopeId).filter((id): id is string => Boolean(id))])];
  const lockedScopes = await listLockedScheduleScopes(db, period.start, affectedScopeIds);
  if (lockedScopes.length) throw new HrError(409, `「${lockedScopes.join("、")}」據點的排班已鎖定。 `);
  const refreshed = input.refreshIds.map((id) => {
    const entry = byId.get(id)!;
    return { personKind: entry.personKind, employmentId: entry.employmentId ?? undefined, workerId: entry.workerId ?? undefined, scopeId: entry.scopeId, shiftVersionId: entry.shiftVersionId, workDate: entry.workDate, attendanceStatus: entry.attendanceStatus };
  });
  if (authorizedScopeId) {
    for (const entry of input.entries) {
      const shift = current.shifts.find((shift) => shift.versionId === entry.shiftVersionId && shift.scopeId === entry.scopeId);
      const personId = entry.personKind === "employee" ? entry.employmentId : entry.workerId;
      if (shift?.allowedPersonIds != null && (!personId || !shift.allowedPersonIds.includes(personId))) throw new HrError(403, "這位人員未納入班別的前台可排人員，請聯絡 HR 調整。 ");
    }
  }
  const enriched = await validateAndEnrichEntries(db, period, [...input.entries, ...refreshed]);
  if (authorizedScopeId) enriched.forEach((entry, index) => { entry.enforceMembership = index < input.entries.length; });
  const retained = current.entries.filter((entry) => !touchedIds.has(entry.id));
  for (const entry of enriched) {
    for (const other of retained) {
      if (other.scopeId !== entry.scopeId) continue;
      const samePerson = entry.personKind === other.personKind && (entry.personKind === "employee" ? "employmentId" in other && other.employmentId === entry.employmentId : "workerId" in other && other.workerId === entry.workerId);
      if (samePerson && entry.startsAt < other.endsAt && other.startsAt < entry.endsAt) throw new HrError(409, "同一人員在同一營運據點的排班時段重疊。 ");
      if (!other.archivedAt && other.workDate === entry.workDate && other.shiftTemplateId === entry.shiftTemplateId && other.requiredHeadcount !== entry.requiredHeadcount) throw new HrError(409, "同班排班需求人力已變更，請一併重新套用該班的活動人員排班。 ");
    }
  }
  if (!touchedIds.size && !enriched.length) throw new HrError(400, "沒有需要儲存的排班變更。 ");
  const version = current.version ?? { id: crypto.randomUUID(), revision: 1, lockedAt: null };
  return saveEntriesAtomically(db, { ...version, lockedAt: version.lockedAt }, enriched, actor, {
    employee: [...touchedIds].filter((id) => byId.get(id)?.personKind === "employee"),
    worker: [...touchedIds].filter((id) => byId.get(id)?.personKind === "worker"),
    scheduledOnlyIds: authorizedScopeId ? input.removedIds : [],
  }, authorizedScopeId, retained, current.version ? undefined : period, { periodStart: period.start, scopeIds: affectedScopeIds });
}

async function listLockedScheduleScopes(db: Database, periodStart: string, scopeIds: string[]) {
  if (!scopeIds.length) return [];
  const rows = await db.select({ scopeId: hrScheduleScopeLocks.scopeId }).from(hrScheduleScopeLocks)
    .where(and(eq(hrScheduleScopeLocks.periodStart, periodStart), inArray(hrScheduleScopeLocks.scopeId, scopeIds), isNotNull(hrScheduleScopeLocks.lockedAt)));
  return rows.map((row) => row.scopeId);
}

export async function getHrScheduleScopeLock(db: Database, periodKey: string, scopeId: string) {
  const period = monthPeriodFromKey(periodKey);
  const row = (await db.select().from(hrScheduleScopeLocks).where(and(eq(hrScheduleScopeLocks.periodStart, period.start), eq(hrScheduleScopeLocks.scopeId, scopeId))).limit(1))[0];
  return { revision: row?.revision ?? 0, locked: Boolean(row?.lockedAt), lockedAt: row?.lockedAt ?? null };
}

export async function setHrScheduleScopeLock(db: Database, periodKey: string, scopeId: string, input: { revision: number; locked: boolean }, actor: HrActor) {
  const period = monthPeriodFromKey(periodKey);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new HrError(400, "據點排班鎖定版本不正確。 ");
  const version = await latestScheduleVersion(db, period);
  if (!version) throw new HrError(404, "指定月份尚未建立排班。 ");
  if (version.lockedAt) throw new HrError(409, "整個月份已由 HR 鎖定，請聯絡 HR 開鎖。 ");
  const scope = (await db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(and(eq(scopes.id, scopeId), eq(scopes.scopeKind, "store"), eq(scopes.active, 1))).limit(1))[0];
  if (!scope) throw new HrError(404, "找不到有效的營運據點。 ");
  const current = await getHrScheduleScopeLock(db, periodKey, scopeId);
  if (current.revision !== input.revision) throw new HrError(409, "據點排班鎖定狀態已變更，請重新整理。 ");
  if (current.locked === input.locked) return { scopeId, revision: current.revision, locked: input.locked };
  const event = activityRow({ entityType: "hr_schedule", entityId: version.id, source: "hr", eventType: input.locked ? "schedule_scope_locked" : "schedule_scope_unlocked", summary: input.locked ? `「${scope.name}」據點排班已鎖定` : `「${scope.name}」據點排班已開鎖`, actor, payload: { scopeId, periodKey } });
  const managerGuard = sql`EXISTS (SELECT 1 FROM hr_schedule_managers AS manager INNER JOIN users ON users.id=manager.user_id INNER JOIN hr_employments ON hr_employments.employee_user_id=users.id INNER JOIN scopes ON scopes.id=manager.scope_id WHERE manager.scope_id=${scopeId} AND manager.user_id=${actor.id} AND users.status='active' AND hr_employments.archived_at IS NULL AND scopes.active=1 AND scopes.scope_kind='store')
    AND EXISTS (SELECT 1 FROM hr_schedule_versions WHERE id=${version.id} AND locked_at IS NULL)`;
  const write = input.revision === 0
    ? sql`INSERT INTO hr_schedule_scope_locks (period_start, scope_id, locked_at, locked_by, updated_by, revision)
        SELECT ${period.start}, ${scopeId}, ${input.locked ? new Date().toISOString() : null}, ${input.locked ? actor.id : null}, ${actor.id}, 1 WHERE ${managerGuard}
        ON CONFLICT (period_start, scope_id) DO NOTHING RETURNING revision`
    : sql`UPDATE hr_schedule_scope_locks SET locked_at=${input.locked ? new Date().toISOString() : null}, locked_by=${input.locked ? actor.id : null}, updated_by=${actor.id}, updated_at=CURRENT_TIMESTAMP, revision=revision+1
        WHERE period_start=${period.start} AND scope_id=${scopeId} AND revision=${input.revision} AND ${managerGuard} RETURNING revision`;
  const result = await runRawBatch(db, compileStatements([
    write,
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email, payload_json)
      SELECT ${event.id}, ${event.entityType}, ${event.entityId}, ${event.eventType}, ${event.summary}, ${event.source}, ${event.actorType}, ${event.actorId}, ${event.actorEmail}, ${event.payloadJson} WHERE changes()=1`,
  ]), true);
  const rows = result[0]?.results as Array<{ revision?: number }> | undefined;
  const revision = rows?.[0]?.revision;
  if (revision === undefined) throw new HrError(409, "據點排班鎖定狀態已變更，請重新整理。 ");
  return { scopeId, revision, locked: input.locked };
}

export async function setHrScheduleLock(db: Database, periodKey: string, input: { revision: number; locked: boolean }, actor: HrActor) {
  const period = monthPeriodFromKey(periodKey);
  const version = await latestScheduleVersion(db, period);
  if (!version) throw new HrError(404, "指定月份尚未建立排班。 ");
  const row = activityRow({ entityType: "hr_schedule", entityId: version.id, source: "hr", eventType: input.locked ? "schedule_locked" : "schedule_unlocked", summary: input.locked ? "排班已鎖定" : "排班已開鎖", actor });
  await runRawBatch(db, compileStatements([
    sql`UPDATE hr_schedule_versions SET locked_at=${input.locked ? new Date().toISOString() : null}, revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${version.id} AND revision=${input.revision} RETURNING id`,
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email)
      SELECT ${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail} WHERE changes() = 1`,
  ]), true);
  return { id: version.id, revision: version.revision + 1, locked: input.locked };
}

/**
 * 班別一律是當天上下班，不提供跨午夜；代碼由系統產生。
 *
 * 代碼在資料庫是全域唯一，但沒有任何地方拿它來查或顯示。讓人自己填的話，不同店各建一個
 * 「AM 早班」就會撞號，而錯誤訊息講的是一個使用者根本不在乎的欄位。
 */
export interface HrShiftTime {
  dayType: HrDayType;
  startSecond: number;
  endSecond: number;
  standardMinutes: number;
  breakMinutes: number;
  /** 這個日型的排班提示人力；舊呼叫端可省略，由班別層級值補上。 */
  requiredHeadcount?: number;
}

export interface HrShiftInput {
  scopeId: string;
  name: string;
  times: HrShiftTime[];
  allowedPersonIds?: string[] | null;
  /** 舊版 API 的班別層級需求人力；新的 UI 會在每個日型提供自己的值。 */
  requiredHeadcount?: number;
}

function assertSameDayShift(input: { startSecond: number; endSecond: number; standardMinutes: number; breakMinutes: number }) {
  if (!Number.isInteger(input.startSecond) || input.startSecond < 0 || input.startSecond > 86_399 || !Number.isInteger(input.endSecond) || input.endSecond < 0 || input.endSecond > 86_399 || input.endSecond <= input.startSecond) throw new HrError(400, "班別的結束時間必須晚於開始時間。 ");
  assertShiftMinutes(input, input.endSecond - input.startSecond);
}

/**
 * 平日那一組是必填的，因為它同時是所有沒設定的日型的退路（見 pickShiftForDay）。
 *
 * 允許只填週末而不填平日的話，一個平日按下去會找不到任何時間，排班頁只能給出
 * 「這個班別在今天沒有時間」這種沒人看得懂的錯誤。
 */
function assertShiftTimes(times: HrShiftTime[]) {
  if (!Array.isArray(times) || !times.length || times.length > 3) throw new HrError(400, "班別的時間組數不正確。 ");
  const seen = new Set<HrDayType>();
  for (const time of times) {
    if (!isHrDayType(time.dayType)) throw new HrError(400, "班別的日期類型不正確。 ");
    if (seen.has(time.dayType)) throw new HrError(400, `班別的${HR_DAY_TYPE_LABELS[time.dayType]}時間重複設定了。 `);
    seen.add(time.dayType);
    assertSameDayShift(time);
  }
  if (!seen.has("weekday")) throw new HrError(400, "班別一定要有平日時間，其他日型沒設定時會沿用它。 ");
}

function assertRequiredHeadcount(value: number | undefined) {
  const requiredHeadcount = value ?? 1;
  if (!Number.isSafeInteger(requiredHeadcount) || requiredHeadcount < 1 || requiredHeadcount > 100) throw new HrError(400, "班別需求人力必須是 1～100 的整數。 ");
  return requiredHeadcount;
}

function resolveRequiredHeadcounts(times: HrShiftTime[], fallback: number | undefined, inherited: Map<HrDayType, number> = new Map()) {
  const defaultHeadcount = assertRequiredHeadcount(fallback);
  return new Map(times.map((time) => [time.dayType, assertRequiredHeadcount(time.requiredHeadcount ?? inherited.get(time.dayType) ?? defaultHeadcount)]));
}

async function validateShiftPeople(db: Database, ids: string[] | null | undefined, previous: string[] | null = null) {
  if (ids == null) return;
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some((id) => typeof id !== "string" || !id || id.length > 100) || new Set(ids).size !== ids.length) throw new HrError(400, "班別可排人員名單格式不正確。 ");
  const people = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(inJsonArray(hrEmployments.id, ids), isNull(hrEmployments.archivedAt)));
  if (ids.some((id) => !people.some((person) => person.id === id) && !previous?.includes(id))) throw new HrError(400, "班別可排人員必須是有效的員工或支援人員。 ");
}

function insertShiftVersion(versionId: string, templateId: string, time: HrShiftTime, requiredHeadcount: number, versionNumber: number, actorId: string) {
  return sql`INSERT INTO hr_shift_versions (id, shift_template_id, day_type, required_headcount, version_number, start_second, end_second, end_day_offset, standard_minutes, break_minutes, pay_factor_ppm, created_by)
    VALUES (${versionId}, ${templateId}, ${time.dayType}, ${requiredHeadcount}, ${versionNumber}, ${time.startSecond}, ${time.endSecond}, 0, ${time.standardMinutes}, ${time.breakMinutes}, 1000000, ${actorId})`;
}

export async function createHrShift(db: Database, input: HrShiftInput, actor: HrActor) {
  assertShiftTimes(input.times);
  await validateShiftPeople(db, input.allowedPersonIds);
  const requiredHeadcounts = resolveRequiredHeadcounts(input.times, input.requiredHeadcount);
  const weekdayHeadcount = requiredHeadcounts.get("weekday")!;
  const [scope] = await db.select({ id: scopes.id }).from(scopes).where(and(eq(scopes.id, input.scopeId), eq(scopes.scopeKind, "store"), eq(scopes.active, 1))).limit(1);
  if (!scope) throw new HrError(404, "找不到有效的營運據點。 ");
  const templateId = crypto.randomUUID();
  const versionIds = new Map(input.times.map((time) => [time.dayType, crypto.randomUUID()]));
  const assignmentId = `${input.scopeId}:${templateId}`;
  const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
  const row = activityRow({ entityType: "hr_schedule", entityId: templateId, source: "hr", eventType: "shift_created", summary: "班別已建立", actor, payload: { name: input.name.trim(), allowedPersonIds: input.allowedPersonIds ?? null, requiredHeadcount: weekdayHeadcount, requiredHeadcounts: Object.fromEntries(requiredHeadcounts), dayTypes: input.times.map((time) => time.dayType) } });
  const statements = [
    sql`INSERT INTO hr_shift_templates (id, code, name, active, required_headcount, allowed_person_ids, created_by) VALUES (${templateId}, ${templateId}, ${input.name.trim()}, 1, ${weekdayHeadcount}, ${input.allowedPersonIds == null ? null : JSON.stringify(input.allowedPersonIds)}, ${actor.id}) RETURNING id`,
    ...input.times.map((time) => insertShiftVersion(versionIds.get(time.dayType)!, templateId, time, requiredHeadcounts.get(time.dayType)!, 1, actor.id)),
    sql`INSERT INTO hr_scope_shift_assignments (scope_id, shift_template_id, is_default, created_by) VALUES (${input.scopeId}, ${templateId}, 0, ${actor.id}) RETURNING scope_id AS id`,
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email, payload_json) VALUES (${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail}, ${row.payloadJson})`,
  ].map((statement) => dialect.sqlToQuery(statement));
  await runRawBatch(db, statements, false);
  return { id: templateId, versionId: versionIds.get("weekday")!, assignmentId };
}

/**
 * 修改與刪除之前都要確認：這個班別屬於這家店，而且**只**屬於這家店。
 *
 * 同一個班別掛在多家店時，改或刪一家會連另一家一起動到，而操作的人只看得到自己點開的那家。
 */
async function assertShiftOwnedByScope(db: Database, templateId: string, scopeId: string, action: "修改" | "刪除") {
  const assignments = await db.select({ scopeId: hrScopeShiftAssignments.scopeId }).from(hrScopeShiftAssignments).where(eq(hrScopeShiftAssignments.shiftTemplateId, templateId));
  if (!assignments.some((item) => item.scopeId === scopeId)) throw new HrError(404, "找不到這家店的這個班別。 ");
  if (assignments.length > 1) throw new HrError(409, `這個班別同時用在多家店，直接${action}會連其他店一起${action === "修改" ? "改" : "刪"}掉；請改為在這家店新增一個班別。 `);
}

/**
 * 直接改班別的名稱與時間，不開新版本。
 *
 * 這是刻意的取捨：已存下的排班各自存了 starts_at／ends_at，不會因為這裡改了就變；但之後
 * 有人對那個月份重新按儲存，會用新時間重算。鎖定的月份存不了，所以已結算的月份請先鎖定。
 *
 * 班別若同時掛在多家店就拒絕：改一家店的早班，另一家店的早班也會跟著變，而畫面上操作的
 * 人只看得到自己點進來的那一家。從班別管理頁建立的班別一定只屬於一家店。
 */
export async function updateHrShift(db: Database, templateId: string, input: HrShiftInput & { revision: number }, actor: HrActor) {
  assertShiftTimes(input.times);
  await assertShiftOwnedByScope(db, templateId, input.scopeId, "修改");
  const [template] = await db.select({ requiredHeadcount: hrShiftTemplates.requiredHeadcount, allowedPersonIds: hrShiftTemplates.allowedPersonIds }).from(hrShiftTemplates).where(eq(hrShiftTemplates.id, templateId)).limit(1);
  await validateShiftPeople(db, input.allowedPersonIds, template?.allowedPersonIds);
  const allowedPersonIds = input.allowedPersonIds === undefined ? template?.allowedPersonIds ?? null : input.allowedPersonIds;
  const existing = await db.select({ id: hrShiftVersions.id, dayType: hrShiftVersions.dayType, versionNumber: hrShiftVersions.versionNumber, requiredHeadcount: hrShiftVersions.requiredHeadcount })
    .from(hrShiftVersions).where(eq(hrShiftVersions.shiftTemplateId, templateId)).orderBy(desc(hrShiftVersions.versionNumber));
  if (!existing.length) throw new HrError(404, "找不到班別的時間設定。 ");
  const latestByDayType = new Map<HrDayType, { id: string; versionNumber: number; requiredHeadcount: number }>();
  for (const version of existing) if (!latestByDayType.has(version.dayType)) latestByDayType.set(version.dayType, version);
  /* 有明確帶入舊版班別層級值時，它代表整個舊 API 的需求人力；未帶入時才保留既有各日型值。 */
  const inheritedHeadcounts = input.requiredHeadcount === undefined
    ? new Map([...latestByDayType.entries()].map(([dayType, version]) => [dayType, version.requiredHeadcount]))
    : new Map<HrDayType, number>();
  const requiredHeadcounts = resolveRequiredHeadcounts(input.times, input.requiredHeadcount ?? template?.requiredHeadcount, inheritedHeadcounts);
  const weekdayHeadcount = requiredHeadcounts.get("weekday")!;
  const wanted = new Set(input.times.map((time) => time.dayType));
  const removed = [...latestByDayType.entries()].filter(([dayType]) => !wanted.has(dayType));
  const row = activityRow({ entityType: "hr_schedule", entityId: templateId, source: "hr", eventType: "shift_updated", summary: "班別已修改", actor, payload: { scopeId: input.scopeId, name: input.name.trim(), allowedPersonIds, requiredHeadcount: weekdayHeadcount, requiredHeadcounts: Object.fromEntries(requiredHeadcounts), times: input.times } });
  /*
   * 只有第一句真的改到一列，後面才動時間與寫紀錄；用 changes() 而不是再查一次 revision。
   * 用「revision = 舊值 + 1」判斷會被併發騙過：別人先改成 2 之後，拿著舊值 1 的請求
   * 算出來的也是 2，條件照樣成立，名稱沒改到、時間卻被蓋掉。
   *
   * changes() 看的是「上一句」，所以這條鏈成立的前提是**後面每一句都剛好動到一列**：
   * UPDATE 與 DELETE 用主鍵、INSERT 一次一列，都滿足。加新句子時要維持這個性質，
   * 否則從那一句之後的守衛全部失效。
   */
  const statements = [
    sql`UPDATE hr_shift_templates SET name=${input.name.trim()}, required_headcount=${weekdayHeadcount}, allowed_person_ids=${allowedPersonIds === null ? null : JSON.stringify(allowedPersonIds)}, revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${templateId} AND revision=${input.revision} RETURNING id`,
    ...input.times.map((time) => {
      const current = latestByDayType.get(time.dayType);
      const requiredHeadcount = requiredHeadcounts.get(time.dayType)!;
      return current
        ? sql`UPDATE hr_shift_versions SET required_headcount=${requiredHeadcount}, start_second=${time.startSecond}, end_second=${time.endSecond}, end_day_offset=0, standard_minutes=${time.standardMinutes}, break_minutes=${time.breakMinutes} WHERE id=${current.id} AND changes() = 1`
        : sql`INSERT INTO hr_shift_versions (id, shift_template_id, day_type, required_headcount, version_number, start_second, end_second, end_day_offset, standard_minutes, break_minutes, pay_factor_ppm, created_by)
            SELECT ${crypto.randomUUID()}, ${templateId}, ${time.dayType}, ${requiredHeadcount}, 1, ${time.startSecond}, ${time.endSecond}, 0, ${time.standardMinutes}, ${time.breakMinutes}, 1000000, ${actor.id} WHERE changes() = 1`;
    }),
    ...removed.map(([, version]) => sql`DELETE FROM hr_shift_versions WHERE id=${version.id} AND changes() = 1`),
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email, payload_json)
      SELECT ${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail}, ${row.payloadJson} WHERE changes() = 1`,
  ];
  try {
    await runRawBatch(db, compileStatements(statements), true, "班別已被其他人修改，請重新整理後再改。 ");
  } catch (error) {
    // 移掉某個日型的時間時，那組時間可能已經被排進班表；外鍵會擋下整批，換成看得懂的訊息。
    if (error instanceof Error && /FOREIGN KEY/i.test(error.message)) throw new HrError(409, "要移除的那組時間已經排進班表，請先到排班月曆移除該日的排班。 ");
    throw error;
  }
  return { id: templateId, revision: input.revision + 1 };
}

/**
 * 刪除班別。只有**從沒被排進任何排班**的班別能刪。
 *
 * 排班表以外鍵指著班別版本，已排過的班別刪不掉；就算改成停用，那個月份之後重新儲存時
 * 也會因為找不到班別而存不進去。所以直接擋下並講清楚排在哪裡，讓人先到排班月曆移除。
 */
export async function deleteHrShift(db: Database, templateId: string, input: { scopeId: string; revision: number }, actor: HrActor) {
  await assertShiftOwnedByScope(db, templateId, input.scopeId, "刪除");
  const usage = sql`SELECT work_date FROM hr_schedule_entries WHERE shift_version_id IN (SELECT id FROM hr_shift_versions WHERE shift_template_id=${templateId})
    UNION ALL SELECT work_date FROM hr_schedule_worker_entries WHERE shift_version_id IN (SELECT id FROM hr_shift_versions WHERE shift_template_id=${templateId})`;
  const [used] = await db.all<{ total: number; earliest: string | null }>(sql`SELECT count(*) AS total, min(work_date) AS earliest FROM (${usage})`);
  if (used && Number(used.total) > 0) throw new HrError(409, `這個班別已經排進 ${used.total} 筆排班（最早 ${used.earliest}），請先到排班月曆移除後再刪除。 `);
  const row = activityRow({ entityType: "hr_schedule", entityId: templateId, source: "hr", eventType: "shift_deleted", summary: "班別已刪除", actor, payload: { scopeId: input.scopeId } });
  // 每一句都帶同一個 revision 條件：revision 在這一批裡不會被改，所以不會有修改那邊「舊值 + 1」的問題。
  const current = sql`EXISTS (SELECT 1 FROM hr_shift_templates WHERE id=${templateId} AND revision=${input.revision})`;
  try {
    await runRawBatch(db, compileStatements([
      sql`SELECT id FROM hr_shift_templates WHERE id=${templateId} AND revision=${input.revision}`,
      sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email, payload_json)
        SELECT ${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail}, ${row.payloadJson} WHERE ${current}`,
      sql`DELETE FROM hr_scope_shift_assignments WHERE shift_template_id=${templateId} AND ${current}`,
      sql`DELETE FROM hr_shift_versions WHERE shift_template_id=${templateId} AND ${current}`,
      sql`DELETE FROM hr_shift_templates WHERE id=${templateId} AND revision=${input.revision}`,
    ]), true, "班別已被其他人修改，請重新整理後再刪除。 ");
  } catch (error) {
    // 檢查完到真正刪除之間，有人剛好把這個班別排進去：外鍵會擋下整批，換成看得懂的訊息。
    if (error instanceof Error && /FOREIGN KEY/i.test(error.message)) throw new HrError(409, "這個班別剛被排進排班，請重新整理後再確認。 ");
    throw error;
  }
  return { id: templateId };
}

export const HR_SCHEDULE_WORKER_PAGE_SIZES = [10, 25, 50, 100] as const;
export type HrScheduleWorkerSortField = "name" | "status";
export interface HrScheduleWorkerListQuery {
  page: number;
  pageSize: number;
  search: string;
  status: "all" | "active" | "inactive";
  sortField: HrScheduleWorkerSortField;
  sortDirection: "asc" | "desc";
}

async function withWorkerCompensation(db: Database, workers: Array<typeof hrScheduleWorkers.$inferSelect>) {
  const compensation = workers.length
    ? await db.select().from(hrWorkerCompensationVersions)
      .where(inJsonArray(hrWorkerCompensationVersions.workerId, workers.map((worker) => worker.id)))
      .orderBy(desc(hrWorkerCompensationVersions.validFrom), desc(hrWorkerCompensationVersions.versionNumber))
    : [];
  return workers.map((worker) => ({ ...worker, compensation: compensation.filter((version) => version.workerId === worker.id) }));
}

/** 舊排班鏡像只保存相容欄位；讀取時以 canonical employment 的姓名、狀態與 revision 為準。 */
function canonicalWorkerRow(row: { worker: typeof hrScheduleWorkers.$inferSelect; employment: typeof hrEmployments.$inferSelect }) {
  return {
    ...row.worker,
    displayName: row.employment.legalName,
    active: row.employment.archivedAt === null ? 1 : 0,
    revision: row.employment.revision,
  };
}

export async function listHrScheduleWorkers(db: Database) {
  const rows = await db.select({ worker: hrScheduleWorkers, employment: hrEmployments })
    .from(hrScheduleWorkers).innerJoin(hrEmployments, eq(hrEmployments.id, hrScheduleWorkers.employmentId))
    .orderBy(asc(hrScheduleWorkers.active), asc(hrScheduleWorkers.displayName));
  return withWorkerCompensation(db, rows.map(canonicalWorkerRow));
}

export async function listHrScheduleWorkersPage(db: Database, query: HrScheduleWorkerListQuery) {
  const statusCondition = query.status === "all" ? undefined : query.status === "active" ? isNull(hrEmployments.archivedAt) : sql`${hrEmployments.archivedAt} IS NOT NULL`;
  const where = and(
    eq(hrEmployments.personKind, "worker"),
    statusCondition,
    query.search ? like(hrEmployments.legalName, `%${query.search}%`) : undefined,
  );
  const sortColumn = query.sortField === "name" ? hrEmployments.legalName : hrEmployments.archivedAt;
  const sortDirection = query.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
  const [joinedRows, [totalRow]] = await Promise.all([
    db.select({ worker: hrScheduleWorkers, employment: hrEmployments }).from(hrScheduleWorkers).innerJoin(hrEmployments, eq(hrEmployments.id, hrScheduleWorkers.employmentId)).where(where)
      .orderBy(sortDirection, asc(hrEmployments.legalName), asc(hrScheduleWorkers.id))
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(hrScheduleWorkers).innerJoin(hrEmployments, eq(hrEmployments.id, hrScheduleWorkers.employmentId)).where(where),
  ]);
  const total = totalRow?.value ?? 0;
  return { workers: await withWorkerCompensation(db, joinedRows.map(canonicalWorkerRow)), total, page: query.page, pageSize: query.pageSize, hasMore: query.page * query.pageSize < total };
}

export async function createHrScheduleWorker(db: Database, input: { displayName: string }, actor: HrActor) {
  const id = crypto.randomUUID();
  const name = input.displayName.trim();
  if (!name) throw new HrError(400, "請輸入支援人員姓名。 ");
  const row = activityRow({ entityType: "hr_schedule", entityId: id, source: "hr", eventType: "schedule_worker_created", summary: "支援人員已建立", actor });
  await runRawBatch(db, compileStatements([
    sql`INSERT INTO hr_employments (id, person_kind, employee_number, legal_name, position) VALUES (${id}, 'worker', 'W-' || replace(${id}, '-', ''), ${name}, '支援人員') RETURNING id`,
    sql`INSERT INTO hr_schedule_workers (id, employment_id, display_name, active, created_by) VALUES (${id}, ${id}, ${name}, 1, ${actor.id}) RETURNING id`,
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email) VALUES (${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail})`,
  ]), false);
  return { id };
}

export async function updateHrScheduleWorker(db: Database, id: string, input: { displayName: string; active: boolean; revision: number }, actor: HrActor) {
  const name = input.displayName.trim();
  if (!name) throw new HrError(400, "請輸入支援人員姓名。 ");
  const row = activityRow({ entityType: "hr_schedule", entityId: id, source: "hr", eventType: "schedule_worker_updated", summary: "支援人員已更新", actor });
  const results = await runRawBatch(db, compileStatements([
    sql`UPDATE hr_employments SET legal_name=${name}, archived_at=${input.active ? null : sql`CURRENT_TIMESTAMP`}, revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND person_kind='worker' AND revision=${input.revision} AND EXISTS (SELECT 1 FROM hr_schedule_workers WHERE id=${id} AND revision=${input.revision}) RETURNING id`,
    sql`UPDATE hr_schedule_workers SET display_name=${name}, active=${input.active ? 1 : 0}, revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND revision=${input.revision} AND changes() = 1 RETURNING id`,
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email)
      SELECT ${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail} WHERE changes() = 1`,
  ]), true);
  return { id, revision: results[0]?.results?.length ? input.revision + 1 : input.revision };
}

export type HrWorkerPayBasis = "daily" | "hourly";

export interface HrWorkerCompensationInput {
  workerId: string;
  validFrom: string;
  validTo: string | null;
  payBasis: HrWorkerPayBasis;
  baseAmountMinor: number;
  /** 兩者擇一；都留空時沿用加班申請凍結的制度倍率。 */
  overtimeRatePpm?: number | null;
  overtimeHourlyMinor?: number | null;
  note: string;
}

export async function createHrWorkerCompensation(db: Database, input: HrWorkerCompensationInput, actor: HrActor) {
  if (input.payBasis !== "daily" && input.payBasis !== "hourly") throw new HrError(400, "支援人員敘薪方式只能是日薪或時薪。 ");
  if (!LOCAL_DATE.test(input.validFrom) || (input.validTo !== null && !LOCAL_DATE.test(input.validTo)) || (input.validTo !== null && input.validTo <= input.validFrom) || !Number.isSafeInteger(input.baseAmountMinor) || input.baseAmountMinor < 0) throw new HrError(400, "支援人員敘薪資料不正確。 ");
  const overtimeRatePpm = input.overtimeRatePpm ?? null;
  const overtimeHourlyMinor = input.overtimeHourlyMinor ?? null;
  if (overtimeHourlyMinor !== null && (!Number.isSafeInteger(overtimeHourlyMinor) || overtimeHourlyMinor <= 0 || overtimeHourlyMinor % 100 !== 0)) {
    throw new HrError(400, "加班固定時薪必須是大於 0 的整數元；不適用請留空。 ");
  }
  if (overtimeRatePpm !== null && (!Number.isSafeInteger(overtimeRatePpm) || overtimeRatePpm <= 0 || overtimeRatePpm > 10_000_000)
    || overtimeRatePpm !== null && overtimeHourlyMinor !== null) {
    throw new HrError(400, "支援人員加班設定必須是固定倍率、固定金額二擇一；不適用請留空。 ");
  }
  if (input.note.length > 1000) throw new HrError(400, "支援人員敘薪備註不可超過 1000 字。 ");
  const [worker] = await db.select({ id: hrEmployments.id }).from(hrEmployments)
    .where(and(eq(hrEmployments.id, input.workerId), eq(hrEmployments.personKind, "worker"), isNull(hrEmployments.archivedAt))).limit(1);
  if (!worker) throw new HrError(404, "找不到目前有效的支援人員。 ");
  const [[latest], [latestVersionNumber]] = await Promise.all([
    db.select({ id: hrWorkerCompensationVersions.id, validFrom: hrWorkerCompensationVersions.validFrom, validTo: hrWorkerCompensationVersions.validTo, versionNumber: hrWorkerCompensationVersions.versionNumber }).from(hrWorkerCompensationVersions)
      .where(eq(hrWorkerCompensationVersions.workerId, input.workerId))
      .orderBy(desc(hrWorkerCompensationVersions.validFrom), desc(hrWorkerCompensationVersions.versionNumber)).limit(1),
    db.select({ value: sql<number>`coalesce(max(${hrWorkerCompensationVersions.versionNumber}), 0)` }).from(hrWorkerCompensationVersions).where(eq(hrWorkerCompensationVersions.workerId, input.workerId)),
  ]);
  const closePrevious = latest && latest.validTo === null && latest.validFrom < input.validFrom ? latest : undefined;
  const overlap = await db.select({ id: hrWorkerCompensationVersions.id }).from(hrWorkerCompensationVersions).where(and(
    eq(hrWorkerCompensationVersions.workerId, input.workerId),
    closePrevious ? sql`${hrWorkerCompensationVersions.id} <> ${closePrevious.id}` : undefined,
    sql`${hrWorkerCompensationVersions.validFrom} < ${input.validTo ?? "9999-12-31"} AND (${hrWorkerCompensationVersions.validTo} IS NULL OR ${hrWorkerCompensationVersions.validTo} > ${input.validFrom})`,
  )).limit(1);
  if (overlap.length) throw new HrError(409, "敘薪生效期間與既有版本重疊。 ");
  const id = crypto.randomUUID();
  const versionNumber = Number(latestVersionNumber?.value ?? 0) + 1;
  const row = activityRow({ entityType: "hr_schedule", entityId: input.workerId, source: "hr", eventType: "worker_compensation_created", summary: "支援人員敘薪已建立", actor });
  await runRawBatch(db, compileStatements([
    ...(closePrevious ? [sql`UPDATE hr_worker_compensation_versions SET valid_to=${input.validFrom} WHERE id=${closePrevious.id} AND valid_to IS NULL AND valid_from < ${input.validFrom} RETURNING id`] : []),
    sql`INSERT INTO hr_worker_compensation_versions (id, worker_id, version_number, valid_from, valid_to, pay_basis, base_amount_minor, overtime_rate_ppm, overtime_hourly_minor, note, created_by) VALUES (${id}, ${input.workerId}, ${versionNumber}, ${input.validFrom}, ${input.validTo}, ${input.payBasis}, ${input.baseAmountMinor}, ${overtimeRatePpm}, ${overtimeHourlyMinor}, ${input.note}, ${actor.id}) RETURNING id`,
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email) VALUES (${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail})`,
  ]), false);
  return { id, versionNumber };
}
