import { and, asc, count, desc, eq, gt, gte, lt, lte, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError } from "./hr-people.js";
import { listHrAnnualLeaveEntitlements } from "./hr-annual-leave.js";
import { hrEmployments } from "./schema/hr-people.js";
import { hrLeaveRequests, hrLeaveTypes } from "./schema/hr-payroll.js";
import { formatTaipeiDate, taipeiMidnightUtc } from "./taipei-time.js";

export interface HrSelfLeaveQuery {
  status?: "all" | "draft" | "pending" | "approved" | "rejected" | "cancelled";
  dateField?: "submitted" | "leave";
  fromDate?: string;
  toDate?: string;
  page?: number;
}

function employeeId(value: string) {
  if (typeof value !== "string" || !value.trim()) throw new HrError(400, "缺少本人 HR 授權。");
  return value;
}

function dateOnly(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HrError(400, "日期必須是有效的 YYYY-MM-DD。" );
  }
  return value;
}

function shiftDate(value: string, days: number) {
  const timestamp = Date.parse(`${value}T00:00:00Z`) + days * 86_400_000;
  return new Date(timestamp).toISOString().slice(0, 10);
}

export async function listHrSelfToolLeaveRequests(db: Database, userId: string, query: HrSelfLeaveQuery = {}, now = Date.now()) {
  employeeId(userId);
  const status = query.status ?? "all";
  const dateField = query.dateField ?? "leave";
  const page = query.page ?? 1;
  if (!["all", "draft", "pending", "approved", "rejected", "cancelled"].includes(status)
    || !["submitted", "leave"].includes(dateField)
    || !Number.isSafeInteger(page) || page < 1 || page > 10_000) throw new HrError(400, "假單查詢條件不正確。" );
  if ((query.fromDate === undefined) !== (query.toDate === undefined)) throw new HrError(400, "請提供完整日期區間。" );
  const today = formatTaipeiDate(now);
  const fromDate = query.fromDate === undefined ? status === "pending" ? undefined : shiftDate(today, -29) : dateOnly(query.fromDate);
  const toDate = query.toDate === undefined ? fromDate ? today : undefined : dateOnly(query.toDate);
  if (fromDate && toDate && (fromDate > toDate || Date.parse(toDate) - Date.parse(fromDate) >= 366 * 86_400_000)) {
    throw new HrError(400, "日期區間需依序且最多涵蓋 366 天。" );
  }
  const submittedAt = sql<string>`datetime(${hrLeaveRequests.createdAt})`;
  const filter = and(
    eq(hrEmployments.employeeUserId, userId),
    status === "all" ? undefined : eq(hrLeaveRequests.status, status),
    fromDate && toDate ? dateField === "submitted"
      ? and(gte(submittedAt, taipeiMidnightUtc(fromDate)), lt(submittedAt, taipeiMidnightUtc(shiftDate(toDate, 1))))
      : and(lte(hrLeaveRequests.startsOn, toDate), gt(hrLeaveRequests.endsOn, fromDate)) : undefined,
  );
  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(hrLeaveRequests)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId)).where(filter);
  const pageSize = 20;
  const requests = await db.select({
    id: hrLeaveRequests.id,
    leaveType: hrLeaveRequests.leaveType,
    status: hrLeaveRequests.status,
    startsAt: hrLeaveRequests.startsAt,
    endsAt: hrLeaveRequests.endsAt,
    startsOn: hrLeaveRequests.startsOn,
    endsOnExclusive: hrLeaveRequests.endsOn,
    durationMinutes: hrLeaveRequests.durationMinutes,
    submittedAt: hrLeaveRequests.createdAt,
    reviewedAt: hrLeaveRequests.reviewedAt,
  }).from(hrLeaveRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
    .where(filter).orderBy(desc(hrLeaveRequests.createdAt), asc(hrLeaveRequests.id)).limit(pageSize).offset((page - 1) * pageSize);
  return {
    timeZone: "Asia/Taipei", timestampTimeZone: "UTC", asOfDate: today,
    filters: { status, dateField, fromDate: fromDate ?? null, toDate: toDate ?? null },
    requests, total, page, pageSize, hasMore: page * pageSize < total,
  };
}

export async function getHrSelfToolAnnualLeave(db: Database, userId: string, now = Date.now()) {
  employeeId(userId);
  const asOfDate = formatTaipeiDate(now);
  const entitlements = (await listHrAnnualLeaveEntitlements(db, { employeeUserId: userId, asOfDate }))
    .filter((row) => row.status === "open" && row.periodStart <= asOfDate && row.periodEnd > asOfDate);
  const periods = await Promise.all(entitlements.map(async (row) => {
    const [pending] = await db.select({ minutes: sql<number>`coalesce(sum(${hrLeaveRequests.durationMinutes}), 0)` })
      .from(hrLeaveRequests).innerJoin(hrLeaveTypes, eq(hrLeaveTypes.id, hrLeaveRequests.leaveTypeId))
      .where(and(eq(hrLeaveRequests.employmentId, row.employmentId), eq(hrLeaveTypes.leaveKind, "annual"),
        eq(hrLeaveRequests.status, "pending"), gte(hrLeaveRequests.startsOn, row.periodStart), lte(hrLeaveRequests.endsOn, row.periodEnd)));
    return {
      periodStart: row.periodStart, expiresOn: shiftDate(row.periodEnd, -1),
      entitledMinutes: row.entitledHalfHours * 30,
      remainingMinutes: row.balanceHalfHours * 30,
      remainingDays: row.balanceHalfHours * 30 / row.dailyMinutes,
      dailyMinutes: row.dailyMinutes,
      pendingMinutes: Number(pending?.minutes ?? 0),
    };
  }));
  return {
    status: periods.length ? "OK" : "NO_CURRENT_ENTITLEMENT",
    asOfDate, timeZone: "Asia/Taipei", periods,
    note: periods.length ? "特休核准後才扣除，待審核時數尚未扣除。" : "目前沒有當期可用特休額度，不代表餘額為零；請向 HR 確認資格與政策設定。",
  };
}
