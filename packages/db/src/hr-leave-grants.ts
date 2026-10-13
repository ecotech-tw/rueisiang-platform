import { and, asc, count, desc, eq, isNull, like, lt, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, hrEmployeeName, hrEmployeeNumberOrder, writeHrMutation, type HrActor } from "./hr-people.js";
import { formatTaipeiDate } from "./taipei-time.js";
import { hrEmployments } from "./schema/hr-people.js";
import { hrLeaveGrantBatches, hrLeaveGrantLedger, hrLeaveGrants, hrLeaveRequests, hrLeaveTypes } from "./schema/hr-payroll.js";
import { users } from "./schema/auth.js";

const employeeName = hrEmployeeName;
const MAX_GRANT_MINUTES = 60 * 24 * 365;

export const HR_LEAVE_GRANT_PAGE_SIZES = [10, 25, 50, 100] as const;

export interface HrLeaveGrantListQuery {
  page: number;
  pageSize: number;
  search: string;
  leaveTypeId: string | null;
  expiry: "unexpired" | "expired" | "all";
  asOfDate: string;
}

export interface HrLeaveGrantInput {
  leaveTypeId: string;
  employmentIds: string[];
  issuedOn: string;
  expiresOn: string;
  amountMinutes: number;
  note: string;
}

export interface HrLeaveGrantCredit {
  grantId: string;
  issuedOn: string;
  expiresOn: string;
  amountMinutes: number;
  balanceMinutes: number;
}

export interface HrLeaveGrantAllocationInput {
  employmentId: string;
  leaveTypeId: string;
  startsOn: string;
  /** 請假 endsOn 是半開區間，最後使用日為它的前一天。 */
  endsOn: string;
  durationMinutes: number;
}

export interface HrLeaveGrantAllocation {
  grantId: string;
  amountMinutes: number;
  balanceMinutes: number;
  expiresOn: string;
}

function assertDate(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HrError(400, `${label}格式不正確。`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new HrError(400, `${label}不是有效日期。`);
}

function lastIncludedDate(endExclusive: string) {
  const date = new Date(`${endExclusive}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export async function listHrLeaveGrantEmployees(db: Database) {
  return db.select({
    employmentId: hrEmployments.id,
    employeeUserId: hrEmployments.employeeUserId,
    employeeNumber: hrEmployments.employeeNumber,
    employeeName,
  }).from(hrEmployments)
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(and(eq(hrEmployments.personKind, "employee"), isNull(hrEmployments.archivedAt), eq(users.status, "active")))
    .orderBy(...hrEmployeeNumberOrder(), asc(employeeName));
}

export async function createHrLeaveGrantBatch(db: Database, input: HrLeaveGrantInput, actor: HrActor) {
  assertDate(input.issuedOn, "發放日期");
  assertDate(input.expiresOn, "使用期限");
  if (input.expiresOn < input.issuedOn) throw new HrError(400, "使用期限不可早於發放日期。");
  if (!Number.isSafeInteger(input.amountMinutes) || input.amountMinutes < 60 || input.amountMinutes > MAX_GRANT_MINUTES || input.amountMinutes % 60 !== 0) {
    throw new HrError(400, "發放時數必須是 1 小時的整數倍，且不可超過 8760 小時。");
  }
  if (!input.employmentIds.length || input.employmentIds.length > 100 || new Set(input.employmentIds).size !== input.employmentIds.length) {
    throw new HrError(400, "請選擇 1～100 位不重複的在職員工。");
  }
  if (input.note.length > 1000) throw new HrError(400, "備註不可超過 1000 字。");
  const [leaveType] = await db.select({ id: hrLeaveTypes.id }).from(hrLeaveTypes)
    .where(and(eq(hrLeaveTypes.id, input.leaveTypeId), eq(hrLeaveTypes.leaveKind, "grant"), eq(hrLeaveTypes.active, 1))).limit(1);
  if (!leaveType) throw new HrError(404, "找不到啟用中且使用額度發放的假別。");
  const employees = await db.select({ id: hrEmployments.id }).from(hrEmployments)
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(and(sql`${hrEmployments.id} IN (SELECT value FROM json_each(${JSON.stringify(input.employmentIds)}))`, eq(hrEmployments.personKind, "employee"), isNull(hrEmployments.archivedAt), eq(users.status, "active")));
  if (employees.length !== input.employmentIds.length) throw new HrError(409, "部分員工已非在職狀態，請重新選擇發放對象。");

  const batchId = crypto.randomUUID();
  const entries = input.employmentIds.map((employmentId) => ({ grantId: crypto.randomUUID(), ledgerId: crypto.randomUUID(), employmentId }));
  const serialized = JSON.stringify(entries);
  return writeHrMutation(db, [
    sql`INSERT INTO hr_leave_grant_batches (id, leave_type_id, issued_on, expires_on, amount_minutes, note, created_by)
      SELECT ${batchId}, ${input.leaveTypeId}, ${input.issuedOn}, ${input.expiresOn}, ${input.amountMinutes}, ${input.note.trim()}, ${actor.id}
      WHERE EXISTS (SELECT 1 FROM hr_leave_types WHERE id=${input.leaveTypeId} AND leave_kind='grant' AND active=1)
        AND (SELECT count(*) FROM hr_employments AS employment INNER JOIN users AS employee ON employee.id=employment.employee_user_id
          WHERE employment.id IN (SELECT json_extract(value, '$.employmentId') FROM json_each(${serialized}))
            AND employment.person_kind='employee' AND employment.archived_at IS NULL AND employee.status='active') = ${entries.length}
      RETURNING id`,
    sql`INSERT INTO hr_leave_grants (id, batch_id, employment_id, status)
      SELECT json_extract(value, '$.grantId'), ${batchId}, json_extract(value, '$.employmentId'), 'active'
      FROM json_each(${serialized}) WHERE EXISTS (SELECT 1 FROM hr_leave_grant_batches WHERE id=${batchId})
      RETURNING id`,
    sql`INSERT INTO hr_leave_grant_ledger (id, grant_id, entry_kind, delta_minutes, source_key, leave_request_id, note, created_by)
      SELECT json_extract(value, '$.ledgerId'), json_extract(value, '$.grantId'), 'grant', ${input.amountMinutes}, 'leave-grant:' || json_extract(value, '$.grantId'), NULL, ${input.note.trim()}, ${actor.id}
      FROM json_each(${serialized}) WHERE EXISTS (SELECT 1 FROM hr_leave_grants WHERE id=json_extract(value, '$.grantId'))
      RETURNING id`,
  ], batchId, actor, "hr_leave_grant_batch_created", "發放批次或員工資料已變更，請重新整理後再試。", {
    activity: { summary: `發放 ${entries.length} 位員工各 ${input.amountMinutes / 60} 小時額度`, payload: { leaveTypeId: input.leaveTypeId, employmentCount: entries.length, amountMinutes: input.amountMinutes, issuedOn: input.issuedOn, expiresOn: input.expiresOn } },
  });
}

export async function listHrLeaveGrantBatches(db: Database, input: HrLeaveGrantListQuery) {
  const search = input.search.trim();
  const conditions: SQL[] = [];
  if (input.expiry === "unexpired") conditions.push(sql`${hrLeaveGrantBatches.expiresOn} >= ${input.asOfDate}`);
  if (input.expiry === "expired") conditions.push(lt(hrLeaveGrantBatches.expiresOn, input.asOfDate));
  if (input.leaveTypeId) conditions.push(eq(hrLeaveTypes.id, input.leaveTypeId));
  if (search) {
    const pattern = `%${search}%`;
    const matches = or(
      like(hrLeaveTypes.name, pattern),
      like(hrEmployments.employeeNumber, pattern),
      like(hrEmployments.legalName, pattern),
      like(users.displayName, pattern),
      like(users.googleName, pattern),
      like(hrLeaveGrantBatches.note, pattern),
    );
    if (matches) conditions.push(matches);
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const [rows, [totalRow]] = await Promise.all([
    db.select({
      id: hrLeaveGrants.id,
      batchId: hrLeaveGrantBatches.id,
      leaveTypeId: hrLeaveTypes.id,
      leaveType: hrLeaveTypes.name,
      employmentId: hrEmployments.id,
      employeeUserId: hrEmployments.employeeUserId,
      employeeNumber: hrEmployments.employeeNumber,
      employeeName,
      issuedOn: hrLeaveGrantBatches.issuedOn,
      expiresOn: hrLeaveGrantBatches.expiresOn,
      amountMinutes: hrLeaveGrantBatches.amountMinutes,
      balanceMinutes: sql<number>`coalesce((SELECT sum(ledger.delta_minutes) FROM hr_leave_grant_ledger AS ledger WHERE ledger.grant_id=${hrLeaveGrants.id}), 0)`,
      usedMinutes: sql<number>`coalesce((SELECT sum(CASE WHEN ledger.entry_kind IN ('leave_request', 'leave_request_reversal') THEN -ledger.delta_minutes ELSE 0 END) FROM hr_leave_grant_ledger AS ledger WHERE ledger.grant_id=${hrLeaveGrants.id}), 0)`,
      note: hrLeaveGrantBatches.note,
      status: hrLeaveGrants.status,
      revokedAt: hrLeaveGrants.revokedAt,
      createdAt: hrLeaveGrantBatches.createdAt,
    }).from(hrLeaveGrants)
      .innerJoin(hrLeaveGrantBatches, eq(hrLeaveGrantBatches.id, hrLeaveGrants.batchId))
      .innerJoin(hrLeaveTypes, eq(hrLeaveTypes.id, hrLeaveGrantBatches.leaveTypeId))
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveGrants.employmentId))
      .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
      .where(where).orderBy(desc(hrLeaveGrantBatches.createdAt), ...hrEmployeeNumberOrder(), asc(employeeName), asc(hrLeaveGrants.id))
      .limit(input.pageSize).offset((input.page - 1) * input.pageSize),
    db.select({ value: count() }).from(hrLeaveGrants)
      .innerJoin(hrLeaveGrantBatches, eq(hrLeaveGrantBatches.id, hrLeaveGrants.batchId))
      .innerJoin(hrLeaveTypes, eq(hrLeaveTypes.id, hrLeaveGrantBatches.leaveTypeId))
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveGrants.employmentId))
      .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
      .where(where),
  ]);
  const total = Number(totalRow?.value ?? 0);
  return { grants: rows, total, page: input.page, pageSize: input.pageSize, hasMore: input.page * input.pageSize < total };
}

export async function listHrSelfLeaveGrantCredits(db: Database, employeeUserId: string, asOfDate = formatTaipeiDate(Date.now()), leaveTypeId?: string): Promise<HrLeaveGrantCredit[]> {
  assertDate(asOfDate, "額度查詢日期");
  const rows = await db.select({
    grantId: hrLeaveGrants.id,
    issuedOn: hrLeaveGrantBatches.issuedOn,
    expiresOn: hrLeaveGrantBatches.expiresOn,
    amountMinutes: hrLeaveGrantBatches.amountMinutes,
    balanceMinutes: sql<number>`coalesce((SELECT sum(ledger.delta_minutes) FROM hr_leave_grant_ledger AS ledger WHERE ledger.grant_id=${hrLeaveGrants.id}), 0)`,
  }).from(hrLeaveGrants)
    .innerJoin(hrLeaveGrantBatches, eq(hrLeaveGrantBatches.id, hrLeaveGrants.batchId))
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveGrants.employmentId))
    .where(and(
      eq(hrEmployments.employeeUserId, employeeUserId),
      isNull(hrEmployments.archivedAt),
      eq(hrLeaveGrants.status, "active"),
      leaveTypeId ? eq(hrLeaveGrantBatches.leaveTypeId, leaveTypeId) : undefined,
      sql`${hrLeaveGrantBatches.issuedOn} <= ${asOfDate}`,
      sql`${hrLeaveGrantBatches.expiresOn} >= ${asOfDate}`,
    )).orderBy(asc(hrLeaveGrantBatches.expiresOn), asc(hrLeaveGrantBatches.issuedOn), asc(hrLeaveGrants.createdAt));
  return rows.map((row) => ({ ...row, balanceMinutes: Number(row.balanceMinutes) }));
}

export async function allocateHrLeaveGrant(db: Database, input: HrLeaveGrantAllocationInput): Promise<HrLeaveGrantAllocation[]> {
  assertDate(input.startsOn, "請假開始日期");
  assertDate(input.endsOn, "請假結束日期");
  if (input.endsOn <= input.startsOn || !Number.isSafeInteger(input.durationMinutes) || input.durationMinutes <= 0 || input.durationMinutes % 60 !== 0) {
    throw new HrError(400, "此假別請假時數必須是 1 小時的整數倍。");
  }
  const lastDay = lastIncludedDate(input.endsOn);
  const grants = await db.select({
    grantId: hrLeaveGrants.id,
    issuedOn: hrLeaveGrantBatches.issuedOn,
    expiresOn: hrLeaveGrantBatches.expiresOn,
    balanceMinutes: sql<number>`coalesce((SELECT sum(ledger.delta_minutes) FROM hr_leave_grant_ledger AS ledger WHERE ledger.grant_id=${hrLeaveGrants.id}), 0)`,
  }).from(hrLeaveGrants)
    .innerJoin(hrLeaveGrantBatches, eq(hrLeaveGrantBatches.id, hrLeaveGrants.batchId))
    .innerJoin(hrLeaveTypes, eq(hrLeaveTypes.id, hrLeaveGrantBatches.leaveTypeId))
    .where(and(
      eq(hrLeaveGrants.employmentId, input.employmentId),
      eq(hrLeaveGrants.status, "active"),
      eq(hrLeaveTypes.id, input.leaveTypeId),
      eq(hrLeaveTypes.leaveKind, "grant"),
      eq(hrLeaveTypes.active, 1),
      sql`${hrLeaveGrantBatches.issuedOn} <= ${input.startsOn}`,
      sql`${hrLeaveGrantBatches.expiresOn} >= ${lastDay}`,
    )).orderBy(asc(hrLeaveGrantBatches.expiresOn), asc(hrLeaveGrantBatches.issuedOn), asc(hrLeaveGrants.createdAt), asc(hrLeaveGrants.id));
  const eligible = grants.map((grant) => ({ ...grant, balanceMinutes: Number(grant.balanceMinutes) })).filter((grant) => grant.balanceMinutes > 0);
  if (!eligible.length) throw new HrError(409, "所選日期沒有已發放且尚未過期的額度。");
  let remaining = input.durationMinutes;
  const allocations: HrLeaveGrantAllocation[] = [];
  for (const grant of eligible) {
    if (remaining <= 0) break;
    const allocated = Math.min(remaining, grant.balanceMinutes);
    if (allocated > 0) allocations.push({ grantId: grant.grantId, amountMinutes: allocated, balanceMinutes: grant.balanceMinutes, expiresOn: grant.expiresOn });
    remaining -= allocated;
  }
  if (remaining > 0) throw new HrError(409, "所選日期沒有足夠且尚未過期的可用額度。");
  return allocations;
}

export async function revokeHrLeaveGrant(db: Database, grantId: string, actor: HrActor) {
  const [grant] = await db.select({ id: hrLeaveGrants.id, status: hrLeaveGrants.status, employmentId: hrLeaveGrants.employmentId, leaveTypeId: hrLeaveGrantBatches.leaveTypeId }).from(hrLeaveGrants)
    .innerJoin(hrLeaveGrantBatches, eq(hrLeaveGrantBatches.id, hrLeaveGrants.batchId)).where(eq(hrLeaveGrants.id, grantId)).limit(1);
  if (!grant) throw new HrError(404, "找不到額度發放紀錄。");
  if (grant.status !== "active") throw new HrError(409, "這筆額度已撤銷。");
  const [pendingRequest] = await db.select({ id: hrLeaveRequests.id }).from(hrLeaveRequests).where(and(
    eq(hrLeaveRequests.employmentId, grant.employmentId),
    eq(hrLeaveRequests.leaveTypeId, grant.leaveTypeId),
    eq(hrLeaveRequests.status, "pending"),
  )).limit(1);
  if (pendingRequest) throw new HrError(409, "這位員工有待審的同類假別申請，請先完成審核再撤銷額度。");
  const [balanceRow] = await db.select({ balanceMinutes: sql<number>`coalesce(sum(${hrLeaveGrantLedger.deltaMinutes}), 0)` }).from(hrLeaveGrantLedger).where(eq(hrLeaveGrantLedger.grantId, grantId));
  const balance = Number(balanceRow?.balanceMinutes ?? 0);
  if (balance < 0) throw new HrError(409, "額度台帳餘額異常，無法撤銷。");
  const sourceKey = `leave-grant-revocation:${grantId}`;
  const statements = balance > 0 ? [
    sql`INSERT INTO hr_leave_grant_ledger (id, grant_id, entry_kind, delta_minutes, source_key, note, created_by)
      SELECT ${crypto.randomUUID()}, ${grantId}, 'revocation', ${-balance}, ${sourceKey}, '撤銷未使用額度', ${actor.id}
      WHERE EXISTS (SELECT 1 FROM hr_leave_grants WHERE id=${grantId} AND status='active')
        AND coalesce((SELECT sum(delta_minutes) FROM hr_leave_grant_ledger WHERE grant_id=${grantId}), 0) = ${balance}
        AND NOT EXISTS (SELECT 1 FROM hr_leave_grant_ledger WHERE source_key=${sourceKey})
        AND NOT EXISTS (SELECT 1 FROM hr_leave_requests WHERE employment_id=${grant.employmentId} AND leave_type_id=${grant.leaveTypeId} AND status='pending')
      RETURNING id`,
    sql`UPDATE hr_leave_grants SET status='revoked', revoked_at=CURRENT_TIMESTAMP, revoked_by=${actor.id}
      WHERE id=${grantId} AND status='active' AND EXISTS (SELECT 1 FROM hr_leave_grant_ledger WHERE source_key=${sourceKey}) RETURNING id`,
  ] : [sql`UPDATE hr_leave_grants SET status='revoked', revoked_at=CURRENT_TIMESTAMP, revoked_by=${actor.id}
      WHERE id=${grantId} AND status='active'
        AND coalesce((SELECT sum(delta_minutes) FROM hr_leave_grant_ledger WHERE grant_id=${grantId}), 0) = 0
        AND NOT EXISTS (SELECT 1 FROM hr_leave_requests WHERE employment_id=${grant.employmentId} AND leave_type_id=${grant.leaveTypeId} AND status='pending')
      RETURNING id`];
  return writeHrMutation(db, statements, grantId, actor, "hr_leave_grant_revoked", "額度已變更或已撤銷，請重新整理後再試。", { activity: { summary: "撤銷尚未使用的假別額度" } });
}
