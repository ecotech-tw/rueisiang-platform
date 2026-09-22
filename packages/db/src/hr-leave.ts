import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, writeHrMutation, type HrActor } from "./hr-people.js";
import { allocateHrAnnualLeave } from "./hr-annual-leave.js";
import { hrAnnualLeaveEntitlements, hrAnnualLeaveLedger, hrLeaveRequests, hrLeaveTypes } from "./schema/hr-payroll.js";
import { hrEmployees, hrEmployments } from "./schema/hr-people.js";
import { users } from "./schema/auth.js";

const PPM = 1_000_000;
const displayName = sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`;

export interface HrLeaveRequestInput {
  employeeUserId: string;
  leaveTypeId: string;
  startsOn: string;
  /** 日期區間採半開表示法，endsOn 是最後一天的次日。 */
  endsOn: string;
  durationMinutes: number;
  payRatePpm?: number;
  reason: string;
}

export interface HrLeaveRequestCreateOptions {
  /** 後台代登目前直接核准；本人入口省略此選項則保留待審核狀態。 */
  autoApprove?: boolean;
}

const requestFields = {
  request: hrLeaveRequests,
  employeeUserId: hrEmployments.employeeUserId,
  employeeNumber: hrEmployees.employeeNumber,
  employeeName: displayName,
  leaveTypeKind: hrLeaveTypes.leaveKind,
};

function isDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dateDifferenceInDays(start: string, end: string) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function validateInput(input: HrLeaveRequestInput) {
  if (!isDateOnly(input.startsOn) || !isDateOnly(input.endsOn) || input.endsOn <= input.startsOn) throw new HrError(400, "請假日期區間不正確。 ");
  const days = dateDifferenceInDays(input.startsOn, input.endsOn);
  if (!Number.isSafeInteger(input.durationMinutes) || input.durationMinutes < 30 || input.durationMinutes % 30 !== 0 || input.durationMinutes > days * 24 * 60) throw new HrError(400, "請假時數必須是 0.5 小時的正確倍數，且不得超過申請日期區間。 ");
  if (input.payRatePpm !== undefined && (!Number.isSafeInteger(input.payRatePpm) || input.payRatePpm < 0 || input.payRatePpm > PPM)) throw new HrError(400, "給薪比例必須介於 0～100%。 ");
  if (input.reason.length > 1000) throw new HrError(400, "請假原因不可超過 1000 字。 ");
}

async function ensureEmployment(db: Database, input: HrLeaveRequestInput) {
  const [employment] = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(
    eq(hrEmployments.employeeUserId, input.employeeUserId),
    sql`${hrEmployments.hiredOn} <= ${input.startsOn}`,
    sql`(${hrEmployments.endedOn} IS NULL OR ${hrEmployments.endedOn} >= ${input.endsOn})`,
  )).orderBy(desc(hrEmployments.hiredOn)).limit(1);
  if (!employment) throw new HrError(400, "請假日期不在有效任職期間內。 ");
  return employment.id;
}

export async function listHrLeaveRequests(db: Database, employeeUserId?: string) {
  return db.select(requestFields).from(hrLeaveRequests)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
    .innerJoin(hrEmployees, eq(hrEmployees.userId, hrEmployments.employeeUserId))
    .leftJoin(hrLeaveTypes, eq(hrLeaveTypes.id, hrLeaveRequests.leaveTypeId))
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(employeeUserId ? eq(hrEmployments.employeeUserId, employeeUserId) : undefined)
    .orderBy(desc(hrLeaveRequests.startsOn), asc(hrLeaveRequests.createdAt));
}

export async function createHrLeaveRequest(db: Database, input: HrLeaveRequestInput, actor: HrActor, options: HrLeaveRequestCreateOptions = {}) {
  validateInput(input);
  const employmentId = await ensureEmployment(db, input);
  const [leaveType] = await db.select({
    id: hrLeaveTypes.id,
    name: hrLeaveTypes.name,
    leaveKind: hrLeaveTypes.leaveKind,
    defaultPayRatePpm: hrLeaveTypes.defaultPayRatePpm,
  }).from(hrLeaveTypes).where(and(eq(hrLeaveTypes.id, input.leaveTypeId), eq(hrLeaveTypes.active, 1))).limit(1);
  if (!leaveType) throw new HrError(404, "找不到啟用中的假別。 ");
  const id = crypto.randomUUID();
  const autoApprove = options.autoApprove === true;
  const status = autoApprove ? "approved" : "pending";
  const payRatePpm = input.payRatePpm ?? leaveType.defaultPayRatePpm;
  const reviewComment = autoApprove ? "HR 後台建立後直接核准" : null;
  // 代登直接核准時，特休必須在同一個週期內有足夠額度；待審申請則在核准當下再檢查。
  const annualAllocation = autoApprove && leaveType.leaveKind === "annual"
    ? await allocateHrAnnualLeave(db, { employmentId, startsOn: input.startsOn, endsOn: input.endsOn, durationMinutes: input.durationMinutes })
    : null;
  const requestStatement = sql`INSERT INTO hr_leave_requests
      (id, employment_id, leave_type_id, leave_type, status, starts_on, ends_on, duration_minutes, pay_rate_ppm, reason, reviewed_by, reviewed_at, review_comment, created_by)
      SELECT ${id}, ${employmentId}, ${leaveType.id}, ${leaveType.name}, ${status}, ${input.startsOn}, ${input.endsOn}, ${input.durationMinutes}, ${payRatePpm}, ${input.reason.trim()}, ${autoApprove ? actor.id : null}, ${autoApprove ? sql`CURRENT_TIMESTAMP` : sql`NULL`}, ${reviewComment}, ${actor.id}
      WHERE NOT EXISTS (
        SELECT 1 FROM hr_leave_requests AS existing_request
        WHERE existing_request.employment_id=${employmentId}
          AND existing_request.status IN ('pending', 'approved')
          AND existing_request.starts_on < ${input.endsOn}
          AND existing_request.ends_on > ${input.startsOn}
      ) RETURNING id`;
  const statements = annualAllocation ? [requestStatement, sql`INSERT INTO hr_annual_leave_ledger
      (id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by)
      SELECT ${crypto.randomUUID()}, ${annualAllocation.entitlementId}, 'leave_request', ${-annualAllocation.durationHalfHours}, ${`leave-request:${id}`}, ${id}, '特休申請核准扣除', ${actor.id}
      WHERE EXISTS (SELECT 1 FROM hr_leave_requests WHERE id=${id} AND status='approved')
        AND coalesce((SELECT sum(delta_half_hours) FROM hr_annual_leave_ledger WHERE entitlement_id=${annualAllocation.entitlementId}), 0) >= ${annualAllocation.durationHalfHours}
      RETURNING id`] : requestStatement;
  try {
    return await writeHrMutation(db, statements, id, actor, "leave_request_created", "相同員工已有重疊的請假申請、任職期間無效、特休額度不足或資料不合法。 ");
  } catch (error) {
    if (error instanceof HrError) throw error;
    if (error instanceof Error && /UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed/.test(error.message)) throw new HrError(409, "相同員工已有重疊的請假申請、任職期間無效、特休額度不足或資料不合法。 ");
    throw error;
  }
}

export interface HrLeaveCancellationOptions {
  /** 管理端可代為取消；本人入口只能取消自己建立的申請。 */
  allowAny?: boolean;
}

export async function cancelHrLeaveRequest(db: Database, id: string, actor: HrActor, options: HrLeaveCancellationOptions = {}) {
  const [current] = await db.select({
    employeeUserId: hrEmployments.employeeUserId,
    status: hrLeaveRequests.status,
  }).from(hrLeaveRequests)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
    .where(eq(hrLeaveRequests.id, id)).limit(1);
  if (!current) throw new HrError(404, "找不到請假申請。 ");
  if (!options.allowAny && current.employeeUserId !== actor.id) throw new HrError(404, "找不到可取消的請假申請。 ");
  if (current.status !== "pending" && current.status !== "approved") throw new HrError(409, "請假申請不存在或已完成處理。 ");

  const update = sql`UPDATE hr_leave_requests SET
    status='cancelled', reviewed_by=${actor.id}, reviewed_at=CURRENT_TIMESTAMP, review_comment='申請已取消'
    WHERE id=${id} AND status=${current.status} RETURNING id`;
  if (current.status === "pending") return writeHrMutation(db, update, id, actor, "leave_request_cancelled", "請假申請已變更或完成處理，請重新整理。 ");

  const [usage] = await db.select({
    entitlementId: hrAnnualLeaveLedger.entitlementId,
    deltaHalfHours: hrAnnualLeaveLedger.deltaHalfHours,
    entitlementStatus: hrAnnualLeaveEntitlements.status,
  }).from(hrAnnualLeaveLedger)
    .innerJoin(hrAnnualLeaveEntitlements, eq(hrAnnualLeaveEntitlements.id, hrAnnualLeaveLedger.entitlementId))
    .where(and(
      eq(hrAnnualLeaveLedger.leaveRequestId, id),
      eq(hrAnnualLeaveLedger.entryKind, "leave_request"),
    )).limit(1);
  if (usage?.entitlementStatus === "settled") throw new HrError(409, "特休已隨薪資結算，請使用薪資調整處理取消或更正。 ");
  const [reversal] = await db.select({ id: hrAnnualLeaveLedger.id }).from(hrAnnualLeaveLedger)
    .where(eq(hrAnnualLeaveLedger.sourceKey, `leave-request-cancel:${id}`)).limit(1);
  if (!usage || reversal) return writeHrMutation(db, update, id, actor, "leave_request_cancelled", "請假申請已變更或完成處理，請重新整理。 ");

  return writeHrMutation(db, [sql`INSERT INTO hr_annual_leave_ledger
    (id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by)
    SELECT ${crypto.randomUUID()}, ${usage.entitlementId}, 'settlement_reversal', ${-usage.deltaHalfHours}, ${`leave-request-cancel:${id}`}, ${id}, '取消已核准特休，返還原扣除額度', ${actor.id}
    WHERE EXISTS (SELECT 1 FROM hr_leave_requests WHERE id=${id} AND status='approved')
      AND NOT EXISTS (SELECT 1 FROM hr_annual_leave_ledger WHERE source_key=${`leave-request-cancel:${id}`})
    RETURNING id`, update], id, actor, "leave_request_cancelled", "請假申請已變更、額度反向紀錄已存在或無法取消，請重新整理。 ");
}

export async function reviewHrLeaveRequest(db: Database, id: string, decision: "approved" | "rejected" | "cancelled", comment: string, actor: HrActor) {
  if (!comment.trim() && decision === "rejected") throw new HrError(400, "駁回請假申請時必須填寫審核意見。 ");
  if (comment.length > 1000) throw new HrError(400, "審核意見不可超過 1000 字。 ");
  const [current] = await db.select({
    employeeUserId: hrEmployments.employeeUserId,
    employmentId: hrLeaveRequests.employmentId,
    status: hrLeaveRequests.status,
    leaveKind: hrLeaveTypes.leaveKind,
    startsOn: hrLeaveRequests.startsOn,
    endsOn: hrLeaveRequests.endsOn,
    durationMinutes: hrLeaveRequests.durationMinutes,
  }).from(hrLeaveRequests)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
    .leftJoin(hrLeaveTypes, eq(hrLeaveTypes.id, hrLeaveRequests.leaveTypeId))
    .where(eq(hrLeaveRequests.id, id)).limit(1);
  if (!current) throw new HrError(404, "找不到請假申請。 ");
  if (current.employeeUserId === actor.id) throw new HrError(409, "申請人不可審核自己的請假申請。 ");
  if (current.status !== "pending") throw new HrError(409, "請假申請不存在或已完成處理。 ");
  const annualAllocation = decision === "approved" && current.leaveKind === "annual"
    ? await allocateHrAnnualLeave(db, {
      employmentId: current.employmentId,
      startsOn: current.startsOn,
      endsOn: current.endsOn,
      durationMinutes: current.durationMinutes,
    })
    : null;
  const updateStatement = sql`UPDATE hr_leave_requests SET
    status=${decision}, reviewed_by=${actor.id}, reviewed_at=CURRENT_TIMESTAMP, review_comment=${comment.trim()}
    WHERE id=${id} AND status='pending'
      AND EXISTS (SELECT 1 FROM hr_employments WHERE id=hr_leave_requests.employment_id AND employee_user_id <> ${actor.id})
    RETURNING id`;
  const statements = annualAllocation ? [sql`INSERT INTO hr_annual_leave_ledger
    (id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by)
    SELECT ${crypto.randomUUID()}, ${annualAllocation.entitlementId}, 'leave_request', ${-annualAllocation.durationHalfHours}, ${`leave-request:${id}`}, ${id}, '特休申請核准扣除', ${actor.id}
    WHERE EXISTS (SELECT 1 FROM hr_leave_requests WHERE id=${id} AND status='pending')
      AND coalesce((SELECT sum(delta_half_hours) FROM hr_annual_leave_ledger WHERE entitlement_id=${annualAllocation.entitlementId}), 0) >= ${annualAllocation.durationHalfHours}
    RETURNING id`, updateStatement] : updateStatement;
  return writeHrMutation(db, statements, id, actor, "leave_request_reviewed", "請假申請不存在、申請人不可自審、特休額度不足或已完成處理。 ");
}
