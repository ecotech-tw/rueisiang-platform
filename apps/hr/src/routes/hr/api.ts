import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL } from "../../config.js";

export interface Employee {
  userId: string;
  employeeNumber: string;
  displayName: string;
  email: string;
  supervisorUserId?: string | null;
  userStatus: "invited" | "active" | "disabled";
  revision: number;
}
export interface Employment { id: string; employeeUserId: string; hiredOn: string; endedOn: string | null; seniorityStartOn: string; revision: number }
export interface Assignment { id: string; employmentId: string; scopeName: string; validFrom: string; validTo: string | null; revision: number }
export interface AttendanceAssignment {
  id: string;
  employmentId: string;
  locationId: string;
  locationName: string;
  validFrom: string;
  validTo: string | null;
  revision: number;
}
export interface Profile { employee: Employee & { supervisorName?: string | null }; employments: Employment[]; assignments: Assignment[]; attendanceAssignments?: AttendanceAssignment[] }
export interface NamedOption { id: string; name: string }
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
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE_URL}/hr${path}`, { ...init, credentials: "include", headers });
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
