import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, writeHrMutation, type HrActor } from "./hr-people.js";
import { hrFormRequests } from "./schema/hr-requests.js";
import { hrEmployees, hrEmployments } from "./schema/hr-people.js";
import { users } from "./schema/auth.js";

export type HrFormRequestStatus = "draft" | "pending" | "approved" | "rejected";
export type HrFormRequestEventKind = "clock_in" | "clock_out";

export interface HrFormRequestInput {
  employeeUserId: string;
  correctionDate: string;
  requestedEventKind: HrFormRequestEventKind;
  requestedAt: string;
  reason: string;
  approverUserId: string | null;
}

const requesterName = sql<string | null>`(
  SELECT coalesce(nullif(requester.display_name, ''), nullif(requester.google_name, ''), requester.email)
  FROM users AS requester WHERE requester.id = ${hrFormRequests.employeeUserId}
)`;
const approverName = sql<string | null>`(
  SELECT coalesce(nullif(approver.display_name, ''), nullif(approver.google_name, ''), approver.email)
  FROM users AS approver WHERE approver.id = ${hrFormRequests.approverUserId}
)`;
const formFields = {
  id: hrFormRequests.id,
  employeeUserId: hrFormRequests.employeeUserId,
  employmentId: hrFormRequests.employmentId,
  formKind: hrFormRequests.formKind,
  status: hrFormRequests.status,
  correctionDate: hrFormRequests.correctionDate,
  requestedEventKind: hrFormRequests.requestedEventKind,
  requestedAt: hrFormRequests.requestedAt,
  reason: hrFormRequests.reason,
  approverUserId: hrFormRequests.approverUserId,
  approverName,
  requesterName,
  submittedAt: hrFormRequests.submittedAt,
  reviewedAt: hrFormRequests.reviewedAt,
  reviewComment: hrFormRequests.reviewComment,
  createdAt: hrFormRequests.createdAt,
  updatedAt: hrFormRequests.updatedAt,
};

function canonicalUtcStamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new HrError(400, "補打卡時間格式不正確。 ");
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19).replace("T", " ") !== value) throw new HrError(400, "補打卡時間不是有效的 UTC 時間。 ");
  return parsed.getTime();
}

function validateRequestedAt(correctionDate: string, requestedAt: string) {
  const timestamp = canonicalUtcStamp(requestedAt);
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date(timestamp));
  if (localDate !== correctionDate) throw new HrError(400, "補打卡日期與時間的台北日期不一致。 ");
}

async function employmentForDate(db: Database, userId: string, correctionDate: string) {
  const [employment] = await db.select({ id: hrEmployments.id }).from(hrEmployments)
    .where(and(
      eq(hrEmployments.employeeUserId, userId),
      sql`${hrEmployments.hiredOn} <= ${correctionDate}`,
      sql`(${hrEmployments.endedOn} IS NULL OR ${hrEmployments.endedOn} > ${correctionDate})`,
    )).orderBy(desc(hrEmployments.hiredOn)).limit(1);
  if (!employment) throw new HrError(400, "補打卡日期不在有效任職期間內。");
  return employment.id;
}

async function employeeSupervisor(db: Database, userId: string) {
  const [employee] = await db.select({ supervisorUserId: hrEmployees.supervisorUserId }).from(hrEmployees)
    .where(eq(hrEmployees.userId, userId)).limit(1);
  if (!employee) throw new HrError(400, "尚未指派為員工，無法建立申請單。");
  return employee.supervisorUserId;
}

async function ensureApprover(db: Database, employeeUserId: string, approverUserId: string | null) {
  if (!approverUserId) return;
  if (approverUserId === employeeUserId) throw new HrError(400, "審核者不可指定自己。");
  const [approver] = await db.select({ id: hrEmployees.userId }).from(hrEmployees)
    .innerJoin(users, eq(users.id, hrEmployees.userId))
    .where(and(eq(hrEmployees.userId, approverUserId), eq(users.status, "active"))).limit(1);
  if (!approver) throw new HrError(400, "審核者必須是啟用中的員工。");
}

export async function listHrFormApprovers(db: Database, userId: string) {
  const [supervisor] = await db.select({ supervisorUserId: hrEmployees.supervisorUserId }).from(hrEmployees)
    .where(eq(hrEmployees.userId, userId)).limit(1);
  const approvers = await db.select({ id: hrEmployees.userId, name: sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})` })
    .from(hrEmployees).innerJoin(users, eq(users.id, hrEmployees.userId))
    .where(and(ne(hrEmployees.userId, userId), eq(users.status, "active")))
    .orderBy(asc(users.displayName), asc(users.email));
  return { approvers, defaultApproverUserId: supervisor?.supervisorUserId ?? null };
}

export async function listHrFormRequests(db: Database, userId: string, allowAny = false) {
  const requests = await db.select(formFields).from(hrFormRequests)
    .where(eq(hrFormRequests.employeeUserId, userId)).orderBy(desc(hrFormRequests.createdAt));
  const reviewRequests = await db.select(formFields).from(hrFormRequests)
    .where(allowAny ? eq(hrFormRequests.status, "pending") : and(eq(hrFormRequests.approverUserId, userId), eq(hrFormRequests.status, "pending")))
    .orderBy(asc(hrFormRequests.submittedAt), asc(hrFormRequests.createdAt));
  return { requests, reviewRequests };
}

/** 管理端申請中心需要看完整補打卡歷史，不只看目前待審核的列。 */
export async function listHrFormRequestsForHr(db: Database) {
  return db.select(formFields).from(hrFormRequests).orderBy(desc(hrFormRequests.createdAt));
}

export async function getHrFormRequest(db: Database, id: string, userId: string, allowAny = false) {
  const [request] = await db.select(formFields).from(hrFormRequests)
    .where(allowAny ? eq(hrFormRequests.id, id) : and(eq(hrFormRequests.id, id), or(eq(hrFormRequests.employeeUserId, userId), eq(hrFormRequests.approverUserId, userId))))
    .limit(1);
  if (!request) throw new HrError(404, "找不到這份申請單。");
  return request;
}

export async function createHrFormRequest(db: Database, input: HrFormRequestInput, actor: HrActor) {
  validateRequestedAt(input.correctionDate, input.requestedAt);
  const employmentId = await employmentForDate(db, input.employeeUserId, input.correctionDate);
  const defaultApprover = await employeeSupervisor(db, input.employeeUserId);
  const approverUserId = input.approverUserId ?? defaultApprover;
  await ensureApprover(db, input.employeeUserId, approverUserId);
  const id = crypto.randomUUID();
  return writeHrMutation(db, sql`INSERT INTO hr_form_requests
    (id, employee_user_id, employment_id, form_kind, status, correction_date, requested_event_kind, requested_at, reason, approver_user_id)
    VALUES (${id}, ${input.employeeUserId}, ${employmentId}, 'clock_correction', 'draft', ${input.correctionDate}, ${input.requestedEventKind}, ${input.requestedAt}, ${input.reason}, ${approverUserId})
    RETURNING id`, id, actor, "hr_form_request_created", "申請單資料不合法，請重新確認。");
}

export async function updateHrFormRequest(db: Database, id: string, employeeUserId: string, input: Omit<HrFormRequestInput, "employeeUserId">, actor: HrActor) {
  const [current] = await db.select({ status: hrFormRequests.status }).from(hrFormRequests)
    .where(and(eq(hrFormRequests.id, id), eq(hrFormRequests.employeeUserId, employeeUserId))).limit(1);
  if (!current) throw new HrError(404, "找不到這份申請單。");
  if (current.status !== "draft") throw new HrError(409, "申請中的表單不能再修改。");
  validateRequestedAt(input.correctionDate, input.requestedAt);
  const employmentId = await employmentForDate(db, employeeUserId, input.correctionDate);
  await ensureApprover(db, employeeUserId, input.approverUserId);
  return writeHrMutation(db, sql`UPDATE hr_form_requests SET
    employment_id=${employmentId}, correction_date=${input.correctionDate}, requested_event_kind=${input.requestedEventKind},
    requested_at=${input.requestedAt}, reason=${input.reason}, approver_user_id=${input.approverUserId}, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND employee_user_id=${employeeUserId} AND status='draft' RETURNING id`, id, actor, "hr_form_request_updated", "申請單已變更或資料不合法，請重新整理。");
}

export async function submitHrFormRequest(db: Database, id: string, employeeUserId: string, actor: HrActor) {
  const [current] = await db.select({ status: hrFormRequests.status, approverUserId: hrFormRequests.approverUserId })
    .from(hrFormRequests).where(and(eq(hrFormRequests.id, id), eq(hrFormRequests.employeeUserId, employeeUserId))).limit(1);
  if (!current) throw new HrError(404, "找不到這份申請單。");
  if (current.status !== "draft") throw new HrError(409, "這份申請單已送出，不能重複送出。");
  const approverUserId = current.approverUserId ?? await employeeSupervisor(db, employeeUserId);
  if (!approverUserId) throw new HrError(400, "送出前請指定審核者。");
  await ensureApprover(db, employeeUserId, approverUserId);
  return writeHrMutation(db, sql`UPDATE hr_form_requests SET
    status='pending', approver_user_id=${approverUserId}, submitted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND employee_user_id=${employeeUserId} AND status='draft' RETURNING id`, id, actor, "hr_form_request_submitted", "申請單已變更，請重新整理後再送出。");
}

export async function reviewHrFormRequest(db: Database, id: string, reviewerUserId: string, decision: Exclude<HrFormRequestStatus, "draft" | "pending">, comment: string, allowAny: boolean, actor: HrActor) {
  const [current] = await db.select({ employeeUserId: hrFormRequests.employeeUserId, employmentId: hrFormRequests.employmentId, status: hrFormRequests.status, approverUserId: hrFormRequests.approverUserId, requestedEventKind: hrFormRequests.requestedEventKind, requestedAt: hrFormRequests.requestedAt, reason: hrFormRequests.reason, correctedClockEventId: hrFormRequests.correctedClockEventId })
    .from(hrFormRequests).where(eq(hrFormRequests.id, id)).limit(1);
  if (!current) throw new HrError(404, "找不到這份申請單。");
  if (current.employeeUserId === reviewerUserId) throw new HrError(409, "申請人不可審核自己的申請單。");
  if (!allowAny && current.approverUserId !== reviewerUserId) throw new HrError(404, "找不到這份待審核申請單。");
  if (current.status !== "pending") throw new HrError(409, "這份申請單已經完成審核。");
  const reviewWhere = sql`id=${id} AND status='pending' ${allowAny ? sql`` : sql`AND approver_user_id=${reviewerUserId}`}`;
  if (decision === "approved") {
    const eventId = crypto.randomUUID();
    await writeHrMutation(db, [
      sql`INSERT INTO hr_clock_events
        (id, employee_user_id, employment_id, source_kind, idempotency_key, correction_request_id, event_kind, recorded_by, manual_reason, occurred_at, received_at)
        SELECT ${eventId}, ${current.employeeUserId}, ${current.employmentId}, 'manual', ${`form-correction:${id}`}, ${id}, ${current.requestedEventKind}, ${reviewerUserId}, ${current.reason}, ${current.requestedAt}, CURRENT_TIMESTAMP
        FROM hr_form_requests
        WHERE ${reviewWhere} AND corrected_clock_event_id IS NULL RETURNING id`,
      sql`UPDATE hr_form_requests SET
        status='approved', corrected_clock_event_id=${eventId}, reviewed_at=CURRENT_TIMESTAMP, review_comment=${comment.trim()}, updated_at=CURRENT_TIMESTAMP
        WHERE ${reviewWhere} AND corrected_clock_event_id IS NULL RETURNING id`,
    ], id, actor, "hr_form_request_reviewed", "申請單已被其他人處理，請重新整理。 ");
  } else {
    await writeHrMutation(db, sql`UPDATE hr_form_requests SET
      status=${decision}, reviewed_at=CURRENT_TIMESTAMP, review_comment=${comment.trim()}, updated_at=CURRENT_TIMESTAMP
      WHERE ${reviewWhere} RETURNING id`, id, actor, "hr_form_request_reviewed", "申請單已被其他人處理，請重新整理。 ");
  }
  return { id, status: decision };
}
