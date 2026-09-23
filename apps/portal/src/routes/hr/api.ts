import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../../shell/Toast.js";

export interface Employee {
  userId: string;
  employeeNumber: string;
  displayName: string;
  email: string;
  position: string;
  supervisorUserId?: string | null;
  supervisorName?: string | null;
  userStatus: "invited" | "active" | "disabled";
  employmentStatus: "active" | "inactive";
  revision: number;
}
export interface Employment { id: string; employeeUserId: string; employeeNumber: string; position: string; supervisorUserId: string | null; supervisorName?: string | null; serviceStartOn?: string | null; archivedAt: string | null; attendanceMode?: "general" | "scheduled"; monthlyRestDays?: number | null; revision: number }
export interface Assignment { id: string; employmentId: string; scopeName: string; validFrom: string; validTo: string | null; revision: number }
export interface AttendanceAssignment {
  id: string;
  employmentId: string;
  locationId: string;
  locationName: string;
  validFrom: string;
  validTo: string | null;
  isPrimary?: boolean;
  revision: number;
}
export interface CompensationItem { id: string; compensationVersionId: string; itemName: string; amountMinor: number; itemKind: "fixed" | "variable"; amountBasis: "monthly" | "daily" | "hourly"; includeOvertime: number; includeInsurance: number; includeTax: number }
export interface CompensationVersion { id: string; employmentId: string; versionNumber: number; validFrom: string; validTo: string | null; payBasis: "monthly" | "daily" | "hourly"; baseAmountMinor: number; note: string; voidedAt?: string | null; voidedBy?: string | null; items?: CompensationItem[]; createdAt: string; createdBy: string }
export interface InsuranceVersion { id: string; employmentId: string; scheme: "labor" | "health"; versionNumber: number; status: "enrolled" | "withdrawn"; validFrom: string; validTo: string | null; insuredAmountMinor: number; dependentCount: number; rateYear: number; sourceKind: "official" | "manual"; sourceUrl: string; note: string; createdAt: string; createdBy: string }
export interface LeaveRequest { id: string; employmentId: string; leaveType: string; status: "draft" | "pending" | "approved" | "rejected" | "cancelled"; startsAt: string; endsAt: string; startsOn: string; endsOn: string; durationMinutes: number; payRatePpm?: number; reason: string; reviewedBy: string | null; reviewedAt: string | null; reviewComment: string | null; createdAt: string; createdBy: string }
export interface AttendanceEvent { id: string; eventKind: "clock_in" | "clock_out"; occurredAt: string; locationName: string | null; scopeName?: string | null; distanceMeters: number | null; sourceKind?: string; manualReason?: string; recordedBy?: string | null }
export interface Profile { employee: Employee & { supervisorName?: string | null }; employments: Employment[]; /** 只有出勤讀取權限時不回傳。 */ assignments?: Assignment[]; attendanceAssignments?: AttendanceAssignment[]; compensation?: CompensationVersion[]; insurance?: InsuranceVersion[]; leave?: LeaveRequest[]; attendanceEvents?: AttendanceEvent[] }
export interface NamedOption { id: string; name: string }
export interface Candidate { userId: string; displayName: string; email: string; status: "invited" | "active" }
export interface InsuranceBracket { level: number; lowerSalary: number; upperSalary: number | null; insuredAmount: number }
export interface InsuranceBracketTable { scheme: "labor" | "health"; year: number; sourceUrl: string; fetchedAt: string; brackets: InsuranceBracket[] }
export interface InsuranceRateTableRecord { id: string; scheme: "labor" | "health"; year: number; status: "draft" | "active" | "archived"; sourceKind: "official" | "manual"; sourceUrl: string; fetchedAt: string; contentHash: string; note: string; activatedAt: string | null; brackets: InsuranceBracket[] }
export type InsuranceContributionComponent = "ordinary_accident" | "employment";
export interface InsuranceContributionRule { id: string; scheme: "labor" | "health"; component: InsuranceContributionComponent | null; validFrom: string; validTo: string | null; employeeRatePpm: number; employerRatePpm: number; dependentRatePpm: number; totalRatePpm?: number; employeeSharePpm?: number; employerSharePpm?: number; sourceKind: "official" | "manual"; note: string; sourceUrl?: string; isSystemDefault?: boolean }
export interface InsuranceContributionComponentEstimate { component: InsuranceContributionComponent | null; ruleId: string; employeeRatePpm: number; employeeAmountMinor: number; totalRatePpm?: number; employeeSharePpm?: number }
export interface InsuranceContributionEstimate { scheme: "labor" | "health"; status: "enrolled" | "withdrawn"; insuredAmountMinor: number; dependentCount: number; employeeAmountMinor: number | null; ruleId: string | null; ruleIds: string[]; employeeRatePpm: number | null; dependentRatePpm: number | null; components: InsuranceContributionComponentEstimate[] }
export interface InsuranceEstimateResponse { estimates: InsuranceContributionEstimate[] }
export interface InsuranceEstimateRequest { validFrom: string; versions: Array<{ scheme: "labor" | "health"; status: "enrolled" | "withdrawn"; insuredAmountMinor: number; dependentCount: number }> }
export interface AttendanceLocation {
  id: string;
  name: string;
  scopeId: string | null;
  scopeName: string | null;
  geolocationRequired: boolean;
  hasCoordinates: boolean;
  radiusMeters: number;
  revision: number;
}
export interface AttendanceLocationDetail extends AttendanceLocation {
  latitude: number | null;
  longitude: number | null;
}
export interface SpecialWorkdayAllowance { id: string; ruleVersionId: string; itemName: string; unitAmountMinor: number }
export interface SpecialWorkdayOvertimeRule { id: string; ruleVersionId: string; fromHalfHours: number; toHalfHours: number | null; rateKind: "fixed_hourly" | "multiplier"; fixedAmountMinor: number | null; multiplierPpm: number | null }
export interface SpecialWorkdayRuleVersion { id: string; ruleId: string; versionNumber: number; validFrom: string; validTo: string | null; wageKind: "fixed_hourly" | "multiplier"; fixedAmountMinor: number | null; multiplierPpm: number | null; workSource: "schedule" | "hourly" | "manual"; note: string; voidedAt?: string | null; voidedBy?: string | null; allowances: SpecialWorkdayAllowance[]; overtimeRules: SpecialWorkdayOvertimeRule[] }
export interface SpecialWorkdayRule { rule: { id: string; name: string; active: number; revision: number }; versions: SpecialWorkdayRuleVersion[] }
export interface SpecialWorkdayAssignment { assignment: { id: string; ruleVersionId: string; employmentId: string | null; workerId: string | null; workDate: string; ruleNameSnapshot: string; wageKindSnapshot: string; fixedAmountMinorSnapshot: number | null; multiplierPpmSnapshot: number | null; allowanceQuantity: number; appliedAt: string }; ruleVersionNumber: number; ruleVersionVoidedAt: string | null; employeeNumber: string | null; employeeName: string | null; workerName: string | null }
export interface GoogleMapPlace {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}
export interface ClockEvent {
  id: string;
  eventKind: "clock_in" | "clock_out";
  occurredAt: string;
  locationName: string | null;
  distanceMeters: number | null;
}
export interface ClockStatus {
  canClock: boolean;
  message: string | null;
  nextEventKind: "clock_in" | "clock_out";
  geolocationRequired: boolean;
  locationName: string | null;
  locationNames?: string[];
  radiusMeters: number | null;
  events: ClockEvent[];
}
export interface ClockLocationCheck {
  available: boolean;
  withinRadius: boolean;
  locationName: string | null;
  locationNames: string[];
  distanceMeters: number | null;
  radiusMeters: number | null;
  geolocationRequired: boolean;
  message: string | null;
}
export interface ClockMapLocation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}
export interface ClockCalendarDay {
  date: string;
  weekday: number;
  specialKind?: HrCalendarSpecialKind;
  specialScopeIds?: string[];
  status: "not-employed" | "future" | "present" | "open" | "missing" | "rest";
  eventCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
}
export interface ClockCalendar {
  year: number;
  month: number;
  today: string;
  days: ClockCalendarDay[];
  missingDates: string[];
}
export type FormRequestStatus = "draft" | "pending" | "approved" | "rejected";
export interface FormRequest {
  id: string;
  employeeUserId: string;
  employmentId: string;
  formKind: "clock_correction";
  status: FormRequestStatus;
  correctionDate: string;
  requestedEventKind: "clock_in" | "clock_out";
  requestedAt: string;
  reason: string;
  approverUserId: string | null;
  approverName: string | null;
  requesterName: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface FormApprover { id: string; name: string }
export interface HrOvertimeRequest { request: { id: string; employmentId: string; requestedStart: string; requestedEnd: string; actualStart?: string | null; actualEnd?: string | null; settlementKind: "pay" | "compensatory"; ratePpm: number; reason: string; status: "draft" | "pending" | "approved" | "rejected" | "cancelled"; reviewedBy?: string | null; reviewedAt?: string | null; decisionReason: string; createdBy?: string; createdAt: string }; employeeUserId?: string; employeeName: string | null; employeeNumber: string | null }
export interface HrLeaveType { id: string; name: string; leaveKind: "annual" | "other"; defaultPayRatePpm: number; active: number; createdBy: string; createdAt: string; updatedAt: string }
export interface HrLeaveDurationResponse { startsAt: string; endsAt: string; startsOn: string; endsOn: string; durationMinutes: number }
export interface HrLeaveRequest { request: { id: string; employmentId: string; leaveTypeId?: string | null; leaveType: string; status: "draft" | "pending" | "approved" | "rejected" | "cancelled"; startsAt: string; endsAt: string; startsOn: string; endsOn: string; durationMinutes: number; payRatePpm: number; reason: string; reviewedBy: string | null; reviewedAt: string | null; reviewComment: string | null; createdBy: string; createdAt: string }; employeeUserId: string; employeeName: string | null; employeeNumber: string | null; leaveTypeKind?: "annual" | "other" | null }
export interface HrAnnualLeavePolicy { id: string; policyKey: string; versionNumber: number; validFrom: string; validTo: string | null; basis: "anniversary"; dailyMinutes: number; minimumUnitMinutes: number; carryoverAllowed: number; note: string; createdBy: string | null; createdAt: string }
export interface HrAnnualLeaveBracket { id: string; policyVersionId: string; minServiceMonths: number; maxServiceMonths: number | null; entitledDays: number; label: string }
export interface HrAnnualLeaveEntitlement { id: string; employmentId: string; employeeUserId: string; employeeNumber: string; employeeName: string; serviceMonths: number; periodStart: string; periodEnd: string; entitledHalfHours: number; balanceHalfHours: number; usedHalfHours: number; debitHalfHours: number; status: "open" | "settled"; settledAt: string | null }
export interface HrAnnualLeaveLedgerEntry { id: string; entryKind: "grant" | "leave_request" | "manual_adjustment" | "settlement" | "settlement_reversal"; deltaHalfHours: number; sourceKey: string; leaveRequestId: string | null; note: string; createdBy: string | null; createdAt: string }
export interface HrAnnualLeaveEntitlementDetail extends HrAnnualLeaveEntitlement { serviceStartOn: string; policyVersionNumber: number; policyValidFrom: string; policyValidTo: string | null; policyBasis: "anniversary"; policyDailyMinutes: number; policyMinimumUnitMinutes: number; policyCarryoverAllowed: number; policyNote: string; bracketMinServiceMonths: number; bracketMaxServiceMonths: number | null; bracketEntitledDays: number; bracketLabel: string; ledger: HrAnnualLeaveLedgerEntry[] }
export interface HrAnnualLeaveResponse { entitlements: HrAnnualLeaveEntitlement[] }
export interface HrRequestCenterResponse { leaves: HrLeaveRequest[]; overtime: HrOvertimeRequest[]; clockCorrections: FormRequest[] }
export interface FormApproversResponse { approvers: FormApprover[]; defaultApproverUserId: string | null }
export interface PayrollLineCalculationPart { formula: string; amountMinor: number }
export interface PayrollLine { lineKey: string; direction: "earning" | "deduction"; amountMinor: number; quantitySeconds?: number; explanation: Record<string, unknown> }
export interface PayrollEmployee { employmentId: string; employeeUserId: string; employeeNumber: string; employeeName: string; lines: PayrollLine[]; earningMinor: number; deductionMinor: number; netMinor: number; attendanceDays: number; missingPunchDays: number }
export interface PayrollWorker { workerId: string; workerName: string; payBasis: "monthly" | "daily" | "hourly" | "mixed"; scheduledDays: number; amountMinor: number; typhoonStopDays: number; typhoonStopPayMinor: number; compensationVersionId: string | null }
export interface PayrollWorkerCandidate { id: string; displayName: string }
export interface PayrollRun { runId: string; runName: string; periodKey: string; payDate: string | null; status: "ready" | "closed"; engineVersion: string; employees: PayrollEmployee[]; workers: PayrollWorker[]; warnings: string[] }
export type BonusKind = "team_performance" | "individual_performance";
export type PerformancePeriod = "current_month" | "previous_month";
export interface BonusPolicy { policyVersionId: string; policyId: string; policyName: string; versionNumber: number; scopeId: string; scopeName: string; scopeIds?: string[]; scopeNames?: string[]; scopes?: Array<{ id: string; name: string }>; bonusKind: BonusKind; performancePeriod: PerformancePeriod; ratePpm: number; guaranteeMinor: number; validFrom: string; validTo: string | null; isLatest?: boolean }
export interface BonusAssignment { assignment: { id: string; employmentId: string; validFrom: string; validTo: string | null; weightUnits: number }; policyVersionId: string; policyName: string; bonusKind: BonusKind; performancePeriod: PerformancePeriod; employeeUserId: string; employeeNumber: string; employeeName: string }
export interface BonusPerformanceSnapshot { snapshot: { id: string; employmentId: string | null; periodStart: string; periodEnd: string; amountMinor: number; sourceKind: "manual" | "report"; sourceRef: string }; scopeName: string; employeeUserId: string | null; employeeName: string | null }
export interface PayrollRunSummary { run: { id: string; runName: string; versionNumber: number; status: string; payDate: string | null; engineVersion: string; expectedCount: number; completedCount: number; createdAt: string }; periodKey: string; periodStatus: string }
export interface PayrollEmployeeHistoryRecord { runId: string; runName: string; periodKey: string; versionNumber: number; payDate: string | null; employmentId: string; employeeNumber: string; employeeName: string; earningMinor: number; deductionMinor: number; netMinor: number; closedAt: string }
export interface HrOverview { periodKey: string; attendance: { anomalyCount: number }; schedule: { status: "not_started" | "pending" | "published" | "not_applicable"; scheduledEmployeeCount: number; missingEmployeeCount: number }; insurance: { totalEmployeeCount: number; missingEmployeeCount: number }; payroll: { status: "not_started" | "calculating" | "ready" | "approved" | "closed" | "failed"; completedCount: number; expectedCount: number } }
export interface BonusAllocation { employmentId: string; employeeNumber: string; employeeName: string; weightUnits: number; scheduledDays: number; revenueMinor: number; amountMinor: number }
export interface BonusPool { poolId: string; policyVersionId: string; policyName: string; scopeId: string; scopeName: string; scopeIds?: string[]; scopeNames?: string[]; periodKey: string; status: "calculated" | "approved" | "closed" | "failed"; poolAmountMinor: number; allocations: BonusAllocation[]; daily: Array<{ scopeId?: string; businessDate: string; revenueMinor: number; bonusMinor: number; scheduled: boolean }>; warnings: string[] }
export interface ScheduleScope { id: string; name: string }
/** 平日／週末／國定假日。與 packages/db 的 HrDayType 同一組值，行事曆與班別時間共用。 */
export type HrDayType = "weekday" | "weekend" | "holiday";
export const HR_DAY_TYPE_LABELS: Record<HrDayType, string> = { weekday: "平日", weekend: "週末", holiday: "國定假日" };
export const HR_DAY_TYPES: HrDayType[] = ["weekday", "weekend", "holiday"];
export type HrCalendarSpecialKind = "none" | "typhoon_stop";
export const HR_CALENDAR_SPECIAL_KIND_LABELS: Record<HrCalendarSpecialKind, string> = { none: "一般日期", typhoon_stop: "颱風停班（原排班照薪）" };
export const HR_CALENDAR_SPECIAL_KINDS: HrCalendarSpecialKind[] = ["none", "typhoon_stop"];

export interface ScheduleShift { versionId: string; templateId: string; scopeId: string; name: string; dayType: HrDayType; revision: number; startSecond: number; endSecond: number; endDayOffset: number; standardMinutes: number; breakMinutes: number }
export interface HrShiftsResponse { scopes: ScheduleScope[]; shifts: ScheduleShift[] }
export interface HrCalendarDay { date: string; dayType: HrDayType; name: string; specialKind: HrCalendarSpecialKind; specialScopeIds: string[]; overridden: boolean }
export interface HrCalendarResponse { days: HrCalendarDay[]; scopes: ScheduleScope[] }

/**
 * 一個班別在某個日型該用哪一組時間；沒設定該日型就退回平日。
 *
 * 後端之所以規定平日那組必填（assertShiftTimes），就是為了這條退路一定找得到東西。
 * 挑選發生在前端是因為「預設帶哪一組」純粹是輸入時的預設值——存進班表的是使用者最後
 * 選定的版本 ID，後端只驗證它屬於這家店，不會再推算一次，使用者才改得動。
 */
export function pickShiftForDay(versions: ScheduleShift[], dayType: HrDayType) {
  return versions.find((shift) => shift.dayType === dayType) ?? versions.find((shift) => shift.dayType === "weekday");
}

/** 把同一個班別的多組時間收成一筆，順序照平日、週末、國定假日。 */
export function groupShiftsByTemplate(shifts: ScheduleShift[]) {
  const grouped = new Map<string, ScheduleShift[]>();
  for (const shift of shifts) grouped.set(shift.templateId, [...(grouped.get(shift.templateId) ?? []), shift]);
  for (const versions of grouped.values()) versions.sort((a, b) => HR_DAY_TYPES.indexOf(a.dayType) - HR_DAY_TYPES.indexOf(b.dayType));
  return grouped;
}

function clockOf(seconds: number) { return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}`; }
/** 班別時間的唯一格式；排班月曆與班別管理都用這個，兩頁才不會一邊寫 9:00、一邊寫 09:00。 */
export function shiftTimeRange(shift: Pick<ScheduleShift, "startSecond" | "endSecond" | "endDayOffset">) {
  return `${clockOf(shift.startSecond)}–${clockOf(shift.endSecond)}${shift.endDayOffset ? " 次日" : ""}`;
}
export interface ScheduleEmployee { employmentId: string; userId: string; employeeNumber: string; name: string; attendanceMode?: "general" | "scheduled"; monthlyRestDays?: number | null }
export interface ScheduleWorker { id: string; name: string; active: boolean | number }
export interface ScheduleEntry { id: string; scheduleVersionId: string; personKind: "employee" | "worker"; employmentId: string | null; workerId: string | null; scopeId: string; shiftVersionId: string; workDate: string; startsAt: string; endsAt: string; standardMinutes: number; breakMinutes: number; employeeNumber: string | null; personName: string; archivedAt: string | null; scopeName: string; shiftName: string }
export interface HrScheduleResponse { periodKey: string; period: { start: string; end: string }; version: { id: string; revision: number; status: "published"; locked: boolean; lockedAt: string | null } | null; scopes: ScheduleScope[]; calendar: HrCalendarDay[]; shifts: ScheduleShift[]; employees: ScheduleEmployee[]; workers: ScheduleWorker[]; entries: ScheduleEntry[] }
export type SupportWorkerPayBasis = "daily" | "hourly";
export interface WorkerCompensation { id: string; workerId: string; versionNumber: number; validFrom: string; validTo: string | null; payBasis: "monthly" | SupportWorkerPayBasis; baseAmountMinor: number; note: string }
export interface ScheduleWorkerRecord { id: string; displayName: string; active: boolean | number; revision: number; compensation: WorkerCompensation[] }
export interface ScheduleWorkerPageResponse { workers: ScheduleWorkerRecord[]; total: number; page: number; pageSize: number; hasMore: boolean }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/hr${path}`, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `操作失敗（${response.status}）`);
  return result;
}
/**
 * 敘薪、投保、獎金、薪資結算等管理頁共用的員工名單。
 * 用 employable 而不是 active：邀請中的員工還沒登入過平台，但照樣要敘薪、加保、算薪水。
 */
export const HR_ROSTER_PATH = "/employees?page=1&pageSize=100&status=employable&employmentStatus=active&sortField=name&sortDirection=asc";

/**
 * 換條件（月份、分頁、篩選）時留著上一次的資料，頁面才不會整頁換成骨架再長回來；
 * 這段期間 isPlaceholderData 為 true。
 *
 * 查的是「某一筆紀錄」（某個人、某個批次）時要傳 keepPreviousData: false：
 * 那種查詢的舊資料是另一個人的，會被填進表單或顯示在新名字底下。
 */
export function useHrQuery<T>(path: string, enabled = true, options: { keepPreviousData?: boolean } = {}) {
  return useQuery({ queryKey: ["hr", path], queryFn: () => request<T>(path), enabled, retry: false, placeholderData: options.keepPreviousData === false ? undefined : keepPreviousData });
}
export function useHrInsuranceEstimate(employmentId: string, input: InsuranceEstimateRequest | null) {
  const signature = input ? JSON.stringify(input) : "disabled";
  return useQuery({
    queryKey: ["hr", "insurance-estimate", employmentId, signature],
    queryFn: ({ signal }) => {
      if (!input) throw new Error("試算資料尚未準備完成。");
      return request<InsuranceEstimateResponse>(`/employments/${encodeURIComponent(employmentId)}/insurance/estimate`, { method: "POST", body: JSON.stringify(input), signal });
    },
    enabled: input !== null,
    retry: false,
  });
}
export function useHrLeaveDuration(input: { employeeUserId: string; startsAt: string; endsAt: string } | null) {
  const signature = input ? JSON.stringify(input) : "disabled";
  return useQuery({
    queryKey: ["hr", "leave-duration", signature],
    queryFn: ({ signal }) => request<HrLeaveDurationResponse>("/requests/leave-duration", { method: "POST", body: JSON.stringify(input), signal }),
    enabled: input !== null,
    retry: false,
    placeholderData: undefined,
  });
}
export function useHrWrite<T = { id: string }>({ invalidate = true }: { invalidate?: boolean } = {}) {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { path: string; method: string; values: Record<string, unknown> }) => request<T>(input.path, { method: input.method, body: JSON.stringify(input.values) }),
    onSuccess: () => { if (invalidate) void client.invalidateQueries({ queryKey: ["hr"] }); },
    onError: (error) => toast.show(error instanceof Error ? error.message : "HR 操作失敗，請稍後再試。", "danger"),
  });
}
