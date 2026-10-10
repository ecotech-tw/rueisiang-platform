import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, hrEmployeeName, isHrAdministrator, writeHrMutation, type HrActor } from "./hr-people.js";
import { appendHrNotification, insertHrNotification, overtimeBatchSourceKey } from "./hr-notifications.js";
import { hrEmployments, hrEmployeeScopes } from "./schema/hr-people.js";
import { hrOvertimeRequests, hrScheduleVersions, hrScheduleWorkerEntries, hrWorkerOvertimeRequests } from "./schema/hr-scheduling.js";
import { scopes } from "./schema/reports.js";
import { users } from "./schema/auth.js";
import { datesBetween, listHrWorkdayEnds } from "./hr-leave.js";
import { inJsonArray, jsonArrayValues } from "./sql-lists.js";
import { formatTaipeiDate, taipeiMidnightUtc } from "./taipei-time.js";

/** 同一天前 2 小時的加班倍率，建立申請時凍結在申請上；超過 2 小時的級距由薪資試算套用。倍率不是請款人可自由輸入的金額。 */
export const DEFAULT_OVERTIME_RATE_PPM = 1_333_333;

export interface HrOvertimeInput {
  /** 正式員工與無帳號支援人員二擇一。 */
  employeeUserId?: string;
  workerId?: string;
  scopeId?: string | null;
  /** API 先將台北時間轉成這個 canonical UTC wall-clock 格式再交給 DB。 */
  requestedStart: string;
  requestedEnd: string;
  settlementKind: "pay" | "compensatory";
  /** 正式員工舊 client 可帶入，但 server 只接受目前已確認的制度倍率；支援人員由敘薪版本決定，不接受此欄位。 */
  ratePpm?: number;
  /** 修改待審申請時使用，避免覆寫較新的版本。 */
  revision?: number;
  reason: string;
}

export interface HrOvertimeBatchInput {
  employeeUserId?: string;
  workerId?: string;
  scopeId?: string | null;
  settlementKind: "pay" | "compensatory";
  reason: string;
  entries: Array<{ requestedStart: string; requestedEnd: string; scopeId?: string | null }>;
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
export const MAX_OVERTIME_CANCELLATION_ENTRIES = 100;
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

function nextDate(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
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

async function workerForInterval(db: Database, workerId: string, start: string, end: string) {
  stamp(start);
  stamp(end);
  const [worker] = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(
    eq(hrEmployments.id, workerId), eq(hrEmployments.personKind, "worker"), sql`${hrEmployments.archivedAt} IS NULL`,
  )).limit(1);
  if (!worker) throw new HrError(400, "支援人員不存在或已停用，暫時無法建立加班申請。 ");
  return worker.id;
}

async function ensureWorkerScope(db: Database, scopeId: string | null) {
  if (!scopeId) return;
  const [row] = await db.select({ id: scopes.id }).from(scopes).where(and(
    eq(scopes.id, scopeId), eq(scopes.active, 1), eq(scopes.scopeKind, "store"), sql`${scopes.sourceType} <> 'shopee'`,
  )).limit(1);
  if (!row) throw new HrError(400, "加班指定的營運據點不存在或不可使用。 ");
}

function assertTarget(input: Pick<HrOvertimeInput, "employeeUserId" | "workerId">) {
  const hasEmployee = typeof input.employeeUserId === "string" && input.employeeUserId.length > 0;
  const hasWorker = typeof input.workerId === "string" && input.workerId.length > 0;
  if (hasEmployee === hasWorker) throw new HrError(400, "加班申請必須指定一位正式員工或支援人員。 ");
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

const fields = { request: hrOvertimeRequests, employeeUserId: hrEmployments.employeeUserId, employeeNumber: hrEmployments.employeeNumber, employeeName: hrEmployeeName };

export async function listHrOvertimeRequests(db: Database, employeeUserId?: string, includeArchived = false) {
  const employeeRows = employeeUserId === undefined || employeeUserId.length > 0
    ? await db.select(fields).from(hrOvertimeRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId)).innerJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(and(
      includeArchived ? undefined : sql`${hrEmployments.archivedAt} IS NULL`,
      employeeUserId ? eq(hrEmployments.employeeUserId, employeeUserId) : undefined,
    ))
    : [];
  // 支援人員沒有 users，但 canonical employment 仍是名稱、編號與啟用狀態的唯一來源。
  const workerRows = employeeUserId === undefined
    ? await db.select({ request: hrWorkerOvertimeRequests, workerId: hrWorkerOvertimeRequests.workerId, employeeName: hrEmployments.legalName, employeeNumber: hrEmployments.employeeNumber })
      .from(hrWorkerOvertimeRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrWorkerOvertimeRequests.workerId))
      .where(and(eq(hrEmployments.personKind, "worker"), includeArchived ? undefined : isNull(hrEmployments.archivedAt)))
    : [];
  return [
    ...employeeRows.map((row) => ({ ...row, workerId: undefined })),
    ...workerRows.map((row) => ({ request: row.request, employeeUserId: undefined, employeeName: row.employeeName, employeeNumber: row.employeeNumber, workerId: row.workerId })),
  ].sort((left, right) => right.request.requestedStart.localeCompare(left.request.requestedStart));
}

/** 直屬主管只看到指定給自己的待審申請；HR 管理者可代審所有待審申請。 */
export async function listHrOvertimeReviewRequests(db: Database, userId: string, allowAny = false) {
  return db.select(fields).from(hrOvertimeRequests)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId))
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(and(eq(hrOvertimeRequests.status, "pending"), ne(hrEmployments.employeeUserId, userId), allowAny ? undefined : eq(hrOvertimeRequests.approverUserId, userId)))
    .orderBy(asc(hrOvertimeRequests.requestedStart));
}

async function requestApprover(db: Database, employmentId: string, employeeUserId: string) {
  const [employment] = await db.select({ supervisorUserId: hrEmployments.supervisorUserId }).from(hrEmployments)
    .where(and(eq(hrEmployments.id, employmentId), eq(hrEmployments.employeeUserId, employeeUserId), sql`${hrEmployments.archivedAt} IS NULL`)).limit(1);
  const supervisorUserId = employment?.supervisorUserId;
  if (supervisorUserId && supervisorUserId !== employeeUserId) {
    const [approver] = await db.select({ userId: hrEmployments.employeeUserId }).from(hrEmployments)
      .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
      .where(and(eq(hrEmployments.employeeUserId, supervisorUserId), sql`${hrEmployments.archivedAt} IS NULL`, eq(users.status, "active"))).limit(1);
    if (approver) return approver.userId;
  }
  const candidates = await db.select({ userId: users.id }).from(users).where(eq(users.status, "active")).orderBy(asc(users.email));
  for (const candidate of candidates) if (candidate.userId !== employeeUserId && await isHrAdministrator(db, candidate.userId)) return candidate.userId;
  throw new HrError(409, "目前找不到可用的申請審核者，請聯絡 HR 後再送出。 ");
}

const ACTIVE_OVERTIME_STATUSES = ["draft", "pending", "approved"] as const;
const CREATE_CONFLICT_MESSAGE = "相同或重疊的加班時段、活動員工或資料不合法。 ";

/**
 * overlap guard 放在 INSERT ... SELECT 內，和唯一鍵一起由同一個 D1 batch 仲裁，
 * 不讓兩個同時送出的申請都通過先查後寫的 race。後台代登雖直接核准，仍保留
 * approved／reviewed 欄位，讓未來本人入口切回 pending 時不必換資料模型。
 */
function insertOvertimeRequest(id: string, employmentId: string, input: Pick<HrOvertimeInput, "employeeUserId" | "scopeId" | "requestedStart" | "requestedEnd" | "settlementKind" | "reason">, actor: HrActor, autoApprove: boolean, approverUserId: string | null, batchId: string | null = null) {
  const status = autoApprove ? "approved" : "pending";
  const actualStart = autoApprove ? input.requestedStart : null;
  const actualEnd = autoApprove ? input.requestedEnd : null;
  const reviewedBy = autoApprove ? actor.id : null;
  const decisionReason = autoApprove ? "HR 後台建立後直接核准" : "";
  return sql`INSERT INTO hr_overtime_requests
    (id, employment_id, scope_id, requested_start, requested_end, actual_start, actual_end, settlement_kind, status, rate_ppm, reason, approver_user_id, reviewed_by, reviewed_at, decision_reason, batch_id, created_by)
    SELECT ${id}, ${employmentId}, ${input.scopeId ?? null}, ${input.requestedStart}, ${input.requestedEnd}, ${actualStart}, ${actualEnd}, ${input.settlementKind}, ${status}, ${DEFAULT_OVERTIME_RATE_PPM}, ${input.reason.trim()}, ${approverUserId}, ${reviewedBy}, ${autoApprove ? sql`CURRENT_TIMESTAMP` : sql`NULL`}, ${decisionReason}, ${batchId}, ${actor.id}
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

function insertWorkerOvertimeRequest(id: string, workerId: string, input: Pick<HrOvertimeInput, "scopeId" | "requestedStart" | "requestedEnd" | "settlementKind" | "reason">, actor: HrActor, autoApprove: boolean) {
  const status = autoApprove ? "approved" : "pending";
  const actualStart = autoApprove ? input.requestedStart : null;
  const actualEnd = autoApprove ? input.requestedEnd : null;
  const reviewedBy = autoApprove ? actor.id : null;
  const decisionReason = autoApprove ? "HR 後台建立後直接核准" : "";
  return sql`INSERT INTO hr_worker_overtime_requests
    (id, worker_id, scope_id, requested_start, requested_end, actual_start, actual_end, settlement_kind, status, rate_ppm, reason, reviewed_by, reviewed_at, decision_reason, created_by)
    SELECT ${id}, ${workerId}, ${input.scopeId ?? null}, ${input.requestedStart}, ${input.requestedEnd}, ${actualStart}, ${actualEnd}, ${input.settlementKind}, ${status}, ${DEFAULT_OVERTIME_RATE_PPM}, ${input.reason.trim()}, ${reviewedBy}, ${autoApprove ? sql`CURRENT_TIMESTAMP` : sql`NULL`}, ${decisionReason}, ${actor.id}
    WHERE EXISTS (SELECT 1 FROM hr_employments WHERE id=${workerId} AND person_kind='worker' AND archived_at IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM hr_worker_overtime_requests AS existing_request
        WHERE existing_request.worker_id=${workerId}
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

/**
 * 員工自己送的加班一律付薪：補休不進薪資，而審核者改不了結算方式，選錯就是少領一筆沒人攔。
 * 補休只能由 HR 後台代登（autoApprove）。
 */
function assertSelfServiceSettlement(settlementKind: HrOvertimeInput["settlementKind"]) {
  if (settlementKind !== "pay") throw new HrError(400, "本人申請的加班一律付薪；需要補休請洽 HR。 ");
}

function assertNotSelfApproved(employeeUserId: string, actor: HrActor, autoApprove: boolean) {
  if (autoApprove && employeeUserId === actor.id) throw new HrError(409, "申請人不可透過後台直接核准自己的加班申請。 ");
}

export async function createHrOvertimeRequest(db: Database, input: HrOvertimeInput, actor: HrActor, options: HrOvertimeRequestCreateOptions = {}) {
  assertTarget(input);
  validateOvertimeInput(input);
  const autoApprove = options.autoApprove === true;
  if (!autoApprove) assertSelfServiceSettlement(input.settlementKind);
  if (input.employeeUserId) {
    const employmentId = await employmentForInterval(db, input.employeeUserId, input.requestedStart, input.requestedEnd);
    await ensureScope(db, employmentId, input.scopeId ?? null, input.requestedStart, input.requestedEnd);
    const id = crypto.randomUUID();
    assertNotSelfApproved(input.employeeUserId, actor, autoApprove);
    const approverUserId = autoApprove ? null : await requestApprover(db, employmentId, input.employeeUserId);
    const requestStatement = insertOvertimeRequest(id, employmentId, input, actor, autoApprove, approverUserId);
    const mutations = approverUserId ? [requestStatement, insertHrNotification({
      userId: approverUserId, sourceKey: `overtime-request:${id}:submitted`, kind: "request_submitted", entityKind: "overtime", entityId: id,
      title: "有新的加班申請待審核", body: `申請日期：${taipeiDate(stamp(input.requestedStart))}，請開啟待審清單處理。`,
    })] : requestStatement;
    try {
      await writeHrMutation(db, mutations, id, actor, "overtime_request_created", CREATE_CONFLICT_MESSAGE);
    } catch (error) {
      rethrowCreateConflict(error);
    }
    return { id };
  }
  const workerId = await workerForInterval(db, input.workerId!, input.requestedStart, input.requestedEnd);
  await ensureWorkerScope(db, input.scopeId ?? null);
  const id = crypto.randomUUID();
  try {
    await writeHrMutation(db, insertWorkerOvertimeRequest(id, workerId, input, actor, autoApprove), id, actor, "overtime_request_created", CREATE_CONFLICT_MESSAGE);
  } catch (error) {
    rethrowCreateConflict(error);
  }
  return { id };
}

async function listActiveOvertimeBetween(db: Database, target: { employmentId?: string; workerId?: string }, start: string, end: string) {
  if (target.employmentId) {
    return db.select({ requestedStart: hrOvertimeRequests.requestedStart, requestedEnd: hrOvertimeRequests.requestedEnd, status: hrOvertimeRequests.status })
      .from(hrOvertimeRequests)
      .where(and(
        eq(hrOvertimeRequests.employmentId, target.employmentId),
        inArray(hrOvertimeRequests.status, ACTIVE_OVERTIME_STATUSES),
        sql`${hrOvertimeRequests.requestedStart} < ${end}`,
        sql`${hrOvertimeRequests.requestedEnd} > ${start}`,
      ))
      .orderBy(asc(hrOvertimeRequests.requestedStart));
  }
  return db.select({ requestedStart: hrWorkerOvertimeRequests.requestedStart, requestedEnd: hrWorkerOvertimeRequests.requestedEnd, status: hrWorkerOvertimeRequests.status })
    .from(hrWorkerOvertimeRequests)
    .where(and(
      eq(hrWorkerOvertimeRequests.workerId, target.workerId!),
      inArray(hrWorkerOvertimeRequests.status, ACTIVE_OVERTIME_STATUSES),
      sql`${hrWorkerOvertimeRequests.requestedStart} < ${end}`,
      sql`${hrWorkerOvertimeRequests.requestedEnd} > ${start}`,
    ))
    .orderBy(asc(hrWorkerOvertimeRequests.requestedStart));
}

/**
 * 整批全有或全無：一個月的加班是一起對帳的，只建一半的話 HR 得自己找出哪幾天漏了。
 * 先查一次是為了能說出是哪幾天撞到；真正擋 race 的仍是每一句 INSERT 自己的 guard。
 */
export async function createHrOvertimeRequests(db: Database, input: HrOvertimeBatchInput, actor: HrActor, options: HrOvertimeRequestCreateOptions = {}) {
  assertTarget(input);
  if (!input.entries.length) throw new HrError(400, "請至少選擇一天加班。 ");
  if (input.entries.length > MAX_OVERTIME_BATCH_ENTRIES) throw new HrError(400, `一次最多建立 ${MAX_OVERTIME_BATCH_ENTRIES} 筆加班申請。 `);
  const autoApprove = options.autoApprove === true;
  if (!autoApprove) assertSelfServiceSettlement(input.settlementKind);
  if (input.employeeUserId) assertNotSelfApproved(input.employeeUserId, actor, autoApprove);
  const entries = input.entries
    .map((entry) => {
      if (input.scopeId && entry.scopeId && input.scopeId !== entry.scopeId) throw new HrError(400, "同一批加班申請不可指定不同的營運據點。 ");
      return { requestedStart: entry.requestedStart, requestedEnd: entry.requestedEnd, employeeUserId: input.employeeUserId, workerId: input.workerId, scopeId: input.scopeId ?? entry.scopeId ?? null, settlementKind: input.settlementKind, reason: input.reason };
    })
    .sort((a, b) => a.requestedStart.localeCompare(b.requestedStart));
  for (const entry of entries) validateOvertimeInput(entry);
  const dateOf = (entry: { requestedStart: string }) => taipeiDate(stamp(entry.requestedStart));
  const selfOverlap = entries.find((entry, index) => index > 0 && entries[index - 1]!.requestedEnd > entry.requestedStart);
  if (selfOverlap) throw new HrError(400, `${dateOf(selfOverlap)} 的加班時段彼此重疊。 `);

  const target = input.employeeUserId
    ? { employmentId: await employmentIdFor(db, input.employeeUserId) }
    : { workerId: await workerForInterval(db, input.workerId!, entries[0]!.requestedStart, entries[0]!.requestedEnd) };
  if (target.employmentId) {
    await Promise.all(entries.map((entry) => ensureScope(db, target.employmentId!, entry.scopeId ?? null, entry.requestedStart, entry.requestedEnd)));
  } else {
    await Promise.all(entries.map((entry) => ensureWorkerScope(db, entry.scopeId ?? null)));
  }
  const lastEnd = entries.reduce((latest, entry) => entry.requestedEnd > latest ? entry.requestedEnd : latest, "");
  const existing = await listActiveOvertimeBetween(db, target, entries[0]!.requestedStart, lastEnd);
  const blocked = entries.filter((entry) => existing.some((row) => row.requestedStart < entry.requestedEnd && row.requestedEnd > entry.requestedStart));
  if (blocked.length) throw new HrError(409, `${blocked.map(dateOf).join("、")} 已有重疊的加班申請，整批都沒有建立。 `);

  const approverUserId = target.employmentId && !autoApprove
    ? await requestApprover(db, target.employmentId, input.employeeUserId!)
    : null;
  const ids = entries.map(() => crypto.randomUUID());
  // 只有本人送出、需要審核的批次才帶批次鍵；後台代登直接核准，沒有通知要合併。
  const batchId = approverUserId && entries.length > 1 ? crypto.randomUUID() : null;
  const statements = entries.map((entry, index) => target.employmentId
    ? insertOvertimeRequest(ids[index]!, target.employmentId, entry, actor, autoApprove, approverUserId, batchId)
    : insertWorkerOvertimeRequest(ids[index]!, target.workerId!, entry, actor, autoApprove));
  // 月底一次送整個月時，一筆一則會把審核者的通知洗掉；整批只發一則，掛在批次鍵上，待審清單用同一個鍵列出整批。
  const mutations = approverUserId
    ? [...statements, insertHrNotification({
      userId: approverUserId, sourceKey: batchId ? overtimeBatchSourceKey(batchId, "submitted") : `overtime-request:${ids[0]}:submitted`, kind: "request_submitted", entityKind: "overtime", entityId: batchId ?? ids[0]!,
      title: entries.length > 1 ? `有 ${entries.length} 筆新的加班申請待審核` : "有新的加班申請待審核",
      body: `申請日期：${entries.map(dateOf).join("、")}，請開啟待審清單處理。`,
    })]
    : statements;
  try {
    await writeHrMutation(db, mutations, ids[0]!, actor, "overtime_requests_created", CREATE_CONFLICT_MESSAGE, { activity: { payload: { requestIds: ids } } });
  } catch (error) {
    rethrowCreateConflict(error);
  }
  return { ids };
}

async function listHrWorkerWorkdayEnds(db: Database, workerId: string, startsOn: string, endsOn: string) {
  const rows = await db.select({ workDate: hrScheduleWorkerEntries.workDate, endsAt: hrScheduleWorkerEntries.endsAt }).from(hrScheduleWorkerEntries)
    .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleWorkerEntries.scheduleVersionId))
    .where(and(
      eq(hrScheduleWorkerEntries.workerId, workerId),
      eq(hrScheduleVersions.status, "published"),
      sql`${hrScheduleWorkerEntries.workDate} >= ${startsOn}`,
      sql`${hrScheduleWorkerEntries.workDate} < ${endsOn}`,
      sql`${hrScheduleVersions.versionNumber} = (SELECT max(latest.version_number) FROM hr_schedule_versions AS latest WHERE latest.period_start=${hrScheduleVersions.periodStart} AND latest.period_end=${hrScheduleVersions.periodEnd} AND latest.status='published')`,
    ));
  const ends = new Map<string, number>();
  for (const row of rows) {
    const timestamp = stamp(row.endsAt);
    ends.set(row.workDate, Math.max(ends.get(row.workDate) ?? 0, timestamp));
  }
  return ends;
}

export async function listHrOvertimeDays(db: Database, input: { employeeUserId?: string; workerId?: string; startsOn: string; endsOn: string }): Promise<HrOvertimeDay[]> {
  assertTarget(input);
  const spanDays = (Date.parse(`${input.endsOn}T00:00:00Z`) - Date.parse(`${input.startsOn}T00:00:00Z`)) / 86_400_000;
  if (!(spanDays >= 1 && spanDays <= MAX_OVERTIME_DAY_RANGE)) throw new HrError(400, `查詢期間必須是 1～${MAX_OVERTIME_DAY_RANGE} 天。 `);
  const target = input.employeeUserId
    ? { employmentId: await employmentIdFor(db, input.employeeUserId) }
    : { workerId: await workerForInterval(db, input.workerId!, `${input.startsOn} 00:00:00`, `${input.endsOn} 00:00:00`) };
  const [workdayEnds, existing] = await Promise.all([
    target.employmentId ? listHrWorkdayEnds(db, target.employmentId, input.startsOn, input.endsOn) : listHrWorkerWorkdayEnds(db, target.workerId!, input.startsOn, input.endsOn),
    listActiveOvertimeBetween(db, target, taipeiMidnightUtc(input.startsOn), taipeiMidnightUtc(input.endsOn)),
  ]);
  return datesBetween(input.startsOn, input.endsOn).map((date) => {
    const shiftEnd = workdayEnds.get(date);
    const dayStart = taipeiMidnightUtc(date);
    const dayEnd = taipeiMidnightUtc(nextDate(date));
    return {
      date,
      shiftEnd: shiftEnd === undefined ? null : utcStamp(shiftEnd),
      // 跨午夜申請佔用每個相交的台北日期，不能只標在 requestedStart 那天。
      existing: existing.filter((row) => row.requestedStart < dayEnd && row.requestedEnd > dayStart),
    };
  });
}

export async function updateHrOvertimeRequest(db: Database, id: string, input: HrOvertimeInput, actor: HrActor) {
  assertTarget(input);
  if (!input.employeeUserId) throw new HrError(404, "支援人員加班申請不能從本人入口修改。 ");
  validateOvertimeInput(input);
  const [current] = await db.select({
    employeeUserId: hrEmployments.employeeUserId,
    employmentId: hrOvertimeRequests.employmentId,
    scopeId: hrOvertimeRequests.scopeId,
    status: hrOvertimeRequests.status,
    approverUserId: hrOvertimeRequests.approverUserId,
    settlementKind: hrOvertimeRequests.settlementKind,
    revision: hrOvertimeRequests.revision,
    archivedAt: hrEmployments.archivedAt,
  }).from(hrOvertimeRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId)).where(eq(hrOvertimeRequests.id, id)).limit(1);
  if (!current) throw new HrError(404, "找不到加班申請。 ");
  if (current.employeeUserId !== actor.id) throw new HrError(404, "找不到可修改的加班申請。 ");
  if (current.status !== "pending") throw new HrError(409, "只有待審核的加班申請可以修改；已核准請先取消後重新申請。 ");
  if (current.revision !== input.revision) throw new HrError(409, "加班申請不存在或版本已過期，請重新整理。 ");
  if (current.archivedAt) throw new HrError(409, "員工任職已結束，無法修改加班申請。 ");
  if (input.employeeUserId !== current.employeeUserId) throw new HrError(400, "加班申請員工不可變更。 ");
  // 既有的補休申請（HR 代登或規則上線前送的）改時間時可以維持補休，但不能從付薪改成補休。
  if (input.settlementKind !== current.settlementKind) assertSelfServiceSettlement(input.settlementKind);

  const employmentId = await employmentForInterval(db, input.employeeUserId, input.requestedStart, input.requestedEnd, current.employmentId);
  const scopeId = input.scopeId ?? current.scopeId;
  await ensureScope(db, employmentId, scopeId, input.requestedStart, input.requestedEnd);
  const update = sql`UPDATE hr_overtime_requests SET
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
      ) RETURNING id`;
  const mutations = current.approverUserId ? [update, insertHrNotification({
    userId: current.approverUserId, sourceKey: `overtime-request:${id}:updated:${current.revision + 1}`, kind: "request_submitted", entityKind: "overtime", entityId: id,
    title: "加班申請已更新，請重新審核", body: `申請人已更新 ${taipeiDate(stamp(input.requestedStart))} 的加班申請。`,
  })] : update;
  try {
    return await writeHrMutation(db, mutations, id, actor, "overtime_request_updated", "加班申請已變更、時段重疊或資料不合法，請重新整理。 ");
  } catch (error) {
    if (error instanceof HrError) throw error;
    if (error instanceof Error && /UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed/.test(error.message)) throw new HrError(409, "加班申請已變更、時段重疊或資料不合法，請重新整理。 ");
    throw error;
  }
}

/**
 * 取消就是把申請刪掉，不留一列 cancelled：留著的列只會佔住時段、讓申請紀錄多出一堆
 * 不會再有人處理的資料。誰在什麼時候取消了哪一筆，由稽核事件的快照保存。
 * 快照放整列：核定的實際時段與審核資訊刪掉之後就只剩這裡查得到，薪資算的是實際時段。
 */
export async function cancelHrOvertimeRequest(db: Database, id: string, actor: HrActor, options: HrOvertimeCancellationOptions = {}) {
  const [employeeCurrent] = await db.select({ request: hrOvertimeRequests, employeeUserId: hrEmployments.employeeUserId, employeeName: hrEmployeeName })
    .from(hrOvertimeRequests)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId))
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(eq(hrOvertimeRequests.id, id)).limit(1);
  const current = employeeCurrent
    ? { ...employeeCurrent, personKind: "employee" as const, workerId: undefined }
    : await (async () => {
      const [worker] = await db.select({ request: hrWorkerOvertimeRequests, workerId: hrWorkerOvertimeRequests.workerId, employeeName: hrEmployments.legalName })
        .from(hrWorkerOvertimeRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrWorkerOvertimeRequests.workerId))
        .where(and(eq(hrWorkerOvertimeRequests.id, id), eq(hrEmployments.personKind, "worker"))).limit(1);
      return worker ? { ...worker, personKind: "worker" as const, employeeUserId: undefined } : null;
    })();
  if (!current) throw new HrError(404, "找不到加班申請。 ");
  if (!options.allowAny && current.employeeUserId !== actor.id) throw new HrError(404, "找不到可取消的加班申請。 ");
  const { request } = current;
  if (request.status !== "pending" && request.status !== "approved") throw new HrError(409, "加班申請不存在或已完成處理。 ");
  const tableName = current.personKind === "employee" ? "hr_overtime_requests" : "hr_worker_overtime_requests";
  const eventPayload = current.personKind === "employee" ? { employeeUserId: current.employeeUserId, ...request } : { workerId: current.workerId, ...request };
  const deletion = sql`DELETE FROM ${sql.raw(tableName)} WHERE id=${id} AND status=${request.status} RETURNING id`;
  const approverUserId = current.personKind === "employee" ? current.request.approverUserId : null;
  const batchId = current.personKind === "employee" ? current.request.batchId : null;
  const cancelledDate = taipeiDate(stamp(request.requestedStart));
  const cancelNotice = { userId: approverUserId ?? "", kind: "request_cancelled", entityKind: "overtime", title: "加班申請已取消", body: `申請人已取消 ${cancelledDate} 的待審加班申請。` } as const;
  const cancelNotification = request.status !== "pending" || !approverUserId ? null
    // 整批逐筆取消時只留一則，每取消一天接一行。
    : batchId ? appendHrNotification({ ...cancelNotice, sourceKey: overtimeBatchSourceKey(batchId, "cancelled"), entityId: batchId })
      : insertHrNotification({ ...cancelNotice, sourceKey: `overtime-request:${id}:cancelled`, entityId: id });
  const mutations = cancelNotification ? [deletion, cancelNotification] : deletion;
  return writeHrMutation(db, mutations, id, actor, "overtime_request_cancelled", "加班申請已變更或完成處理，請重新整理。 ", {
    activity: { entityLabel: current.employeeName, payload: eventPayload, summary: "加班申請已取消並刪除" },
  });
}

export async function cancelHrOvertimeRequests(db: Database, ids: string[], actor: HrActor) {
  if (!ids.length || ids.length > MAX_OVERTIME_CANCELLATION_ENTRIES || ids.some((id) => !id.trim() || id.length > 100) || new Set(ids).size !== ids.length) {
    throw new HrError(400, "加班申請清單格式不正確。 ");
  }

  const [employeeRows, workerRows] = await Promise.all([
    db.select({ request: hrOvertimeRequests, employeeUserId: hrEmployments.employeeUserId, employeeName: hrEmployeeName })
      .from(hrOvertimeRequests)
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId))
      .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
      .where(inJsonArray(hrOvertimeRequests.id, ids)),
    db.select({ request: hrWorkerOvertimeRequests, employeeName: hrEmployments.legalName })
      .from(hrWorkerOvertimeRequests)
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrWorkerOvertimeRequests.workerId))
      .where(and(inJsonArray(hrWorkerOvertimeRequests.id, ids), eq(hrEmployments.personKind, "worker"))),
  ]);
  const found = [...employeeRows.map(({ request }) => request), ...workerRows.map(({ request }) => request)];
  if (found.length !== ids.length) throw new HrError(404, "找不到完整的加班申請清單。 ");
  if (found.some((request) => request.status !== "approved")) throw new HrError(409, "只有已核准的加班申請可以批次取消，請重新整理後再試。 ");

  const employeeById = new Map(employeeRows.map(({ request, employeeUserId, employeeName }) => [request.id, { personKind: "employee" as const, employeeUserId, employeeName, ...request }]));
  const workerById = new Map(workerRows.map(({ request, employeeName }) => [request.id, { personKind: "worker" as const, employeeName, ...request }]));
  const snapshots = ids.map((id) => employeeById.get(id) ?? workerById.get(id)!);
  const employeeIds = employeeRows.map(({ request }) => request.id);
  const workerIds = workerRows.map(({ request }) => request.id);
  const deletions = [
    employeeIds.length ? sql`DELETE FROM hr_overtime_requests
      WHERE id IN (${jsonArrayValues(employeeIds)}) AND status='approved'
        AND (SELECT count(*) FROM hr_overtime_requests WHERE id IN (${jsonArrayValues(employeeIds)}) AND status='approved')=${employeeIds.length}
      RETURNING id` : null,
    workerIds.length ? sql`DELETE FROM hr_worker_overtime_requests
      WHERE id IN (${jsonArrayValues(workerIds)}) AND status='approved'
        AND (SELECT count(*) FROM hr_worker_overtime_requests WHERE id IN (${jsonArrayValues(workerIds)}) AND status='approved')=${workerIds.length}
      RETURNING id` : null,
  ].filter((statement): statement is NonNullable<typeof statement> => statement !== null);
  const summary = `批次取消並刪除 ${ids.length} 筆已核准加班申請`;
  await writeHrMutation(db, deletions, ids[0]!, actor, "overtime_requests_cancelled", "加班申請已變更或完成處理，請重新整理後再試。 ", {
    activity: { entityLabel: snapshots[0]!.employeeName ?? "加班申請", payload: { requestIds: ids, requests: snapshots }, summary },
  });
  return { ids, count: ids.length };
}

export async function reviewHrOvertimeRequest(db: Database, id: string, decision: "approved" | "rejected" | "cancelled", comment: string, actor: HrActor, actual?: HrOvertimeActualInterval, options: { allowAny?: boolean } = {}) {
  if (!["approved", "rejected", "cancelled"].includes(decision)) throw new HrError(400, "加班審核結果不正確。 ");
  if (comment.length > 1000) throw new HrError(400, "審核意見不可超過 1000 字。 ");
  if (decision === "cancelled") return cancelHrOvertimeRequest(db, id, actor, { allowAny: options.allowAny });
  if (decision === "rejected" && !comment.trim()) throw new HrError(400, "駁回加班申請時必須填寫審核意見。 ");
  const [employeeCurrent] = await db.select({ employeeUserId: hrEmployments.employeeUserId, employmentId: hrOvertimeRequests.employmentId, scopeId: hrOvertimeRequests.scopeId, status: hrOvertimeRequests.status, approverUserId: hrOvertimeRequests.approverUserId, batchId: hrOvertimeRequests.batchId, requestedStart: hrOvertimeRequests.requestedStart, requestedEnd: hrOvertimeRequests.requestedEnd })
    .from(hrOvertimeRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId)).where(eq(hrOvertimeRequests.id, id)).limit(1);
  const current = employeeCurrent
    ? { ...employeeCurrent, personKind: "employee" as const, workerId: undefined }
    : await (async () => {
      const [worker] = await db.select({ workerId: hrWorkerOvertimeRequests.workerId, status: hrWorkerOvertimeRequests.status, requestedStart: hrWorkerOvertimeRequests.requestedStart, requestedEnd: hrWorkerOvertimeRequests.requestedEnd })
        .from(hrWorkerOvertimeRequests).where(eq(hrWorkerOvertimeRequests.id, id)).limit(1);
      return worker ? { ...worker, personKind: "worker" as const, employeeUserId: undefined, employmentId: undefined, scopeId: null } : null;
    })();
  if (!current) throw new HrError(404, "找不到加班申請。 ");
  if (current.personKind === "employee" && current.employeeUserId === actor.id) throw new HrError(409, "申請人不可審核自己的加班申請。 ");
  if (!options.allowAny && (current.personKind === "worker" || current.approverUserId !== actor.id)) throw new HrError(404, "找不到指定給你的待審加班申請。 ");
  if (current.status !== "pending") throw new HrError(409, "加班申請不存在或已完成處理。 ");

  let actualStart: string | null = null;
  let actualEnd: string | null = null;
  if (decision === "approved") {
    actualStart = actual?.start ?? current.requestedStart;
    actualEnd = actual?.end ?? current.requestedEnd;
    const actualStartMs = stamp(actualStart);
    const actualEndMs = stamp(actualEnd);
    if (actualEndMs <= actualStartMs || (actualEndMs - actualStartMs) % (30 * 60 * 1000) !== 0 || actualStart < current.requestedStart || actualEnd > current.requestedEnd) throw new HrError(400, "核定加班實際時段必須以 0.5 小時為單位，且是申請時段內的完整區間。 ");
    if (current.personKind === "employee") {
      const actualEmploymentId = await employmentForInterval(db, current.employeeUserId!, actualStart, actualEnd, current.employmentId!);
      if (actualEmploymentId !== current.employmentId) throw new HrError(400, "核定加班實際時段的員工資料不一致。 ");
      await ensureScope(db, current.employmentId!, current.scopeId, actualStart, actualEnd);
    }
  }
  const update = current.personKind === "employee"
    ? sql`UPDATE hr_overtime_requests SET
      status=${decision}, actual_start=${actualStart}, actual_end=${actualEnd}, reviewed_by=${actor.id}, reviewed_at=CURRENT_TIMESTAMP, decision_reason=${comment.trim()}
      WHERE id=${id} AND status='pending' AND ${options.allowAny ? sql`1=1` : sql`approver_user_id=${actor.id}`} AND EXISTS (SELECT 1 FROM hr_employments WHERE id=hr_overtime_requests.employment_id AND employee_user_id <> ${actor.id}) RETURNING id`
    : sql`UPDATE hr_worker_overtime_requests SET
      status=${decision}, actual_start=${actualStart}, actual_end=${actualEnd}, reviewed_by=${actor.id}, reviewed_at=CURRENT_TIMESTAMP, decision_reason=${comment.trim()}
      WHERE id=${id} AND status='pending' AND ${options.allowAny ? 1 : 0}=1 RETURNING id`;
  const batchId = current.personKind === "employee" ? current.batchId : null;
  const reviewNotification = current.personKind !== "employee" ? null
    : batchId && decision === "approved"
      // 審核者只能一筆一筆核准；同一批的核准合成一則，每核准一天接一行，各自帶那一筆的審核意見。
      // 駁回各有各的理由、員工要個別處理，仍然一筆一則。
      ? appendHrNotification({
        userId: current.employeeUserId!, sourceKey: overtimeBatchSourceKey(batchId, "approved"), kind: "request_reviewed", entityKind: "overtime", entityId: batchId,
        title: "加班申請已核准", body: `${taipeiDate(stamp(current.requestedStart))} 已核准${comment.trim() ? `：${comment.trim()}` : "。"}`,
      })
      : insertHrNotification({
        userId: current.employeeUserId!, sourceKey: `overtime-request:${id}:reviewed:${decision}`, kind: "request_reviewed", entityKind: "overtime", entityId: id,
        title: decision === "approved" ? "加班申請已核准" : "加班申請已駁回",
        body: comment.trim() || (decision === "approved" ? "你的加班申請已完成核准。" : "請開啟申請紀錄查看處理結果。"),
      });
  const mutations = reviewNotification ? [update, reviewNotification] : update;
  await writeHrMutation(db, mutations, id, actor, "overtime_request_reviewed", "加班申請不存在、申請人不可自審或已完成處理。 ");
  return { id, status: decision };
}
