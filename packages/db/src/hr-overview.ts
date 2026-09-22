import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { countHrClockCalendarAnomalies } from "./hr-attendance.js";
import { hrEmployableUser } from "./hr-people.js";
import { hrPayrollPeriods, hrPayrollRuns } from "./schema/hr-payroll-runs.js";
import { hrInsuranceVersions } from "./schema/hr-payroll.js";
import { hrEmployees, hrEmployments } from "./schema/hr-people.js";
import { hrEmploymentAttendanceSettings } from "./schema/hr-attendance.js";
import { hrScheduleEntries, hrScheduleVersions } from "./schema/hr-scheduling.js";
import { users } from "./schema/auth.js";

export type HrOverviewPayrollStatus = "not_started" | "calculating" | "ready" | "approved" | "closed" | "failed";

export interface HrOverviewResult {
  periodKey: string;
  attendance: { anomalyCount: number };
  schedule: { status: "not_started" | "pending" | "published" | "not_applicable"; scheduledEmployeeCount: number; missingEmployeeCount: number };
  insurance: { totalEmployeeCount: number; missingEmployeeCount: number };
  payroll: { status: HrOverviewPayrollStatus; runId: string | null; versionNumber: number | null; completedCount: number; expectedCount: number };
}

function taipeiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

function periodKeyFromDate(date: string) {
  return date.slice(0, 7);
}

/**
 * 概覽只回傳待辦數量與入口需要的狀態，不把薪資、投保金額或個人打卡明細帶到首頁。
 * 待辦由既有資料計算，避免首頁再維護一份會漂移的摘要表。
 */
export async function getHrOverview(db: Database): Promise<HrOverviewResult> {
  const today = taipeiToday();
  const periodKey = periodKeyFromDate(today);
  const [yearText, monthText] = periodKey.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const periodStart = `${periodKey}-01`;
  const nextPeriodStart = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;

  const employeeRows = await db.select({ userId: hrEmployees.userId, employmentId: hrEmployments.id, hiredOn: hrEmployments.hiredOn, endedOn: hrEmployments.endedOn }).from(hrEmployees)
    .innerJoin(users, eq(users.id, hrEmployees.userId))
    .innerJoin(hrEmployments, eq(hrEmployments.employeeUserId, hrEmployees.userId))
    .where(and(hrEmployableUser, sql`${hrEmployments.revokedAt} IS NULL`));
  const activeRows = employeeRows.filter((row) => row.hiredOn <= today && (row.endedOn === null || today < row.endedOn));
  const activeUserIds = [...new Set(activeRows.map((row) => row.userId))];
  const activeEmploymentIds = new Set(activeRows.map((row) => row.employmentId));

  const anomalyCount = await countHrClockCalendarAnomalies(db, activeUserIds, year, month);

  const [attendanceSettings, scheduleVersionRows, insuranceRows, payrollRows] = await Promise.all([
    db.select({ employmentId: hrEmploymentAttendanceSettings.employmentId, attendanceMode: hrEmploymentAttendanceSettings.attendanceMode }).from(hrEmploymentAttendanceSettings).where(inArray(hrEmploymentAttendanceSettings.employmentId, [...activeEmploymentIds])),
    db.select({ id: hrScheduleVersions.id, status: hrScheduleVersions.status, versionNumber: hrScheduleVersions.versionNumber }).from(hrScheduleVersions).where(and(eq(hrScheduleVersions.periodStart, periodStart), eq(hrScheduleVersions.periodEnd, nextPeriodStart))).orderBy(desc(hrScheduleVersions.versionNumber)).limit(1),
    db.select({ employmentId: hrInsuranceVersions.employmentId, scheme: hrInsuranceVersions.scheme, status: hrInsuranceVersions.status, validFrom: hrInsuranceVersions.validFrom, validTo: hrInsuranceVersions.validTo }).from(hrInsuranceVersions).where(and(inArray(hrInsuranceVersions.employmentId, [...activeEmploymentIds]), sql`${hrInsuranceVersions.validFrom} <= ${today} AND (${hrInsuranceVersions.validTo} IS NULL OR ${today} < ${hrInsuranceVersions.validTo})`)),
    db.select({ runId: hrPayrollRuns.id, runStatus: hrPayrollRuns.status, versionNumber: hrPayrollRuns.versionNumber, completedCount: hrPayrollRuns.completedCount, expectedCount: hrPayrollRuns.expectedCount }).from(hrPayrollRuns)
      .innerJoin(hrPayrollPeriods, eq(hrPayrollPeriods.id, hrPayrollRuns.payrollPeriodId))
      .where(eq(hrPayrollPeriods.periodKey, periodKey)).orderBy(desc(hrPayrollRuns.versionNumber), desc(hrPayrollRuns.createdAt)).limit(1),
  ]);

  const scheduledEmploymentIds = new Set(attendanceSettings.filter((setting) => setting.attendanceMode === "scheduled" && activeEmploymentIds.has(setting.employmentId)).map((setting) => setting.employmentId));
  const scheduleVersion = scheduleVersionRows[0];
  const scheduleEntries = scheduleVersion?.status === "published" ? await db.select({ employmentId: hrScheduleEntries.employmentId }).from(hrScheduleEntries).where(and(eq(hrScheduleEntries.scheduleVersionId, scheduleVersion.id), sql`${hrScheduleEntries.workDate} >= ${periodStart} AND ${hrScheduleEntries.workDate} < ${nextPeriodStart}`)) : [];
  const scheduledWithEntries = new Set(scheduleEntries.map((entry) => entry.employmentId));
  const missingEmployeeCount = [...scheduledEmploymentIds].filter((employmentId) => !scheduledWithEntries.has(employmentId)).length;
  const scheduleStatus = !scheduledEmploymentIds.size ? "not_applicable" : !scheduleVersion ? "not_started" : scheduleVersion.status === "published" ? (missingEmployeeCount ? "pending" : "published") : "pending";

  const insuranceByEmployment = new Map<string, Set<string>>();
  for (const row of insuranceRows) {
    if (row.status !== "enrolled" || !activeEmploymentIds.has(row.employmentId)) continue;
    const schemes = insuranceByEmployment.get(row.employmentId) ?? new Set<string>();
    schemes.add(row.scheme);
    insuranceByEmployment.set(row.employmentId, schemes);
  }
  const insuranceMissing = activeRows.filter((row) => {
    const schemes = insuranceByEmployment.get(row.employmentId);
    return !schemes?.has("labor") || !schemes.has("health");
  });
  const missingUserIds = new Set(insuranceMissing.map((row) => row.userId));

  const payroll = payrollRows[0];
  return {
    periodKey,
    attendance: { anomalyCount },
    schedule: { status: scheduleStatus, scheduledEmployeeCount: scheduledEmploymentIds.size, missingEmployeeCount },
    insurance: { totalEmployeeCount: activeUserIds.length, missingEmployeeCount: missingUserIds.size },
    payroll: payroll ? { status: payroll.runStatus, runId: payroll.runId, versionNumber: payroll.versionNumber, completedCount: payroll.completedCount, expectedCount: payroll.expectedCount } : { status: "not_started", runId: null, versionNumber: null, completedCount: 0, expectedCount: 0 },
  };
}
