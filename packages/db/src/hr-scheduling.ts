import { and, asc, count, desc, eq, inArray, like, sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { HR_DAY_TYPE_LABELS, isHrDayType, listHrCalendarMonth } from "./hr-calendar.js";
import { HrError, type HrActor } from "./hr-people.js";
import { hrEmploymentAttendanceSettings } from "./schema/hr-attendance.js";
import { hrEmployments } from "./schema/hr-people.js";
import { hrWorkerCompensationVersions } from "./schema/hr-payroll.js";
import {
  hrScheduleEntries,
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

export interface ScheduleEntryInput {
  personKind: "employee" | "worker";
  employmentId?: string;
  workerId?: string;
  scopeId: string;
  shiftVersionId: string;
  workDate: string;
}

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

async function getOrCreateScheduleVersion(db: Database, period: { start: string; end: string }, actor: HrActor) {
  const current = await latestScheduleVersion(db, period);
  if (current) return current;
  const id = crypto.randomUUID();
  const [created] = await db.insert(hrScheduleVersions).values({
    id,
    periodStart: period.start,
    periodEnd: period.end,
    versionNumber: 1,
    status: "published",
    submittedBy: actor.id,
    approvedBy: actor.id,
    decisionReason: "直接發布",
  }).returning();
  if (!created) throw new HrError(409, "排班版本建立失敗，請重新整理。 ");
  return created;
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

async function saveEntriesAtomically(db: Database, version: { id: string; revision: number; lockedAt: string | null }, entries: Array<ScheduleEntryInput & { startsAt: string; endsAt: string; standardMinutes: number; breakMinutes: number }>, actor: HrActor) {
  const nextRevision = version.revision + 1;
  const guard = sql`EXISTS (SELECT 1 FROM hr_schedule_versions WHERE id=${version.id} AND revision=${nextRevision} AND locked_at IS NULL)`;
  const statements = [
    sql`UPDATE hr_schedule_versions SET revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${version.id} AND revision=${version.revision} AND locked_at IS NULL RETURNING id`,
    // 已封存員工的排班是歷史快照；只替換仍可編輯的活動員工，避免儲存其他人時連帶刪除歷史。
    sql`DELETE FROM hr_schedule_entries
      WHERE schedule_version_id=${version.id}
        AND EXISTS (SELECT 1 FROM hr_employments AS employment WHERE employment.id=hr_schedule_entries.employment_id AND employment.archived_at IS NULL)
        AND ${guard}`,
    sql`DELETE FROM hr_schedule_worker_entries WHERE schedule_version_id=${version.id} AND ${guard}`,
    ...entries.map((entry) => entry.personKind === "employee"
      ? sql`INSERT INTO hr_schedule_entries (id, schedule_version_id, employment_id, scope_id, shift_version_id, work_date, starts_at, ends_at, standard_minutes, break_minutes, created_by)
          SELECT ${crypto.randomUUID()}, ${version.id}, ${entry.employmentId!}, ${entry.scopeId}, ${entry.shiftVersionId}, ${entry.workDate}, ${entry.startsAt}, ${entry.endsAt}, ${entry.standardMinutes}, ${entry.breakMinutes}, ${actor.id} WHERE ${guard}`
      : sql`INSERT INTO hr_schedule_worker_entries (id, schedule_version_id, worker_id, scope_id, shift_version_id, work_date, starts_at, ends_at, standard_minutes, break_minutes, created_by)
          SELECT ${crypto.randomUUID()}, ${version.id}, ${entry.workerId!}, ${entry.scopeId}, ${entry.shiftVersionId}, ${entry.workDate}, ${entry.startsAt}, ${entry.endsAt}, ${entry.standardMinutes}, ${entry.breakMinutes}, ${actor.id} WHERE ${guard}`),
    (() => {
      const row = activityRow({ entityType: "hr_schedule", entityId: version.id, source: "hr", eventType: "schedule_saved", summary: "排班已發布", actor });
      return sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email)
        SELECT ${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail}
        WHERE ${guard}`;
    })(),
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
  }).from(hrScopeShiftAssignments)
    .innerJoin(hrShiftTemplates, eq(hrShiftTemplates.id, hrScopeShiftAssignments.shiftTemplateId))
    .innerJoin(hrShiftVersions, eq(hrShiftVersions.shiftTemplateId, hrShiftTemplates.id))
    .where(eq(hrShiftTemplates.active, 1));
  const shiftMap = new Map(latestShiftVersions(shiftRows).map((shift) => [`${shift.versionId}:${shift.scopeId}`, shift]));
  const employmentRows = await db.select({ id: hrEmployments.id, employeeName: sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})` }).from(hrEmployments)
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(sql`${hrEmployments.archivedAt} IS NULL`);
  const employmentMap = new Map(employmentRows.map((employment) => [employment.id, employment]));
  const attendanceSettings = await db.select({ employmentId: hrEmploymentAttendanceSettings.employmentId, attendanceMode: hrEmploymentAttendanceSettings.attendanceMode, monthlyRestDays: hrEmploymentAttendanceSettings.monthlyRestDays }).from(hrEmploymentAttendanceSettings);
  const attendanceSettingMap = new Map(attendanceSettings.map((setting) => [setting.employmentId, setting]));
  const workers = await db.select({ id: hrScheduleWorkers.id, active: hrScheduleWorkers.active }).from(hrScheduleWorkers);
  const workerMap = new Map(workers.map((worker) => [worker.id, worker]));
  const enriched: Array<ScheduleEntryInput & { startsAt: string; endsAt: string; standardMinutes: number; breakMinutes: number }> = [];
  const occupied = new Map<string, Array<{ start: number; end: number }>>();
  for (const entry of entries) {
    if (!datePeriodContains(entry.workDate, period)) throw new HrError(400, "排班日期必須位於指定月份。 ");
    if (!scopeIds.has(entry.scopeId)) throw new HrError(404, "找不到有效的營運據點。 ");
    const shift = shiftMap.get(`${entry.shiftVersionId}:${entry.scopeId}`);
    if (!shift || shift.scopeId !== entry.scopeId) throw new HrError(400, "班別未設定在這個營運據點。 ");
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
    const interval = { start: dateToDayNumber(entry.workDate) * DAY_SECONDS + shift.startSecond, end: dateToDayNumber(entry.workDate) * DAY_SECONDS + shift.endDayOffset * DAY_SECONDS + shift.endSecond };
    const personIntervals = occupied.get(personId) ?? [];
    if (personIntervals.some((current) => interval.start < current.end && current.start < interval.end)) throw new HrError(409, "同一人員的排班時段重疊。 ");
    personIntervals.push(interval);
    occupied.set(personId, personIntervals);
    enriched.push({ ...entry, startsAt, endsAt, standardMinutes: shift.standardMinutes, breakMinutes: shift.breakMinutes });
  }
  const workDatesByEmployment = new Map<string, Set<string>>();
  for (const entry of enriched) if (entry.personKind === "employee" && entry.employmentId) {
    const dates = workDatesByEmployment.get(entry.employmentId) ?? new Set<string>();
    dates.add(entry.workDate);
    workDatesByEmployment.set(entry.employmentId, dates);
  }
  for (const employment of employmentRows) {
    const setting = attendanceSettingMap.get(employment.id);
    if (setting?.attendanceMode !== "scheduled" || setting.monthlyRestDays === null) continue;
    const activeStart = period.start;
    const activeEnd = period.end;
    let activeDays = 0;
    for (let day = activeStart; day < activeEnd; day = addDays(day, 1)) activeDays += 1;
    const expectedRestDays = Math.min(setting.monthlyRestDays, activeDays);
    const scheduledDays = workDatesByEmployment.get(employment.id)?.size ?? 0;
    if (activeDays - scheduledDays !== expectedRestDays) throw new HrError(400, `排班人員 ${employment.employeeName} 本月應休 ${setting.monthlyRestDays} 天，目前排班無法符合月休設定。 `);
  }
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
      dayType: sql<HrDayType>`${hrShiftVersions.dayType}`.as("schedule_shift_day_type"),
      versionNumber: sql<number>`${hrShiftVersions.versionNumber}`.as("schedule_shift_version_number"),
      startSecond: hrShiftVersions.startSecond,
      endSecond: hrShiftVersions.endSecond,
      endDayOffset: hrShiftVersions.endDayOffset,
      standardMinutes: hrShiftVersions.standardMinutes,
      breakMinutes: hrShiftVersions.breakMinutes,
    }).from(hrScopeShiftAssignments)
      .innerJoin(hrShiftTemplates, eq(hrShiftTemplates.id, hrScopeShiftAssignments.shiftTemplateId))
      .innerJoin(hrShiftVersions, eq(hrShiftVersions.shiftTemplateId, hrShiftTemplates.id))
      .where(eq(hrShiftTemplates.active, 1))
      .orderBy(asc(hrShiftTemplates.name), asc(hrShiftVersions.startSecond));
}

/** 班別管理頁：店與每家店目前生效的班別。 */
export async function listHrShifts(db: Database) {
  const [scopeRows, shiftRows] = await Promise.all([listHrScheduleScopes(db), listHrScopeShiftRows(db)]);
  return { scopes: scopeRows, shifts: latestShiftVersions(shiftRows).map(({ versionNumber: _versionNumber, code: _code, ...shift }) => shift) };
}

export async function getHrSchedule(db: Database, periodKey: string, scopeId?: string) {
  const period = monthPeriodFromKey(periodKey);
  const version = await latestScheduleVersion(db, period);
  const [scopeRows, workerRows, shiftRows, calendar] = await Promise.all([
    listHrScheduleScopes(db),
    db.select({ id: hrScheduleWorkers.id, name: hrScheduleWorkers.displayName, active: hrScheduleWorkers.active }).from(hrScheduleWorkers).where(eq(hrScheduleWorkers.active, 1)).orderBy(asc(hrScheduleWorkers.displayName)),
    listHrScopeShiftRows(db),
    listHrCalendarMonth(db, period),
  ]);
  const selectedScopeId = scopeId && scopeId !== "all" ? scopeId : undefined;
  const [employeeEntries, workerEntries] = version ? await Promise.all([
    db.select({ entry: hrScheduleEntries, employeeNumber: hrEmployments.employeeNumber, employeeName: sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`, archivedAt: hrEmployments.archivedAt, scopeName: scopes.name, shiftName: hrShiftTemplates.name }).from(hrScheduleEntries)
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrScheduleEntries.employmentId))
      .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
      .innerJoin(scopes, eq(scopes.id, hrScheduleEntries.scopeId))
      .innerJoin(hrShiftVersions, eq(hrShiftVersions.id, hrScheduleEntries.shiftVersionId))
      .innerJoin(hrShiftTemplates, eq(hrShiftTemplates.id, hrShiftVersions.shiftTemplateId))
      .where(and(eq(hrScheduleEntries.scheduleVersionId, version.id), selectedScopeId ? eq(hrScheduleEntries.scopeId, selectedScopeId) : undefined)),
    db.select({ entry: hrScheduleWorkerEntries, workerName: hrScheduleWorkers.displayName, scopeName: scopes.name, shiftName: hrShiftTemplates.name }).from(hrScheduleWorkerEntries)
      .innerJoin(hrScheduleWorkers, eq(hrScheduleWorkers.id, hrScheduleWorkerEntries.workerId))
      .innerJoin(scopes, eq(scopes.id, hrScheduleWorkerEntries.scopeId))
      .innerJoin(hrShiftVersions, eq(hrShiftVersions.id, hrScheduleWorkerEntries.shiftVersionId))
      .innerJoin(hrShiftTemplates, eq(hrShiftTemplates.id, hrShiftVersions.shiftTemplateId))
      .where(and(eq(hrScheduleWorkerEntries.scheduleVersionId, version.id), selectedScopeId ? eq(hrScheduleWorkerEntries.scopeId, selectedScopeId) : undefined)),
  ]) : [[], []];
  const employees = await db.select({ employmentId: hrEmployments.id, userId: hrEmployments.employeeUserId, employeeNumber: hrEmployments.employeeNumber, name: sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`, attendanceMode: hrEmploymentAttendanceSettings.attendanceMode, monthlyRestDays: hrEmploymentAttendanceSettings.monthlyRestDays }).from(hrEmployments)
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .leftJoin(hrEmploymentAttendanceSettings, eq(hrEmploymentAttendanceSettings.employmentId, hrEmployments.id))
    .where(sql`${hrEmployments.archivedAt} IS NULL`)
    .orderBy(asc(hrEmployments.employeeNumber));
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
      ...employeeEntries.map(({ entry, employeeNumber, employeeName, archivedAt, scopeName, shiftName }) => ({ ...entry, personKind: "employee" as const, employeeNumber, personName: employeeName, archivedAt, scopeName, shiftName })),
      ...workerEntries.map(({ entry, workerName, scopeName, shiftName }) => ({ ...entry, personKind: "worker" as const, employeeNumber: null, personName: workerName, archivedAt: null, scopeName, shiftName })),
    ],
  };
}

export async function saveHrSchedule(db: Database, input: SaveHrScheduleInput, actor: HrActor) {
  const period = monthPeriodFromKey(input.periodKey);
  const entries = await validateAndEnrichEntries(db, period, input.entries);
  let version = input.scheduleVersionId ? (await db.select().from(hrScheduleVersions).where(eq(hrScheduleVersions.id, input.scheduleVersionId)).limit(1))[0] : await getOrCreateScheduleVersion(db, period, actor);
  if (!version || version.periodStart !== period.start || version.periodEnd !== period.end || version.status !== "published") throw new HrError(404, "找不到指定月份的排班版本。 ");
  if (input.revision !== undefined && input.revision !== version.revision) throw new HrError(409, "排班已被其他人修改，請重新整理。 ");
  return saveEntriesAtomically(db, version, entries, actor);
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
}

export interface HrShiftInput {
  scopeId: string;
  name: string;
  times: HrShiftTime[];
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

function insertShiftVersion(versionId: string, templateId: string, time: HrShiftTime, versionNumber: number, actorId: string) {
  return sql`INSERT INTO hr_shift_versions (id, shift_template_id, day_type, version_number, start_second, end_second, end_day_offset, standard_minutes, break_minutes, pay_factor_ppm, created_by)
    VALUES (${versionId}, ${templateId}, ${time.dayType}, ${versionNumber}, ${time.startSecond}, ${time.endSecond}, 0, ${time.standardMinutes}, ${time.breakMinutes}, 1000000, ${actorId})`;
}

export async function createHrShift(db: Database, input: HrShiftInput, actor: HrActor) {
  assertShiftTimes(input.times);
  const [scope] = await db.select({ id: scopes.id }).from(scopes).where(and(eq(scopes.id, input.scopeId), eq(scopes.scopeKind, "store"), eq(scopes.active, 1))).limit(1);
  if (!scope) throw new HrError(404, "找不到有效的營運據點。 ");
  const templateId = crypto.randomUUID();
  const versionIds = new Map(input.times.map((time) => [time.dayType, crypto.randomUUID()]));
  const assignmentId = `${input.scopeId}:${templateId}`;
  const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
  const row = activityRow({ entityType: "hr_schedule", entityId: templateId, source: "hr", eventType: "shift_created", summary: "班別已建立", actor, payload: { name: input.name.trim(), dayTypes: input.times.map((time) => time.dayType) } });
  const statements = [
    sql`INSERT INTO hr_shift_templates (id, code, name, active, created_by) VALUES (${templateId}, ${templateId}, ${input.name.trim()}, 1, ${actor.id}) RETURNING id`,
    ...input.times.map((time) => insertShiftVersion(versionIds.get(time.dayType)!, templateId, time, 1, actor.id)),
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
  const existing = await db.select({ id: hrShiftVersions.id, dayType: hrShiftVersions.dayType, versionNumber: hrShiftVersions.versionNumber })
    .from(hrShiftVersions).where(eq(hrShiftVersions.shiftTemplateId, templateId)).orderBy(desc(hrShiftVersions.versionNumber));
  if (!existing.length) throw new HrError(404, "找不到班別的時間設定。 ");
  const latestByDayType = new Map<HrDayType, { id: string; versionNumber: number }>();
  for (const version of existing) if (!latestByDayType.has(version.dayType)) latestByDayType.set(version.dayType, version);
  const wanted = new Set(input.times.map((time) => time.dayType));
  const removed = [...latestByDayType.entries()].filter(([dayType]) => !wanted.has(dayType));
  const row = activityRow({ entityType: "hr_schedule", entityId: templateId, source: "hr", eventType: "shift_updated", summary: "班別已修改", actor, payload: { scopeId: input.scopeId, name: input.name.trim(), times: input.times } });
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
    sql`UPDATE hr_shift_templates SET name=${input.name.trim()}, revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${templateId} AND revision=${input.revision} RETURNING id`,
    ...input.times.map((time) => {
      const current = latestByDayType.get(time.dayType);
      return current
        ? sql`UPDATE hr_shift_versions SET start_second=${time.startSecond}, end_second=${time.endSecond}, end_day_offset=0, standard_minutes=${time.standardMinutes}, break_minutes=${time.breakMinutes} WHERE id=${current.id} AND changes() = 1`
        : sql`INSERT INTO hr_shift_versions (id, shift_template_id, day_type, version_number, start_second, end_second, end_day_offset, standard_minutes, break_minutes, pay_factor_ppm, created_by)
            SELECT ${crypto.randomUUID()}, ${templateId}, ${time.dayType}, 1, ${time.startSecond}, ${time.endSecond}, 0, ${time.standardMinutes}, ${time.breakMinutes}, 1000000, ${actor.id} WHERE changes() = 1`;
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
const SCHEDULE_WORKER_SORT_COLUMNS = { name: hrScheduleWorkers.displayName, status: hrScheduleWorkers.active } as const;
export type HrScheduleWorkerSortField = keyof typeof SCHEDULE_WORKER_SORT_COLUMNS;
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
      .where(inArray(hrWorkerCompensationVersions.workerId, workers.map((worker) => worker.id)))
      .orderBy(desc(hrWorkerCompensationVersions.validFrom), desc(hrWorkerCompensationVersions.versionNumber))
    : [];
  return workers.map((worker) => ({ ...worker, compensation: compensation.filter((version) => version.workerId === worker.id) }));
}

export async function listHrScheduleWorkers(db: Database) {
  const workers = await db.select().from(hrScheduleWorkers).orderBy(asc(hrScheduleWorkers.active), asc(hrScheduleWorkers.displayName));
  return withWorkerCompensation(db, workers);
}

export async function listHrScheduleWorkersPage(db: Database, query: HrScheduleWorkerListQuery) {
  const where = and(
    query.status === "all" ? undefined : eq(hrScheduleWorkers.active, query.status === "active" ? 1 : 0),
    query.search ? like(hrScheduleWorkers.displayName, `%${query.search}%`) : undefined,
  );
  const sortColumn = SCHEDULE_WORKER_SORT_COLUMNS[query.sortField];
  const orderColumn = query.sortDirection === "asc" ? asc(sortColumn) : desc(sortColumn);
  const [rows, [totalRow]] = await Promise.all([
    db.select().from(hrScheduleWorkers).where(where)
      .orderBy(orderColumn, asc(hrScheduleWorkers.displayName), asc(hrScheduleWorkers.id))
      .limit(query.pageSize).offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(hrScheduleWorkers).where(where),
  ]);
  const total = totalRow?.value ?? 0;
  return { workers: await withWorkerCompensation(db, rows), total, page: query.page, pageSize: query.pageSize, hasMore: query.page * query.pageSize < total };
}

export async function createHrScheduleWorker(db: Database, input: { displayName: string }, actor: HrActor) {
  const id = crypto.randomUUID();
  const name = input.displayName.trim();
  if (!name) throw new HrError(400, "請輸入支援人員姓名。 ");
  const row = activityRow({ entityType: "hr_schedule", entityId: id, source: "hr", eventType: "schedule_worker_created", summary: "支援人員已建立", actor });
  await runRawBatch(db, compileStatements([
    sql`INSERT INTO hr_schedule_workers (id, display_name, active, created_by) VALUES (${id}, ${name}, 1, ${actor.id}) RETURNING id`,
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email) VALUES (${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail})`,
  ]), false);
  return { id };
}

export async function updateHrScheduleWorker(db: Database, id: string, input: { displayName: string; active: boolean; revision: number }, actor: HrActor) {
  const name = input.displayName.trim();
  if (!name) throw new HrError(400, "請輸入支援人員姓名。 ");
  const row = activityRow({ entityType: "hr_schedule", entityId: id, source: "hr", eventType: "schedule_worker_updated", summary: "支援人員已更新", actor });
  const results = await runRawBatch(db, compileStatements([
    sql`UPDATE hr_schedule_workers SET display_name=${name}, active=${input.active ? 1 : 0}, revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND revision=${input.revision} RETURNING id`,
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email)
      SELECT ${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail} WHERE changes() = 1`,
  ]), true);
  return { id, revision: results[0]?.results?.length ? input.revision + 1 : input.revision };
}

export async function createHrWorkerCompensation(db: Database, input: { workerId: string; validFrom: string; validTo: string | null; payBasis: "monthly" | "daily" | "hourly"; baseAmountMinor: number; note: string }, actor: HrActor) {
  if (!LOCAL_DATE.test(input.validFrom) || (input.validTo !== null && !LOCAL_DATE.test(input.validTo)) || (input.validTo !== null && input.validTo <= input.validFrom) || !Number.isSafeInteger(input.baseAmountMinor) || input.baseAmountMinor < 0) throw new HrError(400, "支援人員敘薪資料不正確。 ");
  const [worker] = await db.select({ id: hrScheduleWorkers.id }).from(hrScheduleWorkers).where(eq(hrScheduleWorkers.id, input.workerId)).limit(1);
  if (!worker) throw new HrError(404, "找不到支援人員。 ");
  const overlap = await db.select({ id: hrWorkerCompensationVersions.id }).from(hrWorkerCompensationVersions).where(and(eq(hrWorkerCompensationVersions.workerId, input.workerId), sql`${hrWorkerCompensationVersions.validFrom} < ${input.validTo ?? "9999-12-31"} AND (${hrWorkerCompensationVersions.validTo} IS NULL OR ${hrWorkerCompensationVersions.validTo} > ${input.validFrom})`)).limit(1);
  if (overlap.length) throw new HrError(409, "敘薪生效期間與既有版本重疊。 ");
  const [latest] = await db.select({ value: sql<number>`coalesce(max(${hrWorkerCompensationVersions.versionNumber}), 0)` }).from(hrWorkerCompensationVersions).where(eq(hrWorkerCompensationVersions.workerId, input.workerId));
  const id = crypto.randomUUID();
  const versionNumber = Number(latest?.value ?? 0) + 1;
  const row = activityRow({ entityType: "hr_schedule", entityId: input.workerId, source: "hr", eventType: "worker_compensation_created", summary: "支援人員敘薪已建立", actor });
  await runRawBatch(db, compileStatements([
    sql`INSERT INTO hr_worker_compensation_versions (id, worker_id, version_number, valid_from, valid_to, pay_basis, base_amount_minor, note, created_by) VALUES (${id}, ${input.workerId}, ${versionNumber}, ${input.validFrom}, ${input.validTo}, ${input.payBasis}, ${input.baseAmountMinor}, ${input.note}, ${actor.id}) RETURNING id`,
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email) VALUES (${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail})`,
  ]), false);
  return { id, versionNumber };
}
