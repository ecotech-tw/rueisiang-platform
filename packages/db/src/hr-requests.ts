import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, hrEmployeeName, hrEmployeeNumberOrder, writeHrMutation, type HrActor } from "./hr-people.js";
import { insertHrNotification } from "./hr-notifications.js";
import { hrFormRequests } from "./schema/hr-requests.js";
import { hrEmployments } from "./schema/hr-people.js";
import { users } from "./schema/auth.js";

export type HrFormRequestStatus = "draft" | "pending" | "approved" | "rejected" | "cancelled";
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
  SELECT coalesce(
    nullif((SELECT employment.legal_name FROM hr_employments AS employment WHERE employment.id = ${hrFormRequests.employmentId}), ''),
    nullif(requester.display_name, ''), nullif(requester.google_name, ''), requester.email
  )
  FROM users AS requester WHERE requester.id = ${hrFormRequests.employeeUserId}
)`;
const approverName = sql<string | null>`(
  SELECT coalesce(
    nullif((SELECT employment.legal_name FROM hr_employments AS employment WHERE employment.employee_user_id = ${hrFormRequests.approverUserId} AND employment.archived_at IS NULL LIMIT 1), ''),
    nullif(approver.display_name, ''), nullif(approver.google_name, ''), approver.email
  )
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
  // 補打卡是補登已經發生的出勤；未來時間核准後會變成一筆還沒發生的正式打卡事件。
  if (timestamp > Date.now()) throw new HrError(400, "補打卡時間不可晚於現在。");
}

/**
 * 同一個人、同一種打卡、同一個時間點，只能有一張審核中或已核准的申請——不然核准兩次就是兩筆一樣的更正事件。
 * 比到時間而不是日期：兩段班的人一天會補兩次上班，那是兩張合理的申請。
 * 送出前的提示與 UPDATE 的 WHERE 都用這一份，規則只有一個來源。
 */
const conflictingRequestExists = (id: string) => sql<number>`EXISTS (
  SELECT 1 FROM hr_form_requests AS other
  WHERE other.id <> ${id} AND other.status IN ('pending', 'approved')
    AND other.employee_user_id = hr_form_requests.employee_user_id
    AND other.requested_event_kind = hr_form_requests.requested_event_kind
    AND other.requested_at = hr_form_requests.requested_at
)`;

async function employmentForActiveUser(db: Database, userId: string) {
  const [employment] = await db.select({ id: hrEmployments.id }).from(hrEmployments)
    .where(and(eq(hrEmployments.employeeUserId, userId), sql`${hrEmployments.archivedAt} IS NULL`)).limit(1);
  if (!employment) throw new HrError(400, "尚未指派為目前員工，無法建立申請單。");
  return employment.id;
}

async function employeeSupervisor(db: Database, userId: string) {
  const [employee] = await db.select({ supervisorUserId: hrEmployments.supervisorUserId }).from(hrEmployments)
    .where(and(eq(hrEmployments.employeeUserId, userId), sql`${hrEmployments.archivedAt} IS NULL`)).limit(1);
  if (!employee) throw new HrError(400, "尚未指派為員工，無法建立申請單。");
  return employee.supervisorUserId;
}

async function ensureApprover(db: Database, employeeUserId: string, approverUserId: string | null) {
  if (!approverUserId) return;
  if (approverUserId === employeeUserId) throw new HrError(400, "審核者不可指定自己。");
  const [approver] = await db.select({ id: hrEmployments.employeeUserId }).from(hrEmployments)
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(and(eq(hrEmployments.employeeUserId, approverUserId), sql`${hrEmployments.archivedAt} IS NULL`, eq(users.status, "active"))).limit(1);
  if (!approver) throw new HrError(400, "審核者必須是啟用中的員工。");
}

export async function listHrFormApprovers(db: Database, userId: string) {
  const [supervisor] = await db.select({ supervisorUserId: hrEmployments.supervisorUserId }).from(hrEmployments)
    .where(and(eq(hrEmployments.employeeUserId, userId), sql`${hrEmployments.archivedAt} IS NULL`)).limit(1);
  const approvers = await db.select({ id: hrEmployments.employeeUserId, name: hrEmployeeName, employeeNumber: hrEmployments.employeeNumber })
    .from(hrEmployments).innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(and(ne(hrEmployments.employeeUserId, userId), sql`${hrEmployments.archivedAt} IS NULL`, eq(users.status, "active")))
    .orderBy(...hrEmployeeNumberOrder(), asc(hrEmployeeName), asc(users.email));
  return { approvers, defaultApproverUserId: supervisor?.supervisorUserId ?? null };
}

export async function listHrFormRequests(db: Database, userId: string, allowAny = false) {
  const requests = await db.select(formFields).from(hrFormRequests)
    .where(eq(hrFormRequests.employeeUserId, userId)).orderBy(desc(hrFormRequests.createdAt));
  const reviewRequests = await db.select(formFields).from(hrFormRequests)
    .where(and(eq(hrFormRequests.status, "pending"), ne(hrFormRequests.employeeUserId, userId), allowAny ? undefined : eq(hrFormRequests.approverUserId, userId)))
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
  const employmentId = await employmentForActiveUser(db, input.employeeUserId);
  const defaultApprover = await employeeSupervisor(db, input.employeeUserId);
  const approverUserId = input.approverUserId ?? defaultApprover;
  await ensureApprover(db, input.employeeUserId, approverUserId);
  const id = crypto.randomUUID();
  return writeHrMutation(db, sql`INSERT INTO hr_form_requests
    (id, employee_user_id, employment_id, form_kind, status, correction_date, requested_event_kind, requested_at, reason, approver_user_id)
    VALUES (${id}, ${input.employeeUserId}, ${employmentId}, 'clock_correction', 'draft', ${input.correctionDate}, ${input.requestedEventKind}, ${input.requestedAt}, ${input.reason}, ${approverUserId})
    RETURNING id`, id, actor, "hr_form_request_created", "申請單資料不合法，請重新確認。");
}

export type HrSelfClockCorrectionInput = Omit<HrFormRequestInput, "approverUserId">;

/**
 * 本人補打卡「送出前先看看行不行」：時間合法、目前在職、有直屬主管可以審。不寫入。
 * 不看原因：原因必填由資料表的 CHECK 把關，而呼叫端在時間還沒問完、原因還沒問到時就需要這個檢查。
 * 同一個時間點有沒有重複的申請要等送出才知道（那個檢查在 UPDATE 的 WHERE 裡），這裡不重做一份。
 */
export async function checkHrSelfClockCorrection(db: Database, input: HrSelfClockCorrectionInput): Promise<void> {
  validateRequestedAt(input.correctionDate, input.requestedAt);
  await employmentForActiveUser(db, input.employeeUserId);
  const approverUserId = await employeeSupervisor(db, input.employeeUserId);
  // HR 頁面可以讓員工自己挑審核者；對話裡不問這個，所以沒有直屬主管的人請他回表單處理。
  if (!approverUserId) throw new HrError(400, "你沒有設定直屬主管，請到 HR 頁面的補打卡申請自行指定審核者。");
  await ensureApprover(db, input.employeeUserId, approverUserId);
}

/**
 * 建立補打卡申請並立刻送出，審核者是直屬主管。
 *
 * HR 頁面是「存草稿、再送出」兩步，因為員工會在表單上停留；對話的草稿存在小香那邊，確認時一次做完，
 * 走的仍是同一對 createHrFormRequest／submitHrFormRequest。送出被擋（例如同一個時間點已經有一張）時
 * 把剛建立的那一列刪掉，不在員工的 HR 頁面留下一張他不知道的草稿。
 *
 * 兩步不在同一個 transaction 裡，清不乾淨的情況都偏向「多留一張 HR 頁面看得到的草稿」，不會多出一張待審申請：
 * - 建立之後、送出之前中斷，或送出失敗後刪除也失敗：HR 頁面留下一張 draft，員工可以在那裡送出或刪掉。
 * - 送出其實已經寫入、呼叫端卻收到錯誤：刪除會因為狀態已是 pending 而被擋，那張待審申請留著；
 *   員工重送同一個時間點時，會被「同一個時間點已有一張」擋下來，不會變成兩張。
 */
export async function createAndSubmitHrClockCorrection(db: Database, input: HrSelfClockCorrectionInput, actor: HrActor): Promise<{ id: string }> {
  const created = await createHrFormRequest(db, { ...input, approverUserId: null }, actor);
  try {
    await submitHrFormRequest(db, created.id, input.employeeUserId, actor);
  } catch (error) {
    await deleteHrFormRequestDraft(db, created.id, input.employeeUserId, actor).catch(() => undefined);
    throw error;
  }
  return { id: created.id };
}

export async function updateHrFormRequest(db: Database, id: string, employeeUserId: string, input: Omit<HrFormRequestInput, "employeeUserId">, actor: HrActor) {
  const [current] = await db.select({ status: hrFormRequests.status }).from(hrFormRequests)
    .where(and(eq(hrFormRequests.id, id), eq(hrFormRequests.employeeUserId, employeeUserId))).limit(1);
  if (!current) throw new HrError(404, "找不到這份申請單。");
  if (current.status !== "draft") throw new HrError(409, "申請中的表單不能再修改。");
  validateRequestedAt(input.correctionDate, input.requestedAt);
  const employmentId = await employmentForActiveUser(db, employeeUserId);
  await ensureApprover(db, employeeUserId, input.approverUserId);
  return writeHrMutation(db, sql`UPDATE hr_form_requests SET
    employment_id=${employmentId}, correction_date=${input.correctionDate}, requested_event_kind=${input.requestedEventKind},
    requested_at=${input.requestedAt}, reason=${input.reason}, approver_user_id=${input.approverUserId}, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND employee_user_id=${employeeUserId} AND status='draft' RETURNING id`, id, actor, "hr_form_request_updated", "申請單已變更或資料不合法，請重新整理。");
}

export async function submitHrFormRequest(db: Database, id: string, employeeUserId: string, actor: HrActor) {
  const [current] = await db.select({ status: hrFormRequests.status, approverUserId: hrFormRequests.approverUserId, correctionDate: hrFormRequests.correctionDate, requestedAt: hrFormRequests.requestedAt, conflict: conflictingRequestExists(id) })
    .from(hrFormRequests).where(and(eq(hrFormRequests.id, id), eq(hrFormRequests.employeeUserId, employeeUserId))).limit(1);
  if (!current) throw new HrError(404, "找不到這份申請單。");
  if (current.status !== "draft") throw new HrError(409, "這份申請單已送出，不能重複送出。");
  // 草稿可能是這條檢查上線前存的，或存了之後才放到過期；送出時再驗一次。
  validateRequestedAt(current.correctionDate, current.requestedAt);
  const approverUserId = current.approverUserId ?? await employeeSupervisor(db, employeeUserId);
  if (!approverUserId) throw new HrError(400, "送出前請指定審核者。");
  await ensureApprover(db, employeeUserId, approverUserId);
  if (current.conflict) throw new HrError(409, "同一個時間點已有一張審核中或已核准的補打卡申請，請改時間，或先取消審核中的那一張。");
  // 上面只為了給出看得懂的訊息；真正擋住同時送出兩張的是 WHERE 裡的同一個條件。
  const update = sql`UPDATE hr_form_requests SET
    status='pending', approver_user_id=${approverUserId}, submitted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND employee_user_id=${employeeUserId} AND status='draft' AND NOT ${conflictingRequestExists(id)} RETURNING id`;
  const mutations = [update, insertHrNotification({
    userId: approverUserId, sourceKey: `clock-correction:${id}:submitted`, kind: "request_submitted", entityKind: "clock_correction", entityId: id,
    title: "有新的補打卡申請待審核", body: `申請日期：${current.correctionDate}，請開啟待審清單處理。`,
  })];
  return writeHrMutation(db, mutations, id, actor, "hr_form_request_submitted", "申請單已變更，請重新整理後再送出。");
}

/** 取消只開放審核中的申請：已核准的已經產生 append-only 打卡事件，不能靠改狀態收回。 */
export async function cancelHrFormRequest(db: Database, id: string, employeeUserId: string, actor: HrActor) {
  const [current] = await db.select({ status: hrFormRequests.status }).from(hrFormRequests)
    .where(and(eq(hrFormRequests.id, id), eq(hrFormRequests.employeeUserId, employeeUserId))).limit(1);
  if (!current) throw new HrError(404, "找不到這份申請單。");
  if (current.status !== "pending") throw new HrError(409, "只有審核中的申請單可以取消。");
  const update = sql`UPDATE hr_form_requests SET status='cancelled', updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND employee_user_id=${employeeUserId} AND status='pending' RETURNING id`;
  const [request] = await db.select({ approverUserId: hrFormRequests.approverUserId }).from(hrFormRequests).where(eq(hrFormRequests.id, id)).limit(1);
  const mutations = request?.approverUserId ? [update, insertHrNotification({
    userId: request.approverUserId, sourceKey: `clock-correction:${id}:cancelled`, kind: "request_cancelled", entityKind: "clock_correction", entityId: id,
    title: "補打卡申請已取消", body: "申請人已取消一筆待審補打卡申請。",
  })] : update;
  return writeHrMutation(db, mutations, id, actor, "hr_form_request_cancelled", "申請單已被審核或變更，請重新整理。");
}

/** 草稿沒有送出過、審核者也沒看過，直接刪除；送出過的申請一律保留成紀錄。 */
export async function deleteHrFormRequestDraft(db: Database, id: string, employeeUserId: string, actor: HrActor) {
  const [current] = await db.select({ status: hrFormRequests.status }).from(hrFormRequests)
    .where(and(eq(hrFormRequests.id, id), eq(hrFormRequests.employeeUserId, employeeUserId))).limit(1);
  if (!current) throw new HrError(404, "找不到這份申請單。");
  if (current.status !== "draft") throw new HrError(409, "已送出的申請單不能刪除。");
  return writeHrMutation(db, sql`DELETE FROM hr_form_requests
    WHERE id=${id} AND employee_user_id=${employeeUserId} AND status='draft' RETURNING id`, id, actor, "hr_form_request_deleted", "申請單已變更，請重新整理。");
}

export async function reviewHrFormRequest(db: Database, id: string, reviewerUserId: string, decision: "approved" | "rejected", comment: string, allowAny: boolean, actor: HrActor) {
  const [current] = await db.select({ employeeUserId: hrFormRequests.employeeUserId, employmentId: hrFormRequests.employmentId, status: hrFormRequests.status, approverUserId: hrFormRequests.approverUserId, correctionDate: hrFormRequests.correctionDate, requestedEventKind: hrFormRequests.requestedEventKind, requestedAt: hrFormRequests.requestedAt, reason: hrFormRequests.reason, correctedClockEventId: hrFormRequests.correctedClockEventId })
    .from(hrFormRequests).where(eq(hrFormRequests.id, id)).limit(1);
  if (!current) throw new HrError(404, "找不到這份申請單。");
  if (current.employeeUserId === reviewerUserId) throw new HrError(409, "申請人不可審核自己的申請單。");
  if (!allowAny && current.approverUserId !== reviewerUserId) throw new HrError(404, "找不到這份待審核申請單。");
  if (current.status === "cancelled") throw new HrError(409, "這份申請單已由申請人取消。");
  if (current.status !== "pending") throw new HrError(409, "這份申請單已經完成審核。");
  // 這條檢查上線前送出的申請可能帶著未來時間；核准會把它變成正式打卡事件，所以在這裡擋，駁回不受影響。
  if (decision === "approved") validateRequestedAt(current.correctionDate, current.requestedAt);
  // 封存只阻止新的申請，不阻止核准既有的補打卡歷史；事件仍指向原 employmentId。
  const reviewWhere = sql`id=${id} AND status='pending' ${allowAny ? sql`` : sql`AND approver_user_id=${reviewerUserId}`}`;
  if (decision === "approved") {
    const eventId = crypto.randomUUID();
    const update = sql`UPDATE hr_form_requests SET
      status='approved', corrected_clock_event_id=${eventId}, reviewed_at=CURRENT_TIMESTAMP, review_comment=${comment.trim()}, updated_at=CURRENT_TIMESTAMP
      WHERE ${reviewWhere} AND corrected_clock_event_id IS NULL RETURNING id`;
    await writeHrMutation(db, [
      sql`INSERT INTO hr_clock_events
        (id, employee_user_id, employment_id, source_kind, idempotency_key, correction_request_id, event_kind, recorded_by, manual_reason, occurred_at, received_at)
        SELECT ${eventId}, ${current.employeeUserId}, ${current.employmentId}, 'manual', ${`form-correction:${id}`}, ${id}, ${current.requestedEventKind}, ${reviewerUserId}, ${current.reason}, ${current.requestedAt}, CURRENT_TIMESTAMP
        FROM hr_form_requests
        WHERE ${reviewWhere} AND corrected_clock_event_id IS NULL RETURNING id`,
      update,
      insertHrNotification({
        userId: current.employeeUserId, sourceKey: `clock-correction:${id}:reviewed:approved`, kind: "request_reviewed", entityKind: "clock_correction", entityId: id,
        title: "補打卡申請已核准", body: comment.trim() || "正式打卡紀錄已建立，請回到出勤日曆查看。",
      }),
    ], id, actor, "hr_form_request_reviewed", "申請單已被其他人處理，請重新整理。 ");
  } else {
    await writeHrMutation(db, [
      sql`UPDATE hr_form_requests SET
        status=${decision}, reviewed_at=CURRENT_TIMESTAMP, review_comment=${comment.trim()}, updated_at=CURRENT_TIMESTAMP
        WHERE ${reviewWhere} RETURNING id`,
      insertHrNotification({
        userId: current.employeeUserId, sourceKey: `clock-correction:${id}:reviewed:${decision}`, kind: "request_reviewed", entityKind: "clock_correction", entityId: id,
        title: "補打卡申請已駁回", body: comment.trim() || "請開啟申請紀錄查看審核意見。",
      }),
    ], id, actor, "hr_form_request_reviewed", "申請單已被其他人處理，請重新整理。 ");
  }
  return { id, status: decision };
}
