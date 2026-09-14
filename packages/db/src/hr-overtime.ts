import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { HrError, type HrActor } from "./hr-people.js";
import { activityEvents } from "./schema/activity.js";
import { hrEmployees, hrEmployments } from "./schema/hr-people.js";
import { hrOvertimeRequests } from "./schema/hr-scheduling.js";
import { users } from "./schema/auth.js";

export interface HrOvertimeInput { employeeUserId: string; scopeId?: string | null; requestedStart: string; requestedEnd: string; settlementKind: "pay" | "compensatory"; ratePpm: number; reason: string }
function stamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new HrError(400, "加班時間必須是 YYYY-MM-DD HH:mm:ss。 ");
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19).replace("T", " ") !== value) throw new HrError(400, "加班時間不是有效日期。 ");
}
async function employmentForDate(db: Database, userId: string, stampValue: string) {
  const date = stampValue.slice(0, 10);
  const [row] = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(eq(hrEmployments.employeeUserId, userId), sql`${hrEmployments.hiredOn} <= ${date}`, sql`(${hrEmployments.endedOn} IS NULL OR ${hrEmployments.endedOn} > ${date})`)).orderBy(desc(hrEmployments.hiredOn)).limit(1);
  if (!row) throw new HrError(400, "加班日期不在有效任職期間。 "); return row.id;
}
const fields = { request: hrOvertimeRequests, employeeNumber: hrEmployees.employeeNumber, employeeName: sql<string | null>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})` };
export async function listHrOvertimeRequests(db: Database, employeeUserId?: string) {
  return db.select(fields).from(hrOvertimeRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId)).innerJoin(hrEmployees, eq(hrEmployees.userId, hrEmployments.employeeUserId)).innerJoin(users, eq(users.id, hrEmployments.employeeUserId)).where(employeeUserId ? eq(hrEmployments.employeeUserId, employeeUserId) : undefined).orderBy(desc(hrOvertimeRequests.requestedStart));
}
export async function createHrOvertimeRequest(db: Database, input: HrOvertimeInput, actor: HrActor) {
  stamp(input.requestedStart); stamp(input.requestedEnd); if (input.requestedEnd <= input.requestedStart) throw new HrError(400, "加班結束時間必須晚於開始時間。 ");
  if (!Number.isSafeInteger(input.ratePpm) || input.ratePpm <= 0 || input.ratePpm > 10_000_000) throw new HrError(400, "請提供已確認的加班倍率（ppm）。 ");
  if (!input.reason.trim() || input.reason.length > 1000) throw new HrError(400, "加班原因必填。 ");
  const employmentId = await employmentForDate(db, input.employeeUserId, input.requestedStart); const id = crypto.randomUUID();
  try {
    await db.batch([db.insert(hrOvertimeRequests).values({ id, employmentId, scopeId: input.scopeId ?? null, requestedStart: input.requestedStart, requestedEnd: input.requestedEnd, settlementKind: input.settlementKind, ratePpm: input.ratePpm, reason: input.reason.trim(), createdBy: actor.id }), db.insert(activityEvents).values(activityRow({ entityType: "hr_personnel", entityId: id, source: "hr", eventType: "overtime_request_created", summary: "加班申請建立", actor }))] as never);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed/.test(error.message)) throw new HrError(409, "相同加班時段已存在或資料不合法。 ");
    throw error;
  }
  return { id };
}
export async function reviewHrOvertimeRequest(db: Database, id: string, decision: "approved" | "rejected" | "cancelled", comment: string, actor: HrActor) {
  if (comment.length > 1000) throw new HrError(400, "審核意見不可超過 1000 字。 ");
  if (decision === "rejected" && !comment.trim()) throw new HrError(400, "駁回加班申請時必須填寫審核意見。 ");
  const result = await db.update(hrOvertimeRequests).set({ status: decision, reviewedBy: actor.id, reviewedAt: sql`CURRENT_TIMESTAMP`, decisionReason: comment }).where(and(eq(hrOvertimeRequests.id, id), eq(hrOvertimeRequests.status, "pending"))).returning({ id: hrOvertimeRequests.id });
  if (!result.length) throw new HrError(409, "加班申請不存在或已完成處理。 ");
  await db.insert(activityEvents).values(activityRow({ entityType: "hr_personnel", entityId: id, source: "hr", eventType: "overtime_request_reviewed", summary: "加班申請審核", actor, payload: { decision } }));
  return { id, status: decision };
}
