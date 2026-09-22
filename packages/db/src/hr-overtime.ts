import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, writeHrMutation, type HrActor } from "./hr-people.js";
import { hrEmployments, hrEmployeeScopes } from "./schema/hr-people.js";
import { hrOvertimeRequests } from "./schema/hr-scheduling.js";
import { scopes } from "./schema/reports.js";
import { users } from "./schema/auth.js";
import { formatTaipeiDate } from "./taipei-time.js";

/** 公司目前唯一已確認的加班倍率；倍率不是請款人可自由輸入的金額。 */
export const DEFAULT_OVERTIME_RATE_PPM = 1_333_333;

export interface HrOvertimeInput {
  employeeUserId: string;
  scopeId?: string | null;
  /** API 先將台北時間轉成這個 canonical UTC wall-clock 格式再交給 DB。 */
  requestedStart: string;
  requestedEnd: string;
  settlementKind: "pay" | "compensatory";
  /** 舊 client 可帶入，但 server 只接受目前已確認的制度倍率。 */
  ratePpm?: number;
  reason: string;
}

export interface HrOvertimeActualInterval { start: string; end: string }

function stamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new HrError(400, "加班時間必須是 YYYY-MM-DD HH:mm:ss。 ");
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19).replace("T", " ") !== value) throw new HrError(400, "加班時間不是有效日期。 ");
  return parsed.getTime();
}

function taipeiDate(timestamp: number) {
  return formatTaipeiDate(timestamp);
}

async function employmentForInterval(db: Database, userId: string, start: string, end: string) {
  stamp(start);
  stamp(end);
  const [row] = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(
    eq(hrEmployments.employeeUserId, userId),
    sql`${hrEmployments.archivedAt} IS NULL`,
  )).limit(1);
  if (!row) throw new HrError(400, "員工沒有活動的 hr_employments，暫時無法建立加班申請。 ");
  return row.id;
}

async function ensureScope(db: Database, employmentId: string, scopeId: string | null, start: string, end: string) {
  if (!scopeId) return;
  const startDate = taipeiDate(stamp(start));
  const endDate = taipeiDate(stamp(end) - 1000);
  const [row] = await db.select({ id: hrEmployeeScopes.id }).from(hrEmployeeScopes)
    .innerJoin(scopes, eq(scopes.id, hrEmployeeScopes.scopeId))
    .where(and(
      eq(hrEmployeeScopes.employmentId, employmentId), eq(hrEmployeeScopes.scopeId, scopeId),
      eq(scopes.active, 1), eq(scopes.scopeKind, "store"), sql`${scopes.sourceType} <> 'shopee'`,
      sql`${hrEmployeeScopes.validFrom} <= ${startDate}`,
      sql`(${hrEmployeeScopes.validTo} IS NULL OR ${hrEmployeeScopes.validTo} > ${endDate})`,
    )).limit(1);
  if (!row) throw new HrError(400, "加班指定的營運據點不在員工有效 Scope 指派內。 ");
}

const fields = { request: hrOvertimeRequests, employeeNumber: hrEmployments.employeeNumber, employeeName: sql<string | null>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})` };

export async function listHrOvertimeRequests(db: Database, employeeUserId?: string) {
  return db.select(fields).from(hrOvertimeRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId)).innerJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(and(sql`${hrEmployments.archivedAt} IS NULL`, employeeUserId ? eq(hrEmployments.employeeUserId, employeeUserId) : undefined)).orderBy(desc(hrOvertimeRequests.requestedStart));
}

export async function createHrOvertimeRequest(db: Database, input: HrOvertimeInput, actor: HrActor) {
  const startMs = stamp(input.requestedStart);
  const endMs = stamp(input.requestedEnd);
  if (endMs <= startMs) throw new HrError(400, "加班結束時間必須晚於開始時間。 ");
  if ((endMs - startMs) % (30 * 60 * 1000) !== 0) throw new HrError(400, "加班時數必須以 0.5 小時為單位。 ");
  if (input.settlementKind !== "pay" && input.settlementKind !== "compensatory") throw new HrError(400, "加班結算方式不正確。 ");
  if (input.ratePpm !== undefined && input.ratePpm !== DEFAULT_OVERTIME_RATE_PPM) throw new HrError(400, "加班倍率由公司制度決定，不可由申請人指定。 ");
  if (!input.reason.trim() || input.reason.length > 1000) throw new HrError(400, "加班原因必填。 ");
  const employmentId = await employmentForInterval(db, input.employeeUserId, input.requestedStart, input.requestedEnd);
  await ensureScope(db, employmentId, input.scopeId ?? null, input.requestedStart, input.requestedEnd);
  const id = crypto.randomUUID();
  try {
    // overlap guard 放在 INSERT ... SELECT 內，和唯一鍵一起由同一個 D1 batch 仲裁，
    // 不讓兩個同時送出的申請都通過先查後寫的 race。
    await writeHrMutation(db, sql`INSERT INTO hr_overtime_requests
      (id, employment_id, scope_id, requested_start, requested_end, settlement_kind, status, rate_ppm, reason, created_by)
      SELECT ${id}, ${employmentId}, ${input.scopeId ?? null}, ${input.requestedStart}, ${input.requestedEnd}, ${input.settlementKind}, 'pending', ${DEFAULT_OVERTIME_RATE_PPM}, ${input.reason.trim()}, ${actor.id}
      WHERE NOT EXISTS (
        SELECT 1 FROM hr_overtime_requests AS existing_request
        WHERE existing_request.employment_id=${employmentId}
          AND existing_request.status IN ('draft', 'pending', 'approved')
          AND existing_request.requested_start < ${input.requestedEnd}
          AND existing_request.requested_end > ${input.requestedStart}
      ) RETURNING id`, id, actor, "overtime_request_created", "相同或重疊的加班時段、活動員工或資料不合法。 ");
  } catch (error) {
    if (error instanceof HrError) throw error;
    if (error instanceof Error && /UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed/.test(error.message)) throw new HrError(409, "相同或重疊的加班時段、活動員工或資料不合法。 ");
    throw error;
  }
  return { id };
}

export async function reviewHrOvertimeRequest(db: Database, id: string, decision: "approved" | "rejected" | "cancelled", comment: string, actor: HrActor, actual?: HrOvertimeActualInterval) {
  if (!["approved", "rejected", "cancelled"].includes(decision)) throw new HrError(400, "加班審核結果不正確。 ");
  if (comment.length > 1000) throw new HrError(400, "審核意見不可超過 1000 字。 ");
  if (decision === "rejected" && !comment.trim()) throw new HrError(400, "駁回加班申請時必須填寫審核意見。 ");
  const [current] = await db.select({ employeeUserId: hrEmployments.employeeUserId, employmentId: hrOvertimeRequests.employmentId, scopeId: hrOvertimeRequests.scopeId, status: hrOvertimeRequests.status, requestedStart: hrOvertimeRequests.requestedStart, requestedEnd: hrOvertimeRequests.requestedEnd })
    .from(hrOvertimeRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId)).where(and(eq(hrOvertimeRequests.id, id), sql`${hrEmployments.archivedAt} IS NULL`)).limit(1);
  if (!current) throw new HrError(404, "找不到加班申請。 ");
  if (current.employeeUserId === actor.id) throw new HrError(409, "申請人不可審核自己的加班申請。 ");
  if (current.status !== "pending") throw new HrError(409, "加班申請不存在或已完成處理。 ");

  let actualStart: string | null = null;
  let actualEnd: string | null = null;
  if (decision === "approved") {
    actualStart = actual?.start ?? current.requestedStart;
    actualEnd = actual?.end ?? current.requestedEnd;
    const actualStartMs = stamp(actualStart);
    const actualEndMs = stamp(actualEnd);
    if (actualEndMs <= actualStartMs || (actualEndMs - actualStartMs) % (30 * 60 * 1000) !== 0 || actualStart < current.requestedStart || actualEnd > current.requestedEnd) throw new HrError(400, "核定加班實際時段必須以 0.5 小時為單位，且是申請時段內的完整區間。 ");
    const actualEmploymentId = await employmentForInterval(db, current.employeeUserId, actualStart, actualEnd);
    if (actualEmploymentId !== current.employmentId) throw new HrError(400, "核定加班實際時段的活動員工資料不一致。 ");
    await ensureScope(db, current.employmentId, current.scopeId, actualStart, actualEnd);
  }
  await writeHrMutation(db, sql`UPDATE hr_overtime_requests SET
    status=${decision}, actual_start=${actualStart}, actual_end=${actualEnd}, reviewed_by=${actor.id}, reviewed_at=CURRENT_TIMESTAMP, decision_reason=${comment.trim()}
    WHERE id=${id} AND status='pending' AND EXISTS (SELECT 1 FROM hr_employments WHERE id=hr_overtime_requests.employment_id AND archived_at IS NULL AND employee_user_id <> ${actor.id}) RETURNING id`, id, actor, "overtime_request_reviewed", "加班申請不存在、申請人不可自審或已完成處理。 ");
  return { id, status: decision };
}
