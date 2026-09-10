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
export interface CompensationVersion { id: string; employmentId: string; versionNumber: number; validFrom: string; validTo: string | null; payBasis: "monthly" | "daily" | "hourly"; baseAmountMinor: number; note: string; createdAt: string; createdBy: string }
export interface InsuranceVersion { id: string; employmentId: string; scheme: "labor" | "health"; versionNumber: number; status: "enrolled" | "withdrawn"; validFrom: string; validTo: string | null; insuredAmountMinor: number; dependentCount: number; rateYear: number; sourceKind: "official" | "manual"; sourceUrl: string; note: string; createdAt: string; createdBy: string }
export interface LeaveRequest { id: string; employmentId: string; leaveType: string; status: "draft" | "pending" | "approved" | "rejected" | "cancelled"; startsOn: string; endsOn: string; durationMinutes: number; reason: string; reviewedBy: string | null; reviewedAt: string | null; reviewComment: string | null; createdAt: string; createdBy: string }
export interface AttendanceEvent { id: string; eventKind: "clock_in" | "clock_out"; occurredAt: string; locationName: string | null; distanceMeters: number | null }
export interface Profile { employee: Employee & { supervisorName?: string | null }; employments: Employment[]; assignments: Assignment[]; attendanceAssignments?: AttendanceAssignment[]; compensation?: CompensationVersion[]; insurance?: InsuranceVersion[]; leave?: LeaveRequest[]; attendanceEvents?: AttendanceEvent[] }
export interface NamedOption { id: string; name: string }
export interface Candidate { userId: string; displayName: string; email: string; status: "invited" | "active" }
export interface InsuranceBracket { level: number; lowerSalary: number; upperSalary: number | null; insuredAmount: number }
export interface InsuranceBracketTable { scheme: "labor" | "health"; year: number; sourceUrl: string; fetchedAt: string; brackets: InsuranceBracket[] }
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
export interface HrManagementScope {
  userId: string;
  userName: string;
  userEmail: string;
  scopeId: string;
  scopeName: string;
  createdAt: string;
}
export interface HrManagementOptions {
  users: { id: string; name: string; email: string }[];
  scopes: NamedOption[];
  assignments: HrManagementScope[];
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
export interface ClockCalendarDay {
  date: string;
  weekday: number;
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
export interface FormApproversResponse { approvers: FormApprover[]; defaultApproverUserId: string | null }

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
