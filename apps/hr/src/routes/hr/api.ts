import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL } from "../../config.js";

export interface Employee {
  userId: string;
  employeeNumber: string;
  legalName: string;
  accountName: string;
  displayName: string;
  email: string;
  position: string;
  supervisorUserId?: string | null;
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
export interface Profile { employee: Employee & { supervisorName?: string | null }; employments: Employment[]; assignments?: Assignment[]; attendanceAssignments?: AttendanceAssignment[] }

const employeeNumberCollator = new Intl.Collator("zh-Hant", { numeric: true, sensitivity: "base" });
export function sortHrEmployees<T extends Pick<Employee, "employeeNumber" | "legalName">>(employees: readonly T[]): T[] {
  return [...employees].sort((left, right) => employeeNumberCollator.compare(left.employeeNumber, right.employeeNumber) || left.legalName.localeCompare(right.legalName, "zh-Hant"));
}
export function hrEmployeeLabel(employee: Pick<Employee, "employeeNumber" | "legalName">): string {
  return `${employee.employeeNumber}・${employee.legalName}`;
}

export interface NamedOption { id: string; name: string; employeeNumber?: string }
export interface Candidate { userId: string; displayName: string; email: string; status: "invited" | "active" }
export interface AttendanceLocation {
  id: string;
  name: string;
  geolocationRequired: boolean;
  hasCoordinates: boolean;
  radiusMeters: number;
  revision: number;
}
export interface AttendanceLocationDetail extends AttendanceLocation {
  latitude: number | null;
  longitude: number | null;
}
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
export interface ClockCalendarEvent {
  id: string;
  eventKind: "clock_in" | "clock_out";
  occurredAt: string;
  locationName: string | null;
  distanceMeters: number | null;
}
export type HrCalendarSpecialKind = "none" | "typhoon_stop";
export interface ClockCalendarDay {
  date: string;
  weekday: number;
  specialKind: HrCalendarSpecialKind;
  specialScopeIds: string[];
  status: "not-employed" | "future" | "present" | "open" | "missing" | "rest" | "leave";
  eventCount: number;
  workedMinutes: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  anomaly: "missing" | "incomplete" | "invalid-sequence" | "short-duration" | "late-arrival" | "early-leave" | "unscheduled" | null;
  anomalyMessage: string | null;
  expectedStartAt: string | null;
  expectedEndAt: string | null;
  events: ClockCalendarEvent[];
}
export interface ClockCalendar {
  year: number;
  month: number;
  today: string;
  days: ClockCalendarDay[];
}
export type FormRequestStatus = "draft" | "pending" | "approved" | "rejected" | "cancelled";
export interface LeaveCredit {
  entitlementId: string;
  periodStart: string;
  periodEnd: string;
  entitledHalfHours: number;
  balanceHalfHours: number;
}
export interface LeaveTypeOption {
  id: string;
  name: string;
  leaveKind: "annual" | "other";
  defaultPayRatePpm: number;
  credits: LeaveCredit[];
}
export interface LeaveTypesResponse { leaveTypes: LeaveTypeOption[] }
export interface AnnualLeavePeriod extends LeaveCredit { usedHalfHours: number; grantedHalfHours: number }
export interface AnnualLeaveResponse { periods: AnnualLeavePeriod[] }
export interface LeaveMonth { month: string; totalMinutes: number; leaveTypes: Array<{ id: string; name: string; minutes: number }> }
export interface LeaveMonthsResponse { year: number; currentYear: number; firstYear: number; lastYear: number; months: LeaveMonth[] }
export interface HrLeaveDurationResponse {
  startsAt: string;
  endsAt: string;
  startsOn: string;
  endsOn: string;
  durationMinutes: number;
}
export interface LeaveRequest {
  request: {
    id: string;
    employmentId: string;
    leaveTypeId: string | null;
    leaveType: string;
    status: "draft" | "pending" | "approved" | "rejected" | "cancelled";
    approverUserId: string | null;
    revision: number;
    startsAt: string;
    endsAt: string;
    startsOn: string;
    endsOn: string;
    durationMinutes: number;
    payRatePpm: number;
    reason: string;
    reviewedBy: string | null;
    reviewedAt: string | null;
    reviewComment: string | null;
    createdAt: string;
    updatedAt: string;
  };
  employeeUserId: string;
  employeeNumber: string;
  employeeName: string | null;
}
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
export interface FormApprover { id: string; name: string; employeeNumber?: string }
export interface FormApproversResponse { approvers: FormApprover[]; defaultApproverUserId: string | null }
export interface HrNotification {
  id: string;
  kind: "request_submitted" | "request_reviewed" | "request_cancelled";
  entityKind: "leave" | "overtime" | "clock_correction";
  entityId: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}
export interface HrNotificationsResponse { notifications: HrNotification[]; unreadCount: number }
export interface HrPayrollHistoryRecord {
  runId: string;
  periodKey: string;
  versionNumber: number;
  payDate: string | null;
  employmentId: string;
  employeeNumber: string;
  employeeName: string;
  earningMinor: number;
  deductionMinor: number;
  netMinor: number;
  closedAt: string;
}
export interface PayrollLine { lineKey: string; direction: "earning" | "deduction"; amountMinor: number; explanation: Record<string, unknown> }
export interface HrPayslipDetailResponse {
  detail: {
    record: Pick<HrPayrollHistoryRecord, "periodKey" | "versionNumber" | "payDate" | "employmentId" | "employeeNumber" | "employeeName" | "earningMinor" | "deductionMinor" | "netMinor">;
    lines: PayrollLine[];
  };
}
export interface OvertimeRequest { request: { id: string; requestedStart: string; requestedEnd: string; actualStart?: string | null; actualEnd?: string | null; settlementKind: "pay" | "compensatory"; ratePpm: number; reason: string; approverUserId: string | null; status: "draft" | "pending" | "approved" | "rejected" | "cancelled"; decisionReason: string; revision: number; createdAt: string }; employeeUserId: string; employeeName: string | null }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE_URL}/hr${path}`, { ...init, credentials: "include", headers });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `操作失敗（${response.status}）`);
  return result;
}
/** keepPrevious：換 path（例如切換年份）時先留著上一份資料，依賴它的控制項才不會閃掉；用 isPlaceholderData 判斷是不是舊的。 */
export function useHrQuery<T>(path: string, enabled = true, keepPrevious = false) {
  return useQuery({ queryKey: ["hr", path], queryFn: () => request<T>(path), enabled, retry: false, placeholderData: keepPrevious ? keepPreviousData : undefined });
}
export function useHrLeaveDuration(input: { startsAt: string; endsAt: string } | null) {
  const signature = input ? JSON.stringify(input) : "disabled";
  return useQuery({
    queryKey: ["hr", "leave-duration", signature],
    queryFn: () => request<HrLeaveDurationResponse>("/me/leave-duration", { method: "POST", body: JSON.stringify(input) }),
    enabled: input !== null,
    retry: false,
  });
}
export function useHrWrite<T = { id: string }>(options: { onSuccess?: () => Promise<void> } = {}) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { path: string; method: string; values: Record<string, unknown> }) => request<T>(input.path, { method: input.method, body: JSON.stringify(input.values) }),
    onSuccess: options.onSuccess,
    // 失敗也要重抓：409 幾乎都代表畫面上的資料已經過期（別人先審了、先取消了），不重抓的話同一顆按鈕會一直失敗。
    onSettled: () => { void client.invalidateQueries({ queryKey: ["hr"] }); },
  });
}
