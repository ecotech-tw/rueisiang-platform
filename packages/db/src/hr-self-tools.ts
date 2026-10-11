import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, listHrEmployees } from "./hr-people.js";
import { authLineAccountLinks } from "./schema/auth.js";
import { listHrAnnualLeaveEntitlements } from "./hr-annual-leave.js";
import { defaultDayType, listHrCalendarMonth } from "./hr-calendar.js";
import { hrEmploymentAttendanceSettings } from "./schema/hr-attendance.js";
import { hrEmployments } from "./schema/hr-people.js";
import { hrLeaveRequests, hrLeaveTypes } from "./schema/hr-payroll.js";
import { hrOvertimeRequests, hrScheduleEntries, hrScheduleVersions, hrShiftTemplates, hrShiftVersions } from "./schema/hr-scheduling.js";
import { scopes } from "./schema/reports.js";
import { inJsonArray } from "./sql-lists.js";
import { formatTaipeiDate, taipeiMidnightUtc, taipeiMinuteFromUtcWallClock } from "./taipei-time.js";

export async function listHrSandboxEmployees(db: Database, input: { page: number; search: string; lineLoginChannelId?: string }) {
  const result = await listHrEmployees(db, {
    page: input.page, pageSize: 25, search: input.search, status: "all", employmentStatus: "active",
    sortField: "employeeNumber", sortDirection: "asc",
  });
  const bindings = result.employees.length && input.lineLoginChannelId
    ? await db.select({ userId: authLineAccountLinks.userId }).from(authLineAccountLinks)
      .where(and(inArray(authLineAccountLinks.userId, result.employees.map((employee) => employee.userId)), eq(authLineAccountLinks.channelId, input.lineLoginChannelId)))
    : [];
  const linked = new Set(bindings.map((binding) => binding.userId));
  return {
    employees: result.employees.map((employee) => ({
      userId: employee.userId, displayName: employee.displayName, employeeNumber: employee.employeeNumber,
      userStatus: employee.userStatus, lineBound: linked.has(employee.userId),
    })),
    page: result.page, hasMore: result.hasMore,
  };
}

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

const WEEKDAY_LABELS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"] as const;

function weekdayLabel(date: string) {
  return WEEKDAY_LABELS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

/** 工具的日期區間：兩個都給或都不給；不給時用 fallback，fallback 為 null 代表不限日期。 */
function toolDateRange(query: { fromDate?: string; toDate?: string }, fallback: { fromDate: string; toDate: string } | null, maxDays: number) {
  if ((query.fromDate === undefined) !== (query.toDate === undefined)) throw new HrError(400, "請提供完整日期區間。" );
  const fromDate = query.fromDate === undefined ? fallback?.fromDate : dateOnly(query.fromDate);
  const toDate = query.toDate === undefined ? fallback?.toDate : dateOnly(query.toDate);
  if (fromDate && toDate && (fromDate > toDate || Date.parse(toDate) - Date.parse(fromDate) >= maxDays * 86_400_000)) {
    throw new HrError(400, `日期區間需依序且最多涵蓋 ${maxDays} 天。` );
  }
  return { fromDate, toDate };
}

export async function listHrSelfToolLeaveRequests(db: Database, userId: string, query: HrSelfLeaveQuery = {}, now = Date.now()) {
  employeeId(userId);
  const status = query.status ?? "all";
  const dateField = query.dateField ?? "leave";
  const page = query.page ?? 1;
  if (!["all", "draft", "pending", "approved", "rejected", "cancelled"].includes(status)
    || !["submitted", "leave"].includes(dateField)
    || !Number.isSafeInteger(page) || page < 1 || page > 10_000) throw new HrError(400, "假單查詢條件不正確。" );
  const today = formatTaipeiDate(now);
  const { fromDate, toDate } = toolDateRange(query, status === "pending" ? null : { fromDate: shiftDate(today, -29), toDate: today }, 366);
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
  // SQLite 與 ISO UTC 字串不能直接排序；julianday 也保留毫秒，避免同秒假單錯排。
  const submittedOrder = sql<number>`julianday(${hrLeaveRequests.createdAt})`;
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
    .where(filter).orderBy(desc(submittedOrder), asc(hrLeaveRequests.id)).limit(pageSize).offset((page - 1) * pageSize);
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

export interface HrSelfOvertimeQuery {
  status?: "all" | "draft" | "pending" | "approved" | "rejected" | "cancelled";
  dateField?: "submitted" | "work";
  fromDate?: string;
  toDate?: string;
  page?: number;
}

function minutesBetween(start: string, end: string) {
  return Math.round((Date.parse(`${end.replace(" ", "T")}Z`) - Date.parse(`${start.replace(" ", "T")}Z`)) / 60_000);
}

/** 本人的加班申請。查詢條件的形狀刻意跟假單一樣，模型不用學兩套；時間一律轉成台北時間再給。 */
export async function listHrSelfToolOvertimeRequests(db: Database, userId: string, query: HrSelfOvertimeQuery = {}, now = Date.now()) {
  employeeId(userId);
  const status = query.status ?? "all";
  const dateField = query.dateField ?? "work";
  const page = query.page ?? 1;
  if (!["all", "draft", "pending", "approved", "rejected", "cancelled"].includes(status)
    || !["submitted", "work"].includes(dateField)
    || !Number.isSafeInteger(page) || page < 1 || page > 10_000) throw new HrError(400, "加班查詢條件不正確。" );
  const today = formatTaipeiDate(now);
  const { fromDate, toDate } = toolDateRange(query, status === "pending" ? null : { fromDate: shiftDate(today, -29), toDate: today }, 366);
  const submittedAt = sql<string>`datetime(${hrOvertimeRequests.createdAt})`;
  const rangeStart = fromDate ? taipeiMidnightUtc(fromDate) : undefined;
  const rangeEnd = toDate ? taipeiMidnightUtc(shiftDate(toDate, 1)) : undefined;
  const filter = and(
    eq(hrEmployments.employeeUserId, userId),
    status === "all" ? undefined : eq(hrOvertimeRequests.status, status),
    rangeStart && rangeEnd ? dateField === "submitted"
      ? and(gte(submittedAt, rangeStart), lt(submittedAt, rangeEnd))
      : and(lt(hrOvertimeRequests.requestedStart, rangeEnd), gt(hrOvertimeRequests.requestedEnd, rangeStart)) : undefined,
  );
  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(hrOvertimeRequests)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId)).where(filter);
  const pageSize = 20;
  const rows = await db.select({
    id: hrOvertimeRequests.id,
    status: hrOvertimeRequests.status,
    settlementKind: hrOvertimeRequests.settlementKind,
    requestedStart: hrOvertimeRequests.requestedStart,
    requestedEnd: hrOvertimeRequests.requestedEnd,
    actualStart: hrOvertimeRequests.actualStart,
    actualEnd: hrOvertimeRequests.actualEnd,
    submittedAt: hrOvertimeRequests.createdAt,
    reviewedAt: hrOvertimeRequests.reviewedAt,
  }).from(hrOvertimeRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrOvertimeRequests.employmentId))
    .where(filter).orderBy(desc(hrOvertimeRequests.requestedStart), asc(hrOvertimeRequests.id)).limit(pageSize).offset((page - 1) * pageSize);
  return {
    timeZone: "Asia/Taipei", asOfDate: today,
    filters: { status, dateField, fromDate: fromDate ?? null, toDate: toDate ?? null },
    requests: rows.map((row) => ({
      id: row.id,
      status: row.status,
      settlementKind: row.settlementKind,
      requestedStart: taipeiMinuteFromUtcWallClock(row.requestedStart),
      requestedEnd: taipeiMinuteFromUtcWallClock(row.requestedEnd),
      requestedMinutes: minutesBetween(row.requestedStart, row.requestedEnd),
      // 核定時段是主管核准的實際加班時間，可能比申請的短；還沒核准就是 null。
      approvedStart: row.actualStart ? taipeiMinuteFromUtcWallClock(row.actualStart) : null,
      approvedEnd: row.actualEnd ? taipeiMinuteFromUtcWallClock(row.actualEnd) : null,
      approvedMinutes: row.actualStart && row.actualEnd ? minutesBetween(row.actualStart, row.actualEnd) : null,
      submittedAt: taipeiMinuteFromUtcWallClock(row.submittedAt),
      reviewedAt: row.reviewedAt ? taipeiMinuteFromUtcWallClock(row.reviewedAt) : null,
    })),
    total, page, pageSize, hasMore: page * pageSize < total,
  };
}

export interface HrSelfScheduleQuery {
  fromDate?: string;
  toDate?: string;
}

/**
 * 本人已發布的班表，一天一列。
 *
 * 「這天沒有班」有四種完全不同的意思：排了休、那個月還沒人發布班表、發布了但還沒排到這個人、這個人根本不是排班制。
 * 只回班次的話模型會把四種都講成「你那天休假」，所以每一天都帶 scheduleStatus，整體再帶 attendanceMode。
 *
 * 班表版本以期間為單位、不分據點，而且存檔就是發布：別的據點先排好，整個月就有已發布的版本。
 * 所以「有已發布的版本」不代表這個人被排過——要他在那個期間的最新已發布版裡至少有一個班才算，
 * 跟 hr-overview 算「還有幾個人沒排」是同一個判斷。
 *
 * 日型、假日名稱與當天的請假也一起給：核准的假不會把班次刪掉，只看班次會回答成「明天 10 點上班」；
 * 而 LINE 的 HR 回合呼叫過 HR 工具後不能再呼叫別的工具，查不到行事曆。
 */
export async function listHrSelfToolSchedule(db: Database, userId: string, query: HrSelfScheduleQuery = {}, now = Date.now()) {
  employeeId(userId);
  const today = formatTaipeiDate(now);
  const range = toolDateRange(query, { fromDate: today, toDate: shiftDate(today, 13) }, 62);
  const fromDate = range.fromDate!;
  const toDate = range.toDate!;
  const endExclusive = shiftDate(toDate, 1);
  const latestPublished = sql`${hrScheduleVersions.versionNumber} = (SELECT max(latest_schedule_version.version_number) FROM hr_schedule_versions AS latest_schedule_version WHERE latest_schedule_version.period_start = ${hrScheduleVersions.periodStart} AND latest_schedule_version.period_end = ${hrScheduleVersions.periodEnd} AND latest_schedule_version.status = 'published')`;
  const [entries, publishedPeriods, assignedPeriods, leaves, calendar, settings] = await Promise.all([
    db.select({
      workDate: hrScheduleEntries.workDate,
      startsAt: hrScheduleEntries.startsAt,
      endsAt: hrScheduleEntries.endsAt,
      breakMinutes: hrScheduleEntries.breakMinutes,
      scopeName: scopes.name,
      shiftName: hrShiftTemplates.name,
    }).from(hrScheduleEntries)
      .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleEntries.scheduleVersionId))
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrScheduleEntries.employmentId))
      .innerJoin(scopes, eq(scopes.id, hrScheduleEntries.scopeId))
      .innerJoin(hrShiftVersions, eq(hrShiftVersions.id, hrScheduleEntries.shiftVersionId))
      .innerJoin(hrShiftTemplates, eq(hrShiftTemplates.id, hrShiftVersions.shiftTemplateId))
      .where(and(
        eq(hrEmployments.employeeUserId, userId), isNull(hrEmployments.archivedAt), eq(hrScheduleVersions.status, "published"),
        // 同一期間重新發布會留下舊版；只認最新的已發布版，與出勤頁讀本人班表的條件一致。
        latestPublished,
        gte(hrScheduleEntries.workDate, fromDate), lt(hrScheduleEntries.workDate, endExclusive),
      )).orderBy(asc(hrScheduleEntries.workDate), asc(hrScheduleEntries.startsAt)),
    db.select({ periodStart: hrScheduleVersions.periodStart, periodEnd: hrScheduleVersions.periodEnd }).from(hrScheduleVersions)
      .where(and(eq(hrScheduleVersions.status, "published"), lt(hrScheduleVersions.periodStart, endExclusive), gt(hrScheduleVersions.periodEnd, fromDate))),
    // 看整個期間而不是只看查詢的那幾天：只問「明天」時，明天沒班不代表這個月沒排到他。
    db.selectDistinct({ periodStart: hrScheduleVersions.periodStart, periodEnd: hrScheduleVersions.periodEnd }).from(hrScheduleEntries)
      .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleEntries.scheduleVersionId))
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrScheduleEntries.employmentId))
      .where(and(
        eq(hrEmployments.employeeUserId, userId), isNull(hrEmployments.archivedAt), eq(hrScheduleVersions.status, "published"), latestPublished,
        lt(hrScheduleVersions.periodStart, endExclusive), gt(hrScheduleVersions.periodEnd, fromDate),
      )),
    db.select({
      leaveType: hrLeaveRequests.leaveType, status: hrLeaveRequests.status,
      startsOn: hrLeaveRequests.startsOn, endsOnExclusive: hrLeaveRequests.endsOn,
      startsAt: hrLeaveRequests.startsAt, endsAt: hrLeaveRequests.endsAt,
    }).from(hrLeaveRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
      .where(and(
        eq(hrEmployments.employeeUserId, userId), inArray(hrLeaveRequests.status, ["approved", "pending"]),
        lt(hrLeaveRequests.startsOn, endExclusive), gt(hrLeaveRequests.endsOn, fromDate),
      )).orderBy(asc(hrLeaveRequests.startsAt)),
    listHrCalendarMonth(db, { start: fromDate, end: endExclusive }),
    db.select({ attendanceMode: hrEmploymentAttendanceSettings.attendanceMode }).from(hrEmploymentAttendanceSettings)
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrEmploymentAttendanceSettings.employmentId))
      .where(and(eq(hrEmployments.employeeUserId, userId), isNull(hrEmployments.archivedAt))),
  ]);
  const attendanceMode = settings.some((row) => row.attendanceMode === "scheduled") ? "scheduled" : settings.length ? "general" : "unknown";
  const covers = (periods: Array<{ periodStart: string; periodEnd: string }>, date: string) =>
    periods.some((period) => period.periodStart <= date && period.periodEnd > date);
  return {
    timeZone: "Asia/Taipei", asOfDate: today, fromDate, toDate, attendanceMode,
    days: calendar.map((day) => ({
      date: day.date,
      weekday: weekdayLabel(day.date),
      dayType: day.dayType,
      holidayName: day.name,
      scheduleStatus: covers(assignedPeriods, day.date) ? "assigned" as const
        : covers(publishedPeriods, day.date) ? "not_assigned" as const : "not_published" as const,
      leaves: leaves.filter((leave) => leave.startsOn <= day.date && leave.endsOnExclusive > day.date).map((leave) => ({
        leaveType: leave.leaveType,
        status: leave.status,
        startsAt: taipeiMinuteFromUtcWallClock(leave.startsAt),
        endsAt: taipeiMinuteFromUtcWallClock(leave.endsAt),
      })),
      shifts: entries.filter((entry) => entry.workDate === day.date).map((entry) => ({
        scopeName: entry.scopeName,
        shiftName: entry.shiftName,
        startsAt: taipeiMinuteFromUtcWallClock(entry.startsAt),
        endsAt: taipeiMinuteFromUtcWallClock(entry.endsAt),
        breakMinutes: entry.breakMinutes,
      })),
    })),
    note: attendanceMode === "scheduled"
      ? "scheduleStatus 是 assigned 而且 shifts 是空的，那天才是沒有排班；not_published 是那個月的班表還沒發布，not_assigned 是班表發布了但還沒排到這位員工，兩種都不能說成休假。leaves 是當天的請假，approved 的時段不用上班，pending 還沒核准。"
      : "這位員工不是排班制，平台沒有他的逐日班表；shifts 是空的不代表休假，上班時間請依公司規定或向主管確認。",
  };
}

export interface HrToolCalendarQuery {
  fromDate?: string;
  toDate?: string;
}

/**
 * 公司行事曆裡「跟星期幾推出來不一樣」的日子：國定假日、補班日、災防停班。
 * 只回這些而不是逐日列出——一年 366 列大部分是「週三、平日」，白白佔掉模型的 context。
 */
export async function listHrToolCalendar(db: Database, query: HrToolCalendarQuery = {}, now = Date.now()) {
  const today = formatTaipeiDate(now);
  const range = toolDateRange(query, { fromDate: today, toDate: shiftDate(today, 59) }, 366);
  const fromDate = range.fromDate!;
  const toDate = range.toDate!;
  const days = (await listHrCalendarMonth(db, { start: fromDate, end: shiftDate(toDate, 1) })).filter((day) => day.overridden);
  const scopeIds = [...new Set(days.flatMap((day) => day.specialScopeIds))];
  const scopeRows = scopeIds.length
    ? await db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(inJsonArray(scopes.id, scopeIds))
    : [];
  const scopeNames = new Map(scopeRows.map((row) => [row.id, row.name]));
  return {
    timeZone: "Asia/Taipei", asOfDate: today, fromDate, toDate,
    defaultRule: "沒有列出的日期依星期判斷：週一到週五是平日，週六、週日是週末。",
    days: days.map((day) => ({
      date: day.date,
      weekday: weekdayLabel(day.date),
      dayType: day.dayType,
      name: day.name,
      // 週六日被設成平日，就是補班日。
      makeupWorkday: day.dayType === "weekday" && defaultDayType(day.date) === "weekend",
      // 災防停班：null 是沒有停班，"all" 是全公司，否則是停班的據點名稱。
      stopWork: day.specialKind !== "typhoon_stop" ? null
        : day.specialScopeIds.length ? day.specialScopeIds.map((id) => scopeNames.get(id) ?? id) : "all",
    })),
    note: days.length ? "" : "這段期間行事曆沒有任何設定，可能是該年度的國定假日還沒匯入；不要據此回答「沒有假日」。",
  };
}
