import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

export const HR_REQUEST_CENTER_PAGE_SIZES = [10, 25, 50, 100] as const;

export type HrRequestCenterKind = "leave" | "overtime" | "clock_correction";
export type HrRequestCenterStatus = "draft" | "pending" | "approved" | "rejected" | "cancelled";

export interface HrRequestCenterListQuery {
  page: number;
  pageSize: number;
  search: string;
  kind: HrRequestCenterKind | "all";
  status: HrRequestCenterStatus | "all";
}

export interface HrRequestCenterRow {
  kind: HrRequestCenterKind;
  id: string;
  employeeName: string | null;
  employeeNumber: string | null;
  status: HrRequestCenterStatus;
  reason: string;
  createdAt: string;
  startsAt: string | null;
  endsAt: string | null;
  startsOn: string | null;
  endsOn: string | null;
  leaveType: string | null;
  durationMinutes: number | null;
  requestedStart: string | null;
  requestedEnd: string | null;
  settlementKind: "pay" | "compensatory" | null;
  correctionDate: string | null;
  requestedEventKind: "clock_in" | "clock_out" | null;
  requestedAt: string | null;
}

export interface HrRequestCenterPage {
  rows: HrRequestCenterRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface HrRequestCenterDbRow {
  kind: HrRequestCenterKind;
  id: string;
  employee_name: string | null;
  employee_number: string | null;
  status: HrRequestCenterStatus;
  reason: string;
  created_at: string;
  starts_at: string | null;
  ends_at: string | null;
  starts_on: string | null;
  ends_on: string | null;
  leave_type: string | null;
  duration_minutes: number | null;
  requested_start: string | null;
  requested_end: string | null;
  settlement_kind: "pay" | "compensatory" | null;
  correction_date: string | null;
  requested_event_kind: "clock_in" | "clock_out" | null;
  requested_at: string | null;
}

function requestCenterCte() {
  return sql`WITH request_rows AS (
    SELECT
      'leave' AS kind,
      leave_request.id AS id,
      coalesce(nullif(employment.legal_name, ''), nullif(employee.display_name, ''), nullif(employee.google_name, ''), employee.email) AS employee_name,
      employment.employee_number AS employee_number,
      leave_request.status AS status,
      leave_request.reason AS reason,
      leave_request.created_at AS created_at,
      leave_request.starts_at AS starts_at,
      leave_request.ends_at AS ends_at,
      leave_request.starts_on AS starts_on,
      leave_request.ends_on AS ends_on,
      leave_request.leave_type AS leave_type,
      leave_request.duration_minutes AS duration_minutes,
      NULL AS requested_start,
      NULL AS requested_end,
      NULL AS settlement_kind,
      NULL AS correction_date,
      NULL AS requested_event_kind,
      NULL AS requested_at,
      (
        '請假 ' ||
        coalesce(nullif(employment.legal_name, ''), nullif(employee.display_name, ''), nullif(employee.google_name, ''), employee.email, '') || ' ' ||
        coalesce(employment.employee_number, '') || ' ' ||
        coalesce(leave_request.leave_type, '') || ' ' ||
        coalesce(leave_request.starts_on, '') || ' ' ||
        coalesce(leave_request.ends_on, '') || ' ' ||
        coalesce(datetime(leave_request.starts_at, '+8 hours'), '') || ' ' ||
        coalesce(datetime(leave_request.ends_at, '+8 hours'), '') || ' ' ||
        printf('%.1f 小時', leave_request.duration_minutes / 60.0) || ' ' ||
        coalesce(leave_request.reason, '') || ' ' ||
        CASE leave_request.status
          WHEN 'draft' THEN '草稿'
          WHEN 'pending' THEN '待審核'
          WHEN 'approved' THEN '已核准'
          WHEN 'rejected' THEN '已駁回'
          WHEN 'cancelled' THEN '已取消'
          ELSE leave_request.status
        END
      ) AS search_text
    FROM hr_leave_requests AS leave_request
    INNER JOIN hr_employments AS employment ON employment.id = leave_request.employment_id
    INNER JOIN users AS employee ON employee.id = employment.employee_user_id

    UNION ALL

    SELECT
      'overtime' AS kind,
      overtime_request.id AS id,
      coalesce(nullif(employment.legal_name, ''), nullif(employee.display_name, ''), nullif(employee.google_name, ''), employee.email) AS employee_name,
      employment.employee_number AS employee_number,
      overtime_request.status AS status,
      overtime_request.reason AS reason,
      overtime_request.created_at AS created_at,
      NULL AS starts_at,
      NULL AS ends_at,
      NULL AS starts_on,
      NULL AS ends_on,
      NULL AS leave_type,
      NULL AS duration_minutes,
      overtime_request.requested_start AS requested_start,
      overtime_request.requested_end AS requested_end,
      overtime_request.settlement_kind AS settlement_kind,
      NULL AS correction_date,
      NULL AS requested_event_kind,
      NULL AS requested_at,
      (
        '加班 ' ||
        coalesce(nullif(employment.legal_name, ''), nullif(employee.display_name, ''), nullif(employee.google_name, ''), employee.email, '') || ' ' ||
        coalesce(employment.employee_number, '') || ' ' ||
        coalesce(datetime(overtime_request.requested_start, '+8 hours'), '') || ' ' ||
        coalesce(datetime(overtime_request.requested_end, '+8 hours'), '') || ' ' ||
        CASE overtime_request.settlement_kind WHEN 'pay' THEN '付薪' ELSE '補休' END || ' ' ||
        coalesce(overtime_request.reason, '') || ' ' ||
        CASE overtime_request.status
          WHEN 'draft' THEN '草稿'
          WHEN 'pending' THEN '待審核'
          WHEN 'approved' THEN '已核准'
          WHEN 'rejected' THEN '已駁回'
          WHEN 'cancelled' THEN '已取消'
          ELSE overtime_request.status
        END
      ) AS search_text
    FROM hr_overtime_requests AS overtime_request
    INNER JOIN hr_employments AS employment ON employment.id = overtime_request.employment_id
    INNER JOIN users AS employee ON employee.id = employment.employee_user_id

    UNION ALL

    SELECT
      'overtime' AS kind,
      worker_overtime_request.id AS id,
      worker_employment.legal_name AS employee_name,
      worker_employment.employee_number AS employee_number,
      worker_overtime_request.status AS status,
      worker_overtime_request.reason AS reason,
      worker_overtime_request.created_at AS created_at,
      NULL AS starts_at,
      NULL AS ends_at,
      NULL AS starts_on,
      NULL AS ends_on,
      NULL AS leave_type,
      NULL AS duration_minutes,
      worker_overtime_request.requested_start AS requested_start,
      worker_overtime_request.requested_end AS requested_end,
      worker_overtime_request.settlement_kind AS settlement_kind,
      NULL AS correction_date,
      NULL AS requested_event_kind,
      NULL AS requested_at,
      (
        '加班 支援人員 ' || coalesce(worker_employment.legal_name, '') || ' ' ||
        coalesce(datetime(worker_overtime_request.requested_start, '+8 hours'), '') || ' ' ||
        coalesce(datetime(worker_overtime_request.requested_end, '+8 hours'), '') || ' ' ||
        CASE worker_overtime_request.settlement_kind WHEN 'pay' THEN '付薪' ELSE '補休' END || ' ' ||
        coalesce(worker_overtime_request.reason, '') || ' ' ||
        CASE worker_overtime_request.status
          WHEN 'draft' THEN '草稿'
          WHEN 'pending' THEN '待審核'
          WHEN 'approved' THEN '已核准'
          WHEN 'rejected' THEN '已駁回'
          WHEN 'cancelled' THEN '已取消'
          ELSE worker_overtime_request.status
        END
      ) AS search_text
    FROM hr_worker_overtime_requests AS worker_overtime_request
    INNER JOIN hr_employments AS worker_employment ON worker_employment.id = worker_overtime_request.worker_id AND worker_employment.person_kind = 'worker'

    UNION ALL

    SELECT
      'clock_correction' AS kind,
      form_request.id AS id,
      coalesce(nullif(employment.legal_name, ''), nullif(employee.display_name, ''), nullif(employee.google_name, ''), employee.email) AS employee_name,
      employment.employee_number AS employee_number,
      form_request.status AS status,
      form_request.reason AS reason,
      form_request.created_at AS created_at,
      NULL AS starts_at,
      NULL AS ends_at,
      NULL AS starts_on,
      NULL AS ends_on,
      NULL AS leave_type,
      NULL AS duration_minutes,
      NULL AS requested_start,
      NULL AS requested_end,
      NULL AS settlement_kind,
      form_request.correction_date AS correction_date,
      form_request.requested_event_kind AS requested_event_kind,
      form_request.requested_at AS requested_at,
      (
        '補打卡 ' ||
        coalesce(nullif(employment.legal_name, ''), nullif(employee.display_name, ''), nullif(employee.google_name, ''), employee.email, '') || ' ' ||
        coalesce(employment.employee_number, '') || ' ' ||
        coalesce(form_request.correction_date, '') || ' ' ||
        coalesce(datetime(form_request.requested_at, '+8 hours'), '') || ' ' ||
        CASE form_request.requested_event_kind WHEN 'clock_in' THEN '補上班' ELSE '補下班' END || ' ' ||
        coalesce(form_request.reason, '') || ' ' ||
        CASE form_request.status
          WHEN 'draft' THEN '草稿'
          WHEN 'pending' THEN '待審核'
          WHEN 'approved' THEN '已核准'
          WHEN 'rejected' THEN '已駁回'
          WHEN 'cancelled' THEN '已取消'
          ELSE form_request.status
        END
      ) AS search_text
    FROM hr_form_requests AS form_request
    INNER JOIN hr_employments AS employment ON employment.id = form_request.employment_id
    INNER JOIN users AS employee ON employee.id = form_request.employee_user_id
  )`;
}

function requestCenterWhere(query: HrRequestCenterListQuery) {
  const kind = query.kind === "all" ? sql`1 = 1` : sql`kind = ${query.kind}`;
  const status = query.status === "all" ? sql`1 = 1` : sql`status = ${query.status}`;
  return sql`${kind} AND ${status} AND instr(lower(search_text), lower(${query.search.trim()})) > 0`;
}

export async function listHrRequestCenterPage(db: Database, query: HrRequestCenterListQuery): Promise<HrRequestCenterPage> {
  const requestedPage = Math.max(1, Math.floor(query.page));
  const pageSize = Math.max(1, Math.floor(query.pageSize));
  const countRows = await db.all<{ total: number }>(sql`${requestCenterCte()}
    SELECT count(*) AS total FROM request_rows WHERE ${requestCenterWhere(query)}`);
  const total = Number(countRows[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * pageSize;
  const rows = await db.all<HrRequestCenterDbRow>(sql`${requestCenterCte()}
    SELECT
      kind, id, employee_name, employee_number, status, reason, created_at,
      starts_at, ends_at, starts_on, ends_on, leave_type, duration_minutes,
      requested_start, requested_end, settlement_kind,
      correction_date, requested_event_kind, requested_at
    FROM request_rows
    WHERE ${requestCenterWhere(query)}
    ORDER BY created_at DESC, id DESC
    LIMIT ${pageSize} OFFSET ${offset}`);
  return {
    rows: rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      employeeName: row.employee_name,
      employeeNumber: row.employee_number,
      status: row.status,
      reason: row.reason,
      createdAt: row.created_at,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      leaveType: row.leave_type,
      durationMinutes: row.duration_minutes,
      requestedStart: row.requested_start,
      requestedEnd: row.requested_end,
      settlementKind: row.settlement_kind,
      correctionDate: row.correction_date,
      requestedEventKind: row.requested_event_kind,
      requestedAt: row.requested_at,
    })),
    total,
    page,
    pageSize,
  };
}
