import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, writeHrMutation, type HrActor } from "./hr-people.js";
import { allocateHrAnnualLeave } from "./hr-annual-leave.js";
import { hrAnnualLeaveEntitlements, hrAnnualLeaveLedger, hrLeaveRequests, hrLeaveTypes } from "./schema/hr-payroll.js";
import { hrEmployees, hrEmployments } from "./schema/hr-people.js";
import { formatTaipeiDate } from "./taipei-time.js";
import { users } from "./schema/auth.js";

const HALF_HOUR_MINUTES = 30;
const MAX_LEAVE_MINUTES = 44_640;
const displayName = sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`;

export interface HrLeaveRequestInput {
  employeeUserId: string;
  leaveTypeId: string;
  /** API 已將使用者選的台北時間轉成 canonical UTC wall-clock。 */
  startsAt: string;
  endsAt: string;
  reason: string;
}

export interface HrLeaveRequestCreateOptions {
  /** 後台代登目前直接核准；本人入口省略此選項則保留待審核狀態。 */
  autoApprove?: boolean;
}

interface NormalizedLeaveInterval {
  startsAt: string;
  endsAt: string;
  startsOn: string;
  endsOn: string;
  durationMinutes: number;
}

const requestFields = {
  request: hrLeaveRequests,
  employeeUserId: hrEmployments.employeeUserId,
  employeeNumber: hrEmployees.employeeNumber,
  employeeName: displayName,
  leaveTypeKind: hrLeaveTypes.leaveKind,
};

function stamp(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new HrError(400, `${label}格式不正確。 `);
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19).replace("T", " ") !== value) throw new HrError(400, `${label}不是有效時間。 `);
  return parsed.getTime();
}

function nextTaipeiDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return formatTaipeiDate(parsed.getTime() + 86_400_000);
}

function normalizeInterval(startsAt: string, endsAt: string): NormalizedLeaveInterval {
  const startMs = stamp(startsAt, "請假開始時間");
  const endMs = stamp(endsAt, "請假結束時間");
  if (endMs <= startMs) throw new HrError(400, "請假結束時間必須晚於開始時間。 ");
  const elapsedMs = endMs - startMs;
  const durationMinutes = elapsedMs / 60_000;
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes < HALF_HOUR_MINUTES || durationMinutes % HALF_HOUR_MINUTES !== 0 || durationMinutes > MAX_LEAVE_MINUTES) {
    throw new HrError(400, "請假時數必須由時間計算為 0.5 小時的倍數，且不可超過 31 天。 ");
  }
  const startsOn = formatTaipeiDate(startMs);
  const lastDate = formatTaipeiDate(endMs - 1_000);
  return { startsAt, endsAt, startsOn, endsOn: nextTaipeiDate(lastDate), durationMinutes };
}

async function ensureEmploymentForPeriod(db: Database, employeeUserId: string, startsOn: string, endsOn: string) {
  const [employment] = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(
    eq(hrEmployments.employeeUserId, employeeUserId),
    sql`${hrEmployments.hiredOn} <= ${startsOn}`,
    sql`(${hrEmployments.endedOn} IS NULL OR ${hrEmployments.endedOn} >= ${endsOn})`,
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
    .orderBy(desc(hrLeaveRequests.startsAt), asc(hrLeaveRequests.createdAt));
}

export async function createHrLeaveRequest(db: Database, input: HrLeaveRequestInput, actor: HrActor, options: HrLeaveRequestCreateOptions = {}) {
  if (input.reason.length > 1000) throw new HrError(400, "請假原因不可超過 1000 字。 ");
  const interval = normalizeInterval(input.startsAt, input.endsAt);
  const employmentId = await ensureEmploymentForPeriod(db, input.employeeUserId, interval.startsOn, interval.endsOn);
  const [leaveType] = await db.select({
    id: hrLeaveTypes.id,
    name: hrLeaveTypes.name,
    leaveKind: hrLeaveTypes.leaveKind,
    defaultPayRatePpm: hrLeaveTypes.defaultPayRatePpm,
  }).from(hrLeaveTypes).where(and(eq(hrLeaveTypes.id, input.leaveTypeId), eq(hrLeaveTypes.active, 1))).limit(1);
  if (!leaveType) throw new HrError(404, "找不到啟用中的假別。 ");
  const id = crypto.randomUUID();
  const autoApprove = options.autoApprove === true;
  if (autoApprove && input.employeeUserId === actor.id) throw new HrError(409, "申請人不可透過後台直接核准自己的請假申請。 ");
  const status = autoApprove ? "approved" : "pending";
  const payRatePpm = leaveType.defaultPayRatePpm;
  const reviewComment = autoApprove ? "HR 後台建立後直接核准" : null;
  // 代登直接核准時，特休必須在同一個週期內有足夠額度；待審申請則在核准當下再檢查。
  const annualAllocation = autoApprove && leaveType.leaveKind === "annual"
    ? await allocateHrAnnualLeave(db, { employmentId, startsOn: interval.startsOn, endsOn: interval.endsOn, durationMinutes: interval.durationMinutes })
    : null;
  const requestStatement = sql`INSERT INTO hr_leave_requests
      (id, employment_id, leave_type_id, leave_type, status, starts_at, ends_at, starts_on, ends_on, duration_minutes, pay_rate_ppm, reason, reviewed_by, reviewed_at, review_comment, created_by)
      SELECT ${id}, ${employmentId}, ${leaveType.id}, ${leaveType.name}, ${status}, ${interval.startsAt}, ${interval.endsAt}, ${interval.startsOn}, ${interval.endsOn}, ${interval.durationMinutes}, ${payRatePpm}, ${input.reason.trim()}, ${autoApprove ? actor.id : null}, ${autoApprove ? sql`CURRENT_TIMESTAMP` : sql`NULL`}, ${reviewComment}, ${actor.id}
      WHERE EXISTS (
        SELECT 1 FROM hr_employments AS current_employment
        WHERE current_employment.id=${employmentId}
          AND current_employment.employee_user_id=${input.employeeUserId}
          AND current_employment.hired_on <= ${interval.startsOn}
          AND (current_employment.ended_on IS NULL OR current_employment.ended_on >= ${interval.endsOn})
      )
        AND NOT EXISTS (
        SELECT 1 FROM hr_leave_requests AS existing_request
        WHERE existing_request.employment_id=${employmentId}
          AND existing_request.status IN ('pending', 'approved')
          AND (
            (existing_request.starts_at <> '' AND existing_request.starts_at < ${interval.endsAt} AND existing_request.ends_at > ${interval.startsAt})
            OR (existing_request.starts_at = '' AND existing_request.starts_on < ${interval.endsOn} AND existing_request.ends_on > ${interval.startsOn})
          )
      ) RETURNING id`;
  const statements = annualAllocation ? [requestStatement, sql`INSERT INTO hr_annual_leave_ledger
      (id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by)
      SELECT ${crypto.randomUUID()}, ${annualAllocation.entitlementId}, 'leave_request', ${-annualAllocation.durationHalfHours}, ${`leave-request:${id}`}, ${id}, '特休申請核准扣除', ${actor.id}
      WHERE EXISTS (SELECT 1 FROM hr_leave_requests WHERE id=${id} AND status='approved')
        AND coalesce((SELECT sum(delta_half_hours) FROM hr_annual_leave_ledger WHERE entitlement_id=${annualAllocation.entitlementId}), 0) >= ${annualAllocation.durationHalfHours}
      RETURNING id`] : requestStatement;
  try {
    return await writeHrMutation(db, statements, id, actor, "leave_request_created", "相同員工已有重疊的請假時段、任職期間無效、特休額度不足或資料不合法。 ");
  } catch (error) {
    if (error instanceof HrError) throw error;
    if (error instanceof Error && /UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed/.test(error.message)) throw new HrError(409, "相同員工已有重疊的請假時段、任職期間無效、特休額度不足或資料不合法。 ");
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

  return writeHrMutation(db, [update, sql`INSERT INTO hr_annual_leave_ledger
    (id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by)
    SELECT ${crypto.randomUUID()}, ${usage.entitlementId}, 'settlement_reversal', ${-usage.deltaHalfHours}, ${`leave-request-cancel:${id}`}, ${id}, '取消已核准特休，返還原扣除額度', ${actor.id}
    WHERE EXISTS (SELECT 1 FROM hr_leave_requests WHERE id=${id} AND status='cancelled')
      AND EXISTS (SELECT 1 FROM hr_annual_leave_entitlements WHERE id=${usage.entitlementId} AND status='open' AND settled_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM hr_annual_leave_ledger WHERE source_key=${`leave-request-cancel:${id}`})
    RETURNING id`], id, actor, "leave_request_cancelled", "請假申請已變更、額度反向紀錄已存在或無法取消，請重新整理。 ");
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
  if (decision === "approved") await ensureEmploymentForPeriod(db, current.employeeUserId, current.startsOn, current.endsOn);
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
      AND EXISTS (
        SELECT 1 FROM hr_employments
        WHERE id=hr_leave_requests.employment_id
          AND employee_user_id <> ${actor.id}
          AND hired_on <= ${current.startsOn}
          AND (ended_on IS NULL OR ended_on >= ${current.endsOn})
      )
    RETURNING id`;
  const statements = annualAllocation ? [sql`INSERT INTO hr_annual_leave_ledger
    (id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by)
    SELECT ${crypto.randomUUID()}, ${annualAllocation.entitlementId}, 'leave_request', ${-annualAllocation.durationHalfHours}, ${`leave-request:${id}`}, ${id}, '特休申請核准扣除', ${actor.id}
    WHERE EXISTS (
        SELECT 1 FROM hr_leave_requests AS request
        INNER JOIN hr_employments AS employment ON employment.id=request.employment_id
        WHERE request.id=${id}
          AND request.status='pending'
          AND employment.employee_user_id <> ${actor.id}
          AND employment.hired_on <= ${current.startsOn}
          AND (employment.ended_on IS NULL OR employment.ended_on >= ${current.endsOn})
      )
      AND coalesce((SELECT sum(delta_half_hours) FROM hr_annual_leave_ledger WHERE entitlement_id=${annualAllocation.entitlementId}), 0) >= ${annualAllocation.durationHalfHours}
    RETURNING id`, updateStatement] : updateStatement;
  return writeHrMutation(db, statements, id, actor, "leave_request_reviewed", "請假申請不存在、申請人不可自審、特休額度不足或已完成處理。 ");
}
