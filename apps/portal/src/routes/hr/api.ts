import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface Employee {
  userId: string;
  employeeNumber: string;
  displayName: string;
  email: string;
  supervisorUserId?: string | null;
  userStatus: "invited" | "active" | "disabled";
  revision: number;
}
export interface Employment { id: string; employeeUserId: string; hiredOn: string; endedOn: string | null; seniorityStartOn: string; attendanceMode?: "general" | "scheduled"; revision: number }
interface Assignment { id: string; employmentId: string; scopeName: string; validFrom: string; validTo: string | null; revision: number }
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
export interface CompensationVersion { id: string; employmentId: string; versionNumber: number; validFrom: string; validTo: string | null; payBasis: "monthly" | "daily" | "hourly"; baseAmountMinor: number; note: string; createdAt: string; createdBy: string }
export interface InsuranceVersion { id: string; employmentId: string; scheme: "labor" | "health"; versionNumber: number; status: "enrolled" | "withdrawn"; validFrom: string; validTo: string | null; insuredAmountMinor: number; dependentCount: number; rateYear: number; sourceKind: "official" | "manual"; sourceUrl: string; note: string; createdAt: string; createdBy: string }
export interface LeaveRequest { id: string; employmentId: string; leaveType: string; status: "draft" | "pending" | "approved" | "rejected" | "cancelled"; startsOn: string; endsOn: string; durationMinutes: number; payRatePpm?: number; reason: string; reviewedBy: string | null; reviewedAt: string | null; reviewComment: string | null; createdAt: string; createdBy: string }
export interface AttendanceEvent { id: string; eventKind: "clock_in" | "clock_out"; occurredAt: string; locationName: string | null; scopeName?: string | null; distanceMeters: number | null; sourceKind?: string; manualReason?: string; recordedBy?: string | null }
export interface Profile { employee: Employee & { supervisorName?: string | null }; employments: Employment[]; assignments: Assignment[]; attendanceAssignments?: AttendanceAssignment[]; compensation?: CompensationVersion[]; insurance?: InsuranceVersion[]; leave?: LeaveRequest[]; attendanceEvents?: AttendanceEvent[] }
export interface NamedOption { id: string; name: string }
export interface Candidate { userId: string; displayName: string; email: string; status: "invited" | "active" }
interface InsuranceBracket { level: number; lowerSalary: number; upperSalary: number | null; insuredAmount: number }
export interface InsuranceBracketTable { scheme: "labor" | "health"; year: number; sourceUrl: string; fetchedAt: string; brackets: InsuranceBracket[] }
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
export interface GoogleMapPlace {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}
export interface PayrollLine { lineKey: string; direction: "earning" | "deduction"; amountMinor: number; quantitySeconds?: number; explanation: Record<string, unknown> }
interface PayrollEmployee { employmentId: string; employeeUserId: string; employeeNumber: string; employeeName: string; lines: PayrollLine[]; earningMinor: number; deductionMinor: number; netMinor: number; attendanceDays: number; missingPunchDays: number }
interface PayrollWorker { workerId: string; workerName: string; payBasis: "monthly" | "daily" | "hourly" | "mixed"; scheduledDays: number; amountMinor: number; compensationVersionId: string | null }
export interface PayrollRun { runId: string; periodKey: string; status: "ready"; engineVersion: string; employees: PayrollEmployee[]; workers: PayrollWorker[]; warnings: string[] }
type BonusKind = "team_performance" | "individual_performance";
type PerformancePeriod = "current_month" | "previous_month";
export interface BonusPolicy { policyVersionId: string; policyId: string; policyName: string; versionNumber: number; scopeId: string; scopeName: string; bonusKind: BonusKind; performancePeriod: PerformancePeriod; ratePpm: number; guaranteeMinor: number; validFrom: string; validTo: string | null }
export interface BonusAssignment { assignment: { id: string; employmentId: string; validFrom: string; validTo: string | null; weightUnits: number }; policyVersionId: string; policyName: string; bonusKind: BonusKind; performancePeriod: PerformancePeriod; employeeUserId: string; employeeNumber: string; employeeName: string }

export interface PayrollRunSummary { run: { id: string; versionNumber: number; status: string; engineVersion: string; expectedCount: number; completedCount: number; createdAt: string }; periodKey: string; periodStatus: string }
interface ScheduleScope { id: string; name: string }
export interface ScheduleShift { versionId: string; templateId: string; scopeId: string; code: string; name: string; startSecond: number; endSecond: number; endDayOffset: number }
interface ScheduleEmployee { employmentId: string; userId: string; employeeNumber: string; name: string }
interface ScheduleWorker { id: string; name: string; active: boolean | number }
export interface ScheduleEntry { id: string; scheduleVersionId: string; personKind: "employee" | "worker"; employmentId: string | null; workerId: string | null; scopeId: string; shiftVersionId: string; workDate: string; startsAt: string; endsAt: string; employeeNumber: string | null; personName: string; scopeName: string; shiftName: string }
export interface HrScheduleResponse { periodKey: string; period: { start: string; end: string }; version: { id: string; revision: number; status: "published"; locked: boolean; lockedAt: string | null } | null; scopes: ScheduleScope[]; shifts: ScheduleShift[]; employees: ScheduleEmployee[]; workers: ScheduleWorker[]; entries: ScheduleEntry[] }
interface WorkerCompensation { id: string; workerId: string; versionNumber: number; validFrom: string; validTo: string | null; payBasis: "monthly" | "daily" | "hourly"; baseAmountMinor: number; note: string }
export interface ScheduleWorkerRecord { id: string; displayName: string; active: boolean | number; revision: number; compensation: WorkerCompensation[] }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/hr${path}`, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `操作失敗（${response.status}）`);
  return result;
}
export function useHrQuery<T>(path: string, enabled = true) {
  return useQuery({ queryKey: ["hr", path], queryFn: () => request<T>(path), enabled, retry: false });
}
export function useHrWrite<T = { id: string }>() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { path: string; method: string; values: Record<string, unknown> }) => request<T>(input.path, { method: input.method, body: JSON.stringify(input.values) }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["hr"] }); },
  });
}
