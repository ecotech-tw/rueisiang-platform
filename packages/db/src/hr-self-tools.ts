import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, listHrEmployees } from "./hr-people.js";
import { authLineAccountLinks } from "./schema/auth.js";
import { listHrAnnualLeaveEntitlements } from "./hr-annual-leave.js";
import { defaultDayType, listHrCalendarMonth, type HrCalendarDayView } from "./hr-calendar.js";
import { latestPublishedScheduleVersion } from "./hr-scheduling.js";
import { hrEmploymentAttendanceSettings } from "./schema/hr-attendance.js";
import { hrEmployments } from "./schema/hr-people.js";
import { hrLeaveRequests, hrLeaveTypes } from "./schema/hr-payroll.js";
import { hrCalendarDays, hrOvertimeRequests, hrScheduleEntries, hrScheduleVersions, hrShiftTemplates, hrShiftVersions } from "./schema/hr-scheduling.js";
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

const REQUEST_PAGE_SIZE = 20;

/** 申請單查詢（假單、加班）共用的條件解析：狀態、依哪個日期篩、第幾頁。dateFields 的第一個是預設值。 */
function requestListQuery<Status extends string, Field extends string>(
  query: { status?: string; dateField?: string; page?: number },
  statuses: readonly Status[], dateFields: readonly [Field, ...Field[]], message: string,
) {
  const status = query.status ?? "all";
  const dateField = query.dateField ?? dateFields[0];
  const page = query.page ?? 1;
  if ((status !== "all" && !(statuses as readonly string[]).includes(status))
    || !(dateFields as readonly string[]).includes(dateField)
    || !Number.isSafeInteger(page) || page < 1 || page > 10_000) throw new HrError(400, message);
  return { status: status as Status | "all", dateField: dateField as Field, page };
}

export async function listHrSelfToolLeaveRequests(db: Database, userId: string, query: HrSelfLeaveQuery = {}, now = Date.now()) {
  employeeId(userId);
  const { status, dateField, page } = requestListQuery(query, ["draft", "pending", "approved", "rejected", "cancelled"], ["leave", "submitted"], "假單查詢條件不正確。");
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
  const pageSize = REQUEST_PAGE_SIZE;
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
  status?: "all" | "pending" | "approved" | "rejected";
  dateField?: "submitted" | "work";
  fromDate?: string;
  toDate?: string;
  page?: number;
}

function minutesBetween(start: string, end: string) {
  return Math.round((Date.parse(`${end.replace(" ", "T")}Z`) - Date.parse(`${start.replace(" ", "T")}Z`)) / 60_000);
}

/**
 * 本人的加班申請。查詢條件的形狀刻意跟假單一樣，模型不用學兩套；時間一律轉成台北時間再給。
 *
 * 跟假單不同的兩件事：
 * - 狀態沒有 cancelled 也沒有 draft。加班取消是把那一列刪掉（見 hr-overtime 的 cancelHrOvertimeRequest），
 *   也沒有任何流程會寫入 draft；留著這兩個選項只會永遠回空，讓模型答成「沒有取消過」。
 * - 依加班日期查時，預設區間往前也往後各 30 天。加班多半是事前申請，只回溯到今天的話
 *   「我這週六的加班核准了嗎」會查不到。
 */
export async function listHrSelfToolOvertimeRequests(db: Database, userId: string, query: HrSelfOvertimeQuery = {}, now = Date.now()) {
  employeeId(userId);
  const { status, dateField, page } = requestListQuery(query, ["pending", "approved", "rejected"], ["work", "submitted"], "加班查詢條件不正確。");
  const today = formatTaipeiDate(now);
  const { fromDate, toDate } = toolDateRange(query, status === "pending" ? null : dateField === "submitted"
    ? { fromDate: shiftDate(today, -29), toDate: today }
    : { fromDate: shiftDate(today, -30), toDate: shiftDate(today, 30) }, 366);
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
  const pageSize = REQUEST_PAGE_SIZE;
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

/** 行事曆上有指定停班據點的日子，把 scope ID 換成名字給模型看。 */
async function calendarScopeNames(db: Database, days: readonly HrCalendarDayView[]) {
  const scopeIds = [...new Set(days.flatMap((day) => day.specialScopeIds))];
  const rows = scopeIds.length
    ? await db.select({ id: scopes.id, name: scopes.name }).from(scopes).where(inJsonArray(scopes.id, scopeIds))
    : [];
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** 災防停班：null 是沒有停班，"all" 是全公司，否則是停班的據點名稱。班表與行事曆兩個工具用同一個形狀。 */
function stopWorkOf(day: HrCalendarDayView, scopeNames: Map<string, string>): null | "all" | string[] {
  if (day.specialKind !== "typhoon_stop") return null;
  return day.specialScopeIds.length ? day.specialScopeIds.map((id) => scopeNames.get(id) ?? id) : "all";
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
 * 讀哪一版跟出勤頁讀本人班表一樣：同一期間最新的已發布版（latestPublishedScheduleVersion）。
 * 班表版本以期間為單位、不分據點，而且存檔就是發布：別的據點先排好，整個月就有已發布的版本。
 * 所以「有已發布的版本」不代表這個人被排過——他在那一版裡至少有一個班才算 assigned。
 * 這跟 hr-overview 的「還沒排的人數」是同一個想法，但不是同一條規則：總覽看的是版本號最大的那一版
 * （不管狀態）而且只數排班制員工，那是給 HR 看進度用的；這裡要回答的是員工現在實際該照哪一版上班。
 *
 * 會讓「有班」變成「不用上班」的三件事也一起給：當天的請假（核准的假不會把班次刪掉）、國定假日、災防停班。
 * LINE 的 HR 回合呼叫過 HR 工具後不能再呼叫別的工具，查不到行事曆，漏給就只能答成照常上班。
 */
export async function listHrSelfToolSchedule(db: Database, userId: string, query: HrSelfScheduleQuery = {}, now = Date.now()) {
  employeeId(userId);
  const today = formatTaipeiDate(now);
  const range = toolDateRange(query, { fromDate: today, toDate: shiftDate(today, 13) }, 62);
  const fromDate = range.fromDate!;
  const toDate = range.toDate!;
  const endExclusive = shiftDate(toDate, 1);
  const ownActiveEmployment = and(eq(hrEmployments.employeeUserId, userId), isNull(hrEmployments.archivedAt));
  const [entries, publishedPeriods, assignedPeriods, leaves, calendar, employments] = await Promise.all([
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
      .where(and(ownActiveEmployment, latestPublishedScheduleVersion(), gte(hrScheduleEntries.workDate, fromDate), lt(hrScheduleEntries.workDate, endExclusive)))
      .orderBy(asc(hrScheduleEntries.workDate), asc(hrScheduleEntries.startsAt)),
    db.select({ periodStart: hrScheduleVersions.periodStart, periodEnd: hrScheduleVersions.periodEnd }).from(hrScheduleVersions)
      .where(and(eq(hrScheduleVersions.status, "published"), lt(hrScheduleVersions.periodStart, endExclusive), gt(hrScheduleVersions.periodEnd, fromDate))),
    // 看整個期間而不是只看查詢的那幾天：只問「明天」時，明天沒班不代表這個月沒排到他。
    db.selectDistinct({ periodStart: hrScheduleVersions.periodStart, periodEnd: hrScheduleVersions.periodEnd }).from(hrScheduleEntries)
      .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleEntries.scheduleVersionId))
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrScheduleEntries.employmentId))
      .where(and(ownActiveEmployment, latestPublishedScheduleVersion(), lt(hrScheduleVersions.periodStart, endExclusive), gt(hrScheduleVersions.periodEnd, fromDate))),
    db.select({
      leaveType: hrLeaveRequests.leaveType, status: hrLeaveRequests.status,
      startsOn: hrLeaveRequests.startsOn, endsOnExclusive: hrLeaveRequests.endsOn,
      startsAt: hrLeaveRequests.startsAt, endsAt: hrLeaveRequests.endsAt,
    }).from(hrLeaveRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
      // 封存的任職連同上面的假一起排除：離職回任的人，舊任職的假不該掛到現在的班表上。
      .where(and(ownActiveEmployment, inArray(hrLeaveRequests.status, ["approved", "pending"]), lt(hrLeaveRequests.startsOn, endExclusive), gt(hrLeaveRequests.endsOn, fromDate)))
      .orderBy(asc(hrLeaveRequests.startsAt)),
    listHrCalendarMonth(db, { start: fromDate, end: endExclusive }),
    db.select({ attendanceMode: hrEmploymentAttendanceSettings.attendanceMode }).from(hrEmployments)
      .leftJoin(hrEmploymentAttendanceSettings, eq(hrEmploymentAttendanceSettings.employmentId, hrEmployments.id))
      .where(ownActiveEmployment),
  ]);
  const scopeNames = await calendarScopeNames(db, calendar);
  // 設定是 scheduled，或已發布的班表裡真的有他的班，都算排班制——與請假算時數時的判斷一致（hr-leave 的 scheduled）。
  // 只看設定的話，設定還停在 general 卻已經被排班的人會同時拿到班次與「你沒有班表」。沒有設定列等同 general。
  const attendanceMode = !employments.length ? "no_active_employment" as const
    : assignedPeriods.length || employments.some((row) => row.attendanceMode === "scheduled") ? "scheduled" as const : "general" as const;
  const covers = (periods: Array<{ periodStart: string; periodEnd: string }>, date: string) =>
    periods.some((period) => period.periodStart <= date && period.periodEnd > date);
  return {
    timeZone: "Asia/Taipei", asOfDate: today, fromDate, toDate, attendanceMode,
    days: calendar.map((day) => ({
      date: day.date,
      weekday: weekdayLabel(day.date),
      dayType: day.dayType,
      holidayName: day.name,
      stopWork: stopWorkOf(day, scopeNames),
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
      ? "scheduleStatus 是 assigned 而且 shifts 是空的，那天才是沒有排班；not_published 是那個月的班表還沒發布，not_assigned 是班表發布了但還沒排到這位員工，兩種都不能說成休假。leaves 是當天的請假，approved 的時段不用上班，pending 還沒核准。stopWork 不是 null 代表當天災防停班：all 是全公司，清單是停班的據點，班次的 scopeName 在清單裡才不用上班。"
      : attendanceMode === "general"
        ? "這位員工不是排班制，平台沒有他的逐日班表；shifts 是空的不代表休假，上班時間請依公司規定或向主管確認。leaves 是當天的請假，stopWork 不是 null 代表當天災防停班。"
        : "這個帳號目前沒有在職的任職資料，查不到班表；請向 HR 確認，不要回答成休假。",
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
  const years = [...new Set([fromDate.slice(0, 4), toDate.slice(0, 4)])];
  const [calendar, holidayYears] = await Promise.all([
    listHrCalendarMonth(db, { start: fromDate, end: shiftDate(toDate, 1) }),
    // 「沒有假日」跟「還沒匯入」要分得出來，而這只能看整個年度：一段本來就沒有假日的期間不該被當成沒匯入，
    // 一筆颱風停班也不能證明假日匯入過。
    db.selectDistinct({ year: sql<string>`substr(${hrCalendarDays.date}, 1, 4)` }).from(hrCalendarDays)
      .where(and(eq(hrCalendarDays.dayType, "holiday"), gte(hrCalendarDays.date, `${years[0]}-01-01`), lte(hrCalendarDays.date, `${years.at(-1)}-12-31`))),
  ]);
  const days = calendar.filter((day) => day.overridden);
  const scopeNames = await calendarScopeNames(db, days);
  const missingYears = years.filter((year) => !holidayYears.some((row) => row.year === year));
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
      stopWork: stopWorkOf(day, scopeNames),
    })),
    holidaysNotImportedYears: missingYears,
    note: missingYears.length ? `${missingYears.join("、")} 年的行事曆沒有任何國定假日，應該是還沒匯入；這些年度的日期不要回答成「沒有假日」。` : "",
  };
}
