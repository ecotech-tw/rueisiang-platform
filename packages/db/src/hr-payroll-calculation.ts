import { and, asc, count, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { listHrMonthlyEntriesForPayroll } from "./hr-monthly-data.js";
import { calculateHrInsuranceEmployeeAmount, listHrInsuranceContributionRules } from "./hr-payroll.js";
import { listHrPayrollAdjustmentsForPeriod } from "./hr-payroll-adjustments.js";
import { listHrSpecialWorkdaysForPayroll } from "./hr-special-workdays.js";
import { HrError, hrEmployableUser, writeHrMutation, type HrActor } from "./hr-people.js";
import { listEffectiveDailyPayouts } from "./report-data.js";
import { activityEvents } from "./schema/activity.js";
import { hrClockEvents } from "./schema/hr-attendance.js";
import {
  hrBonusPolicies,
  hrBonusPolicyMembers,
  hrBonusPolicyVersionScopes,
  hrBonusPolicyVersions,
  type HrBonusPolicyMember,
  type HrBonusPolicyVersion,
} from "./schema/hr-bonus.js";
import {
  hrCompensationItems,
  hrCompensationVersions,
  hrWorkerCompensationVersions,
  hrMonthlyHourlyEntries,
  hrMonthlyLeaveEntries,
  hrInsuranceVersions,
  hrLeaveRequests,
} from "./schema/hr-payroll.js";
import {
  hrPayrollPeriods,
  hrPayrollRunEmployees,
  hrPayrollRuns,
  hrPayrollWorkerResults,
  hrPayslipCompensationLinks,
  hrPayslipInsuranceLinks,
  hrPayslipLines,
  hrPayslips,
  hrPayrollAdjustmentItems,
  hrPayrollAdjustments,
} from "./schema/hr-payroll-runs.js";
import { hrEmployees, hrEmployments } from "./schema/hr-people.js";
import { hrEmploymentAttendanceSettings } from "./schema/hr-attendance.js";
import { hrOvertimeRequests, hrScheduleEntries, hrScheduleVersions, hrScheduleWorkerEntries, hrScheduleWorkers, hrSpecialWorkdayAssignments } from "./schema/hr-scheduling.js";
import { users } from "./schema/auth.js";
import { formatTaipeiDate, taipeiMidnightUtc } from "./taipei-time.js";
import { scopes } from "./schema/reports.js";

const PPM = 1_000_000;
/** 獎金規則明定以新臺幣元四捨五入，金額本身以分保存，所以先除 100 再乘回去。 */
function roundToDollar(rawMinor: number) { return Math.max(0, Math.round(rawMinor / 100) * 100); }
/** 非負整數除法四捨五入（.5 進位）。 */
function roundHalfUpDiv(numerator: bigint, denominator: bigint) { return (numerator * 2n + denominator) / (denominator * 2n); }

type PayrollCalculationPart = { formula: string; amountMinor: number };

/*
 * 薪資明細會被保存成歷史快照；公式文字也在這裡一起生成，前端只負責呈現，
 * 不在另一個地方重複一份可能和試算引擎走歪的算法。公式保留到分，讓顯示的乘法不會因為先四捨五入成整元而失真；
 * 實際加總仍然只用分，薪資頁的主金額則沿用整元顯示。
 */
function payrollFormulaMoney(amountMinor: number) {
  const absoluteMinor = Math.abs(amountMinor);
  const whole = Math.floor(absoluteMinor / 100).toLocaleString("zh-TW");
  const cents = absoluteMinor % 100;
  return `NT$ ${amountMinor < 0 ? "−" : ""}${whole}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
}
function payrollFormulaPercent(ratePpm: number) {
  return `${(ratePpm / 10_000).toFixed(4).replace(/\.?0+$/, "")}%`;
}
function payrollFormulaHours(hours: number) {
  return hours.toFixed(2).replace(/\.?0+$/, "");
}
function payrollFormulaTotal(parts: PayrollCalculationPart[], totalMinor: number) {
  const expression = parts.map((part) => part.formula).join(" + ");
  return `${expression || "依薪資規則計算"} = ${payrollFormulaMoney(totalMinor)}`;
}
const PAYROLL_DEMO_WARNING = "本版未計算勞健保扣款：員工尚未建立有效的加保版本。";
const displayName = sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`;

type HrPayrollEmployeeFilter = "all" | "general" | "scheduled";

export interface HrPayrollCalculationInput {
  periodKey: string;
  payDate?: string;
  employeeUserIds?: string[];
  attendanceMode?: HrPayrollEmployeeFilter;
  requestId?: string;
  monthlyDivisorDays?: number;
  standardDailyHours?: number;
}

export interface HrPayrollLineResult {
  lineKey: string;
  direction: "earning" | "deduction";
  amountMinor: number;
  quantitySeconds?: number;
  explanation: Record<string, unknown>;
}

export interface HrPayrollEmployeeResult {
  employmentId: string;
  employeeUserId: string;
  employeeNumber: string;
  employeeName: string;
  lines: HrPayrollLineResult[];
  earningMinor: number;
  deductionMinor: number;
  netMinor: number;
  attendanceDays: number;
  missingPunchDays: number;
}

export interface HrPayrollRunResult {
  runId: string;
  periodKey: string;
  payDate: string | null;
  status: "ready" | "closed";
  engineVersion: string;
  employees: HrPayrollEmployeeResult[];
  workers: Array<{ workerId: string; workerName: string; payBasis: "monthly" | "daily" | "hourly" | "mixed"; scheduledDays: number; amountMinor: number; compensationVersionId: string | null }>;
  warnings: string[];
}

export type HrBonusKind = "team_performance" | "individual_performance";
export type HrBonusPerformancePeriod = "current_month" | "previous_month";

function normalizeBonusKind(value: string): HrBonusKind {
  return value === "individual_performance" ? "individual_performance" : "team_performance";
}

export interface HrBonusPolicyAssignmentInput {
  employeeUserId: string;
  weightUnits?: number;
}

export interface CreateHrBonusPolicyInput {
  name: string;
  /** 新 API 使用 scopeIds；scopeId 僅保留給既有客戶端。 */
  scopeIds?: string[];
  scopeId?: string;
  bonusKind: HrBonusKind;
  performancePeriod: HrBonusPerformancePeriod;
  ratePpm: number;
  guaranteeMinor: number;
  /** 舊 API：未提供 employeeAssignments 時一律以權重 1 建立。 */
  employeeUserIds?: string[];
  /** 團體績效可逐員工指定分配權重；個人績效仍會保存權重 1 以符合既有資料形狀。 */
  employeeAssignments?: HrBonusPolicyAssignmentInput[];
  assignmentValidFrom?: string;
}

export interface UpdateHrBonusPolicyInput extends CreateHrBonusPolicyInput {
  policyVersionId: string;
  validFrom: string;
}

export interface AssignHrBonusPolicyInput {
  policyVersionId: string;
  employeeUserId: string;
  validFrom: string;
  validTo?: string | null;
  weightUnits?: number;
}

function periodFromKey(periodKey: string): { periodKey: string; start: string; end: string; year: number; month: number } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(periodKey);
  if (!match) throw new HrError(400, "薪資月份必須是 YYYY-MM。 ");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const next = new Date(Date.UTC(year, month, 1));
  const start = `${periodKey}-01`;
  const end = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
  return { periodKey, start, end, year, month };
}

function previousPeriod(period: { year: number; month: number }): { start: string; end: string } {
  const startDate = new Date(Date.UTC(period.year, period.month - 2, 1));
  const endDate = new Date(Date.UTC(period.year, period.month - 1, 1));
  return { start: startDate.toISOString().slice(0, 10), end: endDate.toISOString().slice(0, 10) };
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateRange(start: string, end: string): string[] {
  const result: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor < last) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function dailyItemAppliesOnWorkday(attendanceMode: string, payBasis: "monthly" | "daily" | "hourly", date: string, scheduledDates: ReadonlySet<string>, specialDates: ReadonlySet<string>): boolean {
  if (specialDates.has(date)) return true;
  if (payBasis === "daily" || attendanceMode === "scheduled") return scheduledDates.has(date);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function overlapDays(start: string, end: string, from: string, to: string | null): string[] {
  const lower = start > from ? start : from;
  const upper = to && to < end ? to : end;
  return lower < upper ? dateRange(lower, upper) : [];
}

function secondsBetween(start: string, end: string): number {
  const seconds = Math.round((Date.parse(end.replace(" ", "T") + (end.endsWith("Z") ? "" : "Z")) - Date.parse(start.replace(" ", "T") + (start.endsWith("Z") ? "" : "Z"))) / 1000);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 0;
}
function utcWallClockMilliseconds(value: string): number {
  return Date.parse(value.replace(" ", "T") + (value.endsWith("Z") ? "" : "Z"));
}
function canonicalUtcWallClock(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 19).replace("T", " ");
}
function nextDateOnly(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
type SpecialWorkdayOvertimeRule = { fromHalfHours: number; toHalfHours: number | null; rateKind: "fixed_hourly" | "multiplier"; fixedAmountMinor: number | null; multiplierPpm: number | null };
type OvertimeRuleChunk = { seconds: number; rule: SpecialWorkdayOvertimeRule | null };
function splitOvertimeBySpecialRules(seconds: number, rules: readonly SpecialWorkdayOvertimeRule[], elapsedSeconds = 0): OvertimeRuleChunk[] {
  if (!rules.length) return [{ seconds, rule: null }];
  const chunks: OvertimeRuleChunk[] = [];
  let consumedSeconds = 0;
  while (consumedSeconds < seconds) {
    const positionSeconds = elapsedSeconds + consumedSeconds;
    const halfHourIndex = Math.floor(positionSeconds / (30 * 60)) + 1;
    const rule = rules.find((item) => halfHourIndex >= item.fromHalfHours && (item.toHalfHours === null || halfHourIndex <= item.toHalfHours)) ?? null;
    const nextRule = rules.find((item) => item.fromHalfHours > halfHourIndex);
    const boundaryHalfHours = rule?.toHalfHours ?? (nextRule ? nextRule.fromHalfHours - 1 : null);
    const boundarySeconds = boundaryHalfHours === null ? Number.POSITIVE_INFINITY : boundaryHalfHours * 30 * 60;
    const chunkSeconds = Math.min(seconds - consumedSeconds, Math.max(1, boundarySeconds - positionSeconds));
    chunks.push({ seconds: chunkSeconds, rule });
    consumedSeconds += chunkSeconds;
  }
  return chunks;
}
function splitOvertimeByTaipeiDate(start: string, end: string): Array<{ date: string; seconds: number }> {
  const startMilliseconds = utcWallClockMilliseconds(start);
  const endMilliseconds = utcWallClockMilliseconds(end);
  if (!Number.isFinite(startMilliseconds) || !Number.isFinite(endMilliseconds) || endMilliseconds <= startMilliseconds) return [];
  const result: Array<{ date: string; seconds: number }> = [];
  let cursor = startMilliseconds;
  while (cursor < endMilliseconds) {
    const cursorValue = canonicalUtcWallClock(cursor);
    const date = taipeiDate(cursorValue);
    const nextMidnight = utcWallClockMilliseconds(taipeiMidnightUtc(nextDateOnly(date)));
    const segmentEnd = Math.min(endMilliseconds, Number.isFinite(nextMidnight) && nextMidnight > cursor ? nextMidnight : endMilliseconds);
    result.push({ date, seconds: Math.round((segmentEnd - cursor) / 1000) });
    cursor = segmentEnd;
  }
  return result;
}
function scheduledHours(row: { standardMinutes?: number | null; startsAt: string; endsAt: string }) {
  return Number.isInteger(row.standardMinutes) ? (row.standardMinutes as number) / 60 : secondsBetween(row.startsAt, row.endsAt) / 3600;
}

function taipeiDate(value: string): string {
  const normalized = value.replace(" ", "T");
  const timestamp = Date.parse(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
  return Number.isNaN(timestamp) ? value.slice(0, 10) : formatTaipeiDate(timestamp);
}

function covering<T extends { validFrom: string; validTo: string | null }>(rows: T[], date: string): T | undefined {
  return rows.filter((row) => row.validFrom <= date && (row.validTo === null || date < row.validTo)).sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
}

function employeeSelected(employee: { employeeUserId: string; attendanceMode: string }, input: HrPayrollCalculationInput): boolean {
  if (input.employeeUserIds !== undefined && !input.employeeUserIds.includes(employee.employeeUserId)) return false;
  if (input.attendanceMode === "general") return employee.attendanceMode === "general";
  if (input.attendanceMode === "scheduled") return employee.attendanceMode === "scheduled";
  return true;
}

function ensureMoney(value: unknown, name: string, allowNegative = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (!allowNegative && value < 0)) throw new HrError(400, `${name} 必須是非負整數金額（分）。`);
  return value;
}

function batchStatements<T>(statements: T[]): [T, ...T[]] {
  if (!statements.length) throw new Error("至少需要一個資料庫 statement。 ");
  return statements as [T, ...T[]];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).sort().join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

interface PayrollSourceSnapshotInput {
  period: { start: string; end: string; periodKey: string };
  employmentIds: string[];
  workerIds: string[];
}

/**
 * 薪資試算的來源快照不是只記一個 employee revision：假勤、工時、加班、排班、
 * 敘薪、保險與獎金都可能在試算後變動。保存完整的受影響列，結帳前逐列比對，
 * 讓 close 不能默默把 stale result 當成最終薪資。
 */
async function getPayrollSourceSnapshot(db: Database, input: PayrollSourceSnapshotInput) {
  const employmentIds = input.employmentIds.length ? input.employmentIds : ["__none__"];
  const workerIds = input.workerIds.length ? input.workerIds : ["__none__"];
  const employmentFilter = inArray(hrEmployments.id, employmentIds);
  const workerFilter = inArray(hrScheduleWorkers.id, workerIds);
  const employmentValues = sql.join(employmentIds.map((id) => sql`${id}`), sql`, `);
  const relevantBonusVersionIds = sql`SELECT member_version.policy_version_id FROM hr_bonus_policy_members AS member_version
    WHERE member_version.employment_id IN (${employmentValues})
      AND member_version.valid_from < ${input.period.end}
      AND (member_version.valid_to IS NULL OR member_version.valid_to > ${input.period.start})`;
  const relevantBonusScopeIds = sql`SELECT scope_id FROM hr_bonus_policy_versions WHERE id IN (${relevantBonusVersionIds}) UNION SELECT scope_id FROM hr_bonus_policy_version_scopes WHERE policy_version_id IN (${relevantBonusVersionIds})`;
  const sourcePeriod = previousPeriod({ year: Number(input.period.periodKey.slice(0, 4)), month: Number(input.period.periodKey.slice(5, 7)) });
  const periodStartUtc = taipeiMidnightUtc(input.period.start);
  const periodEndUtc = taipeiMidnightUtc(input.period.end);
  const latestPublishedSchedule = sql`${hrScheduleVersions.status} = 'published'
    AND ${hrScheduleVersions.periodStart} = ${input.period.start}
    AND ${hrScheduleVersions.periodEnd} = ${input.period.end}
    AND ${hrScheduleVersions.versionNumber} = (SELECT max(latest_schedule_version.version_number)
      FROM hr_schedule_versions AS latest_schedule_version
      WHERE latest_schedule_version.period_start = ${input.period.start}
        AND latest_schedule_version.period_end = ${input.period.end}
        AND latest_schedule_version.status = 'published')`;
  const selectedScheduleVersions = sql`EXISTS (SELECT 1 FROM hr_schedule_entries AS selected_entry
      WHERE selected_entry.schedule_version_id = hr_schedule_versions.id
        AND selected_entry.employment_id IN (${sql.join(employmentIds.map((id) => sql`${id}`), sql`, `)}))
    OR EXISTS (SELECT 1 FROM hr_schedule_worker_entries AS selected_worker_entry
      WHERE selected_worker_entry.schedule_version_id = hr_schedule_versions.id
        AND selected_worker_entry.worker_id IN (${sql.join(workerIds.map((id) => sql`${id}`), sql`, `)}))`;
  const [employments, employeeProfiles, accountProfiles, attendanceSettings, compensations, compensationItems, insurance, insuranceRules, leaves, monthlyLeaves, monthlyHourly, overtime, clocks, scheduleVersions, scheduleEntries, workerScheduleEntries, workers, workerCompensations, specialWorkdays, bonusMembers, bonusPolicyVersions, bonusPolicies, bonusScopes, bonusPayouts, bonusScheduleDays, adjustments, adjustmentItems] = await Promise.all([
    db.select({ id: hrEmployments.id, employeeUserId: hrEmployments.employeeUserId, hiredOn: hrEmployments.hiredOn, endedOn: hrEmployments.endedOn }).from(hrEmployments).where(employmentFilter),
    db.select({ userId: hrEmployees.userId, employeeNumber: hrEmployees.employeeNumber, supervisorUserId: hrEmployees.supervisorUserId, revision: hrEmployees.revision, updatedAt: hrEmployees.updatedAt }).from(hrEmployees).where(sql`${hrEmployees.userId} IN (SELECT employee_user_id FROM hr_employments WHERE id IN (${employmentValues}))`),
    db.select({ id: users.id, email: users.email, googleName: users.googleName, displayName: users.displayName, status: users.status, updatedAt: users.updatedAt }).from(users).where(sql`${users.id} IN (SELECT employee_user_id FROM hr_employments WHERE id IN (${employmentValues}))`),
    db.select().from(hrEmploymentAttendanceSettings).where(inArray(hrEmploymentAttendanceSettings.employmentId, employmentIds)),
    db.select().from(hrCompensationVersions).where(and(inArray(hrCompensationVersions.employmentId, employmentIds), sql`${hrCompensationVersions.voidedAt} IS NULL`, sql`${hrCompensationVersions.validFrom} < ${input.period.end}`, sql`(${hrCompensationVersions.validTo} IS NULL OR ${hrCompensationVersions.validTo} > ${input.period.start})`)),
    db.select().from(hrCompensationItems).where(sql`${hrCompensationItems.compensationVersionId} IN (SELECT id FROM hr_compensation_versions WHERE employment_id IN (${sql.join(employmentIds.map((id) => sql`${id}`), sql`, `)}) AND voided_at IS NULL AND valid_from < ${input.period.end} AND (valid_to IS NULL OR valid_to > ${input.period.start}))`),
    db.select().from(hrInsuranceVersions).where(and(inArray(hrInsuranceVersions.employmentId, employmentIds), sql`${hrInsuranceVersions.validFrom} <= ${input.period.start}`, sql`(${hrInsuranceVersions.validTo} IS NULL OR ${hrInsuranceVersions.validTo} > ${input.period.start})`)),
    listHrInsuranceContributionRules(db, input.period.start),
    db.select().from(hrLeaveRequests).where(and(eq(hrLeaveRequests.status, "approved"), inArray(hrLeaveRequests.employmentId, employmentIds), sql`${hrLeaveRequests.startsOn} < ${input.period.end}`, sql`${hrLeaveRequests.endsOn} > ${input.period.start}`)),
    db.select().from(hrMonthlyLeaveEntries).where(and(inArray(hrMonthlyLeaveEntries.employmentId, employmentIds), sql`${hrMonthlyLeaveEntries.leaveDate} >= ${input.period.start}`, sql`${hrMonthlyLeaveEntries.leaveDate} < ${input.period.end}`)),
    db.select().from(hrMonthlyHourlyEntries).where(and(inArray(hrMonthlyHourlyEntries.employmentId, employmentIds), sql`${hrMonthlyHourlyEntries.workDate} >= ${input.period.start}`, sql`${hrMonthlyHourlyEntries.workDate} < ${input.period.end}`)),
    db.select().from(hrOvertimeRequests).where(and(eq(hrOvertimeRequests.status, "approved"), eq(hrOvertimeRequests.settlementKind, "pay"), inArray(hrOvertimeRequests.employmentId, employmentIds), sql`(${hrOvertimeRequests.requestedStart} < ${periodEndUtc} AND ${hrOvertimeRequests.requestedEnd} > ${periodStartUtc}) OR (${hrOvertimeRequests.actualStart} IS NOT NULL AND ${hrOvertimeRequests.actualStart} < ${periodEndUtc} AND ${hrOvertimeRequests.actualEnd} > ${periodStartUtc})`)),
    db.select().from(hrClockEvents).where(and(inArray(hrClockEvents.employmentId, employmentIds), sql`${hrClockEvents.occurredAt} >= ${periodStartUtc}`, sql`${hrClockEvents.occurredAt} < ${periodEndUtc}`)),
    db.select().from(hrScheduleVersions).where(and(latestPublishedSchedule, selectedScheduleVersions)),
    db.select({ entry: hrScheduleEntries }).from(hrScheduleEntries)
      .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleEntries.scheduleVersionId))
      .where(and(latestPublishedSchedule, inArray(hrScheduleEntries.employmentId, employmentIds), sql`${hrScheduleEntries.workDate} >= ${input.period.start}`, sql`${hrScheduleEntries.workDate} < ${input.period.end}`)),
    db.select({ entry: hrScheduleWorkerEntries }).from(hrScheduleWorkerEntries)
      .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleWorkerEntries.scheduleVersionId))
      .where(and(latestPublishedSchedule, inArray(hrScheduleWorkerEntries.workerId, workerIds), sql`${hrScheduleWorkerEntries.workDate} >= ${input.period.start}`, sql`${hrScheduleWorkerEntries.workDate} < ${input.period.end}`)),
    db.select().from(hrScheduleWorkers).where(workerFilter),
    db.select().from(hrWorkerCompensationVersions).where(and(inArray(hrWorkerCompensationVersions.workerId, workerIds), sql`${hrWorkerCompensationVersions.validFrom} < ${input.period.end}`, sql`(${hrWorkerCompensationVersions.validTo} IS NULL OR ${hrWorkerCompensationVersions.validTo} > ${input.period.start})`)),
    db.select().from(hrSpecialWorkdayAssignments).where(and(sql`${hrSpecialWorkdayAssignments.workDate} >= ${input.period.start}`, sql`${hrSpecialWorkdayAssignments.workDate} < ${input.period.end}`, or(inArray(hrSpecialWorkdayAssignments.employmentId, employmentIds), inArray(hrSpecialWorkdayAssignments.workerId, workerIds)))),
    db.select().from(hrBonusPolicyMembers).where(and(inArray(hrBonusPolicyMembers.employmentId, employmentIds), sql`${hrBonusPolicyMembers.validFrom} < ${input.period.end}`, sql`(${hrBonusPolicyMembers.validTo} IS NULL OR ${hrBonusPolicyMembers.validTo} > ${input.period.start})`)),
    db.select().from(hrBonusPolicyVersions).where(sql`${hrBonusPolicyVersions.id} IN (${relevantBonusVersionIds})`),
    db.select().from(hrBonusPolicies).where(sql`${hrBonusPolicies.id} IN (SELECT policy_id FROM hr_bonus_policy_versions WHERE id IN (${relevantBonusVersionIds}))`),
    db.select().from(hrBonusPolicyVersionScopes).where(sql`${hrBonusPolicyVersionScopes.policyVersionId} IN (${relevantBonusVersionIds})`),
    /*
     * 獎金的來源是出金表與排班，兩者都要進快照：出金表事後重匯或被人工修訂時，結帳前
     * 的比對才擋得下來。少了這一段，已試算的獎金會在來源悄悄改變之後照樣結出去。
     */
    db.all<{ scopeId: string; businessDate: string; recordOrigin: string; payoutAmount: number }>(sql`SELECT scope_id AS scopeId, business_date AS businessDate, record_origin AS recordOrigin, payout_amount AS payoutAmount FROM report_payout_daily WHERE scope_id IN (${relevantBonusScopeIds}) AND business_date >= ${sourcePeriod.start} AND business_date < ${input.period.end} ORDER BY scope_id, business_date, record_origin`),
    db.select({ employmentId: hrScheduleEntries.employmentId, scopeId: hrScheduleEntries.scopeId, workDate: hrScheduleEntries.workDate }).from(hrScheduleEntries)
      .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleEntries.scheduleVersionId))
      .where(and(eq(hrScheduleVersions.status, "published"), sql`${hrScheduleEntries.employmentId} IN (SELECT employment_id FROM hr_bonus_policy_members WHERE policy_version_id IN (${relevantBonusVersionIds}))`, sql`${hrScheduleEntries.workDate} >= ${sourcePeriod.start}`, sql`${hrScheduleEntries.workDate} < ${input.period.end}`))
      .orderBy(asc(hrScheduleEntries.employmentId), asc(hrScheduleEntries.workDate), asc(hrScheduleEntries.scopeId)),
    db.select().from(hrPayrollAdjustments).where(and(eq(hrPayrollAdjustments.effectivePeriodKey, input.period.periodKey), inArray(hrPayrollAdjustments.employmentId, employmentIds))),
    db.select().from(hrPayrollAdjustmentItems).where(sql`${hrPayrollAdjustmentItems.adjustmentId} IN (SELECT id FROM hr_payroll_adjustments WHERE effective_period_key=${input.period.periodKey} AND employment_id IN (${sql.join(employmentIds.map((id) => sql`${id}`), sql`, `)}))`),
  ]);
  return stableJson({
    periodKey: input.period.periodKey,
    employments, employeeProfiles, accountProfiles, attendanceSettings, compensations, compensationItems, insurance, insuranceRules, leaves,
    monthlyLeaves, monthlyHourly, overtime, clocks, scheduleVersions,
    scheduleEntries: scheduleEntries.map(({ entry }) => entry),
    workerScheduleEntries: workerScheduleEntries.map(({ entry }) => entry),
    workers, workerCompensations, specialWorkdays, bonusMembers, bonusPolicyVersions, bonusPolicies, bonusScopes,
    bonusPayouts, bonusScheduleDays, adjustments, adjustmentItems,
  });
}

async function getPayrollRunResult(db: Database, runId: string, warnings: string[] = []): Promise<HrPayrollRunResult> {
  const [run] = await db.select({ run: hrPayrollRuns, periodKey: hrPayrollPeriods.periodKey }).from(hrPayrollRuns)
    .innerJoin(hrPayrollPeriods, eq(hrPayrollPeriods.id, hrPayrollRuns.payrollPeriodId))
    .where(eq(hrPayrollRuns.id, runId)).limit(1);
  if (!run) throw new HrError(404, "找不到薪資試算批次。 ");
  const payslips = await db.select({ payslip: hrPayslips, employeeUserId: hrEmployments.employeeUserId }).from(hrPayslips)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrPayslips.employmentId))
    .where(eq(hrPayslips.payrollRunId, runId)).orderBy(asc(hrPayslips.employeeNumber));
  const lines = await db.select().from(hrPayslipLines).where(sql`${hrPayslipLines.payslipId} IN (SELECT id FROM hr_payslips WHERE payroll_run_id = ${runId})`);
  const workerResults = await db.select().from(hrPayrollWorkerResults).where(eq(hrPayrollWorkerResults.payrollRunId, runId)).orderBy(asc(hrPayrollWorkerResults.workerName));
  const employees = payslips.map(({ payslip, employeeUserId }) => {
    const employeeLines = lines.filter((line) => line.payslipId === payslip.id).map((line) => ({
      lineKey: line.lineKey,
      direction: line.direction,
      amountMinor: line.amountMinor,
      ...(line.quantitySeconds === null ? {} : { quantitySeconds: line.quantitySeconds }),
      explanation: JSON.parse(line.explanationJson) as Record<string, unknown>,
    }));
    const attendance = employeeLines.find((line) => line.lineKey === "attendance_summary")?.explanation ?? {};
    return {
      employmentId: payslip.employmentId,
      employeeUserId,
      employeeNumber: payslip.employeeNumber,
      employeeName: payslip.employeeName,
      lines: employeeLines.filter((line) => line.lineKey !== "attendance_summary"),
      earningMinor: payslip.earningMinor,
      deductionMinor: payslip.deductionMinor,
      netMinor: payslip.netMinor,
      attendanceDays: Number(attendance.attendanceDays ?? 0),
      missingPunchDays: Number(attendance.missingPunchDays ?? 0),
    };
  });
  const hasInsuranceDeduction = employees.some((employee) => employee.lines.some((line) => line.lineKey === "labor_insurance" || line.lineKey === "health_insurance"));
  let persistedWarnings: string[] = [];
  try {
    const parsed = JSON.parse(run.run.warningsJson) as unknown;
    if (Array.isArray(parsed)) persistedWarnings = parsed.filter((value): value is string => typeof value === "string");
  } catch {
    persistedWarnings = ["此批次的試算提醒快照格式無法解析，請重新試算。"];
  }
  return { runId, periodKey: run.periodKey, payDate: run.run.payDate, status: run.run.status === "closed" ? "closed" : "ready", engineVersion: run.run.engineVersion, employees, workers: workerResults.map((worker) => ({ workerId: worker.workerId, workerName: worker.workerName, payBasis: worker.payBasis, scheduledDays: worker.scheduledDays, amountMinor: worker.amountMinor, compensationVersionId: worker.compensationVersionId })), warnings: [...new Set([...(hasInsuranceDeduction ? [] : [PAYROLL_DEMO_WARNING]), ...persistedWarnings, ...warnings])] };
}

interface AssignedBonusPolicy {
  version: Pick<HrBonusPolicyVersion, "id" | "scopeId" | "bonusKind" | "performancePeriod" | "ratePpm" | "guaranteeMinor"> & { scopeIds: string[] };
  member: Pick<HrBonusPolicyMember, "id" | "employmentId" | "weightUnits">;
  policyName: string;
}

interface CalculatedAssignedBonus {
  amountMinor: number;
  poolAmountMinor: number;
  revenueMinor: number;
  /** 個人績效才有意義；團體績效不看排班，固定為 null。 */
  scheduledDays: number | null;
  weightedTotal: number;
  /** 計入業績的日期中完全沒有出金資料的日期；缺一天就少算一天。 */
  missingPayoutDates: string[];
  formula: string;
}

/**
 * `${scopeId}:${businessDate}`。出金與排班都用同一個鍵，兩邊才對得起來。
 *
 * 拆回來一定要用 lastIndexOf：scope id 自己就含冒號（`cyberbiz:store:demo-ximen`），
 * 用 indexOf 會把店名切成 `cyberbiz`，比對永遠不成立而且獎金安靜地變成 0。
 */
function dayKey(scopeId: string, businessDate: string) {
  return `${scopeId}:${businessDate}`;
}
function scopeOfKey(key: string) { return key.slice(0, key.lastIndexOf(":")); }
function dateOfKey(key: string) { return key.slice(key.lastIndexOf(":") + 1); }

/**
 * 獎金一律從出金表的每日金額算出來，沒有第二條路。
 *
 * 團體績效：政策綁的那些店在來源月份**每一天**的出金加總，扣一次保底再乘比例得到池；
 * 池只按權重分給成員（自己的權重 ÷ 全體權重）。**不看排班、不看出勤天數**：只要在獎金
 * 名單裡就照權重分，這是業主明確定下的規則，不要再把排班天數乘回去。
 * 個人績效：只看**這個人自己**排到的 (店, 日期)，同樣扣保底乘比例，不需要分配。
 *
 * 以前個人績效另外走一份月結業績快照，同一個政策從兩個入口算出來的金額不一樣——
 * 那份已經整個移除。
 */
function calculateAssignedBonus(
  assignment: AssignedBonusPolicy,
  period: { start: string; end: string; year: number; month: number },
  payouts: ReadonlyMap<string, number>,
  scheduledDaysByEmployment: ReadonlyMap<string, ReadonlySet<string>>,
  policyMembers: ReadonlyArray<{ employmentId: string; weightUnits: number }>,
): CalculatedAssignedBonus {
  const version = assignment.version;
  const sourcePeriod = version.performancePeriod === "previous_month" ? previousPeriod(period) : { start: period.start, end: period.end };
  const scopeIds = version.scopeIds.length ? version.scopeIds : [version.scopeId];
  const inSourcePeriod = (key: string) => dateOfKey(key) >= sourcePeriod.start && dateOfKey(key) < sourcePeriod.end;
  const ownDays = [...(scheduledDaysByEmployment.get(assignment.member.employmentId) ?? [])]
    .filter((key) => inSourcePeriod(key) && scopeIds.includes(scopeOfKey(key)));

  // 個人績效：業績就是自己站過的那些日子，不進池也不分配。
  if (version.bonusKind === "individual_performance") {
    const revenueMinor = ownDays.reduce((sum, key) => sum + (payouts.get(key) ?? 0), 0);
    const amountMinor = roundToDollar(Math.max(0, revenueMinor - version.guaranteeMinor) * version.ratePpm / PPM);
    return {
      amountMinor, poolAmountMinor: amountMinor, revenueMinor, scheduledDays: ownDays.length, weightedTotal: assignment.member.weightUnits,
      missingPayoutDates: ownDays.filter((key) => !payouts.has(key)).map(dateOfKey).sort(),
      formula: "max(0, 本人排班日出金 - 保底) × 比例",
    };
  }

  // 團體績效：政策的店在來源月份的每一天都算，跟誰有沒有排班無關。
  const eligibleDays = scopeIds.flatMap((scopeId) => dateRange(sourcePeriod.start, sourcePeriod.end).map((date) => dayKey(scopeId, date)));
  const revenueMinor = eligibleDays.reduce((sum, key) => sum + (payouts.get(key) ?? 0), 0);
  const netRevenueMinor = Math.max(0, revenueMinor - version.guaranteeMinor);
  // 池只是給人核對的顯示值；每個人的金額不從這個四捨五入過的數字分，而是從精確的池分。
  const poolAmountMinor = roundToDollar(netRevenueMinor * version.ratePpm / PPM);
  const weightedTotal = policyMembers.reduce((sum, item) => sum + item.weightUnits, 0);
  const own = policyMembers.find((item) => item.employmentId === assignment.member.employmentId);
  /*
   * 業主定的規則是「每個人的獎金四捨五入到元」：精確池 × 本人權重 ÷ 全體權重，最後才捨入一次。
   * 先把池捨入再分，會分出 3,357.50 這種帶角的金額，而且跟手算的 3,357.4875 對不起來。
   * 各自捨入後加總可能跟池差一兩元，這是接受的結果，不再把尾差塞給某一個人。
   * 用 BigInt 做整數運算：出金（分）× 比例（ppm）× 權重會超過 2^53，浮點數在 .5 邊界會捨錯方向。
   */
  const amountMinor = weightedTotal && own
    ? Number(roundHalfUpDiv(BigInt(netRevenueMinor) * BigInt(version.ratePpm) * BigInt(own.weightUnits), BigInt(PPM) * BigInt(weightedTotal) * 100n)) * 100
    : 0;
  return {
    amountMinor,
    poolAmountMinor, revenueMinor, scheduledDays: null, weightedTotal,
    // 多店時同一天可能好幾家店都缺；提醒只需要日期。
    missingPayoutDates: [...new Set(eligibleDays.filter((key) => !payouts.has(key)).map(dateOfKey))].sort(),
    formula: "max(0, 期間出金 - 保底) × 比例 × 本人權重 ÷ 全體權重，四捨五入到元",
  };
}

/**
 * 以明確輸入的示範規則試算薪資：月薪固定以 30 日制按在職日數計算、
 * 核准付薪加班、申請上凍結的給薪比例；勞健保依系統預設或公司覆核的有效負擔規則計算。
 */
export async function calculateHrPayroll(db: Database, input: HrPayrollCalculationInput, actor: HrActor): Promise<HrPayrollRunResult> {
  const period = periodFromKey(input.periodKey);
  const monthlyDivisorDays = 30;
  const standardDailyHours = input.standardDailyHours ?? 8;
  if ((input.monthlyDivisorDays !== undefined && input.monthlyDivisorDays !== 30) || !Number.isFinite(standardDailyHours) || standardDailyHours <= 0 || standardDailyHours > 24) {
    throw new HrError(400, "薪資計算固定採月薪除以 30 日；每日工時設定不正確。 ");
  }
  const payDate = input.payDate === undefined || input.payDate === "" ? null : input.payDate;
  if (payDate !== null && !isDateOnly(payDate)) throw new HrError(400, "發薪日必須是有效的 YYYY-MM-DD 日期。 ");

  const [existing] = input.requestId ? await db.select({ id: hrPayrollRuns.id }).from(hrPayrollRuns).where(eq(hrPayrollRuns.requestId, input.requestId)).limit(1) : [];
  if (existing) return getPayrollRunResult(db, existing.id, ["requestId 已存在，回傳原試算結果。"]);
  const [existingPeriod] = await db.select({ status: hrPayrollPeriods.status }).from(hrPayrollPeriods).where(eq(hrPayrollPeriods.id, `payroll-period-${period.periodKey}`)).limit(1);
  if (existingPeriod?.status === "closed") throw new HrError(409, "該月份已結帳，不能重新建立薪資試算。 ");

  const employeeRows = await db.select({
    employmentId: hrEmployments.id,
    employeeUserId: hrEmployments.employeeUserId,
    employeeNumber: hrEmployees.employeeNumber,
    employeeName: displayName,
    hiredOn: hrEmployments.hiredOn,
    endedOn: hrEmployments.endedOn,
    attendanceMode: sql<string>`coalesce((SELECT attendance_mode FROM hr_employment_attendance_settings WHERE employment_id = ${hrEmployments.id}), 'general')`,
    employeeRevision: hrEmployees.revision,
  }).from(hrEmployments)
    .innerJoin(hrEmployees, eq(hrEmployees.userId, hrEmployments.employeeUserId))
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(and(
      sql`${hrEmployments.hiredOn} < ${period.end}`,
      sql`(${hrEmployments.endedOn} IS NULL OR ${hrEmployments.endedOn} > ${period.start})`,
      hrEmployableUser,
    ));
  const employees = employeeRows.filter((row) => employeeSelected(row, input));
  const closedEmploymentIds = employees.length ? await db.select({ employmentId: hrPayslips.employmentId }).from(hrPayslips)
    .innerJoin(hrPayrollRuns, eq(hrPayrollRuns.id, hrPayslips.payrollRunId)).innerJoin(hrPayrollPeriods, eq(hrPayrollPeriods.id, hrPayrollRuns.payrollPeriodId))
    .where(and(eq(hrPayrollPeriods.periodKey, period.periodKey), eq(hrPayrollRuns.status, "closed"), inArray(hrPayslips.employmentId, employees.map((employee) => employee.employmentId)))) : [];
  if (closedEmploymentIds.length) throw new HrError(409, "同一員工同一月份已有已結帳結果，請改用薪資調整。 ");
  // 臨時支援人員沒有 users／hr_employments，薪資資格來自已發布班表；不套用獎金 policy。
  const scheduledEmployeeRows = await db.select({ employmentId: hrScheduleEntries.employmentId, workDate: hrScheduleEntries.workDate }).from(hrScheduleEntries)
    .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleEntries.scheduleVersionId))
    .where(and(
      eq(hrScheduleVersions.status, "published"),
      eq(hrScheduleVersions.periodStart, period.start), eq(hrScheduleVersions.periodEnd, period.end),
      sql`${hrScheduleVersions.versionNumber} = (SELECT max(latest_schedule_version.version_number) FROM hr_schedule_versions AS latest_schedule_version WHERE latest_schedule_version.period_start = ${period.start} AND latest_schedule_version.period_end = ${period.end} AND latest_schedule_version.status = 'published')`,
      sql`${hrScheduleEntries.workDate} >= ${period.start}`, sql`${hrScheduleEntries.workDate} < ${period.end}`,
    ));
  const scheduledWorkerRows = await db.select({ workerId: hrScheduleWorkerEntries.workerId, workerName: hrScheduleWorkers.displayName, workDate: hrScheduleWorkerEntries.workDate, startsAt: hrScheduleWorkerEntries.startsAt, endsAt: hrScheduleWorkerEntries.endsAt, standardMinutes: hrScheduleWorkerEntries.standardMinutes }).from(hrScheduleWorkerEntries)
    .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleWorkerEntries.scheduleVersionId))
    .innerJoin(hrScheduleWorkers, eq(hrScheduleWorkers.id, hrScheduleWorkerEntries.workerId))
    .where(and(
      eq(hrScheduleVersions.status, "published"),
      eq(hrScheduleVersions.periodStart, period.start), eq(hrScheduleVersions.periodEnd, period.end),
      sql`${hrScheduleVersions.versionNumber} = (SELECT max(latest_schedule_version.version_number) FROM hr_schedule_versions AS latest_schedule_version WHERE latest_schedule_version.period_start = ${period.start} AND latest_schedule_version.period_end = ${period.end} AND latest_schedule_version.status = 'published')`,
      sql`${hrScheduleWorkerEntries.workDate} >= ${period.start}`, sql`${hrScheduleWorkerEntries.workDate} < ${period.end}`,
    ));
  const scheduledDatesByEmployment = new Map<string, Set<string>>();
  for (const row of scheduledEmployeeRows) {
    const dates = scheduledDatesByEmployment.get(row.employmentId) ?? new Set<string>();
    dates.add(row.workDate);
    scheduledDatesByEmployment.set(row.employmentId, dates);
  }
  if (!employees.length && !scheduledWorkerRows.length) throw new HrError(400, "指定月份沒有符合條件的啟用中員工或已發布支援排班。 ");

  const compensations = await db.select().from(hrCompensationVersions).where(and(
    sql`${hrCompensationVersions.voidedAt} IS NULL`,
    sql`${hrCompensationVersions.validFrom} < ${period.end}`,
    sql`(${hrCompensationVersions.validTo} IS NULL OR ${hrCompensationVersions.validTo} > ${period.start})`,
  ));
  const compensationItems = compensations.length ? await db.select().from(hrCompensationItems).where(inArray(hrCompensationItems.compensationVersionId, compensations.map((item) => item.id))) : [];
  const insurance = await db.select().from(hrInsuranceVersions).where(and(
    sql`${hrInsuranceVersions.validFrom} < ${period.end}`,
    sql`(${hrInsuranceVersions.validTo} IS NULL OR ${hrInsuranceVersions.validTo} > ${period.start})`,
  ));
  const insuranceRules = await listHrInsuranceContributionRules(db, period.start);
  const workerCompensations = await db.select().from(hrWorkerCompensationVersions).where(and(
    sql`${hrWorkerCompensationVersions.validFrom} < ${period.end}`,
    sql`(${hrWorkerCompensationVersions.validTo} IS NULL OR ${hrWorkerCompensationVersions.validTo} > ${period.start})`,
  ));
  const leaves = await db.select().from(hrLeaveRequests).where(and(
    eq(hrLeaveRequests.status, "approved"),
    sql`${hrLeaveRequests.startsOn} < ${period.end}`,
    sql`${hrLeaveRequests.endsOn} > ${period.start}`,
  ));
  const monthlyData = await listHrMonthlyEntriesForPayroll(db, period.start, period.end);
  const missingCompensation = employees.flatMap((employee) => overlapDays(period.start, period.end, employee.hiredOn, employee.endedOn)
    .filter((day) => !covering(compensations.filter((row) => row.employmentId === employee.employmentId), day))
    .map((day) => `${employee.employeeName}（${day}）`));
  if (missingCompensation.length) throw new HrError(400, `以下員工在部分任職日沒有有效薪資基準：${missingCompensation.slice(0, 10).join("、")}${missingCompensation.length > 10 ? "…" : ""}。`);
  const hourlyMissing = employees.flatMap((employee) => {
    const rows = compensations.filter((row) => row.employmentId === employee.employmentId);
    return overlapDays(period.start, period.end, employee.hiredOn, employee.endedOn)
      .filter((day) => covering(rows, day)?.payBasis === "hourly" && !monthlyData.hourly.some((entry) => entry.employmentId === employee.employmentId && entry.workDate === day))
      .map((day) => `${employee.employeeName}（${day}）`);
  });
  if (hourlyMissing.length) throw new HrError(400, `以下時薪員工尚未逐日登記工時或明確標記無工時：${hourlyMissing.slice(0, 10).join("、")}${hourlyMissing.length > 10 ? "…" : ""}。`);
  const missingWorkerCompensation = scheduledWorkerRows.flatMap((row) => !covering(workerCompensations.filter((item) => item.workerId === row.workerId), row.workDate) ? [`${row.workerName}（${row.workDate}）`] : []);
  if (missingWorkerCompensation.length) throw new HrError(400, `以下支援排班日期沒有有效薪資基準：${missingWorkerCompensation.slice(0, 10).join("、")}${missingWorkerCompensation.length > 10 ? "…" : ""}。`);
  const payrollAdjustments = await listHrPayrollAdjustmentsForPeriod(db, period.periodKey);
  const specialWorkdays = await listHrSpecialWorkdaysForPayroll(db, period.start, period.end);
  const periodStartUtc = taipeiMidnightUtc(period.start);
  const periodEndUtc = taipeiMidnightUtc(period.end);
  const overtime = await db.select().from(hrOvertimeRequests).where(and(
    eq(hrOvertimeRequests.status, "approved"),
    eq(hrOvertimeRequests.settlementKind, "pay"),
    sql`(${hrOvertimeRequests.requestedEnd} > ${periodStartUtc} AND ${hrOvertimeRequests.requestedStart} < ${periodEndUtc}) OR (${hrOvertimeRequests.actualStart} IS NOT NULL AND ${hrOvertimeRequests.actualEnd} > ${periodStartUtc} AND ${hrOvertimeRequests.actualStart} < ${periodEndUtc})`,
  ));
  const clocks = await db.select().from(hrClockEvents).where(and(
    sql`${hrClockEvents.occurredAt} >= ${periodStartUtc}`,
    sql`${hrClockEvents.occurredAt} < ${periodEndUtc}`,
  ));
  const bonusAssignmentRows = await db.select({
    versionId: sql<string>`${hrBonusPolicyVersions.id}`.as("bonus_assignment_version_id"),
    scopeId: sql<string>`${hrBonusPolicyVersions.scopeId}`.as("bonus_assignment_scope_id"),
    bonusKind: sql<HrBonusKind>`${hrBonusPolicyVersions.bonusKind}`.as("bonus_assignment_kind"),
    performancePeriod: sql<HrBonusPerformancePeriod>`${hrBonusPolicyVersions.performancePeriod}`.as("bonus_assignment_period"),
    ratePpm: sql<number>`${hrBonusPolicyVersions.ratePpm}`.as("bonus_assignment_rate"),
    guaranteeMinor: sql<number>`${hrBonusPolicyVersions.guaranteeMinor}`.as("bonus_assignment_guarantee"),
    memberId: sql<string>`${hrBonusPolicyMembers.id}`.as("bonus_assignment_member_id"),
    weightUnits: sql<number>`${hrBonusPolicyMembers.weightUnits}`.as("bonus_assignment_weight"),
    employmentId: sql<string>`${hrBonusPolicyMembers.employmentId}`.as("bonus_assignment_employment_id"),
    policyName: sql<string>`${hrBonusPolicies.name}`.as("bonus_assignment_name"),
  }).from(hrBonusPolicyMembers)
    .innerJoin(hrBonusPolicyVersions, eq(hrBonusPolicyVersions.id, hrBonusPolicyMembers.policyVersionId))
    .innerJoin(hrBonusPolicies, eq(hrBonusPolicies.id, hrBonusPolicyVersions.policyId))
    .where(and(
      eq(hrBonusPolicies.active, 1),
      sql`${hrBonusPolicyVersions.voidedAt} IS NULL`,
      sql`${hrBonusPolicyVersions.validFrom} < ${period.end}`,
      sql`(${hrBonusPolicyVersions.validTo} IS NULL OR ${hrBonusPolicyVersions.validTo} > ${period.start})`,
      sql`${hrBonusPolicyMembers.validFrom} < ${period.end}`,
      sql`(${hrBonusPolicyMembers.validTo} IS NULL OR ${hrBonusPolicyMembers.validTo} > ${period.start})`,
    ));
  const bonusScopeRows = await db.select({ policyVersionId: hrBonusPolicyVersionScopes.policyVersionId, scopeId: hrBonusPolicyVersionScopes.scopeId }).from(hrBonusPolicyVersionScopes);
  const bonusScopesByVersion = new Map<string, string[]>();
  for (const row of bonusScopeRows) bonusScopesByVersion.set(row.policyVersionId, [...(bonusScopesByVersion.get(row.policyVersionId) ?? []), row.scopeId]);
  const bonusAssignments: AssignedBonusPolicy[] = bonusAssignmentRows.map((row) => ({
    version: { id: row.versionId, scopeId: row.scopeId, scopeIds: bonusScopesByVersion.get(row.versionId) ?? [row.scopeId], bonusKind: normalizeBonusKind(row.bonusKind), performancePeriod: row.performancePeriod, ratePpm: row.ratePpm, guaranteeMinor: row.guaranteeMinor },
    member: { id: row.memberId, employmentId: row.employmentId, weightUnits: row.weightUnits },
    policyName: row.policyName,
  }));
  // D1 的多個讀取不是一個長交易；重新擷取來源並比對，避免試算讀到來源異動前後的混合版本。
  const sourceSnapshotBeforeCalculation = await getPayrollSourceSnapshot(db, {
    period,
    employmentIds: employees.map((employee) => employee.employmentId),
    workerIds: [...new Set(scheduledWorkerRows.map((row) => row.workerId))],
  });
  const previous = previousPeriod(period);
  /*
   * 獎金的兩個輸入：政策涵蓋的店在來源月份的每日出金，以及成員的已發布排班。
   * 排班只有個人績效用得到（業績只算本人排到的日子）；團體績效只看出金與權重。
   * 出金與排班都涵蓋前一個月，因為政策可以設定以前月業績計算。
   */
  const bonusScopeIds = [...new Set(bonusAssignments.flatMap((item) => item.version.scopeIds.length ? item.version.scopeIds : [item.version.scopeId]))];
  const bonusMemberIds = [...new Set(bonusAssignments.map((item) => item.member.employmentId))];
  const [payoutRows, bonusScheduleRows] = await Promise.all([
    listEffectiveDailyPayouts(db, { scopeIds: bonusScopeIds, start: previous.start, end: period.end }),
    bonusMemberIds.length
      ? db.select({ employmentId: hrScheduleEntries.employmentId, scopeId: hrScheduleEntries.scopeId, workDate: hrScheduleEntries.workDate }).from(hrScheduleEntries)
        .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleEntries.scheduleVersionId))
        .where(and(
          eq(hrScheduleVersions.status, "published"),
          // 一個月可能有多個已發布版本，只認每個月份編號最大的那一版。
          sql`${hrScheduleVersions.versionNumber} = (SELECT max(latest.version_number) FROM hr_schedule_versions AS latest WHERE latest.period_start = hr_schedule_versions.period_start AND latest.period_end = hr_schedule_versions.period_end AND latest.status = 'published')`,
          inArray(hrScheduleEntries.employmentId, bonusMemberIds),
          sql`${hrScheduleEntries.workDate} >= ${previous.start}`, sql`${hrScheduleEntries.workDate} < ${period.end}`,
        ))
      : Promise.resolve([]),
  ]);
  /*
   * 出金表存的是**新臺幣元**，薪資一律是分。換算只能在這一個邊界做：listEffectiveDailyPayouts
   * 也給報表用，報表要的是元。漏掉這個 ×100，獎金會安靜地少 100 倍——而且只要測試資料
   * 也寫成分，測試會跟著一起錯而照樣是綠的。
   */
  const payouts = new Map<string, number>(payoutRows.map((row) => [dayKey(row.scopeId, row.businessDate), row.payoutAmount * 100]));
  const bonusScheduledDays = new Map<string, Set<string>>();
  for (const row of bonusScheduleRows) {
    const days = bonusScheduledDays.get(row.employmentId) ?? new Set<string>();
    days.add(dayKey(row.scopeId, row.workDate));
    bonusScheduledDays.set(row.employmentId, days);
  }
  const membersByVersion = new Map<string, Array<{ employmentId: string; weightUnits: number }>>();
  for (const item of bonusAssignments) {
    membersByVersion.set(item.version.id, [...(membersByVersion.get(item.version.id) ?? []), { employmentId: item.member.employmentId, weightUnits: item.member.weightUnits }]);
  }
  const calendarDays = dateRange(period.start, period.end);
  const statementRows: Array<{ employee: HrPayrollEmployeeResult; payslipId: string; lines: HrPayrollLineResult[]; compensationIds: string[]; insuranceIds: string[] }> = [];
  const calculationWarnings = new Set<string>();
  type WorkerStatement = { workerId: string; workerName: string; payBasis: "monthly" | "daily" | "hourly" | "mixed"; scheduledDays: number; amountMinor: number; compensationVersionId: string | null };
  const workerStatements = new Map<string, WorkerStatement>();
  const workerRowsById = new Map<string, typeof scheduledWorkerRows>();
  for (const row of scheduledWorkerRows) workerRowsById.set(row.workerId, [...(workerRowsById.get(row.workerId) ?? []), row]);
  for (const [workerId, rows] of workerRowsById) {
    const workerName = rows[0]!.workerName;
    const dates = [...new Set(rows.map((row) => row.workDate))].sort();
    const workerCompensationsForPeriod = workerCompensations.filter((item) => item.workerId === workerId);
    const compensationIds = new Set<string>();
    const payBases = new Set<"monthly" | "daily" | "hourly">();
    let amountMinor = 0;
    let missingCompensation = false;
    for (const date of dates) {
      const dateRows = rows.filter((row) => row.workDate === date);
      const compensation = covering(workerCompensationsForPeriod, date);
      if (!compensation) {
        missingCompensation = true;
        continue;
      }
      compensationIds.add(compensation.id);
      payBases.add(compensation.payBasis);
      const special = specialWorkdays.find((item) => item.workerId === workerId && item.workDate === date);
      if (special) {
        const hours = dateRows.reduce((sum, row) => sum + scheduledHours(row), 0);
        if (!hours) calculationWarnings.add(`${workerName} 的特殊上班日 ${date} 缺少工時資料，薪資列為異常且不自動補 0。`);
        else if (special.wageKindSnapshot === "fixed_hourly" && special.fixedAmountMinorSnapshot !== null) amountMinor += Math.round(special.fixedAmountMinorSnapshot * hours);
        else if (special.multiplierPpmSnapshot !== null) amountMinor += Math.floor((compensation.payBasis === "monthly" ? Math.floor(compensation.baseAmountMinor / monthlyDivisorDays) : compensation.baseAmountMinor) * special.multiplierPpmSnapshot / PPM);
        if (special.allowanceQuantity) amountMinor += (JSON.parse(special.allowanceSnapshotJson) as Array<{ unitAmountMinor: number }>).reduce((sum, item) => sum + item.unitAmountMinor * special.allowanceQuantity, 0);
      } else if (compensation.payBasis === "monthly") {
        amountMinor += Math.floor(compensation.baseAmountMinor / monthlyDivisorDays);
      } else if (compensation.payBasis === "daily") {
        amountMinor += compensation.baseAmountMinor;
      } else {
        amountMinor += dateRows.reduce((sum, row) => sum + Math.round(compensation.baseAmountMinor * scheduledHours(row)), 0);
      }
    }
    if (missingCompensation) calculationWarnings.add(`${workerName} 有排班日期找不到有效的支援人員敘薪，該日期薪資為 0。`);
    const payBasis = payBases.size === 1 ? [...payBases][0]! : payBases.size > 1 ? "mixed" : "daily";
    workerStatements.set(workerId, {
      workerId, workerName, payBasis, scheduledDays: dates.length, amountMinor,
      compensationVersionId: compensationIds.size === 1 ? [...compensationIds][0]! : null,
    });
  }

  for (const employee of employees) {
    const employmentDays = overlapDays(period.start, period.end, employee.hiredOn, employee.endedOn);
    const employeeCompensations = compensations.filter((row) => row.employmentId === employee.employmentId);
    const lines: HrPayrollLineResult[] = [];
    let baseMinor = 0;
    let specialMinor = 0;
    const baseCalculationParts = new Map<string, { payBasis: "monthly" | "daily" | "hourly"; baseAmountMinor: number; dayCount: number; hours: number; amountMinor: number; fullMonth: boolean; specialDailyBaseMinor: number }>();
    const specialCalculationParts: PayrollCalculationPart[] = [];
    const compensationItemTotals = new Map<string, number>();
    const itemCalculationParts = new Map<string, { amountBasis: "monthly" | "daily" | "hourly"; baseAmountMinor: number; quantity: number; quantityUnit: "個月" | "天" | "小時"; amountMinor: number; fullMonth: boolean }>();
    const dailyMonthlyItems = new Map<string, (typeof compensationItems)[number]>();
    const specialAssignments = specialWorkdays.filter((item) => item.employmentId === employee.employmentId);
    const scheduledDates = scheduledDatesByEmployment.get(employee.employmentId) ?? new Set<string>();
    const specialDates = new Set(specialAssignments.map((item) => item.workDate));
    if (employeeCompensations.some((item) => item.payBasis === "daily") && scheduledDates.size === 0) {
      calculationWarnings.add(`${employee.employeeName} 為日薪制但本期沒有已發布排班，薪資為 0。`);
    }
    for (const day of employmentDays) {
      const compensation = covering(employeeCompensations, day);
      if (!compensation) continue;
      // 日薪是買「已發布的工作日」，不能把整段任職期間誤當成出勤日；特殊上班日則由明確套用資料保留計薪機會。
      if (compensation.payBasis === "daily" && !scheduledDates.has(day) && !specialDates.has(day)) continue;
      const special = specialAssignments.find((item) => item.workDate === day);
      if (special) {
        let hours = 0;
        if (special.workSourceSnapshot === "hourly") {
          const entry = monthlyData.hourly.find((item) => item.employmentId === employee.employmentId && item.workDate === day);
          hours = entry && !entry.noWork ? entry.hoursHalfUnits / 2 : 0;
        } else if (special.workSourceSnapshot === "schedule") {
          const scheduleRows = await db.select({ startsAt: hrScheduleEntries.startsAt, endsAt: hrScheduleEntries.endsAt, standardMinutes: hrScheduleEntries.standardMinutes }).from(hrScheduleEntries)
            .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleEntries.scheduleVersionId))
            .where(and(eq(hrScheduleEntries.employmentId, employee.employmentId), eq(hrScheduleEntries.workDate, day), eq(hrScheduleVersions.status, "published"), eq(hrScheduleVersions.periodStart, period.start), eq(hrScheduleVersions.periodEnd, period.end), sql`${hrScheduleVersions.versionNumber} = (SELECT max(latest_schedule_version.version_number) FROM hr_schedule_versions AS latest_schedule_version WHERE latest_schedule_version.period_start = ${period.start} AND latest_schedule_version.period_end = ${period.end} AND latest_schedule_version.status = 'published')`));
          hours = scheduleRows.reduce((sum, row) => sum + scheduledHours(row), 0);
        }
        if (hours <= 0) calculationWarnings.add(`${employee.employeeName} 的特殊上班日 ${day} 缺少工時資料，薪資列為異常且不自動補 0。`);
        else if (special.wageKindSnapshot === "fixed_hourly" && special.fixedAmountMinorSnapshot !== null) {
          const amount = Math.round(special.fixedAmountMinorSnapshot * hours);
          specialMinor += amount;
          specialCalculationParts.push({ formula: `${day}：round(${payrollFormulaMoney(special.fixedAmountMinorSnapshot)} × ${payrollFormulaHours(hours)} 小時)`, amountMinor: amount });
        } else if (special.multiplierPpmSnapshot !== null) {
          const dailyBase = compensation.payBasis === "monthly" ? Math.floor(compensation.baseAmountMinor / monthlyDivisorDays) : compensation.payBasis === "daily" ? compensation.baseAmountMinor : Math.round(compensation.baseAmountMinor * hours);
          const amount = Math.floor(dailyBase * special.multiplierPpmSnapshot / PPM);
          specialMinor += amount;
          specialCalculationParts.push({ formula: `${day}：floor(${payrollFormulaMoney(dailyBase)} × ${payrollFormulaPercent(special.multiplierPpmSnapshot)})`, amountMinor: amount });
        }
      } else if (compensation.payBasis === "monthly") {
        const amount = Math.floor(compensation.baseAmountMinor / monthlyDivisorDays);
        baseMinor += amount;
        const current = baseCalculationParts.get(compensation.id) ?? { payBasis: compensation.payBasis, baseAmountMinor: compensation.baseAmountMinor, dayCount: 0, hours: 0, amountMinor: 0, fullMonth: false, specialDailyBaseMinor: 0 };
        current.dayCount += 1;
        current.amountMinor += amount;
        baseCalculationParts.set(compensation.id, current);
      } else if (compensation.payBasis === "daily") {
        baseMinor += compensation.baseAmountMinor;
        const current = baseCalculationParts.get(compensation.id) ?? { payBasis: compensation.payBasis, baseAmountMinor: compensation.baseAmountMinor, dayCount: 0, hours: 0, amountMinor: 0, fullMonth: false, specialDailyBaseMinor: 0 };
        current.dayCount += 1;
        current.amountMinor += compensation.baseAmountMinor;
        baseCalculationParts.set(compensation.id, current);
      } else {
        const entry = monthlyData.hourly.find((item) => item.employmentId === employee.employmentId && item.workDate === day);
        if (entry && !entry.noWork) {
          const hours = entry.hoursHalfUnits / 2;
          const amount = Math.round(compensation.baseAmountMinor * hours);
          baseMinor += amount;
          const current = baseCalculationParts.get(compensation.id) ?? { payBasis: compensation.payBasis, baseAmountMinor: compensation.baseAmountMinor, dayCount: 0, hours: 0, amountMinor: 0, fullMonth: false, specialDailyBaseMinor: 0 };
          current.dayCount += 1;
          current.hours += hours;
          current.amountMinor += amount;
          baseCalculationParts.set(compensation.id, current);
        }
      }
      const entry = monthlyData.hourly.find((item) => item.employmentId === employee.employmentId && item.workDate === day);
      const itemHours = entry && !entry.noWork ? entry.hoursHalfUnits / 2 : 0;
      for (const item of compensationItems.filter((candidate) => candidate.compensationVersionId === compensation.id)) {
        /*
         * 日薪人員的月給項目整月照發，不按上班天數比例折算：日薪人員本來就只有排班日才進這個迴圈，
         * 按比例等於每個月都被扣一大截。以項目名稱為鍵、後面的版本覆蓋前面的，月中換敘薪版本
         * 才不會同一個津貼發兩次；一天都沒排班的月份不會進到這裡，也就不發。
         */
        if (compensation.payBasis === "daily" && item.amountBasis === "monthly") {
          dailyMonthlyItems.set(item.itemName, item);
          continue;
        }
        // 每一筆項目自己決定單位：月給的津貼不能因為員工是日薪就每個工作日再加一次。
        const itemAmount = item.amountBasis === "monthly"
          ? Math.floor(item.amountMinor / monthlyDivisorDays)
          : item.amountBasis === "daily"
            ? dailyItemAppliesOnWorkday(employee.attendanceMode, compensation.payBasis, day, scheduledDates, specialDates) ? item.amountMinor : 0
            : Math.round(item.amountMinor * itemHours);
        compensationItemTotals.set(item.id, (compensationItemTotals.get(item.id) ?? 0) + itemAmount);
        if (itemAmount > 0) {
          const quantity = item.amountBasis === "hourly" ? itemHours : 1;
          const current = itemCalculationParts.get(item.id) ?? { amountBasis: item.amountBasis, baseAmountMinor: item.amountMinor, quantity: 0, quantityUnit: item.amountBasis === "hourly" ? "小時" : "天", amountMinor: 0, fullMonth: false };
          current.quantity += quantity;
          current.amountMinor += itemAmount;
          itemCalculationParts.set(item.id, current);
        }
      }
    }
    for (const item of dailyMonthlyItems.values()) {
      compensationItemTotals.set(item.id, item.amountMinor);
      itemCalculationParts.set(item.id, { amountBasis: item.amountBasis, baseAmountMinor: item.amountMinor, quantity: 1, quantityUnit: "個月", amountMinor: item.amountMinor, fullMonth: false });
    }
    // 避免每一天 floor 造成完整月份少幾分：完整月份同一版月薪直接保留原額。
    const fullMonthComp = covering(employeeCompensations, period.start);
    if (fullMonthComp?.payBasis === "monthly" && fullMonthComp.validFrom <= period.start && (fullMonthComp.validTo === null || fullMonthComp.validTo >= period.end)) {
      const employedDays = employeeDaysForPeriod(employee, period);
      const fullMonthBase = Math.round(fullMonthComp.baseAmountMinor * employedDays / monthlyDivisorDays);
      const specialDailyBase = specialAssignments.filter((item) => employmentDays.includes(item.workDate)).reduce((sum) => sum + Math.floor(fullMonthComp.baseAmountMinor / monthlyDivisorDays), 0);
      baseMinor = Math.max(0, fullMonthBase - specialDailyBase);
      baseCalculationParts.clear();
      baseCalculationParts.set(fullMonthComp.id, { payBasis: "monthly", baseAmountMinor: fullMonthComp.baseAmountMinor, dayCount: employedDays, hours: 0, amountMinor: baseMinor, fullMonth: true, specialDailyBaseMinor: specialDailyBase });
      // 只有月給的項目要跟著本薪一起用整月金額回推；日給與時給仍是上面逐日累加的結果。
      for (const item of compensationItems.filter((candidate) => candidate.compensationVersionId === fullMonthComp.id && candidate.amountBasis === "monthly")) {
        const amount = Math.round(item.amountMinor * employedDays / monthlyDivisorDays);
        compensationItemTotals.set(item.id, amount);
        itemCalculationParts.set(item.id, { amountBasis: item.amountBasis, baseAmountMinor: item.amountMinor, quantity: employedDays, quantityUnit: "天", amountMinor: amount, fullMonth: true });
      }
    }
    let compensationItemLineNumber = 0;
    for (const [itemId, amount] of compensationItemTotals) {
      const item = compensationItems.find((candidate) => candidate.id === itemId);
      if (!item || amount <= 0) continue;
      compensationItemLineNumber += 1;
      const calculation = itemCalculationParts.get(item.id);
      const itemParts: PayrollCalculationPart[] = calculation ? [{
        formula: calculation.fullMonth
          ? `round(月給 ${payrollFormulaMoney(calculation.baseAmountMinor)} × ${calculation.quantity} 天 ÷ ${monthlyDivisorDays} 天)`
          : calculation.quantityUnit === "個月"
            ? `月給 ${payrollFormulaMoney(calculation.baseAmountMinor)} × 1 個月`
            : item.amountBasis === "monthly"
              ? `每日 floor(${payrollFormulaMoney(calculation.baseAmountMinor)} ÷ ${monthlyDivisorDays} 天) × ${calculation.quantity} 天`
              : item.amountBasis === "daily"
                ? `每日項目 ${payrollFormulaMoney(calculation.baseAmountMinor)} × ${calculation.quantity} 天`
                : `Σ round(時薪項目 ${payrollFormulaMoney(calculation.baseAmountMinor)} × 每日工時)（合計 ${payrollFormulaHours(calculation.quantity)} 小時）`,
        amountMinor: calculation.amountMinor,
      }] : [];
      lines.push({ lineKey: `salary_item_${compensationItemLineNumber}`, direction: "earning", amountMinor: amount, explanation: {
        itemName: item.itemName, itemKind: item.itemKind, amountBasis: item.amountBasis,
        includeOvertime: Boolean(item.includeOvertime), includeInsurance: Boolean(item.includeInsurance), includeTax: Boolean(item.includeTax),
        calculationParts: itemParts, formulaDetail: payrollFormulaTotal(itemParts, amount),
      } });
    }
    if (fullMonthComp?.payBasis === "hourly" && !monthlyData.hourly.some((item) => item.employmentId === employee.employmentId)) {
      calculationWarnings.add(`${employee.employeeName} 為時薪制但尚未登記本期工時；請登記工時或明確標記本期無工時。`);
    }
    if (baseMinor > 0) {
      const baseParts: PayrollCalculationPart[] = [...baseCalculationParts.values()]
        .filter((part) => part.amountMinor > 0)
        .map((part) => ({
          formula: part.fullMonth
            ? `round(月薪 ${payrollFormulaMoney(part.baseAmountMinor)} × ${part.dayCount} 天 ÷ ${monthlyDivisorDays} 天)${part.specialDailyBaseMinor ? ` − 特殊日替代基薪 ${payrollFormulaMoney(part.specialDailyBaseMinor)}` : ""}`
            : part.payBasis === "monthly"
              ? `每日 floor(${payrollFormulaMoney(part.baseAmountMinor)} ÷ ${monthlyDivisorDays} 天) × ${part.dayCount} 天`
              : part.payBasis === "daily"
                ? `日薪 ${payrollFormulaMoney(part.baseAmountMinor)} × ${part.dayCount} 天`
                : `Σ round(時薪 ${payrollFormulaMoney(part.baseAmountMinor)} × 每日工時)（合計 ${payrollFormulaHours(part.hours)} 小時）`,
          amountMinor: part.amountMinor,
        }));
      lines.push({ lineKey: "base_salary", direction: "earning", amountMinor: baseMinor, explanation: {
        payBasis: fullMonthComp?.payBasis ?? "unknown", period: input.periodKey,
        rule: fullMonthComp?.payBasis === "hourly" ? "依月度人工工時登記（0.5 小時單位）" : fullMonthComp?.payBasis === "daily" ? "依已發布排班日期計算；特殊上班日依套用資料" : "月薪固定以 30 日制按在職日數計算",
        calculationParts: baseParts, formulaDetail: payrollFormulaTotal(baseParts, baseMinor),
      } });
    }
    if (specialMinor > 0) lines.push({ lineKey: "special_workday", direction: "earning", amountMinor: specialMinor, explanation: {
      rule: "特殊上班日取代當日基本薪資", assignmentIds: specialAssignments.map((item) => item.id),
      calculationParts: specialCalculationParts, formulaDetail: payrollFormulaTotal(specialCalculationParts, specialMinor),
    } });
    for (const [index, special] of specialAssignments.entries()) {
      if (!special.allowanceQuantity) continue;
      const allowances = JSON.parse(special.allowanceSnapshotJson) as Array<{ itemName: string; unitAmountMinor: number }>;
      const allowanceTotal = allowances.reduce((sum, item) => sum + item.unitAmountMinor * special.allowanceQuantity, 0);
      if (allowanceTotal > 0) {
        const unitFormula = allowances.map((item) => `${item.itemName} ${payrollFormulaMoney(item.unitAmountMinor)}`).join(" + ");
        const allowancePart = { formula: `${special.workDate}：(${unitFormula}) × ${special.allowanceQuantity} 次`, amountMinor: allowanceTotal };
        lines.push({ lineKey: `special_allowance_${index + 1}`, direction: "earning", amountMinor: allowanceTotal, explanation: {
          rule: special.ruleNameSnapshot, quantity: special.allowanceQuantity, allowances: special.allowanceSnapshotJson,
          calculationParts: [allowancePart], formulaDetail: payrollFormulaTotal([allowancePart], allowanceTotal),
        } });
      }
    }

    let bonusLineNumber = 0;
    for (const assignment of bonusAssignments.filter((item) => item.member.employmentId === employee.employmentId)) {
      const bonus = calculateAssignedBonus(assignment, period, payouts, bonusScheduledDays, membersByVersion.get(assignment.version.id) ?? []);
      const monthLabel = assignment.version.performancePeriod === "previous_month" ? "前月" : "當月";
      /*
       * 缺出金資料不是「獎金剛好是 0」，是「算不出來」。這兩件事在薪資單上長得一樣，
       * 所以一定要講出來——出金表還沒匯入就發薪，少的錢沒有人會主動回來補。
       */
      // scheduledDays 只有個人績效會是數字；團體績效不看排班，不該因為沒排班而提醒。
      if (bonus.scheduledDays === 0) {
        calculationWarnings.add(`${employee.employeeName} 的「${assignment.policyName}」在${monthLabel}沒有涵蓋通路的已發布排班，獎金為 0。`);
      } else if (bonus.missingPayoutDates.length) {
        calculationWarnings.add(`${employee.employeeName} 的「${assignment.policyName}」有 ${bonus.missingPayoutDates.length} 天缺少${monthLabel}出金資料（${bonus.missingPayoutDates.slice(0, 3).join("、")}${bonus.missingPayoutDates.length > 3 ? " 等" : ""}），這幾天按 0 計算。請先完成出金表匯入再重新試算。`);
      }
      if (bonus.amountMinor > 0) {
        bonusLineNumber += 1;
        const bonusBaseFormula = `max(0, ${payrollFormulaMoney(bonus.revenueMinor)} − ${payrollFormulaMoney(assignment.version.guaranteeMinor)}) × ${payrollFormulaPercent(assignment.version.ratePpm)}`;
        const bonusFormulaDetail = assignment.version.bonusKind === "individual_performance"
          ? `${bonusBaseFormula} = ${payrollFormulaMoney(bonus.amountMinor)}（四捨五入至元）`
          : `${bonusBaseFormula} × 本人權重 ${assignment.member.weightUnits} ÷ 全體權重 ${bonus.weightedTotal} = ${payrollFormulaMoney(bonus.amountMinor)}（每人最後四捨五入至元；顯示獎金池 ${payrollFormulaMoney(bonus.poolAmountMinor)}）`;
        lines.push({ lineKey: `bonus_${bonusLineNumber}`, direction: "earning", amountMinor: bonus.amountMinor, explanation: {
          policyName: assignment.policyName,
          policyVersionId: assignment.version.id,
          policyMemberId: assignment.member.id,
          bonusKind: assignment.version.bonusKind,
          performancePeriod: assignment.version.performancePeriod,
          revenueMinor: bonus.revenueMinor,
          poolAmountMinor: bonus.poolAmountMinor,
          scheduledDays: bonus.scheduledDays,
          weightUnits: assignment.member.weightUnits,
          weightedTotal: bonus.weightedTotal,
          missingPayoutDates: bonus.missingPayoutDates,
          guaranteeMinor: assignment.version.guaranteeMinor,
          ratePpm: assignment.version.ratePpm,
          formula: bonus.formula,
          formulaDetail: bonusFormulaDetail,
          rounding: "nearest_ntd_dollar",
        } });
      }
    }

    const adjustmentRows = payrollAdjustments.get(employee.employmentId) ?? [];
    adjustmentRows.forEach(({ adjustment, item }, index) => {
      const amount = Math.abs(item.amountMinor);
      if (!amount) return;
      lines.push({ lineKey: `adjustment_${index + 1}`, direction: item.amountMinor >= 0 ? "earning" : "deduction", amountMinor: amount, explanation: {
        adjustmentId: adjustment.id, itemName: item.itemName, sourcePeriodKey: adjustment.sourcePeriodKey, reason: adjustment.reason,
        formulaDetail: `人工調整（來源 ${adjustment.sourcePeriodKey}） = ${payrollFormulaMoney(amount)}`,
      } });
    });

    const employeeOvertime = overtime.filter((row) => row.employmentId === employee.employmentId).sort((left, right) => {
      const leftStart = left.actualStart ?? left.requestedStart;
      const rightStart = right.actualStart ?? right.requestedStart;
      return leftStart.localeCompare(rightStart) || (left.actualEnd ?? left.requestedEnd).localeCompare(right.actualEnd ?? right.requestedEnd);
    });
    let overtimeMinor = 0;
    let overtimeSeconds = 0;
    const overtimeCalculationParts: PayrollCalculationPart[] = [];
    const overtimeElapsedByDate = new Map<string, number>();
    const specialWorkdayRuleSnapshots = new Map<string, { workDate: string; ruleVersionId: string; overtimeRules: Array<{ fromHalfHours: number; toHalfHours: number | null; rateKind: "fixed_hourly" | "multiplier"; fixedAmountMinor: number | null; multiplierPpm: number | null }> }>();
    for (const row of employeeOvertime) {
      const start = row.actualStart ?? row.requestedStart;
      const end = row.actualEnd ?? row.requestedEnd;
      const clippedStart = start > periodStartUtc ? start : periodStartUtc;
      const clippedEnd = end < periodEndUtc ? end : periodEndUtc;
      if (!secondsBetween(clippedStart, clippedEnd)) continue;
      for (const segment of splitOvertimeByTaipeiDate(clippedStart, clippedEnd)) {
        const special = specialAssignments.find((item) => item.workDate === segment.date);
        if (special) specialWorkdayRuleSnapshots.set(`${segment.date}:${special.ruleVersionId}`, {
          workDate: segment.date,
          ruleVersionId: special.ruleVersionId,
          overtimeRules: special.overtimeRules.map((rule) => ({ fromHalfHours: rule.fromHalfHours, toHalfHours: rule.toHalfHours, rateKind: rule.rateKind, fixedAmountMinor: rule.fixedAmountMinor, multiplierPpm: rule.multiplierPpm })),
        });
        // 級距以同一台北工作日的累計核准加班時數套用，不能每筆申請都重新從第一級開始。
        const elapsedSeconds = overtimeElapsedByDate.get(segment.date) ?? 0;
        const chunks = splitOvertimeBySpecialRules(segment.seconds, special?.overtimeRules ?? [], elapsedSeconds);
        overtimeElapsedByDate.set(segment.date, elapsedSeconds + segment.seconds);
        for (const chunk of chunks) {
          const compensation = covering(employeeCompensations, segment.date) ?? fullMonthComp;
          const hourly = compensation?.payBasis === "monthly"
            ? Math.floor(compensation.baseAmountMinor / monthlyDivisorDays / standardDailyHours)
            : compensation?.payBasis === "daily" ? Math.floor(compensation.baseAmountMinor / standardDailyHours) : compensation?.baseAmountMinor ?? 0;
          const itemHourly = compensation ? compensationItems.filter((item) => item.compensationVersionId === compensation.id && item.includeOvertime).reduce((sum, item) => sum + (item.amountBasis === "monthly" ? Math.floor(item.amountMinor / monthlyDivisorDays / standardDailyHours) : item.amountBasis === "daily" ? Math.floor(item.amountMinor / standardDailyHours) : item.amountMinor), 0) : 0;
          const ratePpm = chunk.rule?.rateKind === "multiplier" ? chunk.rule.multiplierPpm! : row.ratePpm;
          const overtimeAmount = chunk.rule?.rateKind === "fixed_hourly"
            ? Math.floor(chunk.rule.fixedAmountMinor! * chunk.seconds / 3600)
            : Math.floor((hourly + itemHourly) * chunk.seconds / 3600 * ratePpm / PPM);
          overtimeMinor += overtimeAmount;
          overtimeSeconds += chunk.seconds;
          if (overtimeAmount > 0) overtimeCalculationParts.push({
            formula: chunk.rule?.rateKind === "fixed_hourly"
              ? `${segment.date}：特殊日固定時薪 ${payrollFormulaMoney(chunk.rule.fixedAmountMinor!)} × ${payrollFormulaHours(chunk.seconds / 3600)} 小時`
              : `${segment.date}：floor((${payrollFormulaMoney(hourly)}${itemHourly ? ` + ${payrollFormulaMoney(itemHourly)}` : ""}) × ${payrollFormulaHours(chunk.seconds / 3600)} 小時 × ${payrollFormulaPercent(ratePpm)})`,
            amountMinor: overtimeAmount,
          });
        }
      }
    }
    if (overtimeSeconds > 0) lines.push({ lineKey: "overtime", direction: "earning", amountMinor: overtimeMinor, quantitySeconds: overtimeSeconds, explanation: {
      approvedRequests: employeeOvertime.length, monthlyDivisorDays, standardDailyHours,
      specialWorkdayRuleSnapshots: [...specialWorkdayRuleSnapshots.values()],
      calculationParts: overtimeCalculationParts, formulaDetail: payrollFormulaTotal(overtimeCalculationParts, overtimeMinor),
    } });

    const monthlyLeaves = monthlyData.leaves.filter((row) => row.employmentId === employee.employmentId);
    let leaveDeduction = 0;
    const leaveCalculationParts: PayrollCalculationPart[] = [];
    if (monthlyLeaves.length) {
      // 月度人工登記的扣款以整數元保存，直接轉成薪資內部的分；給薪比例只作核對資訊。
      for (const leave of monthlyLeaves) {
        const amount = leave.deductionAmount * 100;
        leaveDeduction += amount;
        if (amount > 0) leaveCalculationParts.push({ formula: `${leave.leaveDate} 月度登記扣款`, amountMinor: amount });
      }
    } else {
      // 舊 hr_leave_requests 只作歷史相容；新月份資料存在時不與人工登記重複扣款。
      for (const leave of leaves.filter((row) => row.employmentId === employee.employmentId)) {
        if (leave.payRatePpm >= PPM) continue;
        for (const day of overlapDays(period.start, period.end, leave.startsOn, leave.endsOn)) {
          const compensation = covering(employeeCompensations, day);
          if (!compensation) continue;
          const daily = compensation.payBasis === "monthly"
            ? Math.floor(compensation.baseAmountMinor / monthlyDivisorDays)
            : compensation.payBasis === "daily" ? compensation.baseAmountMinor : Math.round(compensation.baseAmountMinor * standardDailyHours);
          const amount = Math.floor(daily * (PPM - leave.payRatePpm) / PPM);
          leaveDeduction += amount;
          if (amount > 0) leaveCalculationParts.push({ formula: `floor(${leave.leaveType} ${day}：${payrollFormulaMoney(daily)} × ${payrollFormulaPercent(PPM - leave.payRatePpm)})`, amountMinor: amount });
        }
      }
    }
    if (leaveDeduction > 0) lines.push({ lineKey: "unpaid_leave", direction: "deduction", amountMinor: leaveDeduction, explanation: {
      rule: monthlyLeaves.length ? "月度人工扣款（整數元）" : "使用請假提交時凍結的 payRatePpm", period: input.periodKey, entryCount: monthlyLeaves.length,
      calculationParts: leaveCalculationParts, formulaDetail: payrollFormulaTotal(leaveCalculationParts, leaveDeduction),
    } });

    const employeeClocks = clocks.filter((row) => row.employmentId === employee.employmentId);
    const attendanceDays = new Set(employeeClocks.map((row) => taipeiDate(row.occurredAt)));
    const missingPunchDays = calendarDays.filter((day) => employeeClocks.filter((row) => taipeiDate(row.occurredAt) === day).length === 1);
    const compensationIds = employeeCompensations.filter((row) => row.validFrom < period.end && (row.validTo === null || row.validTo > period.start)).map((row) => row.id);
    const insuranceIds = insurance.filter((row) => row.employmentId === employee.employmentId).map((row) => row.id);
    const employeeInsurance = insurance.filter((row) => row.employmentId === employee.employmentId && row.status === "enrolled");
    for (const scheme of ["labor", "health"] as const) {
      const insuranceVersion = covering(employeeInsurance.filter((row) => row.scheme === scheme), period.start);
      const contributionRule = covering(insuranceRules.filter((row) => row.scheme === scheme), period.start);
      if (!insuranceVersion || insuranceVersion.status !== "enrolled") continue;
      if (!contributionRule) {
        calculationWarnings.add(`${employee.employeeName} 的${scheme === "labor" ? "勞保" : "健保"}缺少有效負擔規則，請在保險設定完成審閱。`);
        continue;
      }
      const employeeShare = calculateHrInsuranceEmployeeAmount({
        scheme,
        insuredAmountMinor: insuranceVersion.insuredAmountMinor,
        employeeRatePpm: contributionRule.employeeRatePpm,
        dependentRatePpm: contributionRule.dependentRatePpm,
        dependentCount: insuranceVersion.dependentCount,
      });
      if (employeeShare > 0) {
        const baseEmployeeAmountMinor = Math.floor(insuranceVersion.insuredAmountMinor * contributionRule.employeeRatePpm / PPM);
        const baseEmployeeAmountYuan = Math.round(baseEmployeeAmountMinor / 100);
        const dependentMultiplier = scheme === "health" ? 1 + insuranceVersion.dependentCount * contributionRule.dependentRatePpm / PPM : 1;
        const baseFormula = `floor(${payrollFormulaMoney(insuranceVersion.insuredAmountMinor)} × ${payrollFormulaPercent(contributionRule.employeeRatePpm)}) 先四捨五入至元 = ${payrollFormulaMoney(baseEmployeeAmountYuan * 100)}`;
        const dependentMultiplierLabel = dependentMultiplier.toFixed(4).replace(/\.?0+$/, "");
        const formulaDetail = scheme === "health"
          ? `${baseFormula} × ${dependentMultiplierLabel}（本人 1 + ${insuranceVersion.dependentCount} 位親屬 × ${payrollFormulaPercent(contributionRule.dependentRatePpm)}） = ${payrollFormulaMoney(employeeShare)}`
          : `${baseFormula} = ${payrollFormulaMoney(employeeShare)}`;
        lines.push({ lineKey: `${scheme}_insurance`, direction: "deduction", amountMinor: employeeShare, explanation: {
          scheme, insuredAmountMinor: insuranceVersion.insuredAmountMinor, dependentCount: insuranceVersion.dependentCount,
          employeeRatePpm: contributionRule.employeeRatePpm, dependentRatePpm: contributionRule.dependentRatePpm,
          baseEmployeeAmountMinor, baseEmployeeAmountYuan, dependentMultiplier, ruleId: contributionRule.id, sourceKind: contributionRule.sourceKind,
          formulaDetail,
        } });
      }
    }
    lines.push({ lineKey: "attendance_summary", direction: "earning", amountMinor: 0, explanation: { attendanceDays: attendanceDays.size, missingPunchDays: missingPunchDays.length } });
    const earningMinor = lines.filter((line) => line.direction === "earning").reduce((sum, line) => sum + line.amountMinor, 0);
    const deductionMinor = lines.filter((line) => line.direction === "deduction").reduce((sum, line) => sum + line.amountMinor, 0);
    statementRows.push({
      payslipId: crypto.randomUUID(),
      employee: { employmentId: employee.employmentId, employeeUserId: employee.employeeUserId, employeeNumber: employee.employeeNumber, employeeName: employee.employeeName, lines, earningMinor, deductionMinor, netMinor: earningMinor - deductionMinor, attendanceDays: attendanceDays.size, missingPunchDays: missingPunchDays.length },
      lines,
      compensationIds,
      insuranceIds,
    });
  }

  const sourceSnapshotJson = await getPayrollSourceSnapshot(db, {
    period,
    employmentIds: employees.map((employee) => employee.employmentId),
    workerIds: [...workerRowsById.keys()],
  });
  if (sourceSnapshotJson !== sourceSnapshotBeforeCalculation) throw new HrError(409, "薪資來源在試算期間發生變更，請重新試算後再試。 ");
  const calculationInputJson = JSON.stringify({
    periodKey: input.periodKey,
    payDate,
    employeeUserIds: input.employeeUserIds ?? null,
    attendanceMode: input.attendanceMode ?? "all",
    monthlyDivisorDays,
    standardDailyHours,
  });
  const [latest] = await db.select({ value: sql<number>`coalesce(max(${hrPayrollRuns.versionNumber}), 0)` }).from(hrPayrollRuns).where(eq(hrPayrollRuns.payrollPeriodId, `payroll-period-${period.periodKey}`));
  const runId = crypto.randomUUID();
  const requestId = input.requestId ?? crypto.randomUUID();
  const versionNumber = Number(latest?.value ?? 0) + 1;
  const periodInsert = db.insert(hrPayrollPeriods).values({ id: `payroll-period-${period.periodKey}`, periodKey: period.periodKey, attendanceStart: period.start, attendanceEnd: period.end, payDate, createdBy: actor.id }).onConflictDoNothing();
  const totalResults = statementRows.length + workerStatements.size;
  const runInsert = db.insert(hrPayrollRuns).values({ id: runId, payrollPeriodId: `payroll-period-${period.periodKey}`, versionNumber, requestId, inputRevision: Math.max(1, ...employees.map((employee) => employee.employeeRevision)), payDate, calculationInputJson, sourceSnapshotJson, warningsJson: JSON.stringify([...calculationWarnings]), engineVersion: "hr-payroll-demo-v1", status: "ready", expectedCount: totalResults, completedCount: totalResults, createdBy: actor.id });
  const statements = [periodInsert, runInsert, ...statementRows.flatMap(({ payslipId, employee, lines, compensationIds, insuranceIds }) => [
    db.insert(hrPayrollRunEmployees).values({ payrollRunId: runId, employmentId: employee.employmentId, inputRevision: 1, status: "succeeded" }),
    db.insert(hrPayslips).values({ id: payslipId, payrollRunId: runId, employmentId: employee.employmentId, employeeNumber: employee.employeeNumber, employeeName: employee.employeeName, earningMinor: employee.earningMinor, deductionMinor: employee.deductionMinor, netMinor: employee.netMinor }),
    ...lines.map((line) => db.insert(hrPayslipLines).values({ id: crypto.randomUUID(), payslipId, lineKey: line.lineKey, direction: line.direction, amountMinor: line.amountMinor, quantitySeconds: line.quantitySeconds ?? null, explanationJson: JSON.stringify(line.explanation) })),
    ...compensationIds.map((id) => db.insert(hrPayslipCompensationLinks).values({ payslipId, compensationVersionId: id })),
    ...insuranceIds.map((id) => db.insert(hrPayslipInsuranceLinks).values({ payslipId, insuranceVersionId: id })),
  ]),
  ...Array.from(workerStatements.values()).map((worker) => db.insert(hrPayrollWorkerResults).values({ id: crypto.randomUUID(), payrollRunId: runId, workerId: worker.workerId, workerName: worker.workerName, compensationVersionId: worker.compensationVersionId, payBasis: worker.payBasis, scheduledDays: worker.scheduledDays, amountMinor: worker.amountMinor })),
  db.insert(activityEvents).values(activityRow({ entityType: "hr_payroll", entityId: runId, source: "hr", eventType: "payroll_calculated", summary: "薪資試算完成", actor, payload: { periodKey: period.periodKey, resultCount: totalResults, engineVersion: "hr-payroll-demo-v1" } }))];
  try {
    await db.batch(batchStatements(statements));
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed|payroll_period_closed/.test(error.message)) throw new HrError(409, "薪資期間已結帳或試算請求已存在，請重新整理。 ");
    throw error;
  }
  return getPayrollRunResult(db, runId, [...calculationWarnings]);
}

function employeeDaysForPeriod(employee: { hiredOn: string; endedOn: string | null }, period: { start: string; end: string }): number {
  return overlapDays(period.start, period.end, employee.hiredOn, employee.endedOn).length;
}

/** 取得可選的獎金；來源與比例保留在 API，前端不另複製制度常數。 */
export const HR_BONUS_POLICY_PAGE_SIZES = [10, 25, 50, 100] as const;
export interface HrBonusPolicyListQuery {
  page: number;
  pageSize: number;
  search: string;
  scopeId: string;
  bonusKind: "all" | HrBonusKind;
  performancePeriod: "all" | HrBonusPerformancePeriod;
}

export async function listHrBonusPolicies(db: Database, input: HrBonusPolicyListQuery) {
  // LocalD1 與 D1 都以欄位名稱映射結果；join 裡不能讓三張表同時輸出 id/name，否則相同欄名會互相覆蓋。
  const search = input.search.trim();
  const where = and(
    eq(hrBonusPolicies.active, 1),
    sql`${hrBonusPolicyVersions.voidedAt} IS NULL`,
    sql`NOT EXISTS (
      SELECT 1 FROM hr_bonus_policy_versions AS newer_bonus_version
      WHERE newer_bonus_version.policy_id = ${hrBonusPolicyVersions.policyId}
        AND newer_bonus_version.voided_at IS NULL
        AND (newer_bonus_version.valid_from > ${hrBonusPolicyVersions.validFrom}
          OR (newer_bonus_version.valid_from = ${hrBonusPolicyVersions.validFrom} AND newer_bonus_version.version_number > ${hrBonusPolicyVersions.versionNumber}))
    )`,
    search ? or(
      like(hrBonusPolicies.name, `%${search}%`),
      like(scopes.name, `%${search}%`),
      sql`EXISTS (SELECT 1 FROM hr_bonus_policy_version_scopes AS filter_scope INNER JOIN scopes AS filter_scope_name ON filter_scope_name.id = filter_scope.scope_id WHERE filter_scope.policy_version_id = ${hrBonusPolicyVersions.id} AND filter_scope_name.name LIKE ${`%${search}%`})`,
    ) : undefined,
    input.scopeId !== "all" ? sql`(${hrBonusPolicyVersions.scopeId} = ${input.scopeId} OR EXISTS (SELECT 1 FROM hr_bonus_policy_version_scopes AS filter_scope WHERE filter_scope.policy_version_id = ${hrBonusPolicyVersions.id} AND filter_scope.scope_id = ${input.scopeId}))` : undefined,
    input.bonusKind !== "all" ? eq(hrBonusPolicyVersions.bonusKind, input.bonusKind) : undefined,
    input.performancePeriod !== "all" ? eq(hrBonusPolicyVersions.performancePeriod, input.performancePeriod) : undefined,
  );
  const rowsQuery = db.select({
    policyVersionId: sql<string>`${hrBonusPolicyVersions.id}`.as("policy_version_id"),
    policyId: sql<string>`${hrBonusPolicies.id}`.as("policy_id"),
    policyName: sql<string>`${hrBonusPolicies.name}`.as("policy_name"),
    versionNumber: sql<number>`${hrBonusPolicyVersions.versionNumber}`.as("policy_version_number"),
    scopeId: sql<string>`${hrBonusPolicyVersions.scopeId}`.as("bonus_scope_id"),
    scopeName: sql<string>`${scopes.name}`.as("bonus_scope_name"),
    bonusKind: sql<HrBonusKind>`${hrBonusPolicyVersions.bonusKind}`.as("bonus_kind"),
    performancePeriod: sql<HrBonusPerformancePeriod>`${hrBonusPolicyVersions.performancePeriod}`.as("bonus_performance_period"),
    ratePpm: sql<number>`${hrBonusPolicyVersions.ratePpm}`.as("bonus_rate_ppm"),
    guaranteeMinor: sql<number>`${hrBonusPolicyVersions.guaranteeMinor}`.as("bonus_guarantee_minor"),
    validFrom: sql<string>`${hrBonusPolicyVersions.validFrom}`.as("policy_valid_from"),
    validTo: sql<string | null>`${hrBonusPolicyVersions.validTo}`.as("policy_valid_to"),
  }).from(hrBonusPolicyVersions)
    .innerJoin(hrBonusPolicies, eq(hrBonusPolicies.id, hrBonusPolicyVersions.policyId))
    .innerJoin(scopes, eq(scopes.id, hrBonusPolicyVersions.scopeId));
  const [rows, [totalRow]] = await Promise.all([
    rowsQuery.where(where).orderBy(desc(hrBonusPolicyVersions.validFrom), desc(hrBonusPolicyVersions.versionNumber)).limit(input.pageSize).offset((input.page - 1) * input.pageSize),
    db.select({ value: count() }).from(hrBonusPolicyVersions)
      .innerJoin(hrBonusPolicies, eq(hrBonusPolicies.id, hrBonusPolicyVersions.policyId))
      .innerJoin(scopes, eq(scopes.id, hrBonusPolicyVersions.scopeId))
      .where(where),
  ]);
  const total = totalRow?.value ?? 0;
  const policyIds = [...new Set(rows.map((row) => row.policyId))];
  const latestRows = policyIds.length ? await db.select({ policyId: hrBonusPolicyVersions.policyId, versionId: hrBonusPolicyVersions.id }).from(hrBonusPolicyVersions)
    .where(and(inArray(hrBonusPolicyVersions.policyId, policyIds), sql`${hrBonusPolicyVersions.voidedAt} IS NULL`)).orderBy(desc(hrBonusPolicyVersions.validFrom), desc(hrBonusPolicyVersions.versionNumber)) : [];
  const latestByPolicy = new Map<string, string>();
  for (const row of latestRows) if (!latestByPolicy.has(row.policyId)) latestByPolicy.set(row.policyId, row.versionId);
  const versionIds = rows.map((row) => row.policyVersionId);
  const scopeRows = versionIds.length ? await db.select({ policyVersionId: hrBonusPolicyVersionScopes.policyVersionId, scopeId: hrBonusPolicyVersionScopes.scopeId, scopeName: scopes.name })
    .from(hrBonusPolicyVersionScopes).innerJoin(scopes, eq(scopes.id, hrBonusPolicyVersionScopes.scopeId)).where(inArray(hrBonusPolicyVersionScopes.policyVersionId, versionIds)) : [];
  const scopesByVersion = new Map<string, Array<{ id: string; name: string }>>();
  for (const scope of scopeRows) scopesByVersion.set(scope.policyVersionId, [...(scopesByVersion.get(scope.policyVersionId) ?? []), { id: scope.scopeId, name: scope.scopeName }]);
  return { policies: rows.map((row) => {
    const selectedScopes = scopesByVersion.get(row.policyVersionId) ?? [{ id: row.scopeId, name: row.scopeName }];
    return { ...row, bonusKind: normalizeBonusKind(row.bonusKind), scopeIds: selectedScopes.map((scope) => scope.id), scopeNames: selectedScopes.map((scope) => scope.name), scopes: selectedScopes, isLatest: latestByPolicy.get(row.policyId) === row.policyVersionId };
  }), total, page: input.page, pageSize: input.pageSize, hasMore: input.page * input.pageSize < total };
}

function bonusScopeIds(input: CreateHrBonusPolicyInput): string[] {
  const ids = input.scopeIds?.length ? input.scopeIds : input.scopeId ? [input.scopeId] : [];
  if (!ids.length || ids.length > 100 || ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) throw new HrError(400, "至少選擇一個且不可重複的適用 Scope。 ");
  return ids;
}

function validateBonusPolicy(input: CreateHrBonusPolicyInput) {
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 100) throw new HrError(400, "獎金名稱必須是 1～100 字。 ");
  if (input.bonusKind !== "team_performance" && input.bonusKind !== "individual_performance") throw new HrError(400, "績效歸屬不正確。 ");
  if (input.performancePeriod !== "current_month" && input.performancePeriod !== "previous_month") throw new HrError(400, "業績期間不正確。 ");
  const scopeIds = bonusScopeIds(input);
  if (!Number.isSafeInteger(input.ratePpm) || input.ratePpm < 0 || input.ratePpm > PPM) throw new HrError(400, "獎金比例必須介於 0～100%。");
  ensureMoney(input.guaranteeMinor, "保底金額");
  const employeeAssignments = input.employeeAssignments ?? [];
  if (employeeAssignments.length > 80) throw new HrError(400, "指派員工一次最多指派 80 人。 ");
  const assignedEmployeeUserIds = employeeAssignments.map((assignment) => assignment.employeeUserId);
  if (assignedEmployeeUserIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(assignedEmployeeUserIds).size !== assignedEmployeeUserIds.length) throw new HrError(400, "指派員工不可重複。 ");
  for (const assignment of employeeAssignments) {
    const weightUnits = assignment.weightUnits ?? 1;
    if (!Number.isSafeInteger(weightUnits) || weightUnits < 1 || weightUnits > 1000) throw new HrError(400, "員工權重必須是 1～1000 的整數。 ");
  }
  const employeeUserIds = employeeAssignments.length ? assignedEmployeeUserIds : input.employeeUserIds ?? [];
  const assignmentValidFrom = input.assignmentValidFrom ?? ("validFrom" in input && typeof input.validFrom === "string" ? input.validFrom : undefined);
  if (employeeUserIds.length > 80 || new Set(employeeUserIds).size !== employeeUserIds.length) throw new HrError(400, "指派員工不可重複，且一次最多指派 80 人。 ");
  if (employeeUserIds.length && (!assignmentValidFrom || !isDateOnly(assignmentValidFrom))) throw new HrError(400, "員工套用生效日必須是有效日期。 ");
  return scopeIds;
}

async function ensureBonusScopes(db: Database, scopeIds: string[]) {
  const found = await db.select({ id: scopes.id }).from(scopes).where(and(
    inArray(scopes.id, scopeIds), eq(scopes.active, 1), eq(scopes.scopeKind, "store"), sql`${scopes.sourceType} <> 'shopee'`,
  ));
  if (found.length !== scopeIds.length) throw new HrError(404, "找不到一個或多個啟用中的營運 Scope。 ");
}

async function resolveBonusPolicyEmployments(db: Database, employeeUserIds: string[] | undefined, validFrom: string | undefined) {
  if (!employeeUserIds?.length) return [];
  const rows = await db.select({ id: hrEmployments.id, employeeUserId: hrEmployments.employeeUserId }).from(hrEmployments)
    .innerJoin(hrEmployees, eq(hrEmployees.userId, hrEmployments.employeeUserId))
    .where(and(inArray(hrEmployments.employeeUserId, employeeUserIds), sql`${hrEmployments.hiredOn} <= ${validFrom}`, sql`(${hrEmployments.endedOn} IS NULL OR ${hrEmployments.endedOn} > ${validFrom})`))
    .orderBy(desc(hrEmployments.hiredOn));
  const employmentByUser = new Map<string, { id: string; employeeUserId: string }>();
  for (const row of rows) if (!employmentByUser.has(row.employeeUserId)) employmentByUser.set(row.employeeUserId, row);
  const missing = employeeUserIds.filter((employeeUserId) => !employmentByUser.has(employeeUserId));
  if (missing.length) throw new HrError(404, "有員工在套用生效日沒有有效任職紀錄。 ");
  return employeeUserIds.map((employeeUserId) => employmentByUser.get(employeeUserId)!);
}

export async function createHrBonusPolicy(db: Database, input: CreateHrBonusPolicyInput, actor: HrActor) {
  const scopeIds = validateBonusPolicy(input);
  await ensureBonusScopes(db, scopeIds);
  const employeeAssignments = input.employeeAssignments?.length
    ? input.employeeAssignments.map((assignment) => ({ employeeUserId: assignment.employeeUserId, weightUnits: assignment.weightUnits ?? 1 }))
    : (input.employeeUserIds ?? []).map((employeeUserId) => ({ employeeUserId, weightUnits: 1 }));
  const assignmentWeightByUser = new Map(employeeAssignments.map((assignment) => [assignment.employeeUserId, assignment.weightUnits]));
  const employments = await resolveBonusPolicyEmployments(db, employeeAssignments.map((assignment) => assignment.employeeUserId), input.assignmentValidFrom);
  const policyId = crypto.randomUUID();
  const policyVersionId = crypto.randomUUID();
  try {
    await db.batch(batchStatements([
      db.insert(hrBonusPolicies).values({ id: policyId, name: input.name, active: 1, createdBy: actor.id }),
      db.insert(hrBonusPolicyVersions).values({ id: policyVersionId, policyId, versionNumber: 1, scopeId: scopeIds[0]!, performanceKind: "scheduled_daily", revenueKind: "sales_amount", bonusKind: input.bonusKind, performancePeriod: input.performancePeriod, ratePpm: input.ratePpm, guaranteeMinor: input.guaranteeMinor, validFrom: "1900-01-01", validTo: null, createdBy: actor.id }),
      ...scopeIds.map((scopeId) => db.insert(hrBonusPolicyVersionScopes).values({ policyVersionId, scopeId, createdBy: actor.id })),
      ...employments.map((employment) => db.insert(hrBonusPolicyMembers).values({ id: crypto.randomUUID(), policyVersionId, employmentId: employment.id, validFrom: input.assignmentValidFrom!, validTo: null, weightUnits: assignmentWeightByUser.get(employment.employeeUserId) ?? 1, createdBy: actor.id })),
      db.insert(activityEvents).values(activityRow({ entityType: "hr_bonus", entityId: policyVersionId, source: "hr", eventType: "bonus_policy_created", summary: "獎金建立", actor, payload: { policyId, policyVersionId, scopeIds, bonusKind: input.bonusKind, performancePeriod: input.performancePeriod, assignmentCount: employments.length } })),
    ]));
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new HrError(409, "獎金建立失敗，請重新整理後再試。 ");
    throw error;
  }
  return { policyId, policyVersionId, scopeIds, assignmentCount: employments.length };
}

/** 編輯 policy 不覆蓋舊公式，而是建立同一 policy 的下一個版本。 */
export async function updateHrBonusPolicy(db: Database, input: UpdateHrBonusPolicyInput, actor: HrActor) {
  const scopeIds = validateBonusPolicy(input);
  await ensureBonusScopes(db, scopeIds);
  if (!isDateOnly(input.validFrom)) throw new HrError(400, "變更生效日必須是有效日期。 ");
  const [current] = await db.select({ policyId: hrBonusPolicyVersions.policyId, versionNumber: hrBonusPolicyVersions.versionNumber, validFrom: hrBonusPolicyVersions.validFrom, voidedAt: hrBonusPolicyVersions.voidedAt, active: hrBonusPolicies.active }).from(hrBonusPolicyVersions)
    .innerJoin(hrBonusPolicies, eq(hrBonusPolicies.id, hrBonusPolicyVersions.policyId))
    .where(eq(hrBonusPolicyVersions.id, input.policyVersionId)).limit(1);
  if (!current) throw new HrError(404, "找不到獎金。 ");
  if (!current.active) throw new HrError(409, "這個獎金已停用，不能編輯。 ");
  if (current.voidedAt !== null) throw new HrError(409, "這個獎金版本已解除，請重新整理後改用目前生效的版本。 ");
  if (input.validFrom <= current.validFrom) throw new HrError(400, "新版本生效日必須晚於目前版本生效日。 ");
  const [latest] = await db.select({ id: hrBonusPolicyVersions.id, versionNumber: hrBonusPolicyVersions.versionNumber, validFrom: hrBonusPolicyVersions.validFrom }).from(hrBonusPolicyVersions)
    .where(and(eq(hrBonusPolicyVersions.policyId, current.policyId), sql`${hrBonusPolicyVersions.voidedAt} IS NULL`)).orderBy(desc(hrBonusPolicyVersions.validFrom), desc(hrBonusPolicyVersions.versionNumber)).limit(1);
  if (latest && latest.id !== input.policyVersionId) throw new HrError(409, "獎金已變更，請重新整理後再試。 ");
  if (latest && input.validFrom <= latest.validFrom) throw new HrError(400, "新版本生效日必須晚於最新版本生效日。 ");
  /*
   * 編號取所有版本的最大值，已解除的也算：解除不刪列，(policy_id, version_number) 仍是唯一索引，
   * 用「目前最新版 + 1」的話，解除第 2 版之後再建一版就會撞回第 2 版。
   */
  const [maxVersion] = await db.select({ versionNumber: sql<number>`coalesce(max(${hrBonusPolicyVersions.versionNumber}), 0)`.as("bonus_max_version_number") })
    .from(hrBonusPolicyVersions).where(eq(hrBonusPolicyVersions.policyId, current.policyId));
  const versionNumber = Number(maxVersion?.versionNumber ?? 0) + 1;
  const activeMembers = await db.select({ member: hrBonusPolicyMembers }).from(hrBonusPolicyMembers)
    .innerJoin(hrBonusPolicyVersions, eq(hrBonusPolicyVersions.id, hrBonusPolicyMembers.policyVersionId))
    .where(and(eq(hrBonusPolicyVersions.policyId, current.policyId), sql`${hrBonusPolicyVersions.voidedAt} IS NULL`, sql`${hrBonusPolicyVersions.validFrom} < ${input.validFrom}`, sql`(${hrBonusPolicyVersions.validTo} IS NULL OR ${hrBonusPolicyVersions.validTo} > ${input.validFrom})`, sql`${hrBonusPolicyMembers.validFrom} < ${input.validFrom}`, sql`(${hrBonusPolicyMembers.validTo} IS NULL OR ${hrBonusPolicyMembers.validTo} > ${input.validFrom})`));
  const specifiedAssignments = input.employeeAssignments !== undefined
    ? input.employeeAssignments.map((assignment) => ({ employeeUserId: assignment.employeeUserId, weightUnits: assignment.weightUnits ?? 1 }))
    : input.employeeUserIds !== undefined
      ? input.employeeUserIds.map((employeeUserId) => ({ employeeUserId, weightUnits: 1 }))
      : undefined;
  const specifiedEmployments = specifiedAssignments === undefined ? [] : await resolveBonusPolicyEmployments(db, specifiedAssignments.map((assignment) => assignment.employeeUserId), input.validFrom);
  const specifiedWeightByUser = new Map((specifiedAssignments ?? []).map((assignment) => [assignment.employeeUserId, assignment.weightUnits]));
  const nextMembers = specifiedAssignments === undefined
    ? activeMembers.map(({ member }) => ({ employmentId: member.employmentId, validTo: member.validTo, weightUnits: member.weightUnits }))
    : specifiedEmployments.map((employment) => ({ employmentId: employment.id, validTo: null, weightUnits: specifiedWeightByUser.get(employment.employeeUserId) ?? 1 }));
  const policyVersionId = crypto.randomUUID();
  try {
    await db.batch(batchStatements([
      db.update(hrBonusPolicies).set({ name: input.name }).where(eq(hrBonusPolicies.id, current.policyId)),
      ...(latest ? [db.update(hrBonusPolicyVersions).set({ validTo: input.validFrom }).where(and(eq(hrBonusPolicyVersions.id, latest.id), sql`${hrBonusPolicyVersions.voidedAt} IS NULL`))] : []),
      /*
       * policy_id 取自「這一版還沒被解除」的子查詢，而不是上面讀到的值：讀取與寫入之間
       * 別人可能剛解除了這一版，只靠 JS 的檢查攔不到。被解除時子查詢是 NULL，NOT NULL
       * 直接讓整個 batch 回滾——否則上一版已被解除還原成有效，新版本又插進來，會有兩個
       * 同時有效的版本，獎金發兩次。
       * 「有人搶先建立了更新的版本」則仍由 (policy_id, version_number) 的唯一索引擋下。
       */
      db.insert(hrBonusPolicyVersions).values({ id: policyVersionId, policyId: sql`(SELECT policy_id FROM hr_bonus_policy_versions WHERE id=${input.policyVersionId} AND voided_at IS NULL)`, versionNumber, scopeId: scopeIds[0]!, performanceKind: "scheduled_daily", revenueKind: "sales_amount", bonusKind: input.bonusKind, performancePeriod: input.performancePeriod, ratePpm: input.ratePpm, guaranteeMinor: input.guaranteeMinor, validFrom: input.validFrom, validTo: null, createdBy: actor.id }),
      ...scopeIds.map((scopeId) => db.insert(hrBonusPolicyVersionScopes).values({ policyVersionId, scopeId, createdBy: actor.id })),
      /*
       * 關成員時把原本的迄日與關它的版本留著，解除版本才還原得回來（見 schema 的註解）。
       * 必須排在新版本插入之後：superseded_by_version_id 指著那一列。
       */
      ...(activeMembers.length ? [db.update(hrBonusPolicyMembers).set({ validTo: input.validFrom, supersededValidTo: sql`valid_to`, supersededByVersionId: policyVersionId }).where(inArray(hrBonusPolicyMembers.id, activeMembers.map(({ member }) => member.id)))] : []),
      ...nextMembers.map((member) => db.insert(hrBonusPolicyMembers).values({ id: crypto.randomUUID(), policyVersionId, employmentId: member.employmentId, validFrom: input.validFrom, validTo: member.validTo, weightUnits: member.weightUnits, createdBy: actor.id })),
      db.insert(activityEvents).values(activityRow({ entityType: "hr_bonus", entityId: policyVersionId, source: "hr", eventType: "bonus_policy_version_created", summary: "獎金更新", actor, payload: { policyId: current.policyId, previousPolicyVersionId: input.policyVersionId, policyVersionId, versionNumber, validFrom: input.validFrom, scopeIds, assignmentCount: nextMembers.length } })),
    ]));
  } catch (error) {
    // NOT NULL 是上面那句 policy_id 子查詢落空的訊號：這一版剛被別人解除了。
    if (error instanceof Error && /UNIQUE constraint failed|NOT NULL constraint failed/.test(error.message)) throw new HrError(409, "獎金已變更，請重新整理後再試。 ");
    throw error;
  }
  return { policyId: current.policyId, policyVersionId, versionNumber };
}

/** 刪除 policy 採停用，不物理刪除，保留已結算薪資與操作紀錄可追溯性。 */
export async function deleteHrBonusPolicy(db: Database, policyVersionId: string, actor: HrActor) {
  const [policy] = await db.select({ id: hrBonusPolicies.id, name: hrBonusPolicies.name, active: hrBonusPolicies.active }).from(hrBonusPolicyVersions)
    .innerJoin(hrBonusPolicies, eq(hrBonusPolicies.id, hrBonusPolicyVersions.policyId))
    .where(eq(hrBonusPolicyVersions.id, policyVersionId)).limit(1);
  if (!policy) throw new HrError(404, "找不到獎金。 ");
  if (!policy.active) return { policyId: policy.id, deleted: false };
  await db.batch(batchStatements([
    db.update(hrBonusPolicies).set({ active: 0 }).where(eq(hrBonusPolicies.id, policy.id)),
    db.insert(activityEvents).values(activityRow({ entityType: "hr_bonus", entityId: policy.id, source: "hr", eventType: "bonus_policy_archived", summary: "獎金停用", actor, payload: { policyId: policy.id, policyVersionId, policyName: policy.name } })),
  ]));
  return { policyId: policy.id, deleted: true };
}

/**
 * 解除最新的獎金版本但不刪除資料；重複呼叫可依序撤回到第一版。
 *
 * 沒有這條路的話，改錯的公式要等到隔天才改得回來：新版本的生效日必須晚於目前版本，
 * 當天再改一次就會被擋下。解除會把上一版連同它的成員期間還原成解除前的狀態，
 * 已結算的薪資快照不受影響——那是當期薪資自己的凍結資料。
 */
export async function voidHrBonusPolicyVersion(db: Database, policyVersionId: string, actor: HrActor) {
  const [version] = await db.select({
    policyId: hrBonusPolicyVersions.policyId, versionNumber: hrBonusPolicyVersions.versionNumber,
    validFrom: hrBonusPolicyVersions.validFrom, validTo: hrBonusPolicyVersions.validTo, voidedAt: hrBonusPolicyVersions.voidedAt,
    active: hrBonusPolicies.active,
  }).from(hrBonusPolicyVersions)
    .innerJoin(hrBonusPolicies, eq(hrBonusPolicies.id, hrBonusPolicyVersions.policyId))
    .where(eq(hrBonusPolicyVersions.id, policyVersionId)).limit(1);
  if (!version) throw new HrError(404, "找不到獎金版本。 ");
  if (version.voidedAt !== null) throw new HrError(409, "這個獎金版本已經解除。 ");
  if (!version.active) throw new HrError(409, "這個獎金已停用，不能解除版本。 ");
  const openVersions = await db.select({ id: hrBonusPolicyVersions.id, versionNumber: hrBonusPolicyVersions.versionNumber, validFrom: hrBonusPolicyVersions.validFrom }).from(hrBonusPolicyVersions)
    .where(and(eq(hrBonusPolicyVersions.policyId, version.policyId), sql`${hrBonusPolicyVersions.voidedAt} IS NULL`))
    .orderBy(desc(hrBonusPolicyVersions.validFrom), desc(hrBonusPolicyVersions.versionNumber));
  if (openVersions[0]?.id !== policyVersionId) throw new HrError(409, "只能解除最新的獎金版本；請先依序解除較新的版本。 ");
  const previous = openVersions[1];
  if (!previous) throw new HrError(409, "這是第一個版本，沒有可以回到的上一版；整個獎金設錯請改用刪除。 ");
  await writeHrMutation(db, [
    sql`UPDATE hr_bonus_policy_versions SET voided_at=CURRENT_TIMESTAMP, voided_by=${actor.id}
      WHERE id=${policyVersionId} AND voided_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM hr_bonus_policy_versions AS newer
          WHERE newer.policy_id=${version.policyId} AND newer.voided_at IS NULL
            AND (newer.valid_from > ${version.validFrom} OR (newer.valid_from = ${version.validFrom} AND newer.version_number > ${version.versionNumber})))
      RETURNING id`,
    // 上一版當初是被這一版的生效日關起來的，還原成它被關之前的迄日（最新版一定是 NULL）。
    sql`UPDATE hr_bonus_policy_versions SET valid_to=${version.validTo}
      WHERE id=${previous.id} AND valid_to=${version.validFrom} RETURNING id`,
    // 成員還原成被這一版關起來之前的原值；來源是關它的時候留下的 superseded_*，不是推算的。
    sql`UPDATE hr_bonus_policy_members SET valid_to=superseded_valid_to, superseded_valid_to=NULL, superseded_by_version_id=NULL
      WHERE superseded_by_version_id=${policyVersionId} RETURNING id`,
  ], policyVersionId, actor, "bonus_policy_version_voided", "獎金版本已被其他人變更，請重新整理。 ", { allowEmptyMutationIndexes: new Set([1, 2]) });
  return { policyId: version.policyId, policyVersionId, previousPolicyVersionId: previous.id, status: "voided" as const };
}

export async function listHrBonusAssignments(db: Database) {
  const rows = await db.select({
    assignmentId: sql<string>`${hrBonusPolicyMembers.id}`.as("bonus_assignment_id"),
    assignmentEmploymentId: sql<string>`${hrBonusPolicyMembers.employmentId}`.as("bonus_assignment_employment_id"),
    validFrom: sql<string>`${hrBonusPolicyMembers.validFrom}`.as("bonus_assignment_valid_from"),
    validTo: sql<string | null>`${hrBonusPolicyMembers.validTo}`.as("bonus_assignment_valid_to"),
    weightUnits: sql<number>`${hrBonusPolicyMembers.weightUnits}`.as("bonus_assignment_weight"),
    policyVersionId: sql<string>`${hrBonusPolicyVersions.id}`.as("bonus_assignment_policy_version_id"),
    policyName: sql<string>`${hrBonusPolicies.name}`.as("bonus_assignment_policy_name"),
    bonusKind: sql<HrBonusKind>`${hrBonusPolicyVersions.bonusKind}`.as("bonus_assignment_kind"),
    performancePeriod: sql<HrBonusPerformancePeriod>`${hrBonusPolicyVersions.performancePeriod}`.as("bonus_assignment_period"),
    employeeUserId: sql<string>`${hrEmployments.employeeUserId}`.as("bonus_assignment_employee_user_id"),
    employeeNumber: sql<string>`${hrEmployees.employeeNumber}`.as("bonus_assignment_employee_number"),
    employeeName: displayName,
  }).from(hrBonusPolicyMembers)
    .innerJoin(hrBonusPolicyVersions, eq(hrBonusPolicyVersions.id, hrBonusPolicyMembers.policyVersionId))
    .innerJoin(hrBonusPolicies, eq(hrBonusPolicies.id, hrBonusPolicyVersions.policyId))
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrBonusPolicyMembers.employmentId))
    .innerJoin(hrEmployees, eq(hrEmployees.userId, hrEmployments.employeeUserId))
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(sql`${hrBonusPolicyVersions.voidedAt} IS NULL`)
    .orderBy(desc(hrBonusPolicyMembers.createdAt));
  return rows.map((row) => ({
    assignment: { id: row.assignmentId, employmentId: row.assignmentEmploymentId, validFrom: row.validFrom, validTo: row.validTo, weightUnits: row.weightUnits },
    policyVersionId: row.policyVersionId, policyName: row.policyName, bonusKind: normalizeBonusKind(row.bonusKind), performancePeriod: row.performancePeriod,
    employeeUserId: row.employeeUserId, employeeNumber: row.employeeNumber, employeeName: row.employeeName,
  }));
}

export async function assignHrBonusPolicyMember(db: Database, input: AssignHrBonusPolicyInput, actor: HrActor) {
  if (!isDateOnly(input.validFrom) || (input.validTo !== null && input.validTo !== undefined && !isDateOnly(input.validTo))) throw new HrError(400, "獎金生效期間必須是有效日期。 ");
  if (input.validTo !== null && input.validTo !== undefined && input.validTo <= input.validFrom) throw new HrError(400, "獎金結束日必須晚於生效日。 ");
  const weightUnits = input.weightUnits ?? 1;
  if (!Number.isSafeInteger(weightUnits) || weightUnits <= 0) throw new HrError(400, "權重必須是正整數。 ");
  const [employment] = await db.select({ id: hrEmployments.id }).from(hrEmployments)
    .innerJoin(hrEmployees, eq(hrEmployees.userId, hrEmployments.employeeUserId))
    .where(and(eq(hrEmployments.employeeUserId, input.employeeUserId), sql`${hrEmployments.hiredOn} <= ${input.validFrom}`, sql`(${hrEmployments.endedOn} IS NULL OR ${hrEmployments.endedOn} > ${input.validFrom})`))
    .orderBy(desc(hrEmployments.hiredOn)).limit(1);
  if (!employment) throw new HrError(404, "找不到該員工在生效日的任職紀錄。 ");
  const [policy] = await db.select({ id: hrBonusPolicyVersions.id, policyId: hrBonusPolicyVersions.policyId, versionValidFrom: hrBonusPolicyVersions.validFrom, versionValidTo: hrBonusPolicyVersions.validTo, voidedAt: hrBonusPolicyVersions.voidedAt, active: hrBonusPolicies.active }).from(hrBonusPolicyVersions)
    .innerJoin(hrBonusPolicies, eq(hrBonusPolicies.id, hrBonusPolicyVersions.policyId))
    .where(eq(hrBonusPolicyVersions.id, input.policyVersionId)).limit(1);
  if (!policy) throw new HrError(404, "找不到獎金。 ");
  if (!policy.active) throw new HrError(409, "這個獎金已停用，不能再套用。 ");
  if (policy.voidedAt !== null) throw new HrError(409, "這個獎金版本已解除，請套用到目前生效的版本。 ");
  if (input.validFrom < policy.versionValidFrom || (policy.versionValidTo !== null && input.validFrom >= policy.versionValidTo)) throw new HrError(400, "員工套用生效日不在 獎金有效期間內。 ");
  if (input.validTo !== null && input.validTo !== undefined && policy.versionValidTo !== null && input.validTo > policy.versionValidTo) throw new HrError(400, "員工套用結束日不可超過 獎金有效期間。 ");
  const assignmentEnd = input.validTo ?? "9999-12-31";
  const [duplicate] = await db.select({ id: hrBonusPolicyMembers.id }).from(hrBonusPolicyMembers)
    .innerJoin(hrBonusPolicyVersions, eq(hrBonusPolicyVersions.id, hrBonusPolicyMembers.policyVersionId))
    // 已解除版本的成員還留在資料庫，但它們不算數；不排除的話解除回上一版之後就再也套用不了同一個人。
    .where(and(eq(hrBonusPolicyVersions.policyId, policy.policyId), sql`${hrBonusPolicyVersions.voidedAt} IS NULL`, eq(hrBonusPolicyMembers.employmentId, employment.id), sql`${hrBonusPolicyMembers.validFrom} < ${assignmentEnd}`, sql`(${hrBonusPolicyMembers.validTo} IS NULL OR ${hrBonusPolicyMembers.validTo} > ${input.validFrom})`))
    .limit(1);
  if (duplicate) throw new HrError(409, "該員工已套用這個獎金，不能重複套用重疊期間。 ");
  const assignmentId = crypto.randomUUID();
  try {
    await writeHrMutation(db, sql`INSERT INTO hr_bonus_policy_members
      (id, policy_version_id, employment_id, valid_from, valid_to, weight_units, created_by)
      SELECT ${assignmentId}, ${input.policyVersionId}, ${employment.id}, ${input.validFrom}, ${input.validTo ?? null}, ${weightUnits}, ${actor.id}
      WHERE NOT EXISTS (
        SELECT 1 FROM hr_bonus_policy_members AS existing_member
        INNER JOIN hr_bonus_policy_versions AS existing_version ON existing_version.id = existing_member.policy_version_id
        WHERE existing_version.policy_id = ${policy.policyId}
          AND existing_version.voided_at IS NULL
          AND existing_member.employment_id = ${employment.id}
          AND existing_member.valid_from < ${assignmentEnd}
          AND (existing_member.valid_to IS NULL OR existing_member.valid_to > ${input.validFrom})
      ) RETURNING id`, assignmentId, actor, "bonus_policy_assigned", "該員工已套用這個獎金，不能重複套用重疊期間。 ");
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new HrError(409, "該員工已套用這個獎金，不能重複套用相同生效日。 ");
    throw error;
  }
  return { id: assignmentId, employmentId: employment.id };
}

export async function listHrPayrollRuns(db: Database) {
  // D1/SQLite 對 join 後同名欄位的巢狀映射不可靠；明確別名才能避免期間 status 蓋掉批次 status。
  const rows = await db.select({
    runId: hrPayrollRuns.id,
    payrollPeriodId: hrPayrollRuns.payrollPeriodId,
    versionNumber: hrPayrollRuns.versionNumber,
    requestId: hrPayrollRuns.requestId,
    inputRevision: hrPayrollRuns.inputRevision,
    payDate: hrPayrollRuns.payDate,
    engineVersion: hrPayrollRuns.engineVersion,
    runStatus: hrPayrollRuns.status,
    expectedCount: hrPayrollRuns.expectedCount,
    completedCount: hrPayrollRuns.completedCount,
    approvedBy: hrPayrollRuns.approvedBy,
    createdBy: hrPayrollRuns.createdBy,
    createdAt: hrPayrollRuns.createdAt,
    updatedAt: hrPayrollRuns.updatedAt,
    periodKey: hrPayrollPeriods.periodKey,
    periodStatus: hrPayrollPeriods.status,
  }).from(hrPayrollRuns)
    .innerJoin(hrPayrollPeriods, eq(hrPayrollPeriods.id, hrPayrollRuns.payrollPeriodId))
    .orderBy(desc(hrPayrollRuns.createdAt));
  return rows.map((row) => ({
    run: {
      id: row.runId,
      payrollPeriodId: row.payrollPeriodId,
      versionNumber: row.versionNumber,
      requestId: row.requestId,
      inputRevision: row.inputRevision,
      payDate: row.payDate,
      engineVersion: row.engineVersion,
      status: row.runStatus,
      expectedCount: row.expectedCount,
      completedCount: row.completedCount,
      approvedBy: row.approvedBy,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    periodKey: row.periodKey,
    periodStatus: row.periodStatus,
  }));
}

export async function closeHrPayrollRun(db: Database, runId: string, actor: HrActor) {
  const [run] = await db.select({ id: hrPayrollRuns.id, payrollPeriodId: hrPayrollRuns.payrollPeriodId, periodKey: hrPayrollPeriods.periodKey, status: hrPayrollRuns.status, sourceSnapshotJson: hrPayrollRuns.sourceSnapshotJson, calculationInputJson: hrPayrollRuns.calculationInputJson, expectedCount: hrPayrollRuns.expectedCount, completedCount: hrPayrollRuns.completedCount, periodStatus: hrPayrollPeriods.status }).from(hrPayrollRuns)
    .innerJoin(hrPayrollPeriods, eq(hrPayrollPeriods.id, hrPayrollRuns.payrollPeriodId)).where(eq(hrPayrollRuns.id, runId)).limit(1);
  if (!run) throw new HrError(404, "找不到薪資試算批次。 ");
  if (run.status !== "ready") throw new HrError(409, "只有已完成試算的批次可以結帳。 ");
  if (run.expectedCount !== run.completedCount || run.periodStatus !== "open") throw new HrError(409, "薪資批次尚未完成或薪資期間已鎖定，不能結帳。 ");
  const payslipRows = await db.select({ employmentId: hrPayslips.employmentId }).from(hrPayslips).where(eq(hrPayslips.payrollRunId, runId));
  const employmentIds = payslipRows.map((row) => row.employmentId);
  const workerRows = await db.select({ workerId: hrPayrollWorkerResults.workerId }).from(hrPayrollWorkerResults).where(eq(hrPayrollWorkerResults.payrollRunId, runId));
  if (!run.sourceSnapshotJson || run.sourceSnapshotJson === "{}") throw new HrError(409, "此薪資批次沒有來源快照，請重新試算後再結帳。 ");
  const currentSnapshot = await getPayrollSourceSnapshot(db, { period: periodFromKey(run.periodKey), employmentIds, workerIds: workerRows.map((row) => row.workerId) });
  if (currentSnapshot !== run.sourceSnapshotJson) throw new HrError(409, "薪資試算來源已變更，請重新試算後再結帳。 ");

  // 部分結算保持期間 open，讓尚未結算的員工仍可建立另一張試算；每次 claim 都在同一
  // D1 batch 內完成，並以「所有當期 active 任職都已 claim」決定是否關閉期間，避免
  // 只拿本次 payslip 數量和 active 人數比較而提早結帳。
  const period = periodFromKey(run.periodKey);
  const mutations = [
    sql`INSERT INTO hr_payroll_closed_employees (period_key, employment_id, payroll_run_id)
      SELECT ${run.periodKey}, payslip.employment_id, ${runId}
      FROM hr_payslips AS payslip
      WHERE payslip.payroll_run_id=${runId}
      RETURNING employment_id`,
    sql`UPDATE hr_payroll_runs SET status='closed', approved_by=${actor.id}, updated_at=CURRENT_TIMESTAMP
      WHERE id=${runId} AND status='ready' AND expected_count=completed_count
        AND expected_count = (SELECT count(*) FROM hr_payroll_run_employees WHERE payroll_run_id=${runId}) + (SELECT count(*) FROM hr_payroll_worker_results WHERE payroll_run_id=${runId})
        AND NOT EXISTS (SELECT 1 FROM hr_payroll_run_employees WHERE payroll_run_id=${runId} AND status <> 'succeeded')
        AND EXISTS (SELECT 1 FROM hr_payroll_periods WHERE id=${run.payrollPeriodId} AND status='open') RETURNING id`,
    sql`UPDATE hr_payroll_periods
      SET status='closed', revision=revision+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=${run.payrollPeriodId} AND status='open'
        AND NOT EXISTS (
          SELECT 1 FROM hr_employments AS employment
          INNER JOIN hr_employees AS employee ON employee.user_id=employment.employee_user_id
          INNER JOIN users AS account ON account.id=employment.employee_user_id
          WHERE account.status='active' AND employment.hired_on < ${period.end}
            AND (employment.ended_on IS NULL OR employment.ended_on > ${period.start})
            AND NOT EXISTS (
              SELECT 1 FROM hr_payroll_closed_employees AS claim
              WHERE claim.period_key=${run.periodKey} AND claim.employment_id=employment.id
            )
        )
      RETURNING id`,
  ];
  await writeHrMutation(db, mutations, runId, actor, "payroll_run_closed", "薪資批次已結帳、來源已變更或同一員工同一月份已有結帳結果，請重新整理。 ", { allowEmptyMutationIndexes: new Set([0, 2]) });
  return getPayrollRunResult(db, runId);
}

export async function getHrPayrollRun(db: Database, runId: string) {
  return getPayrollRunResult(db, runId);
}
