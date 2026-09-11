import { and, asc, count, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { HrError, type HrActor } from "./hr-people.js";
import { activityEvents } from "./schema/activity.js";
import { hrClockEvents } from "./schema/hr-attendance.js";
import {
  hrBonusAllocations,
  hrBonusPolicies,
  hrBonusPolicyMembers,
  hrBonusPolicyVersions,
  hrBonusPerformanceSnapshots,
  hrBonusPools,
  hrBonusRevenueSnapshots,
  type HrBonusPerformanceSnapshot,
  type HrBonusPolicyMember,
  type HrBonusPolicyVersion,
} from "./schema/hr-bonus.js";
import {
  hrCompensationVersions,
  hrWorkerCompensationVersions,
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
} from "./schema/hr-payroll-runs.js";
import { hrEmployees, hrEmployments } from "./schema/hr-people.js";
import { hrOvertimeRequests, hrScheduleEntries, hrScheduleVersions, hrScheduleWorkerEntries, hrScheduleWorkers } from "./schema/hr-scheduling.js";
import { users } from "./schema/auth.js";
import { scopes } from "./schema/reports.js";

const PPM = 1_000_000;
const PAYROLL_DEMO_WARNING = "本版未計算勞健保扣款：需先設定公司採用的費率與負擔規則。";
const BONUS_SOURCE_WARNING = "業績是此次請求明確帶入的快照；未自動套用出金表。";
const displayName = sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`;

export type HrPayrollEmployeeFilter = "all" | "general" | "scheduled";

export interface HrPayrollCalculationInput {
  periodKey: string;
  payDate?: string;
  employeeUserIds?: string[];
  attendanceMode?: HrPayrollEmployeeFilter;
  requestId?: string;
  monthlyDivisorDays?: number;
  standardDailyHours?: number;
  bonusPoolId?: string;
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
  status: "ready";
  engineVersion: string;
  employees: HrPayrollEmployeeResult[];
  workers: Array<{ workerId: string; workerName: string; payBasis: "monthly" | "daily" | "hourly"; scheduledDays: number; amountMinor: number; compensationVersionId: string | null }>;
  warnings: string[];
}

export type HrBonusKind = "team_performance" | "individual_performance";
export type HrBonusPerformancePeriod = "current_month" | "previous_month";

export interface HrBonusRevenueInput {
  businessDate: string;
  amountMinor: number;
  sourceKind?: "manual" | "report";
  sourceRef?: string;
  provenance?: Record<string, unknown>;
}

export interface HrBonusCalculationInput {
  policyVersionId: string;
  periodKey: string;
  revenue: HrBonusRevenueInput[];
}

export interface HrBonusAllocationResult {
  employmentId: string;
  employeeNumber: string;
  employeeName: string;
  weightUnits: number;
  scheduledDays: number;
  revenueMinor: number;
  amountMinor: number;
}

export interface HrBonusPoolResult {
  poolId: string;
  policyVersionId: string;
  policyName: string;
  scopeId: string;
  scopeName: string;
  periodKey: string;
  status: "calculated" | "approved" | "closed" | "failed";
  poolAmountMinor: number;
  allocations: HrBonusAllocationResult[];
  daily: Array<{ businessDate: string; revenueMinor: number; bonusMinor: number; scheduled: boolean }>;
  warnings: string[];
}

function normalizeBonusKind(value: string): HrBonusKind {
  return value === "individual_performance" ? "individual_performance" : "team_performance";
}

export interface CreateHrBonusPolicyInput {
  name: string;
  scopeId: string;
  bonusKind: HrBonusKind;
  performancePeriod: HrBonusPerformancePeriod;
  ratePpm: number;
  guaranteeMinor: number;
  employeeUserIds?: string[];
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

export interface CreateHrBonusPerformanceSnapshotInput {
  scopeId: string;
  employeeUserId?: string | null;
  periodKey: string;
  amountMinor: number;
  sourceKind: "manual" | "report";
  sourceRef: string;
  provenance?: Record<string, unknown>;
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

function overlapDays(start: string, end: string, from: string, to: string | null): string[] {
  const lower = start > from ? start : from;
  const upper = to && to < end ? to : end;
  return lower < upper ? dateRange(lower, upper) : [];
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function secondsBetween(start: string, end: string): number {
  const seconds = Math.round((Date.parse(end.replace(" ", "T") + (end.endsWith("Z") ? "" : "Z")) - Date.parse(start.replace(" ", "T") + (start.endsWith("Z") ? "" : "Z"))) / 1000);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 0;
}

function covering<T extends { validFrom: string; validTo: string | null }>(rows: T[], date: string): T | undefined {
  return rows.filter((row) => row.validFrom <= date && (row.validTo === null || date < row.validTo)).sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
}

function employeeSelected(employee: { employeeUserId: string; attendanceMode: string }, input: HrPayrollCalculationInput): boolean {
  if (input.employeeUserIds?.length && !input.employeeUserIds.includes(employee.employeeUserId)) return false;
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
  return { runId, periodKey: run.periodKey, status: "ready", engineVersion: run.run.engineVersion, employees, workers: workerResults.map((worker) => ({ workerId: worker.workerId, workerName: worker.workerName, payBasis: worker.payBasis, scheduledDays: worker.scheduledDays, amountMinor: worker.amountMinor, compensationVersionId: worker.compensationVersionId })), warnings: [...new Set([PAYROLL_DEMO_WARNING, ...warnings])] };
}

interface AssignedBonusPolicy {
  version: Pick<HrBonusPolicyVersion, "id" | "scopeId" | "bonusKind" | "performancePeriod" | "ratePpm" | "guaranteeMinor">;
  member: Pick<HrBonusPolicyMember, "id" | "employmentId">;
  policyName: string;
}

interface CalculatedAssignedBonus {
  amountMinor: number;
  sourceAmountMinor: number | null;
  performanceSnapshotIds: string[];
  formula: string;
}

function calculateAssignedBonus(
  assignment: AssignedBonusPolicy,
  employee: { employmentId: string },
  period: { start: string; end: string; year: number; month: number },
  performanceSnapshots: HrBonusPerformanceSnapshot[],
): CalculatedAssignedBonus {
  const version = assignment.version;
  const sourcePeriod = version.performancePeriod === "previous_month" ? previousPeriod(period) : { start: period.start, end: period.end };
  const needsPerformance = true;
  const targetEmploymentId = version.bonusKind === "individual_performance" ? employee.employmentId : null;
  const sources = needsPerformance ? performanceSnapshots.filter((snapshot) =>
    snapshot.scopeId === version.scopeId && snapshot.employmentId === targetEmploymentId &&
    snapshot.periodStart === sourcePeriod.start && snapshot.periodEnd === sourcePeriod.end,
  ) : [];
  const sourceAmountMinor = needsPerformance && sources.length ? sources.reduce((sum, snapshot) => sum + snapshot.amountMinor, 0) : null;
  const guaranteeMinor = version.guaranteeMinor;
  const rawAmountMinor = Math.max(0, (sourceAmountMinor ?? 0) - guaranteeMinor) * version.ratePpm / PPM;
  // 金額以分保存，但獎金規則明定以新臺幣元四捨五入，最後才回到分。
  const amountMinor = Math.max(0, Math.round(rawAmountMinor / 100) * 100);
  return {
    amountMinor,
    sourceAmountMinor,
    performanceSnapshotIds: sources.map((source) => source.id),
    formula: "max(0, performance - guarantee) × rate",
  };
}

/**
 * 以明確輸入的示範規則試算薪資：月薪按當月日曆日比例、核准付薪加班、
 * 申請上凍結的給薪比例。勞健保金額不在這裡猜測，因為保費分擔率尚未成為本公司的制度設定。
 */
export async function calculateHrPayroll(db: Database, input: HrPayrollCalculationInput, actor: HrActor): Promise<HrPayrollRunResult> {
  const period = periodFromKey(input.periodKey);
  const monthlyDivisorDays = input.monthlyDivisorDays ?? 30;
  const standardDailyHours = input.standardDailyHours ?? 8;
  if (!Number.isInteger(monthlyDivisorDays) || monthlyDivisorDays <= 0 || !Number.isFinite(standardDailyHours) || standardDailyHours <= 0 || standardDailyHours > 24) {
    throw new HrError(400, "薪資計算的月薪除數與每日工時設定不正確。 ");
  }
  const payDate = input.payDate ?? period.end;
  if (!isDateOnly(payDate)) throw new HrError(400, "發薪日必須是有效的 YYYY-MM-DD 日期。 ");

  const [existing] = input.requestId ? await db.select({ id: hrPayrollRuns.id }).from(hrPayrollRuns).where(eq(hrPayrollRuns.requestId, input.requestId)).limit(1) : [];
  if (existing) return getPayrollRunResult(db, existing.id, ["requestId 已存在，回傳原試算結果。"]);

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
      eq(users.status, "active"),
    ));
  const employees = employeeRows.filter((row) => employeeSelected(row, input));
  // 臨時支援人員沒有 users／hr_employments，薪資資格來自已發布班表；不套用獎金 policy。
  const scheduledWorkerRows = await db.select({ workerId: hrScheduleWorkerEntries.workerId, workerName: hrScheduleWorkers.displayName, workDate: hrScheduleWorkerEntries.workDate }).from(hrScheduleWorkerEntries)
    .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleWorkerEntries.scheduleVersionId))
    .innerJoin(hrScheduleWorkers, eq(hrScheduleWorkers.id, hrScheduleWorkerEntries.workerId))
    .where(and(eq(hrScheduleVersions.status, "published"), sql`${hrScheduleWorkerEntries.workDate} >= ${period.start}`, sql`${hrScheduleWorkerEntries.workDate} < ${period.end}`));
  if (!employees.length && !scheduledWorkerRows.length) throw new HrError(400, "指定月份沒有符合條件的啟用中員工或已發布支援排班。 ");

  const compensations = await db.select().from(hrCompensationVersions).where(and(
    sql`${hrCompensationVersions.validFrom} < ${period.end}`,
    sql`(${hrCompensationVersions.validTo} IS NULL OR ${hrCompensationVersions.validTo} > ${period.start})`,
  ));
  const insurance = await db.select().from(hrInsuranceVersions).where(and(
    sql`${hrInsuranceVersions.validFrom} < ${period.end}`,
    sql`(${hrInsuranceVersions.validTo} IS NULL OR ${hrInsuranceVersions.validTo} > ${period.start})`,
  ));
  const workerCompensations = await db.select().from(hrWorkerCompensationVersions).where(and(
    sql`${hrWorkerCompensationVersions.validFrom} < ${period.end}`,
    sql`(${hrWorkerCompensationVersions.validTo} IS NULL OR ${hrWorkerCompensationVersions.validTo} > ${period.start})`,
  ));
  const leaves = await db.select().from(hrLeaveRequests).where(and(
    eq(hrLeaveRequests.status, "approved"),
    sql`${hrLeaveRequests.startsOn} < ${period.end}`,
    sql`${hrLeaveRequests.endsOn} > ${period.start}`,
  ));
  const overtime = await db.select().from(hrOvertimeRequests).where(and(
    eq(hrOvertimeRequests.status, "approved"),
    eq(hrOvertimeRequests.settlementKind, "pay"),
    sql`${hrOvertimeRequests.requestedEnd} > ${period.start} AND ${hrOvertimeRequests.requestedStart} < ${period.end}`,
  ));
  const clocks = await db.select().from(hrClockEvents).where(and(
    sql`${hrClockEvents.occurredAt} >= ${period.start}`,
    sql`${hrClockEvents.occurredAt} < ${period.end}`,
  ));
  const bonusAllocations = input.bonusPoolId ? await db.select().from(hrBonusAllocations).where(eq(hrBonusAllocations.bonusPoolId, input.bonusPoolId)) : [];
  const bonusAssignmentRows = await db.select({
    versionId: sql<string>`${hrBonusPolicyVersions.id}`.as("bonus_assignment_version_id"),
    scopeId: sql<string>`${hrBonusPolicyVersions.scopeId}`.as("bonus_assignment_scope_id"),
    bonusKind: sql<HrBonusKind>`${hrBonusPolicyVersions.bonusKind}`.as("bonus_assignment_kind"),
    performancePeriod: sql<HrBonusPerformancePeriod>`${hrBonusPolicyVersions.performancePeriod}`.as("bonus_assignment_period"),
    ratePpm: sql<number>`${hrBonusPolicyVersions.ratePpm}`.as("bonus_assignment_rate"),
    guaranteeMinor: sql<number>`${hrBonusPolicyVersions.guaranteeMinor}`.as("bonus_assignment_guarantee"),
    memberId: sql<string>`${hrBonusPolicyMembers.id}`.as("bonus_assignment_member_id"),
    employmentId: sql<string>`${hrBonusPolicyMembers.employmentId}`.as("bonus_assignment_employment_id"),
    policyName: sql<string>`${hrBonusPolicies.name}`.as("bonus_assignment_name"),
  }).from(hrBonusPolicyMembers)
    .innerJoin(hrBonusPolicyVersions, eq(hrBonusPolicyVersions.id, hrBonusPolicyMembers.policyVersionId))
    .innerJoin(hrBonusPolicies, eq(hrBonusPolicies.id, hrBonusPolicyVersions.policyId))
    .where(and(
      eq(hrBonusPolicies.active, 1),
      sql`${hrBonusPolicyVersions.validFrom} < ${period.end}`,
      sql`(${hrBonusPolicyVersions.validTo} IS NULL OR ${hrBonusPolicyVersions.validTo} > ${period.start})`,
      sql`${hrBonusPolicyMembers.validFrom} < ${period.end}`,
      sql`(${hrBonusPolicyMembers.validTo} IS NULL OR ${hrBonusPolicyMembers.validTo} > ${period.start})`,
    ));
  const bonusAssignments: AssignedBonusPolicy[] = bonusAssignmentRows.map((row) => ({
    version: { id: row.versionId, scopeId: row.scopeId, bonusKind: normalizeBonusKind(row.bonusKind), performancePeriod: row.performancePeriod, ratePpm: row.ratePpm, guaranteeMinor: row.guaranteeMinor },
    member: { id: row.memberId, employmentId: row.employmentId },
    policyName: row.policyName,
  }));
  const previous = previousPeriod(period);
  const performanceSnapshots = await db.select().from(hrBonusPerformanceSnapshots).where(and(
    sql`${hrBonusPerformanceSnapshots.periodStart} >= ${previous.start}`,
    sql`${hrBonusPerformanceSnapshots.periodEnd} <= ${period.end}`,
  ));
  const calculationWarnings = new Set<string>();
  const calendarDays = dateRange(period.start, period.end);
  const statementRows: Array<{ employee: HrPayrollEmployeeResult; payslipId: string; lines: HrPayrollLineResult[]; compensationIds: string[]; insuranceIds: string[] }> = [];
  const workerStatements = new Map<string, { workerId: string; workerName: string; payBasis: "monthly" | "daily" | "hourly"; scheduledDays: number; amountMinor: number; compensationVersionId: string | null }>();
  for (const row of scheduledWorkerRows) {
    const scheduledDays = new Set(scheduledWorkerRows.filter((item) => item.workerId === row.workerId).map((item) => item.workDate)).size;
    const compensation = covering(workerCompensations.filter((item) => item.workerId === row.workerId), row.workDate);
    const existing = workerStatements.get(row.workerId);
    if (existing) continue;
    if (!compensation) {
      calculationWarnings.add(`${row.workerName} 找不到指定月份有效的支援人員敘薪，薪資為 0。`);
      workerStatements.set(row.workerId, { workerId: row.workerId, workerName: row.workerName, payBasis: "daily", scheduledDays, amountMinor: 0, compensationVersionId: null });
      continue;
    }
    const amountPerDay = compensation.payBasis === "monthly"
      ? Math.floor(compensation.baseAmountMinor / daysInMonth(period.year, period.month))
      : compensation.payBasis === "daily" ? compensation.baseAmountMinor : Math.round(compensation.baseAmountMinor * standardDailyHours);
    workerStatements.set(row.workerId, { workerId: row.workerId, workerName: row.workerName, payBasis: compensation.payBasis, scheduledDays, amountMinor: amountPerDay * scheduledDays, compensationVersionId: compensation.id });
  }

  for (const employee of employees) {
    const employmentDays = overlapDays(period.start, period.end, employee.hiredOn, employee.endedOn);
    const employeeCompensations = compensations.filter((row) => row.employmentId === employee.employmentId);
    const lines: HrPayrollLineResult[] = [];
    let baseMinor = 0;
    for (const day of employmentDays) {
      const compensation = covering(employeeCompensations, day);
      if (!compensation) continue;
      if (compensation.payBasis === "monthly") baseMinor += Math.floor(compensation.baseAmountMinor / daysInMonth(period.year, period.month));
      else if (compensation.payBasis === "daily") baseMinor += compensation.baseAmountMinor;
      else baseMinor += Math.round(compensation.baseAmountMinor * standardDailyHours);
    }
    // 避免每一天 floor 造成完整月份少幾分：完整月份同一版月薪直接保留原額。
    const fullMonthComp = covering(employeeCompensations, period.start);
    if (fullMonthComp?.payBasis === "monthly" && fullMonthComp.validFrom <= period.start && (fullMonthComp.validTo === null || fullMonthComp.validTo >= period.end)) {
      baseMinor = employeeDaysForPeriod(employee, period) === calendarDays.length ? fullMonthComp.baseAmountMinor : Math.round(fullMonthComp.baseAmountMinor * employeeDaysForPeriod(employee, period) / monthlyDivisorDays);
    }
    if (baseMinor > 0) lines.push({ lineKey: "base_salary", direction: "earning", amountMinor: baseMinor, explanation: { payBasis: fullMonthComp?.payBasis ?? "unknown", period: input.periodKey, rule: "月薪按日曆日比例；日薪／時薪按任職日計算" } });

    let bonusLineNumber = 0;
    for (const assignment of bonusAssignments.filter((item) => item.member.employmentId === employee.employmentId)) {
      const bonus = calculateAssignedBonus(assignment, employee, period, performanceSnapshots);
      if (bonus.sourceAmountMinor === null) {
        calculationWarnings.add(`${employee.employeeName} 的「${assignment.policyName}」找不到${assignment.version.performancePeriod === "previous_month" ? "前月" : "當月"}業績快照，獎金為 0。`);
      }
      if (bonus.amountMinor > 0) {
        bonusLineNumber += 1;
        lines.push({ lineKey: `bonus_${bonusLineNumber}`, direction: "earning", amountMinor: bonus.amountMinor, explanation: {
          policyName: assignment.policyName,
          policyVersionId: assignment.version.id,
          policyMemberId: assignment.member.id,
          bonusKind: assignment.version.bonusKind,
          performancePeriod: assignment.version.performancePeriod,
          performanceSnapshotIds: bonus.performanceSnapshotIds,
          sourceAmountMinor: bonus.sourceAmountMinor,
          guaranteeMinor: assignment.version.guaranteeMinor,
          ratePpm: assignment.version.ratePpm,
          formula: bonus.formula,
          rounding: "nearest_ntd_dollar",
        } });
      }
    }

    const employeeOvertime = overtime.filter((row) => row.employmentId === employee.employmentId);
    let overtimeMinor = 0;
    let overtimeSeconds = 0;
    for (const row of employeeOvertime) {
      const start = row.actualStart ?? row.requestedStart;
      const end = row.actualEnd ?? row.requestedEnd;
      const seconds = secondsBetween(start, end);
      if (!seconds) continue;
      const compensation = covering(employeeCompensations, start.slice(0, 10)) ?? fullMonthComp;
      const hourly = compensation?.payBasis === "monthly"
        ? Math.floor(compensation.baseAmountMinor / monthlyDivisorDays / standardDailyHours)
        : compensation?.payBasis === "daily" ? Math.floor(compensation.baseAmountMinor / standardDailyHours) : compensation?.baseAmountMinor ?? 0;
      overtimeMinor += Math.floor(hourly * seconds / 3600 * row.ratePpm / PPM);
      overtimeSeconds += seconds;
    }
    if (overtimeMinor > 0) lines.push({ lineKey: "overtime", direction: "earning", amountMinor: overtimeMinor, quantitySeconds: overtimeSeconds, explanation: { approvedRequests: employeeOvertime.length, monthlyDivisorDays, standardDailyHours } });

    let leaveDeduction = 0;
    for (const leave of leaves.filter((row) => row.employmentId === employee.employmentId)) {
      if (leave.payRatePpm >= PPM) continue;
      for (const day of overlapDays(period.start, period.end, leave.startsOn, leave.endsOn)) {
        const compensation = covering(employeeCompensations, day);
        if (!compensation) continue;
        const daily = compensation.payBasis === "monthly"
          ? Math.floor(compensation.baseAmountMinor / daysInMonth(period.year, period.month))
          : compensation.payBasis === "daily" ? compensation.baseAmountMinor : Math.round(compensation.baseAmountMinor * standardDailyHours);
        leaveDeduction += Math.floor(daily * (PPM - leave.payRatePpm) / PPM);
      }
    }
    if (leaveDeduction > 0) lines.push({ lineKey: "unpaid_leave", direction: "deduction", amountMinor: leaveDeduction, explanation: { rule: "使用請假提交時凍結的 payRatePpm", period: input.periodKey } });

    const bonus = bonusAllocations.find((row) => row.employmentId === employee.employmentId);
    if (bonus && bonus.amountMinor > 0) lines.push({ lineKey: "booth_bonus", direction: "earning", amountMinor: bonus.amountMinor, explanation: { bonusPoolId: input.bonusPoolId } });

    const attendanceDays = new Set(clocks.filter((row) => row.employmentId === employee.employmentId).map((row) => row.occurredAt.slice(0, 10)));
    const missingPunchDays = calendarDays.filter((day) => {
      const count = clocks.filter((row) => row.employmentId === employee.employmentId && row.occurredAt.slice(0, 10) === day).length;
      return count === 1;
    });
    const compensationIds = employeeCompensations.filter((row) => row.validFrom < period.end && (row.validTo === null || row.validTo > period.start)).map((row) => row.id);
    const insuranceIds = insurance.filter((row) => row.employmentId === employee.employmentId).map((row) => row.id);
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

  const [latest] = await db.select({ value: sql<number>`coalesce(max(${hrPayrollRuns.versionNumber}), 0)` }).from(hrPayrollRuns).where(eq(hrPayrollRuns.payrollPeriodId, `payroll-period-${period.periodKey}`));
  const runId = crypto.randomUUID();
  const requestId = input.requestId ?? crypto.randomUUID();
  const versionNumber = Number(latest?.value ?? 0) + 1;
  const periodInsert = db.insert(hrPayrollPeriods).values({ id: `payroll-period-${period.periodKey}`, periodKey: period.periodKey, attendanceStart: period.start, attendanceEnd: period.end, payDate, createdBy: actor.id }).onConflictDoNothing();
  const totalResults = statementRows.length + workerStatements.size;
  const runInsert = db.insert(hrPayrollRuns).values({ id: runId, payrollPeriodId: `payroll-period-${period.periodKey}`, versionNumber, requestId, inputRevision: Math.max(1, ...employees.map((employee) => employee.employeeRevision)), engineVersion: "hr-payroll-demo-v1", status: "ready", expectedCount: totalResults, completedCount: totalResults, createdBy: actor.id });
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
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new HrError(409, "薪資試算請求已存在，請重新整理。 ");
    throw error;
  }
  return getPayrollRunResult(db, runId, [...calculationWarnings]);
}

function employeeDaysForPeriod(employee: { hiredOn: string; endedOn: string | null }, period: { start: string; end: string }): number {
  return overlapDays(period.start, period.end, employee.hiredOn, employee.endedOn).length;
}

/** 取得可選的獎金政策版本；來源與比例保留在 API，前端不另複製制度常數。 */
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
    search ? or(like(hrBonusPolicies.name, `%${search}%`), like(scopes.name, `%${search}%`)) : undefined,
    input.scopeId !== "all" ? eq(hrBonusPolicyVersions.scopeId, input.scopeId) : undefined,
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
  return { policies: rows.map((row) => ({ ...row, bonusKind: normalizeBonusKind(row.bonusKind) })), total, page: input.page, pageSize: input.pageSize, hasMore: input.page * input.pageSize < total };
}

function validateBonusPolicy(input: CreateHrBonusPolicyInput) {
  if (!Number.isSafeInteger(input.ratePpm) || input.ratePpm < 0 || input.ratePpm > PPM) throw new HrError(400, "獎金比例必須介於 0～100%。");
  ensureMoney(input.guaranteeMinor, "保底金額");
  const employeeUserIds = input.employeeUserIds ?? [];
  if (employeeUserIds.length > 80 || new Set(employeeUserIds).size !== employeeUserIds.length) throw new HrError(400, "指派員工不可重複，且一次最多指派 80 人。 ");
  if (employeeUserIds.length && (!input.assignmentValidFrom || !isDateOnly(input.assignmentValidFrom))) throw new HrError(400, "員工套用生效日必須是有效日期。 ");
}

async function ensureBonusScope(db: Database, scopeId: string) {
  const [scope] = await db.select({ id: scopes.id }).from(scopes).where(eq(scopes.id, scopeId)).limit(1);
  if (!scope) throw new HrError(404, "找不到適用通路。 ");
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
  validateBonusPolicy(input);
  await ensureBonusScope(db, input.scopeId);
  const employments = await resolveBonusPolicyEmployments(db, input.employeeUserIds, input.assignmentValidFrom);
  const policyId = crypto.randomUUID();
  const policyVersionId = crypto.randomUUID();
  try {
    await db.batch(batchStatements([
      db.insert(hrBonusPolicies).values({ id: policyId, name: input.name, active: 1, createdBy: actor.id }),
      db.insert(hrBonusPolicyVersions).values({ id: policyVersionId, policyId, versionNumber: 1, scopeId: input.scopeId, performanceKind: "scheduled_daily", revenueKind: "sales_amount", bonusKind: input.bonusKind, performancePeriod: input.performancePeriod, ratePpm: input.ratePpm, guaranteeMinor: input.guaranteeMinor, validFrom: "1900-01-01", validTo: null, createdBy: actor.id }),
      ...employments.map((employment) => db.insert(hrBonusPolicyMembers).values({ id: crypto.randomUUID(), policyVersionId, employmentId: employment.id, validFrom: input.assignmentValidFrom!, validTo: null, weightUnits: 1, createdBy: actor.id })),
      db.insert(activityEvents).values(activityRow({ entityType: "hr_bonus", entityId: policyVersionId, source: "hr", eventType: "bonus_policy_created", summary: "獎金政策建立", actor, payload: { policyId, policyVersionId, bonusKind: input.bonusKind, performancePeriod: input.performancePeriod, assignmentCount: employments.length } })),
    ]));
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new HrError(409, "獎金政策建立失敗，請重新整理後再試。 ");
    throw error;
  }
  return { policyId, policyVersionId, assignmentCount: employments.length };
}

/** 編輯 policy 不覆蓋舊公式，而是建立同一 policy 的下一個版本。 */
export async function updateHrBonusPolicy(db: Database, input: UpdateHrBonusPolicyInput, actor: HrActor) {
  validateBonusPolicy(input);
  await ensureBonusScope(db, input.scopeId);
  if (!isDateOnly(input.validFrom)) throw new HrError(400, "policy 新版本生效日必須是有效日期。 ");
  const [current] = await db.select({ policyId: hrBonusPolicyVersions.policyId, versionNumber: hrBonusPolicyVersions.versionNumber, validFrom: hrBonusPolicyVersions.validFrom }).from(hrBonusPolicyVersions).where(eq(hrBonusPolicyVersions.id, input.policyVersionId)).limit(1);
  if (!current) throw new HrError(404, "找不到獎金政策版本。 ");
  if (input.validFrom <= current.validFrom) throw new HrError(400, "新版本生效日必須晚於目前版本生效日。 ");
  const [latest] = await db.select({ id: hrBonusPolicyVersions.id, versionNumber: hrBonusPolicyVersions.versionNumber, validFrom: hrBonusPolicyVersions.validFrom }).from(hrBonusPolicyVersions)
    .where(eq(hrBonusPolicyVersions.policyId, current.policyId)).orderBy(desc(hrBonusPolicyVersions.validFrom), desc(hrBonusPolicyVersions.versionNumber)).limit(1);
  if (latest && input.validFrom <= latest.validFrom) throw new HrError(400, "新版本生效日必須晚於最新版本生效日。 ");
  const versionNumber = Number(latest?.versionNumber ?? 0) + 1;
  const carriedMembers = await db.select({ member: hrBonusPolicyMembers }).from(hrBonusPolicyMembers)
    .innerJoin(hrBonusPolicyVersions, eq(hrBonusPolicyVersions.id, hrBonusPolicyMembers.policyVersionId))
    .where(and(eq(hrBonusPolicyVersions.policyId, current.policyId), sql`${hrBonusPolicyVersions.validFrom} < ${input.validFrom}`, sql`(${hrBonusPolicyVersions.validTo} IS NULL OR ${hrBonusPolicyVersions.validTo} > ${input.validFrom})`, sql`${hrBonusPolicyMembers.validFrom} < ${input.validFrom}`, sql`(${hrBonusPolicyMembers.validTo} IS NULL OR ${hrBonusPolicyMembers.validTo} > ${input.validFrom})`));
  const policyVersionId = crypto.randomUUID();
  try {
    await db.batch(batchStatements([
      db.update(hrBonusPolicies).set({ name: input.name }).where(eq(hrBonusPolicies.id, current.policyId)),
      ...(latest ? [db.update(hrBonusPolicyVersions).set({ validTo: input.validFrom }).where(eq(hrBonusPolicyVersions.id, latest.id))] : []),
      ...(carriedMembers.length ? [db.update(hrBonusPolicyMembers).set({ validTo: input.validFrom }).where(inArray(hrBonusPolicyMembers.id, carriedMembers.map(({ member }) => member.id)))] : []),
      db.insert(hrBonusPolicyVersions).values({ id: policyVersionId, policyId: current.policyId, versionNumber, scopeId: input.scopeId, performanceKind: "scheduled_daily", revenueKind: "sales_amount", bonusKind: input.bonusKind, performancePeriod: input.performancePeriod, ratePpm: input.ratePpm, guaranteeMinor: input.guaranteeMinor, validFrom: input.validFrom, validTo: null, createdBy: actor.id }),
      ...carriedMembers.map(({ member }) => db.insert(hrBonusPolicyMembers).values({ id: crypto.randomUUID(), policyVersionId, employmentId: member.employmentId, validFrom: input.validFrom, validTo: member.validTo, weightUnits: member.weightUnits, createdBy: actor.id })),
      db.insert(activityEvents).values(activityRow({ entityType: "hr_bonus", entityId: policyVersionId, source: "hr", eventType: "bonus_policy_version_created", summary: "獎金政策版本更新", actor, payload: { policyId: current.policyId, previousPolicyVersionId: input.policyVersionId, policyVersionId, versionNumber, validFrom: input.validFrom, assignmentCount: carriedMembers.length } })),
    ]));
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new HrError(409, "獎金政策版本已建立，請重新整理。 ");
    throw error;
  }
  return { policyId: current.policyId, policyVersionId, versionNumber };
}

/** 刪除 policy 採停用，不物理刪除，保留已結算薪資與操作紀錄可追溯性。 */
export async function deleteHrBonusPolicy(db: Database, policyVersionId: string, actor: HrActor) {
  const [policy] = await db.select({ id: hrBonusPolicies.id, name: hrBonusPolicies.name, active: hrBonusPolicies.active }).from(hrBonusPolicyVersions)
    .innerJoin(hrBonusPolicies, eq(hrBonusPolicies.id, hrBonusPolicyVersions.policyId))
    .where(eq(hrBonusPolicyVersions.id, policyVersionId)).limit(1);
  if (!policy) throw new HrError(404, "找不到獎金政策版本。 ");
  if (!policy.active) return { policyId: policy.id, deleted: false };
  await db.batch(batchStatements([
    db.update(hrBonusPolicies).set({ active: 0 }).where(eq(hrBonusPolicies.id, policy.id)),
    db.insert(activityEvents).values(activityRow({ entityType: "hr_bonus", entityId: policy.id, source: "hr", eventType: "bonus_policy_archived", summary: "獎金政策停用", actor, payload: { policyId: policy.id, policyVersionId, policyName: policy.name } })),
  ]));
  return { policyId: policy.id, deleted: true };
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
    .orderBy(desc(hrBonusPolicyMembers.createdAt));
  return rows.map((row) => ({
    assignment: { id: row.assignmentId, employmentId: row.assignmentEmploymentId, validFrom: row.validFrom, validTo: row.validTo, weightUnits: row.weightUnits },
    policyVersionId: row.policyVersionId, policyName: row.policyName, bonusKind: normalizeBonusKind(row.bonusKind), performancePeriod: row.performancePeriod,
    employeeUserId: row.employeeUserId, employeeNumber: row.employeeNumber, employeeName: row.employeeName,
  }));
}

export async function assignHrBonusPolicyMember(db: Database, input: AssignHrBonusPolicyInput, actor: HrActor) {
  if (!isDateOnly(input.validFrom) || (input.validTo !== null && input.validTo !== undefined && !isDateOnly(input.validTo))) throw new HrError(400, "政策生效期間必須是有效日期。 ");
  if (input.validTo !== null && input.validTo !== undefined && input.validTo <= input.validFrom) throw new HrError(400, "政策結束日必須晚於生效日。 ");
  const weightUnits = input.weightUnits ?? 1;
  if (!Number.isSafeInteger(weightUnits) || weightUnits <= 0) throw new HrError(400, "政策權重必須是正整數。 ");
  const [employment] = await db.select({ id: hrEmployments.id }).from(hrEmployments)
    .innerJoin(hrEmployees, eq(hrEmployees.userId, hrEmployments.employeeUserId))
    .where(and(eq(hrEmployments.employeeUserId, input.employeeUserId), sql`${hrEmployments.hiredOn} <= ${input.validFrom}`, sql`(${hrEmployments.endedOn} IS NULL OR ${hrEmployments.endedOn} > ${input.validFrom})`))
    .orderBy(desc(hrEmployments.hiredOn)).limit(1);
  if (!employment) throw new HrError(404, "找不到該員工在政策生效日的任職紀錄。 ");
  const [policy] = await db.select({ id: hrBonusPolicyVersions.id, policyId: hrBonusPolicyVersions.policyId, active: hrBonusPolicies.active }).from(hrBonusPolicyVersions)
    .innerJoin(hrBonusPolicies, eq(hrBonusPolicies.id, hrBonusPolicyVersions.policyId))
    .where(eq(hrBonusPolicyVersions.id, input.policyVersionId)).limit(1);
  if (!policy) throw new HrError(404, "找不到獎金政策版本。 ");
  if (!policy.active) throw new HrError(409, "這個 policy 已停用，不能再套用。 ");
  const assignmentEnd = input.validTo ?? "9999-12-31";
  const [duplicate] = await db.select({ id: hrBonusPolicyMembers.id }).from(hrBonusPolicyMembers)
    .innerJoin(hrBonusPolicyVersions, eq(hrBonusPolicyVersions.id, hrBonusPolicyMembers.policyVersionId))
    .where(and(eq(hrBonusPolicyVersions.policyId, policy.policyId), eq(hrBonusPolicyMembers.employmentId, employment.id), sql`${hrBonusPolicyMembers.validFrom} < ${assignmentEnd}`, sql`(${hrBonusPolicyMembers.validTo} IS NULL OR ${hrBonusPolicyMembers.validTo} > ${input.validFrom})`))
    .limit(1);
  if (duplicate) throw new HrError(409, "該員工已套用這個 policy，不能重複套用重疊期間。 ");
  const assignmentId = crypto.randomUUID();
  try {
    await db.batch(batchStatements([
      db.insert(hrBonusPolicyMembers).values({ id: assignmentId, policyVersionId: input.policyVersionId, employmentId: employment.id, validFrom: input.validFrom, validTo: input.validTo ?? null, weightUnits, createdBy: actor.id }),
      db.insert(activityEvents).values(activityRow({ entityType: "hr_bonus", entityId: assignmentId, source: "hr", eventType: "bonus_policy_assigned", summary: "獎金政策套用到員工", actor, payload: { policyVersionId: input.policyVersionId, employmentId: employment.id } })),
    ]));
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new HrError(409, "該員工已套用這個 policy，不能重複套用相同生效日。 ");
    throw error;
  }
  return { id: assignmentId, employmentId: employment.id };
}

export async function createHrBonusPerformanceSnapshot(db: Database, input: CreateHrBonusPerformanceSnapshotInput, actor: HrActor) {
  const period = periodFromKey(input.periodKey);
  await ensureBonusScope(db, input.scopeId);
  ensureMoney(input.amountMinor, "業績金額");
  let employmentId: string | null = null;
  if (input.employeeUserId) {
    const [employment] = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(eq(hrEmployments.employeeUserId, input.employeeUserId), sql`${hrEmployments.hiredOn} < ${period.end}`, sql`(${hrEmployments.endedOn} IS NULL OR ${hrEmployments.endedOn} > ${period.start})`)).orderBy(desc(hrEmployments.hiredOn)).limit(1);
    if (!employment) throw new HrError(404, "找不到業績所屬月份的任職紀錄。 ");
    employmentId = employment.id;
  }
  const [duplicate] = await db.select({ id: hrBonusPerformanceSnapshots.id }).from(hrBonusPerformanceSnapshots)
    .where(and(
      eq(hrBonusPerformanceSnapshots.scopeId, input.scopeId),
      employmentId === null ? sql`${hrBonusPerformanceSnapshots.employmentId} IS NULL` : eq(hrBonusPerformanceSnapshots.employmentId, employmentId),
      eq(hrBonusPerformanceSnapshots.periodStart, period.start),
      eq(hrBonusPerformanceSnapshots.periodEnd, period.end),
      eq(hrBonusPerformanceSnapshots.sourceRef, input.sourceRef),
    )).limit(1);
  if (duplicate) throw new HrError(409, "相同通路、員工、月份與來源的業績快照已存在。 ");
  const id = crypto.randomUUID();
  try {
    await db.batch(batchStatements([
      db.insert(hrBonusPerformanceSnapshots).values({ id, scopeId: input.scopeId, employmentId, periodStart: period.start, periodEnd: period.end, amountMinor: input.amountMinor, sourceKind: input.sourceKind, sourceRef: input.sourceRef, provenanceJson: JSON.stringify(input.provenance ?? {}), createdBy: actor.id }),
      db.insert(activityEvents).values(activityRow({ entityType: "hr_bonus", entityId: id, source: "hr", eventType: "bonus_performance_snapshot_created", summary: "業績快照建立", actor, payload: { scopeId: input.scopeId, employmentId, periodKey: input.periodKey, sourceKind: input.sourceKind } })),
    ]));
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new HrError(409, "相同通路、員工、月份與來源的業績快照已存在。 ");
    throw error;
  }
  return { id, scopeId: input.scopeId, employmentId, periodKey: input.periodKey };
}

export async function listHrBonusPerformanceSnapshots(db: Database, periodKey?: string) {
  const period = periodKey ? periodFromKey(periodKey) : undefined;
  const condition = period ? and(eq(hrBonusPerformanceSnapshots.periodStart, period.start), eq(hrBonusPerformanceSnapshots.periodEnd, period.end)) : undefined;
  return db.select({ snapshot: hrBonusPerformanceSnapshots, scopeName: scopes.name, employeeUserId: hrEmployments.employeeUserId, employeeName: displayName }).from(hrBonusPerformanceSnapshots)
    .innerJoin(scopes, eq(scopes.id, hrBonusPerformanceSnapshots.scopeId))
    .leftJoin(hrEmployments, eq(hrEmployments.id, hrBonusPerformanceSnapshots.employmentId))
    .leftJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(condition).orderBy(desc(hrBonusPerformanceSnapshots.periodStart), desc(hrBonusPerformanceSnapshots.createdAt));
}

async function getBonusPoolResult(db: Database, poolId: string, warnings: string[] = []): Promise<HrBonusPoolResult> {
  const [row] = await db.select({
    poolId: sql<string>`${hrBonusPools.id}`.as("bonus_pool_id"),
    policyVersionId: sql<string>`${hrBonusPolicyVersions.id}`.as("policy_version_id"),
    scopeId: sql<string>`${hrBonusPolicyVersions.scopeId}`.as("bonus_scope_id"),
    policyName: sql<string>`${hrBonusPolicies.name}`.as("bonus_policy_name"),
    scopeName: sql<string>`${scopes.name}`.as("bonus_scope_name"),
    periodStart: sql<string>`${hrBonusPools.periodStart}`.as("bonus_period_start"),
    periodEnd: sql<string>`${hrBonusPools.periodEnd}`.as("bonus_period_end"),
    status: sql<string>`${hrBonusPools.status}`.as("bonus_status"),
    poolAmountMinor: sql<number>`${hrBonusPools.poolAmountMinor}`.as("bonus_pool_amount_minor"),
    guaranteeMinor: sql<number>`${hrBonusPolicyVersions.guaranteeMinor}`.as("bonus_guarantee_minor"),
    ratePpm: sql<number>`${hrBonusPolicyVersions.ratePpm}`.as("bonus_rate_ppm"),
  }).from(hrBonusPools)
    .innerJoin(hrBonusPolicyVersions, eq(hrBonusPolicyVersions.id, hrBonusPools.policyVersionId))
    .innerJoin(hrBonusPolicies, eq(hrBonusPolicies.id, hrBonusPolicyVersions.policyId))
    .innerJoin(scopes, eq(scopes.id, hrBonusPolicyVersions.scopeId))
    .where(eq(hrBonusPools.id, poolId)).limit(1);
  if (!row) throw new HrError(404, "找不到獎金池。 ");
  const allocations = await db.select({ allocation: hrBonusAllocations, employeeNumber: hrEmployees.employeeNumber, employeeName: displayName }).from(hrBonusAllocations)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrBonusAllocations.employmentId))
    .innerJoin(hrEmployees, eq(hrEmployees.userId, hrEmployments.employeeUserId))
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(eq(hrBonusAllocations.bonusPoolId, poolId)).orderBy(asc(hrEmployees.employeeNumber));
  const snapshots = await db.select().from(hrBonusRevenueSnapshots).where(eq(hrBonusRevenueSnapshots.bonusPoolId, poolId)).orderBy(asc(hrBonusRevenueSnapshots.sourceStart));
  const entries = await db.select({ entry: hrScheduleEntries }).from(hrScheduleEntries)
    .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleEntries.scheduleVersionId))
    .where(and(eq(hrScheduleVersions.status, "published"), eq(hrScheduleEntries.scopeId, row.scopeId), sql`${hrScheduleEntries.workDate} >= ${row.periodStart}`, sql`${hrScheduleEntries.workDate} < ${row.periodEnd}`));
  const scheduledDates = new Set(entries.map(({ entry }) => entry.workDate));
  return {
    poolId,
    policyVersionId: row.policyVersionId,
    policyName: row.policyName,
    scopeId: row.scopeId,
    scopeName: row.scopeName,
    periodKey: row.periodStart.slice(0, 7),
    status: row.status as HrBonusPoolResult["status"],
    poolAmountMinor: row.poolAmountMinor,
    allocations: allocations.map(({ allocation, employeeNumber, employeeName }) => ({ employmentId: allocation.employmentId, employeeNumber, employeeName, weightUnits: allocation.weightUnits, scheduledDays: allocation.scheduledDays, revenueMinor: allocation.revenueMinor, amountMinor: allocation.amountMinor })),
    daily: snapshots.map((snapshot) => ({ businessDate: snapshot.sourceStart.slice(0, 10), revenueMinor: snapshot.amountMinor, bonusMinor: scheduledDates.has(snapshot.sourceStart.slice(0, 10)) ? dailyBonus(snapshot.amountMinor, row.guaranteeMinor, row.ratePpm) : 0, scheduled: scheduledDates.has(snapshot.sourceStart.slice(0, 10)) })),
    warnings: [...new Set([BONUS_SOURCE_WARNING, ...warnings])],
  };
}

function dailyBonus(revenueMinor: number, guaranteeMinor: number, ratePpm: number): number {
  return Math.floor(Math.max(0, revenueMinor - guaranteeMinor) * ratePpm / PPM);
}

/**
 * 櫃點獎金規則：只有發布班表涵蓋的日期才有資格；每日營業額先扣保底，
 * 剩餘額乘固定百分比形成獎金池，再依「排班日 × 權重」分配。營業額只接受呼叫端
 * 明確帶入的核准來源，不把 report_payout_daily 當成營業額。
 */
export async function calculateHrBonusPool(db: Database, input: HrBonusCalculationInput, actor: HrActor): Promise<HrBonusPoolResult> {
  const period = periodFromKey(input.periodKey);
  const [policy] = await db.select({ version: hrBonusPolicyVersions, policyName: sql<string>`${hrBonusPolicies.name}`.as("bonus_policy_name"), scopeName: sql<string>`${scopes.name}`.as("bonus_scope_name"), active: sql<number>`${hrBonusPolicies.active}`.as("bonus_policy_active") }).from(hrBonusPolicyVersions)
    .innerJoin(hrBonusPolicies, eq(hrBonusPolicies.id, hrBonusPolicyVersions.policyId))
    .innerJoin(scopes, eq(scopes.id, hrBonusPolicyVersions.scopeId))
    .where(eq(hrBonusPolicyVersions.id, input.policyVersionId)).limit(1);
  if (!policy) throw new HrError(404, "找不到獎金政策版本。 ");
  if (!policy.active) throw new HrError(409, "這個 policy 已停用，不能再計算。 ");
  if (policy.version.bonusKind !== "team_performance") throw new HrError(400, "個人績效 policy 由薪資試算逐員工計算，不能建立櫃點獎金池。 ");
  if (policy.version.validFrom >= period.end || (policy.version.validTo !== null && policy.version.validTo <= period.start)) throw new HrError(400, "獎金政策版本不適用於指定月份。 ");
  if (!Array.isArray(input.revenue)) throw new HrError(400, "獎金計算需要每日核准業績快照。 ");
  if (input.revenue.some((item) => !isDateOnly(item.businessDate))) throw new HrError(400, "業績日期必須是有效的 YYYY-MM-DD 日期。 ");
  const revenue = input.revenue.map((item) => ({ ...item, amountMinor: ensureMoney(item.amountMinor, "業績金額") })).filter((item) => item.businessDate >= period.start && item.businessDate < period.end);
  const revenueDates = new Set<string>();
  for (const item of revenue) {
    if (revenueDates.has(item.businessDate)) throw new HrError(400, "同一月份每日只能提交一筆核准業績快照。 ");
    revenueDates.add(item.businessDate);
  }

  const entries = await db.select({ entry: hrScheduleEntries }).from(hrScheduleEntries)
    .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleEntries.scheduleVersionId))
    .where(and(eq(hrScheduleVersions.status, "published"), eq(hrScheduleEntries.scopeId, policy.version.scopeId), sql`${hrScheduleEntries.workDate} >= ${period.start}`, sql`${hrScheduleEntries.workDate} < ${period.end}`));
  const members = await db.select({ member: hrBonusPolicyMembers, employmentId: hrBonusPolicyMembers.employmentId }).from(hrBonusPolicyMembers)
    .where(and(eq(hrBonusPolicyMembers.policyVersionId, input.policyVersionId), sql`${hrBonusPolicyMembers.validFrom} < ${period.end}`, sql`(${hrBonusPolicyMembers.validTo} IS NULL OR ${hrBonusPolicyMembers.validTo} > ${period.start})`));
  if (!members.length) throw new HrError(400, "獎金政策沒有有效成員。 ");
  const eligible = members.map(({ member }) => ({ member, scheduledDays: new Set(entries.filter(({ entry }) => entry.employmentId === member.employmentId).map(({ entry }) => entry.workDate)).size })).filter((item) => item.scheduledDays > 0);
  if (!eligible.length) throw new HrError(400, "指定月份沒有符合獎金政策的已發布排班。 ");
  const uniqueRevenue = new Map<string, HrBonusRevenueInput>();
  for (const item of revenue) uniqueRevenue.set(item.businessDate, item);
  const daily = [...uniqueRevenue.values()].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  const guaranteeMinor = policy.version.guaranteeMinor;
  const dailyAmounts = daily.map((item) => ({ ...item, bonusMinor: entries.some(({ entry }) => entry.workDate === item.businessDate) ? dailyBonus(item.amountMinor, guaranteeMinor, policy.version.ratePpm) : 0 }));
  const poolAmountMinor = dailyAmounts.reduce((sum, item) => sum + item.bonusMinor, 0);
  const weightedTotal = eligible.reduce((sum, item) => sum + item.scheduledDays * item.member.weightUnits, 0);
  const allocationAmounts = eligible.map((item) => ({ ...item, amountMinor: weightedTotal ? Math.floor(poolAmountMinor * item.scheduledDays * item.member.weightUnits / weightedTotal) : 0 }));
  const remainder = poolAmountMinor - allocationAmounts.reduce((sum, item) => sum + item.amountMinor, 0);
  if (remainder && allocationAmounts[0]) allocationAmounts[0].amountMinor += remainder;

  const [latest] = await db.select({ value: sql<number>`coalesce(max(${hrBonusPools.calculationVersion}), 0)` }).from(hrBonusPools).where(and(eq(hrBonusPools.policyVersionId, input.policyVersionId), eq(hrBonusPools.periodStart, period.start), eq(hrBonusPools.periodEnd, period.end)));
  const poolId = crypto.randomUUID();
  const calculationVersion = Number(latest?.value ?? 0) + 1;
  const statements = [
    db.insert(hrBonusPools).values({ id: poolId, policyVersionId: input.policyVersionId, periodStart: period.start, periodEnd: period.end, calculationVersion, status: "calculated", poolAmountMinor, createdBy: actor.id }),
    ...dailyAmounts.map((item) => db.insert(hrBonusRevenueSnapshots).values({ id: crypto.randomUUID(), bonusPoolId: poolId, scopeId: policy.version.scopeId, sourceKind: item.sourceKind ?? "manual", sourceRef: item.sourceRef ?? "", sourceStart: `${item.businessDate} 00:00:00`, sourceEnd: `${nextDate(item.businessDate)} 00:00:00`, amountMinor: item.amountMinor, provenanceJson: JSON.stringify(item.provenance ?? {}) })),
    ...allocationAmounts.map((item) => db.insert(hrBonusAllocations).values({ id: crypto.randomUUID(), bonusPoolId: poolId, employmentId: item.member.employmentId, weightUnits: item.member.weightUnits, scheduledDays: item.scheduledDays, revenueMinor: dailyAmounts.filter((revenueItem) => entries.some(({ entry }) => entry.employmentId === item.member.employmentId && entry.workDate === revenueItem.businessDate)).reduce((sum, revenueItem) => sum + revenueItem.amountMinor, 0), amountMinor: item.amountMinor, roundingAdjustmentMinor: item.member === allocationAmounts[0]?.member ? remainder : 0, explanationJson: JSON.stringify({ formula: "max(0, revenue - guarantee) × rate × scheduledDays × weight / totalWeightedScheduledDays", guaranteeMinor, ratePpm: policy.version.ratePpm }) })),
    db.insert(activityEvents).values(activityRow({ entityType: "hr_bonus", entityId: poolId, source: "hr", eventType: "bonus_pool_calculated", summary: "櫃點獎金試算完成", actor, payload: { periodKey: period.periodKey, policyVersionId: input.policyVersionId, poolAmountMinor } })),
  ];
  await db.batch(batchStatements(statements));
  return getBonusPoolResult(db, poolId);
}

function nextDate(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export async function listHrBonusPools(db: Database, periodKey?: string) {
  const condition = periodKey ? eq(hrBonusPools.periodStart, periodFromKey(periodKey).start) : undefined;
  return db.select({ pool: hrBonusPools, policyName: sql<string>`${hrBonusPolicies.name}`.as("bonus_policy_name"), scopeName: sql<string>`${scopes.name}`.as("bonus_scope_name") }).from(hrBonusPools)
    .innerJoin(hrBonusPolicyVersions, eq(hrBonusPolicyVersions.id, hrBonusPools.policyVersionId))
    .innerJoin(hrBonusPolicies, eq(hrBonusPolicies.id, hrBonusPolicyVersions.policyId))
    .innerJoin(scopes, eq(scopes.id, hrBonusPolicyVersions.scopeId))
    .where(condition).orderBy(desc(hrBonusPools.createdAt));
}

export async function getHrBonusPool(db: Database, poolId: string) {
  return getBonusPoolResult(db, poolId);
}

export async function listHrPayrollRuns(db: Database) {
  return db.select({ run: hrPayrollRuns, periodKey: hrPayrollPeriods.periodKey, periodStatus: hrPayrollPeriods.status }).from(hrPayrollRuns)
    .innerJoin(hrPayrollPeriods, eq(hrPayrollPeriods.id, hrPayrollRuns.payrollPeriodId))
    .orderBy(desc(hrPayrollRuns.createdAt));
}

export async function getHrPayrollRun(db: Database, runId: string) {
  return getPayrollRunResult(db, runId);
}
