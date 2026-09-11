import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { HrError, type HrActor } from "./hr-people.js";
import { hrAttendanceLocations } from "./schema/hr-attendance.js";
import { hrEmployments, hrEmployees } from "./schema/hr-people.js";
import { hrWorkerCompensationVersions } from "./schema/hr-payroll.js";
import {
  hrScheduleEntries,
  hrScheduleVersions,
  hrScheduleWorkerEntries,
  hrScheduleWorkers,
  hrScopeShiftAssignments,
  hrShiftTemplates,
  hrShiftVersions,
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

function periodFromKey(periodKey: string) {
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

function latestShiftVersions<T extends { templateId: string; versionNumber: number }>(rows: T[]) {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const current = latest.get(row.templateId);
    if (!current || row.versionNumber > current.versionNumber) latest.set(row.templateId, row);
  }
  return rows.filter((row) => latest.get(row.templateId) === row);
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

async function runRawBatch(db: Database, statements: Array<{ sql: string; params: unknown[] }>, expectedUpdate: boolean) {
  const prepared = statements.map((compiled) => db.$client.prepare(compiled.sql).bind(...compiled.params));
  const results = await db.$client.batch(prepared);
  if (expectedUpdate && !results[0]?.results?.length) throw new HrError(409, "排班已被其他人修改或目前已鎖定，請重新整理。 ");
  return results;
}

function compileStatements(statements: SQL[]) {
  const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
  return statements.map((statement) => dialect.sqlToQuery(statement));
}

async function saveEntriesAtomically(db: Database, version: { id: string; revision: number; lockedAt: string | null }, entries: Array<ScheduleEntryInput & { startsAt: string; endsAt: string }>, actor: HrActor) {
  const nextRevision = version.revision + 1;
  const guard = sql`EXISTS (SELECT 1 FROM hr_schedule_versions WHERE id=${version.id} AND revision=${nextRevision} AND locked_at IS NULL)`;
  const statements = [
    sql`UPDATE hr_schedule_versions SET revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=${version.id} AND revision=${version.revision} AND locked_at IS NULL RETURNING id`,
    sql`DELETE FROM hr_schedule_entries WHERE schedule_version_id=${version.id} AND ${guard}`,
    sql`DELETE FROM hr_schedule_worker_entries WHERE schedule_version_id=${version.id} AND ${guard}`,
    ...entries.map((entry) => entry.personKind === "employee"
      ? sql`INSERT INTO hr_schedule_entries (id, schedule_version_id, employment_id, scope_id, shift_version_id, work_date, starts_at, ends_at, created_by)
          SELECT ${crypto.randomUUID()}, ${version.id}, ${entry.employmentId!}, ${entry.scopeId}, ${entry.shiftVersionId}, ${entry.workDate}, ${entry.startsAt}, ${entry.endsAt}, ${actor.id} WHERE ${guard}`
      : sql`INSERT INTO hr_schedule_worker_entries (id, schedule_version_id, worker_id, scope_id, shift_version_id, work_date, starts_at, ends_at, created_by)
          SELECT ${crypto.randomUUID()}, ${version.id}, ${entry.workerId!}, ${entry.scopeId}, ${entry.shiftVersionId}, ${entry.workDate}, ${entry.startsAt}, ${entry.endsAt}, ${actor.id} WHERE ${guard}`),
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
    versionNumber: sql<number>`${hrShiftVersions.versionNumber}`.as("schedule_shift_version_number"),
    startSecond: hrShiftVersions.startSecond,
    endSecond: hrShiftVersions.endSecond,
    endDayOffset: hrShiftVersions.endDayOffset,
  }).from(hrScopeShiftAssignments)
    .innerJoin(hrShiftTemplates, eq(hrShiftTemplates.id, hrScopeShiftAssignments.shiftTemplateId))
    .innerJoin(hrShiftVersions, eq(hrShiftVersions.shiftTemplateId, hrShiftTemplates.id))
    .where(eq(hrShiftTemplates.active, 1));
  const shiftMap = new Map(latestShiftVersions(shiftRows).map((shift) => [shift.versionId, shift]));
  const employmentRows = await db.select({ id: hrEmployments.id, hiredOn: hrEmployments.hiredOn, endedOn: hrEmployments.endedOn }).from(hrEmployments);
  const employmentMap = new Map(employmentRows.map((employment) => [employment.id, employment]));
  const workers = await db.select({ id: hrScheduleWorkers.id, active: hrScheduleWorkers.active }).from(hrScheduleWorkers);
  const workerMap = new Map(workers.map((worker) => [worker.id, worker]));
  const enriched: Array<ScheduleEntryInput & { startsAt: string; endsAt: string }> = [];
  const occupied = new Map<string, Array<{ start: number; end: number }>>();
  for (const entry of entries) {
    if (!datePeriodContains(entry.workDate, period)) throw new HrError(400, "排班日期必須位於指定月份。 ");
    if (!scopeIds.has(entry.scopeId)) throw new HrError(404, "找不到有效的營運據點。 ");
    const shift = shiftMap.get(entry.shiftVersionId);
    if (!shift || shift.scopeId !== entry.scopeId) throw new HrError(400, "班別未設定在這個營運據點。 ");
    if (entry.personKind === "employee") {
      const employment = entry.employmentId ? employmentMap.get(entry.employmentId) : undefined;
      if (!employment || employment.hiredOn > entry.workDate || (employment.endedOn !== null && employment.endedOn <= entry.workDate)) throw new HrError(400, "排班人員沒有涵蓋該日期的有效任職。 ");
    } else {
      const worker = entry.workerId ? workerMap.get(entry.workerId) : undefined;
      if (!worker || !worker.active) throw new HrError(400, "臨時支援人員不存在或已停用。 ");
    }
    const startsAt = wallTime(entry.workDate, shift.startSecond);
    const endsAt = wallTime(addDays(entry.workDate, shift.endDayOffset), shift.endSecond);
    const personId = entry.personKind === "employee" ? `employee:${entry.employmentId}` : `worker:${entry.workerId}`;
    const interval = { start: dateToDayNumber(entry.workDate) * DAY_SECONDS + shift.startSecond, end: dateToDayNumber(entry.workDate) * DAY_SECONDS + shift.endDayOffset * DAY_SECONDS + shift.endSecond };
    const personIntervals = occupied.get(personId) ?? [];
    if (personIntervals.some((current) => interval.start < current.end && current.start < interval.end)) throw new HrError(409, "同一人員的排班時段重疊。 ");
    personIntervals.push(interval);
    occupied.set(personId, personIntervals);
    enriched.push({ ...entry, startsAt, endsAt });
  }
  return enriched;
}

export async function getHrSchedule(db: Database, periodKey: string, scopeId?: string) {
  const period = periodFromKey(periodKey);
  const version = await latestScheduleVersion(db, period);
  const [scopeRows, workerRows, shiftRows] = await Promise.all([
    db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(and(eq(scopes.scopeKind, "store"), eq(scopes.active, 1))).orderBy(asc(scopes.sortOrder), asc(scopes.name)),
    db.select({ id: hrScheduleWorkers.id, name: hrScheduleWorkers.displayName, active: hrScheduleWorkers.active }).from(hrScheduleWorkers).where(eq(hrScheduleWorkers.active, 1)).orderBy(asc(hrScheduleWorkers.displayName)),
    db.select({
      versionId: sql<string>`${hrShiftVersions.id}`.as("schedule_shift_version_id"),
      templateId: sql<string>`${hrShiftTemplates.id}`.as("schedule_shift_template_id"),
      scopeId: sql<string>`${hrScopeShiftAssignments.scopeId}`.as("schedule_shift_scope_id"),
      code: sql<string>`${hrShiftTemplates.code}`.as("schedule_shift_code"),
      name: sql<string>`${hrShiftTemplates.name}`.as("schedule_shift_name"),
      versionNumber: sql<number>`${hrShiftVersions.versionNumber}`.as("schedule_shift_version_number"),
      startSecond: hrShiftVersions.startSecond,
      endSecond: hrShiftVersions.endSecond,
      endDayOffset: hrShiftVersions.endDayOffset,
    }).from(hrScopeShiftAssignments)
      .innerJoin(hrShiftTemplates, eq(hrShiftTemplates.id, hrScopeShiftAssignments.shiftTemplateId))
      .innerJoin(hrShiftVersions, eq(hrShiftVersions.shiftTemplateId, hrShiftTemplates.id))
      .where(eq(hrShiftTemplates.active, 1))
      .orderBy(asc(hrShiftTemplates.name), asc(hrShiftVersions.startSecond)), 
  ]);
  const selectedScopeId = scopeId && scopeId !== "all" ? scopeId : undefined;
  const [employeeEntries, workerEntries] = version ? await Promise.all([
    db.select({ entry: hrScheduleEntries, employeeNumber: hrEmployees.employeeNumber, employeeName: sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`, scopeName: scopes.name, shiftName: hrShiftTemplates.name }).from(hrScheduleEntries)
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrScheduleEntries.employmentId))
      .innerJoin(hrEmployees, eq(hrEmployees.userId, hrEmployments.employeeUserId))
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
  const employees = await db.select({ employmentId: hrEmployments.id, userId: hrEmployments.employeeUserId, employeeNumber: hrEmployees.employeeNumber, name: sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})` }).from(hrEmployments)
    .innerJoin(hrEmployees, eq(hrEmployees.userId, hrEmployments.employeeUserId))
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(sql`${hrEmployments.endedOn} IS NULL OR ${hrEmployments.endedOn} >= ${period.start}`)
    .orderBy(asc(hrEmployees.employeeNumber));
  return {
    periodKey,
    period,
    version: version ? { id: version.id, revision: version.revision, status: "published" as const, locked: version.lockedAt !== null, lockedAt: version.lockedAt } : null,
    scopes: scopeRows,
    shifts: (selectedScopeId ? latestShiftVersions(shiftRows).filter((shift) => shift.scopeId === selectedScopeId) : latestShiftVersions(shiftRows)).map(({ versionNumber: _versionNumber, ...shift }) => shift),
    employees,
    workers: workerRows,
    entries: [
      ...employeeEntries.map(({ entry, employeeNumber, employeeName, scopeName, shiftName }) => ({ ...entry, personKind: "employee" as const, employeeNumber, personName: employeeName, scopeName, shiftName })),
      ...workerEntries.map(({ entry, workerName, scopeName, shiftName }) => ({ ...entry, personKind: "worker" as const, employeeNumber: null, personName: workerName, scopeName, shiftName })),
    ],
  };
}

export async function saveHrSchedule(db: Database, input: SaveHrScheduleInput, actor: HrActor) {
  const period = periodFromKey(input.periodKey);
  const entries = await validateAndEnrichEntries(db, period, input.entries);
  let version = input.scheduleVersionId ? (await db.select().from(hrScheduleVersions).where(eq(hrScheduleVersions.id, input.scheduleVersionId)).limit(1))[0] : await getOrCreateScheduleVersion(db, period, actor);
  if (!version || version.periodStart !== period.start || version.periodEnd !== period.end || version.status !== "published") throw new HrError(404, "找不到指定月份的排班版本。 ");
  if (input.revision !== undefined && input.revision !== version.revision) throw new HrError(409, "排班已被其他人修改，請重新整理。 ");
  return saveEntriesAtomically(db, version, entries, actor);
}

export async function setHrScheduleLock(db: Database, periodKey: string, input: { revision: number; locked: boolean }, actor: HrActor) {
  const period = periodFromKey(periodKey);
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

export interface HrShiftInput {
  scopeId: string;
  code: string;
  name: string;
  startSecond: number;
  endSecond: number;
  endDayOffset: 0 | 1;
}

export async function createHrShift(db: Database, input: HrShiftInput, actor: HrActor) {
  if (!Number.isInteger(input.startSecond) || input.startSecond < 0 || input.startSecond > 86_399 || !Number.isInteger(input.endSecond) || input.endSecond < 0 || input.endSecond > 86_399 || (input.endDayOffset === 0 && input.endSecond <= input.startSecond)) throw new HrError(400, "班別時間不正確。 ");
  const [scope] = await db.select({ id: scopes.id }).from(scopes).where(and(eq(scopes.id, input.scopeId), eq(scopes.scopeKind, "store"), eq(scopes.active, 1))).limit(1);
  if (!scope) throw new HrError(404, "找不到有效的營運據點。 ");
  const templateId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const assignmentId = `${input.scopeId}:${templateId}`;
  const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
  const row = activityRow({ entityType: "hr_schedule", entityId: templateId, source: "hr", eventType: "shift_created", summary: "班別已建立", actor });
  const statements = [
    sql`INSERT INTO hr_shift_templates (id, code, name, active, created_by) VALUES (${templateId}, ${input.code.trim()}, ${input.name.trim()}, 1, ${actor.id}) RETURNING id`,
    sql`INSERT INTO hr_shift_versions (id, shift_template_id, version_number, start_second, end_second, end_day_offset, pay_factor_ppm, created_by) VALUES (${versionId}, ${templateId}, 1, ${input.startSecond}, ${input.endSecond}, ${input.endDayOffset}, 1000000, ${actor.id}) RETURNING id`,
    sql`INSERT INTO hr_scope_shift_assignments (scope_id, shift_template_id, is_default, created_by) VALUES (${input.scopeId}, ${templateId}, 0, ${actor.id}) RETURNING scope_id AS id`,
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email) VALUES (${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail})`,
  ].map((statement) => dialect.sqlToQuery(statement));
  await runRawBatch(db, statements, false);
  return { id: templateId, versionId, assignmentId };
}

export async function listHrScheduleWorkers(db: Database) {
  const workers = await db.select().from(hrScheduleWorkers).orderBy(asc(hrScheduleWorkers.active), asc(hrScheduleWorkers.displayName));
  const compensation = await db.select().from(hrWorkerCompensationVersions).orderBy(desc(hrWorkerCompensationVersions.validFrom), desc(hrWorkerCompensationVersions.versionNumber));
  return workers.map((worker) => ({ ...worker, compensation: compensation.filter((version) => version.workerId === worker.id) }));
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

export async function listHrAttendanceLocationsForSchedule(db: Database) {
  return db.select({ id: hrAttendanceLocations.id, name: hrAttendanceLocations.name, scopeId: hrAttendanceLocations.scopeId, scopeName: scopes.name }).from(hrAttendanceLocations)
    .leftJoin(scopes, eq(scopes.id, hrAttendanceLocations.scopeId)).orderBy(asc(hrAttendanceLocations.name));
}
