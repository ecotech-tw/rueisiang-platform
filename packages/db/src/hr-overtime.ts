import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, hrEmployeeName, writeHrMutation, type HrActor } from "./hr-people.js";
import { hrEmployments, hrEmployeeScopes } from "./schema/hr-people.js";
import { hrOvertimeRequests } from "./schema/hr-scheduling.js";
import { scopes } from "./schema/reports.js";
import { users } from "./schema/auth.js";
import { datesBetween, listHrWorkdayEnds } from "./hr-leave.js";
import { formatTaipeiDate, taipeiMidnightUtc } from "./taipei-time.js";

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
  /** 修改待審申請時使用，避免覆寫較新的版本。 */
  revision?: number;
  reason: string;
}

export interface HrOvertimeBatchInput {
  employeeUserId: string;
  settlementKind: "pay" | "compensatory";
  reason: string;
  entries: Array<{ requestedStart: string; requestedEnd: string }>;
}

export interface HrOvertimeDay {
  /** 台北日期。 */
  date: string;
  /** 當天班表的下班時間（canonical UTC）；沒有班次時為 null，前端不可替使用者猜一個起算點。 */
  shiftEnd: string | null;
  existing: Array<{ requestedStart: string; requestedEnd: string; status: string }>;
}

/** 一次最多一個月；每筆申請在 D1 batch 裡要兩句，再多就接近單次 batch 的上限。 */
export const MAX_OVERTIME_BATCH_ENTRIES = 31;
const MAX_OVERTIME_DAY_RANGE = 62;

export interface HrOvertimeActualInterval { start: string; end: string }

export interface HrOvertimeRequestCreateOptions {
  /** 後台代登目前直接核准；本人入口省略此選項則保留待審核狀態。 */
  autoApprove?: boolean;
}

export interface HrOvertimeCancellationOptions {
  /** 管理端可代為取消；本人入口只能取消自己的申請。 */
  allowAny?: boolean;
}

function stamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new HrError(400, "加班時間必須是 YYYY-MM-DD HH:mm:ss。 ");
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19).replace("T", " ") !== value) throw new HrError(400, "加班時間不是有效日期。 ");
  return parsed.getTime();
}

function taipeiDate(timestamp: number) {
  return formatTaipeiDate(timestamp);
}

function utcStamp(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
}

async function employmentIdFor(db: Database, userId: string, expectedEmploymentId?: string) {
  const [row] = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(
    eq(hrEmployments.employeeUserId, userId),
    expectedEmploymentId ? eq(hrEmployments.id, expectedEmploymentId) : sql`${hrEmployments.archivedAt} IS NULL`,
  )).limit(1);
  if (!row) throw new HrError(400, "員工沒有活動的 hr_employments，暫時無法建立加班申請。 ");
  return row.id;
}

async function employmentForInterval(db: Database, userId: string, start: string, end: string, expectedEmploymentId?: string) {
  stamp(start);
  stamp(end);
  return employmentIdFor(db, userId, expectedEmploymentId);
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

function validateOvertimeInput(input: HrOvertimeInput) {
  const startMs = stamp(input.requestedStart);
  const endMs = stamp(input.requestedEnd);
  if (endMs <= startMs) throw new HrError(400, "加班結束時間必須晚於開始時間。 ");
  if ((endMs - startMs) % (30 * 60 * 1000) !== 0) throw new HrError(400, "加班時數必須以 0.5 小時為單位。 ");
  if (input.settlementKind !== "pay" && input.settlementKind !== "compensatory") throw new HrError(400, "加班結算方式不正確。 ");
  if (input.ratePpm !== undefined && input.ratePpm !== DEFAULT_OVERTIME_RATE_PPM) throw new HrError(400, "加班倍率由公司制度決定，不可由申請人指定。 ");
  if (input.reason.length > 1000) throw new HrError(400, "加班原因不可超過 1000 字。 ");
  return { startMs, endMs };
}

const fields = { request: hrOvertimeRequests, employeeNumber: hrEmployments.employeeNumber, employeeName: hrEmployeeName };

export async function listHrOvertimeRequests(db: Database, employeeUserId?: string, includeArchived = false) {
  return db.select(fields).from(hrOvertimeRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId)).innerJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(and(
    includeArchived ? undefined : sql`${hrEmployments.archivedAt} IS NULL`,
    employeeUserId ? eq(hrEmployments.employeeUserId, employeeUserId) : undefined,
  )).orderBy(desc(hrOvertimeRequests.requestedStart));
}

const ACTIVE_OVERTIME_STATUSES = ["draft", "pending", "approved"] as const;
const CREATE_CONFLICT_MESSAGE = "相同或重疊的加班時段、活動員工或資料不合法。 ";

/**
 * overlap guard 放在 INSERT ... SELECT 內，和唯一鍵一起由同一個 D1 batch 仲裁，
 * 不讓兩個同時送出的申請都通過先查後寫的 race。後台代登雖直接核准，仍保留
 * approved／reviewed 欄位，讓未來本人入口切回 pending 時不必換資料模型。
 */
function insertOvertimeRequest(id: string, employmentId: string, input: Pick<HrOvertimeInput, "employeeUserId" | "scopeId" | "requestedStart" | "requestedEnd" | "settlementKind" | "reason">, actor: HrActor, autoApprove: boolean) {
  const status = autoApprove ? "approved" : "pending";
  const actualStart = autoApprove ? input.requestedStart : null;
  const actualEnd = autoApprove ? input.requestedEnd : null;
  const reviewedBy = autoApprove ? actor.id : null;
  const decisionReason = autoApprove ? "HR 後台建立後直接核准" : "";
  return sql`INSERT INTO hr_overtime_requests
    (id, employment_id, scope_id, requested_start, requested_end, actual_start, actual_end, settlement_kind, status, rate_ppm, reason, reviewed_by, reviewed_at, decision_reason, created_by)
    SELECT ${id}, ${employmentId}, ${input.scopeId ?? null}, ${input.requestedStart}, ${input.requestedEnd}, ${actualStart}, ${actualEnd}, ${input.settlementKind}, ${status}, ${DEFAULT_OVERTIME_RATE_PPM}, ${input.reason.trim()}, ${reviewedBy}, ${autoApprove ? sql`CURRENT_TIMESTAMP` : sql`NULL`}, ${decisionReason}, ${actor.id}
    WHERE EXISTS (
      SELECT 1 FROM hr_employments AS current_employment
      WHERE current_employment.id=${employmentId}
        AND current_employment.employee_user_id=${input.employeeUserId}
        AND current_employment.archived_at IS NULL
    )
      AND NOT EXISTS (
      SELECT 1 FROM hr_overtime_requests AS existing_request
      WHERE existing_request.employment_id=${employmentId}
        AND existing_request.status IN ('draft', 'pending', 'approved')
        AND existing_request.requested_start < ${input.requestedEnd}
        AND existing_request.requested_end > ${input.requestedStart}
    ) RETURNING id`;
}

function rethrowCreateConflict(error: unknown): never {
  if (error instanceof HrError) throw error;
  if (error instanceof Error && /UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed/.test(error.message)) throw new HrError(409, CREATE_CONFLICT_MESSAGE);
  throw error;
}

function assertNotSelfApproved(employeeUserId: string, actor: HrActor, autoApprove: boolean) {
  if (autoApprove && employeeUserId === actor.id) throw new HrError(409, "申請人不可透過後台直接核准自己的加班申請。 ");
}

export async function createHrOvertimeRequest(db: Database, input: HrOvertimeInput, actor: HrActor, options: HrOvertimeRequestCreateOptions = {}) {
  validateOvertimeInput(input);
  const employmentId = await employmentForInterval(db, input.employeeUserId, input.requestedStart, input.requestedEnd);
  await ensureScope(db, employmentId, input.scopeId ?? null, input.requestedStart, input.requestedEnd);
  const id = crypto.randomUUID();
  const autoApprove = options.autoApprove === true;
  assertNotSelfApproved(input.employeeUserId, actor, autoApprove);
  try {
    await writeHrMutation(db, insertOvertimeRequest(id, employmentId, input, actor, autoApprove), id, actor, "overtime_request_created", CREATE_CONFLICT_MESSAGE);
  } catch (error) {
    rethrowCreateConflict(error);
  }
  return { id };
}

async function listActiveOvertimeBetween(db: Database, employmentId: string, start: string, end: string) {
  return db.select({ requestedStart: hrOvertimeRequests.requestedStart, requestedEnd: hrOvertimeRequests.requestedEnd, status: hrOvertimeRequests.status })
    .from(hrOvertimeRequests)
    .where(and(
      eq(hrOvertimeRequests.employmentId, employmentId),
      inArray(hrOvertimeRequests.status, ACTIVE_OVERTIME_STATUSES),
      sql`${hrOvertimeRequests.requestedStart} < ${end}`,
      sql`${hrOvertimeRequests.requestedEnd} > ${start}`,
    ))
    .orderBy(asc(hrOvertimeRequests.requestedStart));
}

/**
 * 整批全有或全無：一個月的加班是一起對帳的，只建一半的話 HR 得自己找出哪幾天漏了。
 * 先查一次是為了能說出是哪幾天撞到；真正擋 race 的仍是每一句 INSERT 自己的 guard。
 */
export async function createHrOvertimeRequests(db: Database, input: HrOvertimeBatchInput, actor: HrActor, options: HrOvertimeRequestCreateOptions = {}) {
  if (!input.entries.length) throw new HrError(400, "請至少選擇一天加班。 ");
  if (input.entries.length > MAX_OVERTIME_BATCH_ENTRIES) throw new HrError(400, `一次最多建立 ${MAX_OVERTIME_BATCH_ENTRIES} 筆加班申請。 `);
  const autoApprove = options.autoApprove === true;
  assertNotSelfApproved(input.employeeUserId, actor, autoApprove);
  const entries = input.entries
    .map((entry) => ({ requestedStart: entry.requestedStart, requestedEnd: entry.requestedEnd, employeeUserId: input.employeeUserId, settlementKind: input.settlementKind, reason: input.reason }))
    .sort((a, b) => a.requestedStart.localeCompare(b.requestedStart));
  for (const entry of entries) validateOvertimeInput(entry);
  const dateOf = (entry: { requestedStart: string }) => taipeiDate(stamp(entry.requestedStart));
  const selfOverlap = entries.find((entry, index) => index > 0 && entries[index - 1]!.requestedEnd > entry.requestedStart);
  if (selfOverlap) throw new HrError(400, `${dateOf(selfOverlap)} 的加班時段彼此重疊。 `);

  const employmentId = await employmentIdFor(db, input.employeeUserId);
  const lastEnd = entries.reduce((latest, entry) => entry.requestedEnd > latest ? entry.requestedEnd : latest, "");
  const existing = await listActiveOvertimeBetween(db, employmentId, entries[0]!.requestedStart, lastEnd);
  const blocked = entries.filter((entry) => existing.some((row) => row.requestedStart < entry.requestedEnd && row.requestedEnd > entry.requestedStart));
  if (blocked.length) throw new HrError(409, `${blocked.map(dateOf).join("、")} 已有重疊的加班申請，整批都沒有建立。 `);

  const ids = entries.map(() => crypto.randomUUID());
  try {
    await writeHrMutation(db, entries.map((entry, index) => insertOvertimeRequest(ids[index]!, employmentId, entry, actor, autoApprove)), ids[0]!, actor, "overtime_requests_created", CREATE_CONFLICT_MESSAGE, { activity: { payload: { requestIds: ids } } });
  } catch (error) {
    rethrowCreateConflict(error);
  }
  return { ids };
}

export async function listHrOvertimeDays(db: Database, input: { employeeUserId: string; startsOn: string; endsOn: string }): Promise<HrOvertimeDay[]> {
  const spanDays = (Date.parse(`${input.endsOn}T00:00:00Z`) - Date.parse(`${input.startsOn}T00:00:00Z`)) / 86_400_000;
  if (!(spanDays >= 1 && spanDays <= MAX_OVERTIME_DAY_RANGE)) throw new HrError(400, `查詢期間必須是 1～${MAX_OVERTIME_DAY_RANGE} 天。 `);
  const employmentId = await employmentIdFor(db, input.employeeUserId);
  const [workdayEnds, existing] = await Promise.all([
    listHrWorkdayEnds(db, employmentId, input.startsOn, input.endsOn),
    listActiveOvertimeBetween(db, employmentId, taipeiMidnightUtc(input.startsOn), taipeiMidnightUtc(input.endsOn)),
  ]);
  return datesBetween(input.startsOn, input.endsOn).map((date) => {
    const shiftEnd = workdayEnds.get(date);
    return {
      date,
      shiftEnd: shiftEnd === undefined ? null : utcStamp(shiftEnd),
      existing: existing.filter((row) => taipeiDate(stamp(row.requestedStart)) === date),
    };
  });
}

export async function updateHrOvertimeRequest(db: Database, id: string, input: HrOvertimeInput, actor: HrActor) {
  validateOvertimeInput(input);
  const [current] = await db.select({
    employeeUserId: hrEmployments.employeeUserId,
    employmentId: hrOvertimeRequests.employmentId,
    scopeId: hrOvertimeRequests.scopeId,
    status: hrOvertimeRequests.status,
    revision: hrOvertimeRequests.revision,
    archivedAt: hrEmployments.archivedAt,
  }).from(hrOvertimeRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId)).where(eq(hrOvertimeRequests.id, id)).limit(1);
  if (!current) throw new HrError(404, "找不到加班申請。 ");
  if (current.employeeUserId !== actor.id) throw new HrError(404, "找不到可修改的加班申請。 ");
  if (current.status !== "pending") throw new HrError(409, "只有待審核的加班申請可以修改；已核准請先取消後重新申請。 ");
  if (current.revision !== input.revision) throw new HrError(409, "加班申請不存在或版本已過期，請重新整理。 ");
  if (current.archivedAt) throw new HrError(409, "員工任職已結束，無法修改加班申請。 ");
  if (input.employeeUserId !== current.employeeUserId) throw new HrError(400, "加班申請員工不可變更。 ");

  const employmentId = await employmentForInterval(db, input.employeeUserId, input.requestedStart, input.requestedEnd, current.employmentId);
  const scopeId = input.scopeId ?? current.scopeId;
  await ensureScope(db, employmentId, scopeId, input.requestedStart, input.requestedEnd);
  try {
    return await writeHrMutation(db, sql`UPDATE hr_overtime_requests SET
      scope_id=${scopeId}, requested_start=${input.requestedStart}, requested_end=${input.requestedEnd},
      actual_start=NULL, actual_end=NULL, settlement_kind=${input.settlementKind}, reason=${input.reason.trim()},
      updated_at=CURRENT_TIMESTAMP, revision=revision+1
      WHERE id=${id} AND employment_id=${current.employmentId} AND status='pending' AND revision=${input.revision}
        AND NOT EXISTS (
          SELECT 1 FROM hr_overtime_requests AS existing_request
          WHERE existing_request.id <> ${id}
            AND existing_request.employment_id=${current.employmentId}
            AND existing_request.status IN ('draft', 'pending', 'approved')
            AND existing_request.requested_start < ${input.requestedEnd}
            AND existing_request.requested_end > ${input.requestedStart}
        ) RETURNING id`, id, actor, "overtime_request_updated", "加班申請已變更、時段重疊或資料不合法，請重新整理。 ");
  } catch (error) {
    if (error instanceof HrError) throw error;
    if (error instanceof Error && /UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed/.test(error.message)) throw new HrError(409, "加班申請已變更、時段重疊或資料不合法，請重新整理。 ");
    throw error;
  }
}

export async function cancelHrOvertimeRequest(db: Database, id: string, actor: HrActor, options: HrOvertimeCancellationOptions = {}) {
  const [current] = await db.select({ employeeUserId: hrEmployments.employeeUserId, status: hrOvertimeRequests.status })
    .from(hrOvertimeRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId)).where(eq(hrOvertimeRequests.id, id)).limit(1);
  if (!current) throw new HrError(404, "找不到加班申請。 ");
  if (!options.allowAny && current.employeeUserId !== actor.id) throw new HrError(404, "找不到可取消的加班申請。 ");
  if (current.status !== "pending" && current.status !== "approved") throw new HrError(409, "加班申請不存在或已完成處理。 ");

  return writeHrMutation(db, sql`UPDATE hr_overtime_requests SET
    status='cancelled', actual_start=NULL, actual_end=NULL, reviewed_by=${actor.id}, reviewed_at=CURRENT_TIMESTAMP,
    decision_reason='申請已取消', updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND status=${current.status} RETURNING id`, id, actor, "overtime_request_cancelled", "加班申請已變更或完成處理，請重新整理。 ");
}

export async function reviewHrOvertimeRequest(db: Database, id: string, decision: "approved" | "rejected" | "cancelled", comment: string, actor: HrActor, actual?: HrOvertimeActualInterval) {
  if (!["approved", "rejected", "cancelled"].includes(decision)) throw new HrError(400, "加班審核結果不正確。 ");
  if (comment.length > 1000) throw new HrError(400, "審核意見不可超過 1000 字。 ");
  if (decision === "cancelled") return cancelHrOvertimeRequest(db, id, actor, { allowAny: true });
  if (decision === "rejected" && !comment.trim()) throw new HrError(400, "駁回加班申請時必須填寫審核意見。 ");
  const [current] = await db.select({ employeeUserId: hrEmployments.employeeUserId, employmentId: hrOvertimeRequests.employmentId, scopeId: hrOvertimeRequests.scopeId, status: hrOvertimeRequests.status, requestedStart: hrOvertimeRequests.requestedStart, requestedEnd: hrOvertimeRequests.requestedEnd })
    .from(hrOvertimeRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId)).where(eq(hrOvertimeRequests.id, id)).limit(1);
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
    const actualEmploymentId = await employmentForInterval(db, current.employeeUserId, actualStart, actualEnd, current.employmentId);
    if (actualEmploymentId !== current.employmentId) throw new HrError(400, "核定加班實際時段的員工資料不一致。 ");
    await ensureScope(db, current.employmentId, current.scopeId, actualStart, actualEnd);
  }
  await writeHrMutation(db, sql`UPDATE hr_overtime_requests SET
    status=${decision}, actual_start=${actualStart}, actual_end=${actualEnd}, reviewed_by=${actor.id}, reviewed_at=CURRENT_TIMESTAMP, decision_reason=${comment.trim()}
    WHERE id=${id} AND status='pending' AND EXISTS (SELECT 1 FROM hr_employments WHERE id=hr_overtime_requests.employment_id AND employee_user_id <> ${actor.id}) RETURNING id`, id, actor, "overtime_request_reviewed", "加班申請不存在、申請人不可自審或已完成處理。 ");
  return { id, status: decision };
}
