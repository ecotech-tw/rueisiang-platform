import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, writeHrMutation, type HrActor } from "./hr-people.js";
import { hrLeaveTypes, hrMonthlyHourlyEntries, hrMonthlyLeaveEntries } from "./schema/hr-payroll.js";
import { hrEmployees, hrEmployments } from "./schema/hr-people.js";
import { hrPayrollPeriods, hrPayrollRuns, hrPayslips } from "./schema/hr-payroll-runs.js";
import { users } from "./schema/auth.js";

const PPM = 1_000_000;
const displayName = sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`;

export interface MonthlyLeaveInput {
  employmentId: string;
  leaveTypeId: string;
  leaveDate: string;
  hoursHalfUnits: number;
  payRatePpm: number;
  deductionAmount: number;
  note?: string;
}
export interface MonthlyHourlyInput {
  employmentId: string;
  workDate: string;
  hoursHalfUnits: number;
  noWork?: boolean;
  note?: string;
}

function period(periodKey: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)) throw new HrError(400, "月份必須是 YYYY-MM。 ");
  const [year, month] = periodKey.split("-").map(Number);
  const next = new Date(Date.UTC(year!, month!, 1));
  return { start: `${periodKey}-01`, end: `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01` };
}

function isDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateHalfUnits(value: number, label: string, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 48) throw new HrError(400, `${label}必須是 0.5 小時的正確倍數。`);
}

function validateMoneyYuan(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new HrError(400, `${label}必須是非負整數元。`);
}

async function ensureOpenPeriod(db: Database, date: string, employmentId?: string) {
  const periodKey = date.slice(0, 7);
  const [row] = await db.select({ status: hrPayrollPeriods.status }).from(hrPayrollPeriods).where(eq(hrPayrollPeriods.periodKey, periodKey)).limit(1);
  if (row?.status === "closed") throw new HrError(409, "該月份已結帳，不能直接修改月度資料，請使用薪資調整。 ");
  if (employmentId) {
    const [closed] = await db.select({ id: hrPayslips.id }).from(hrPayslips)
      .innerJoin(hrPayrollRuns, eq(hrPayrollRuns.id, hrPayslips.payrollRunId)).innerJoin(hrPayrollPeriods, eq(hrPayrollPeriods.id, hrPayrollRuns.payrollPeriodId))
      .where(and(eq(hrPayslips.employmentId, employmentId), eq(hrPayrollPeriods.periodKey, periodKey), eq(hrPayrollRuns.status, "closed"))).limit(1);
    if (closed) throw new HrError(409, "該員工本月份已結帳，不能直接修改月度資料，請使用薪資調整。 ");
  }
}

async function ensureEmploymentOnDate(db: Database, employmentId: string, date: string) {
  const [row] = await db.select({ id: hrEmployments.id }).from(hrEmployments)
    .where(and(eq(hrEmployments.id, employmentId), sql`${hrEmployments.hiredOn} <= ${date}`, sql`(${hrEmployments.endedOn} IS NULL OR ${hrEmployments.endedOn} > ${date})`)).limit(1);
  if (!row) throw new HrError(404, "找不到該日期有效的任職紀錄。 ");
}

function validateDateInPeriod(date: string, periodKey: string, label: string) {
  const range = period(periodKey);
  if (!isDateOnly(date) || date < range.start || date >= range.end) throw new HrError(400, `${label}必須位於 ${periodKey} 月份。 `);
  return range;
}

export async function listHrLeaveTypes(db: Database, includeInactive = false) {
  return db.select().from(hrLeaveTypes).where(includeInactive ? undefined : eq(hrLeaveTypes.active, 1)).orderBy(asc(hrLeaveTypes.name));
}

export async function createHrLeaveType(db: Database, input: { name: string; defaultPayRatePpm: number }, actor: HrActor) {
  if (!input.name.trim() || input.name.trim().length > 80) throw new HrError(400, "假別名稱必須是 1～80 字。 ");
  if (!Number.isSafeInteger(input.defaultPayRatePpm) || input.defaultPayRatePpm < 0 || input.defaultPayRatePpm > PPM) throw new HrError(400, "預設給薪比例必須介於 0～100%。 ");
  const id = crypto.randomUUID();
  return writeHrMutation(db, sql`INSERT INTO hr_leave_types (id, name, default_pay_rate_ppm, active, created_by)
    VALUES (${id}, ${input.name.trim()}, ${input.defaultPayRatePpm}, 1, ${actor.id}) RETURNING id`, id, actor, "monthly_leave_type_created", "假別名稱已存在或資料不合法。 ");
}

const leaveListFields = {
  entry: hrMonthlyLeaveEntries,
  leaveTypeName: hrLeaveTypes.name,
  employeeUserId: hrEmployments.employeeUserId,
  employeeNumber: hrEmployees.employeeNumber,
  employeeName: displayName,
};

export async function listHrMonthlyData(db: Database, periodKey: string, employeeUserId?: string) {
  const range = period(periodKey);
  const employeeFilter = employeeUserId ? eq(hrEmployments.employeeUserId, employeeUserId) : undefined;
  const [leaves, hourly] = await Promise.all([
    db.select(leaveListFields).from(hrMonthlyLeaveEntries)
      .innerJoin(hrLeaveTypes, eq(hrLeaveTypes.id, hrMonthlyLeaveEntries.leaveTypeId))
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrMonthlyLeaveEntries.employmentId))
      .innerJoin(hrEmployees, eq(hrEmployees.userId, hrEmployments.employeeUserId))
      .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
      .where(and(sql`${hrMonthlyLeaveEntries.leaveDate} >= ${range.start}`, sql`${hrMonthlyLeaveEntries.leaveDate} < ${range.end}`, employeeFilter))
      .orderBy(asc(hrMonthlyLeaveEntries.leaveDate), asc(hrEmployees.employeeNumber)),
    db.select({ entry: hrMonthlyHourlyEntries, employeeUserId: hrEmployments.employeeUserId, employeeNumber: hrEmployees.employeeNumber, employeeName: displayName })
      .from(hrMonthlyHourlyEntries).innerJoin(hrEmployments, eq(hrEmployments.id, hrMonthlyHourlyEntries.employmentId))
      .innerJoin(hrEmployees, eq(hrEmployees.userId, hrEmployments.employeeUserId)).innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
      .where(and(sql`${hrMonthlyHourlyEntries.workDate} >= ${range.start}`, sql`${hrMonthlyHourlyEntries.workDate} < ${range.end}`, employeeFilter))
      .orderBy(asc(hrMonthlyHourlyEntries.workDate), asc(hrEmployees.employeeNumber)),
  ]);
  const leaveSummary = new Map<string, { leaveTypeId: string; leaveTypeName: string; employeeUserId: string; employeeNumber: string; employeeName: string; entryCount: number; dateSet: Set<string>; hoursHalfUnits: number; deductionAmount: number; payRatePpmTotal: number }>();
  for (const row of leaves) {
    const key = `${row.employeeUserId}:${row.entry.leaveTypeId}`;
    const current = leaveSummary.get(key) ?? { leaveTypeId: row.entry.leaveTypeId, leaveTypeName: row.leaveTypeName, employeeUserId: row.employeeUserId, employeeNumber: row.employeeNumber, employeeName: row.employeeName, entryCount: 0, dateSet: new Set<string>(), hoursHalfUnits: 0, deductionAmount: 0, payRatePpmTotal: 0 };
    current.entryCount += 1; current.dateSet.add(row.entry.leaveDate); current.hoursHalfUnits += row.entry.hoursHalfUnits; current.deductionAmount += row.entry.deductionAmount; current.payRatePpmTotal += row.entry.payRatePpm;
    leaveSummary.set(key, current);
  }
  return {
    periodKey,
    leaveTypes: await listHrLeaveTypes(db),
    leaves: leaves.map(({ entry, leaveTypeName, employeeUserId: _employeeUserId, employeeNumber, employeeName }) => ({ ...entry, leaveTypeName, employeeNumber, employeeName, hours: entry.hoursHalfUnits / 2 })),
    hourly: hourly.map(({ entry, employeeUserId: _employeeUserId, employeeNumber, employeeName }) => ({ ...entry, employeeNumber, employeeName, hours: entry.hoursHalfUnits / 2 })),
    leaveSummary: [...leaveSummary.values()].map((item) => ({ ...item, dateCount: item.dateSet.size, hours: item.hoursHalfUnits / 2, averagePayRatePpm: Math.round(item.payRatePpmTotal / item.entryCount), dateSet: undefined })),
  };
}

export async function createHrMonthlyLeave(db: Database, input: MonthlyLeaveInput, actor: HrActor) {
  validateDateInPeriod(input.leaveDate, input.leaveDate.slice(0, 7), "假勤日期");
  validateHalfUnits(input.hoursHalfUnits, "假勤時數");
  if (!Number.isSafeInteger(input.payRatePpm) || input.payRatePpm < 0 || input.payRatePpm > PPM) throw new HrError(400, "給薪比例必須介於 0～100%。 ");
  validateMoneyYuan(input.deductionAmount, "扣款金額");
  await ensureOpenPeriod(db, input.leaveDate, input.employmentId);
  await ensureEmploymentOnDate(db, input.employmentId, input.leaveDate);
  const [leaveType] = await db.select({ id: hrLeaveTypes.id }).from(hrLeaveTypes).where(and(eq(hrLeaveTypes.id, input.leaveTypeId), eq(hrLeaveTypes.active, 1))).limit(1);
  if (!leaveType) throw new HrError(404, "找不到啟用中的假別。 ");
  const id = crypto.randomUUID();
  try {
    return await writeHrMutation(db, sql`INSERT INTO hr_monthly_leave_entries
      (id, employment_id, leave_type_id, leave_date, hours_half_units, pay_rate_ppm, deduction_amount, note, created_by, updated_by)
      VALUES (${id}, ${input.employmentId}, ${input.leaveTypeId}, ${input.leaveDate}, ${input.hoursHalfUnits}, ${input.payRatePpm}, ${input.deductionAmount}, ${input.note ?? ""}, ${actor.id}, ${actor.id}) RETURNING id`, id, actor, "monthly_leave_created", "同一員工同一假別日期已登記或資料不合法。 ");
  } catch (error) { throw error; }
}

export async function updateHrMonthlyLeave(db: Database, id: string, input: Omit<MonthlyLeaveInput, "employmentId"> & { employmentId: string; revision: number }, actor: HrActor) {
  validateDateInPeriod(input.leaveDate, input.leaveDate.slice(0, 7), "假勤日期");
  validateHalfUnits(input.hoursHalfUnits, "假勤時數");
  if (!Number.isSafeInteger(input.payRatePpm) || input.payRatePpm < 0 || input.payRatePpm > PPM) throw new HrError(400, "給薪比例必須介於 0～100%。 ");
  validateMoneyYuan(input.deductionAmount, "扣款金額");
  const [existing] = await db.select({ employmentId: hrMonthlyLeaveEntries.employmentId, leaveDate: hrMonthlyLeaveEntries.leaveDate }).from(hrMonthlyLeaveEntries).where(eq(hrMonthlyLeaveEntries.id, id)).limit(1);
  if (!existing) throw new HrError(404, "找不到假勤資料。 ");
  await ensureOpenPeriod(db, existing.leaveDate, existing.employmentId);
  await ensureOpenPeriod(db, input.leaveDate, input.employmentId);
  await ensureEmploymentOnDate(db, input.employmentId, input.leaveDate);
  const [type] = await db.select({ id: hrLeaveTypes.id }).from(hrLeaveTypes).where(eq(hrLeaveTypes.id, input.leaveTypeId)).limit(1);
  if (!type) throw new HrError(404, "找不到假別。 ");
  return writeHrMutation(db, sql`UPDATE hr_monthly_leave_entries SET
    employment_id=${input.employmentId}, leave_type_id=${input.leaveTypeId}, leave_date=${input.leaveDate}, hours_half_units=${input.hoursHalfUnits}, pay_rate_ppm=${input.payRatePpm}, deduction_amount=${input.deductionAmount}, note=${input.note ?? ""}, updated_by=${actor.id}, updated_at=CURRENT_TIMESTAMP, revision=revision+1
    WHERE id=${id} AND revision=${input.revision} RETURNING id`, id, actor, "monthly_leave_updated", "假勤資料已變更、月份已結帳或版本過期，請重新整理。 ");
}

export async function createHrMonthlyHourly(db: Database, input: MonthlyHourlyInput, actor: HrActor) {
  validateDateInPeriod(input.workDate, input.workDate.slice(0, 7), "工時日期");
  const noWork = Boolean(input.noWork);
  validateHalfUnits(input.hoursHalfUnits, "工時", noWork);
  if (noWork && input.hoursHalfUnits !== 0) throw new HrError(400, "標記本期無工時時，工時必須為 0。 ");
  if (!noWork && input.hoursHalfUnits === 0) throw new HrError(400, "請輸入工時，或明確標記本期無工時。 ");
  await ensureOpenPeriod(db, input.workDate, input.employmentId);
  await ensureEmploymentOnDate(db, input.employmentId, input.workDate);
  const id = crypto.randomUUID();
  return writeHrMutation(db, sql`INSERT INTO hr_monthly_hourly_entries
    (id, employment_id, work_date, hours_half_units, no_work, note, created_by, updated_by)
    VALUES (${id}, ${input.employmentId}, ${input.workDate}, ${input.hoursHalfUnits}, ${noWork ? 1 : 0}, ${input.note ?? ""}, ${actor.id}, ${actor.id}) RETURNING id`, id, actor, "monthly_hourly_created", "同一員工同一天已登記工時或資料不合法。 ");
}

export async function updateHrMonthlyHourly(db: Database, id: string, input: MonthlyHourlyInput & { revision: number }, actor: HrActor) {
  validateDateInPeriod(input.workDate, input.workDate.slice(0, 7), "工時日期");
  const noWork = Boolean(input.noWork);
  validateHalfUnits(input.hoursHalfUnits, "工時", noWork);
  if (noWork && input.hoursHalfUnits !== 0) throw new HrError(400, "標記本期無工時時，工時必須為 0。 ");
  if (!noWork && input.hoursHalfUnits === 0) throw new HrError(400, "請輸入工時，或明確標記本期無工時。 ");
  const [existing] = await db.select({ employmentId: hrMonthlyHourlyEntries.employmentId, workDate: hrMonthlyHourlyEntries.workDate }).from(hrMonthlyHourlyEntries).where(eq(hrMonthlyHourlyEntries.id, id)).limit(1);
  if (!existing) throw new HrError(404, "找不到月度工時資料。 ");
  await ensureOpenPeriod(db, existing.workDate, existing.employmentId);
  await ensureOpenPeriod(db, input.workDate, input.employmentId);
  await ensureEmploymentOnDate(db, input.employmentId, input.workDate);
  return writeHrMutation(db, sql`UPDATE hr_monthly_hourly_entries SET
    employment_id=${input.employmentId}, work_date=${input.workDate}, hours_half_units=${input.hoursHalfUnits}, no_work=${noWork ? 1 : 0}, note=${input.note ?? ""}, updated_by=${actor.id}, updated_at=CURRENT_TIMESTAMP, revision=revision+1
    WHERE id=${id} AND revision=${input.revision} RETURNING id`, id, actor, "monthly_hourly_updated", "月度工時已變更、月份已結帳或版本過期，請重新整理。 ");
}

/** 薪資引擎專用：讀取指定期間的月度人工資料，避免前端直接拼計算。 */
export async function listHrMonthlyEntriesForPayroll(db: Database, start: string, end: string) {
  const [leaves, hourly] = await Promise.all([
    db.select().from(hrMonthlyLeaveEntries).where(and(sql`${hrMonthlyLeaveEntries.leaveDate} >= ${start}`, sql`${hrMonthlyLeaveEntries.leaveDate} < ${end}`)),
    db.select().from(hrMonthlyHourlyEntries).where(and(sql`${hrMonthlyHourlyEntries.workDate} >= ${start}`, sql`${hrMonthlyHourlyEntries.workDate} < ${end}`)),
  ]);
  return { leaves, hourly };
}
