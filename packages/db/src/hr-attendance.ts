import { and, asc, count, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, writeHrMutation, type HrActor } from "./hr-people.js";
import { hrAttendanceLocations, hrClockEvents, hrEmployeeAttendanceLocations, hrEmploymentAttendanceSettings } from "./schema/hr-attendance.js";
import { hrEmployments } from "./schema/hr-people.js";
import { users } from "./schema/auth.js";
import { hrScheduleEntries, hrScheduleVersions } from "./schema/hr-scheduling.js";
import { hrLeaveRequests } from "./schema/hr-payroll.js";
import { scopes } from "./schema/reports.js";
import { formatTaipeiDate, taipeiDateFromUtcWallClock, taipeiMidnightUtc } from "./taipei-time.js";

export interface HrAttendanceLocationInput {
  name: string;
  scopeId: string | null;
  geolocationRequired: boolean;
  latitudeE7: number | null;
  longitudeE7: number | null;
  radiusMeters: number;
}

export const HR_ATTENDANCE_LOCATION_PAGE_SIZES = [10, 25, 50, 100] as const;
export interface HrAttendanceLocationListQuery {
  page: number;
  pageSize: number;
  search: string;
  scopeId: string;
  sortField: "name" | "scope" | "radius";
  sortDirection: "asc" | "desc";
}

/**
 * 不帶 input 是完整清單（單筆編輯要找得到停用的位置）；`activeOnly` 給選單用：
 * 出勤範圍對話框要列出**所有**可指派的位置，分頁會讓第 101 筆之後永遠選不到。
 */
export async function listHrAttendanceLocations(db: Database, input?: HrAttendanceLocationListQuery, options: { activeOnly?: boolean } = {}) {
  const where = input ? and(
    eq(hrAttendanceLocations.active, 1),
    input.search ? or(like(hrAttendanceLocations.name, `%${input.search}%`), like(scopes.name, `%${input.search}%`)) : undefined,
    input.scopeId !== "all" ? eq(hrAttendanceLocations.scopeId, input.scopeId) : undefined,
  ) : options.activeOnly ? eq(hrAttendanceLocations.active, 1) : undefined;
  const sortColumn = input?.sortField === "scope" ? scopes.name : input?.sortField === "radius" ? hrAttendanceLocations.radiusMeters : hrAttendanceLocations.name;
  const order = input?.sortDirection === "desc" ? desc(sortColumn) : asc(sortColumn);
  const locationQuery = db.select({ location: hrAttendanceLocations, scopeName: sql<string | null>`${scopes.name}`.as("attendance_scope_name") }).from(hrAttendanceLocations)
    .leftJoin(scopes, eq(scopes.id, hrAttendanceLocations.scopeId)).where(where).orderBy(order, asc(hrAttendanceLocations.name));
  const locations = input ? await locationQuery.limit(input.pageSize).offset((input.page - 1) * input.pageSize) : await locationQuery;
  const total = input ? Number((await db.select({ value: count() }).from(hrAttendanceLocations).leftJoin(scopes, eq(scopes.id, hrAttendanceLocations.scopeId)).where(where))[0]?.value ?? 0) : locations.length;
  const paged = locations;
  return {
    locations: paged.map(({ location, scopeName }) => ({
      id: location.id, name: location.name, scopeId: location.scopeId, scopeName: scopeName ?? null,
      geolocationRequired: Boolean(location.geolocationRequired), hasCoordinates: location.latitudeE7 !== null && location.longitudeE7 !== null,
      radiusMeters: location.radiusMeters, createdAt: location.createdAt, updatedAt: location.updatedAt, revision: location.revision,
    })),
    ...(input ? { total, page: input.page, pageSize: input.pageSize, hasMore: input.page * input.pageSize < total } : {}),
  };
}

export const HR_ATTENDANCE_EVENT_PAGE_SIZES = [10, 25, 50, 100] as const;
export interface HrAttendanceEventListQuery {
  page: number;
  pageSize: number;
  search: string;
  eventKind: "all" | "clock_in" | "clock_out";
  sourceKind: "all" | "portal" | "manual" | "rfid" | "line";
  startDate: string | null;
  endDate: string | null;
  sortField: "occurredAt" | "employee" | "source";
  sortDirection: "asc" | "desc";
}

export async function listHrAttendanceEvents(db: Database, input: HrAttendanceEventListQuery) {
  const startUtc = input.startDate ? taipeiMidnightUtc(input.startDate) : null;
  const endUtc = input.endDate ? taipeiMidnightUtc(input.endDate) : null;
  const where = and(
    input.search ? or(like(hrEmployments.employeeNumber, `%${input.search}%`), like(users.displayName, `%${input.search}%`), like(users.googleName, `%${input.search}%`), like(users.email, `%${input.search}%`)) : undefined,
    input.eventKind !== "all" ? eq(hrClockEvents.eventKind, input.eventKind) : undefined,
    input.sourceKind !== "all" ? eq(hrClockEvents.sourceKind, input.sourceKind) : undefined,
    // occurred_at 以 UTC 保存；查詢日期是台北當地日，邊界先由 IANA timezone 轉成 UTC wall-clock。
    startUtc ? sql`${hrClockEvents.occurredAt} >= ${startUtc}` : undefined,
    endUtc ? sql`${hrClockEvents.occurredAt} < ${endUtc}` : undefined,
  );
  const sortColumn = input.sortField === "employee" ? hrEmployments.employeeNumber : input.sortField === "source" ? hrClockEvents.sourceKind : hrClockEvents.occurredAt;
  const order = input.sortDirection === "desc" ? desc(sortColumn) : asc(sortColumn);
  const [events, [totalRow]] = await Promise.all([
    db.select({
      id: hrClockEvents.id,
      employeeUserId: sql<string>`${hrClockEvents.employeeUserId}`.as("attendance_event_employee_user_id"),
      employeeNumber: sql<string>`${hrEmployments.employeeNumber}`.as("attendance_event_employee_number"),
      employeeName: sql<string>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`.as("attendance_event_employee_name"),
      eventKind: hrClockEvents.eventKind,
      occurredAt: hrClockEvents.occurredAt,
      locationName: sql<string | null>`coalesce(nullif(${hrClockEvents.locationNameSnapshot}, ''), ${hrAttendanceLocations.name})`.as("attendance_event_location_name"),
      scopeName: sql<string | null>`coalesce(nullif(${hrClockEvents.scopeNameSnapshot}, ''), ${scopes.name})`.as("attendance_event_scope_name"),
      sourceKind: hrClockEvents.sourceKind,
      manualReason: hrClockEvents.manualReason,
      distanceMeters: hrClockEvents.distanceMeters,
      timeAnomalyKind: hrClockEvents.timeAnomalyKind,
      expectedStartMinute: hrClockEvents.expectedStartMinute,
      expectedEndMinute: hrClockEvents.expectedEndMinute,
      toleranceMinutes: hrClockEvents.toleranceMinutes,
    }).from(hrClockEvents)
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrClockEvents.employmentId))
      .innerJoin(users, eq(users.id, hrClockEvents.employeeUserId))
      .leftJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrClockEvents.attendanceLocationId))
      .leftJoin(scopes, eq(scopes.id, hrClockEvents.scopeId))
      .where(where).orderBy(order, desc(hrClockEvents.occurredAt), desc(sql`hr_clock_events.rowid`))
      .limit(input.pageSize).offset((input.page - 1) * input.pageSize),
    db.select({ value: count() }).from(hrClockEvents)
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrClockEvents.employmentId))
      .innerJoin(users, eq(users.id, hrClockEvents.employeeUserId))
      .where(where),
  ]);
  const total = Number(totalRow?.value ?? 0);
  return { events, total, page: input.page, pageSize: input.pageSize, hasMore: input.page * input.pageSize < total };
}

/** 座標只在寫入權限的單筆編輯路徑回傳，不隨一般地點清單散出。 */
export async function getHrAttendanceLocation(db: Database, id: string) {
  const [location] = await db.select().from(hrAttendanceLocations).where(eq(hrAttendanceLocations.id, id)).limit(1);
  if (!location) throw new HrError(404, "找不到這個辦公位置。");
  const listed = await listHrAttendanceLocations(db);
  const summary = listed.locations.find((candidate) => candidate.id === id);
  if (!summary) throw new HrError(404, "找不到這個辦公位置。");
  return {
    location: {
      ...summary,
      latitude: location.latitudeE7 === null ? null : location.latitudeE7 / 10_000_000,
      longitude: location.longitudeE7 === null ? null : location.longitudeE7 / 10_000_000,
    },
  };
}

export function createHrAttendanceLocation(db: Database, input: HrAttendanceLocationInput, actor: HrActor) {
  const id = crypto.randomUUID();
  return writeHrMutation(db, sql`INSERT INTO hr_attendance_locations
    (id, name, scope_id, geolocation_required, latitude_e7, longitude_e7, radius_meters)
    VALUES (${id}, ${input.name}, ${input.scopeId}, ${input.geolocationRequired ? 1 : 0}, ${input.latitudeE7}, ${input.longitudeE7}, ${input.radiusMeters}) RETURNING id`, id, actor, "attendance_location_created", "辦公位置名稱已存在、營運據點不存在或資料不合法。");
}

export function updateHrAttendanceLocation(db: Database, id: string, input: HrAttendanceLocationInput & { revision: number }, actor: HrActor) {
  return writeHrMutation(db, sql`UPDATE hr_attendance_locations SET
    name=${input.name}, scope_id=${input.scopeId}, geolocation_required=${input.geolocationRequired ? 1 : 0}, latitude_e7=${input.latitudeE7}, longitude_e7=${input.longitudeE7}, radius_meters=${input.radiusMeters}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND revision=${input.revision} RETURNING id`, id, actor, "attendance_location_updated", "辦公位置已變更、名稱重複或資料不合法，請重新整理。");
}

export async function createHrAttendanceLocationAssignment(db: Database, input: { employmentId: string; locationId: string; validFrom: string; validTo: string | null }, actor: HrActor) {
  const id = crypto.randomUUID();
  const [setting] = await db.select({ primaryAssignmentId: hrEmploymentAttendanceSettings.primaryAssignmentId })
    .from(hrEmploymentAttendanceSettings).where(eq(hrEmploymentAttendanceSettings.employmentId, input.employmentId)).limit(1);
  const mutations = [sql`INSERT INTO hr_employee_attendance_locations
    (id, employment_id, location_id, valid_from, valid_to)
    SELECT ${id}, ${input.employmentId}, ${input.locationId}, ${input.validFrom}, ${input.validTo}
    WHERE EXISTS (SELECT 1 FROM hr_employments WHERE id=${input.employmentId} AND archived_at IS NULL)
      AND EXISTS (SELECT 1 FROM hr_attendance_locations WHERE id=${input.locationId} AND active=1)
      AND NOT EXISTS (SELECT 1 FROM hr_employee_attendance_locations WHERE employment_id=${input.employmentId} AND location_id=${input.locationId}
        AND (${input.validTo} IS NULL OR valid_from < ${input.validTo}) AND (valid_to IS NULL OR valid_to > ${input.validFrom}))
    RETURNING id`];
  // 每段任職至少保留一個主要位置；第一筆指派完成後才把 pointer 指過去，兩步同批提交。
  if (!setting?.primaryAssignmentId) mutations.push(sql`UPDATE hr_employment_attendance_settings SET primary_assignment_id=${id}, updated_at=CURRENT_TIMESTAMP
    WHERE employment_id=${input.employmentId} AND EXISTS (SELECT 1 FROM hr_employments WHERE id=${input.employmentId} AND archived_at IS NULL) RETURNING employment_id AS id`);
  return writeHrMutation(db, mutations, id, actor, "attendance_location_assigned", "員工或辦公位置不存在、同一辦公位置期間重疊，請重新整理。");
}

export async function setHrAttendanceLocationPrimary(db: Database, id: string, actor: HrActor) {
  const [target] = await db.select({ employmentId: hrEmployeeAttendanceLocations.employmentId }).from(hrEmployeeAttendanceLocations).where(eq(hrEmployeeAttendanceLocations.id, id)).limit(1);
  if (!target) throw new HrError(404, "找不到這筆辦公位置指派。");
  const today = taipeiToday();
  return writeHrMutation(db, sql`UPDATE hr_employment_attendance_settings SET primary_assignment_id=${id}, updated_at=CURRENT_TIMESTAMP
    WHERE employment_id=${target.employmentId}
      AND EXISTS (SELECT 1 FROM hr_employee_attendance_locations AS assignment
        WHERE assignment.id=${id} AND assignment.valid_from <= ${today}
          AND (assignment.valid_to IS NULL OR assignment.valid_to > ${today}))
    RETURNING employment_id AS id`, id, actor, "attendance_location_primary_changed", "辦公位置指派已變更或目前不在有效期間，請重新整理。");
}

export async function endHrAttendanceLocationAssignment(db: Database, id: string, input: { validTo: string; revision: number }, actor: HrActor) {
  const [assignment] = await db.select({ employmentId: hrEmployeeAttendanceLocations.employmentId }).from(hrEmployeeAttendanceLocations).where(eq(hrEmployeeAttendanceLocations.id, id)).limit(1);
  if (!assignment) throw new HrError(404, "找不到這筆辦公位置指派。");
  const [setting] = await db.select({ primaryAssignmentId: hrEmploymentAttendanceSettings.primaryAssignmentId }).from(hrEmploymentAttendanceSettings)
    .where(eq(hrEmploymentAttendanceSettings.employmentId, assignment.employmentId)).limit(1);
  const isPrimary = setting?.primaryAssignmentId === id;
  const [replacement] = isPrimary ? await db.select({ id: hrEmployeeAttendanceLocations.id }).from(hrEmployeeAttendanceLocations).where(and(
    eq(hrEmployeeAttendanceLocations.employmentId, assignment.employmentId), sql`${hrEmployeeAttendanceLocations.id} <> ${id}`,
    sql`${hrEmployeeAttendanceLocations.validFrom} < ${input.validTo} AND (${hrEmployeeAttendanceLocations.validTo} IS NULL OR ${hrEmployeeAttendanceLocations.validTo} > ${input.validTo})`,
  )).orderBy(asc(hrEmployeeAttendanceLocations.validFrom)).limit(1) : [];
  const mutations = [sql`UPDATE hr_employee_attendance_locations SET valid_to=${input.validTo}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND revision=${input.revision} AND (valid_to IS NULL OR valid_to > ${input.validTo}) AND valid_from < ${input.validTo} RETURNING id`];
  if (isPrimary) mutations.push(sql`UPDATE hr_employment_attendance_settings SET primary_assignment_id=${replacement?.id ?? null}, updated_at=CURRENT_TIMESTAMP
    WHERE employment_id=${assignment.employmentId} RETURNING employment_id AS id`);
  return writeHrMutation(db, mutations, id, actor, "attendance_location_unassigned", "辦公位置指派已變更或日期不合法，請重新整理。");
}

export interface HrAttendanceScopeUpdateInput {
  employmentId: string;
  attendanceMode: "general" | "scheduled";
  monthlyRestDays: number | null;
  revision: number;
  validFrom: string;
  validTo: string;
  /** Existing assignments end on this date; validTo remains the next day for validating newly added assignments. */
  assignmentValidTo: string;
  locationIds: string[];
  assignmentsToEnd: Array<{ id: string; revision: number }>;
}

/** 出勤方式與多個辦公位置在同一批 mutation 更新，避免只完成一半。 */
export function updateHrAttendanceScope(db: Database, input: HrAttendanceScopeUpdateInput, actor: HrActor) {
  const mutations = [sql`UPDATE hr_employments SET revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${input.employmentId} AND revision=${input.revision} AND archived_at IS NULL RETURNING id`,
    sql`UPDATE hr_employment_attendance_settings SET attendance_mode=${input.attendanceMode}, monthly_rest_days=${input.monthlyRestDays}, updated_at=CURRENT_TIMESTAMP
      WHERE employment_id=${input.employmentId} RETURNING employment_id AS id`];
  const endingAssignmentIds = input.assignmentsToEnd.map((assignment) => assignment.id);
  const endingIdList = endingAssignmentIds.length ? sql`AND id NOT IN (${sql.join(endingAssignmentIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
  const primaryEndingCondition = endingAssignmentIds.length ? sql` OR primary_assignment_id IN (${sql.join(endingAssignmentIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
  for (const assignment of input.assignmentsToEnd) mutations.push(sql`UPDATE hr_employee_attendance_locations SET valid_to=CASE WHEN valid_from < ${input.assignmentValidTo} THEN ${input.assignmentValidTo} ELSE ${input.validTo} END, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${assignment.id} AND employment_id=${input.employmentId} AND revision=${assignment.revision}
      AND (valid_to IS NULL OR valid_to > CASE WHEN valid_from < ${input.assignmentValidTo} THEN ${input.assignmentValidTo} ELSE ${input.validTo} END)
      AND valid_from < ${input.validTo} RETURNING id`);
  for (const locationId of input.locationIds) {
    const id = crypto.randomUUID();
    mutations.push(sql`INSERT INTO hr_employee_attendance_locations (id, employment_id, location_id, valid_from, valid_to)
      SELECT ${id}, ${input.employmentId}, ${locationId}, ${input.validFrom}, NULL
      WHERE EXISTS (SELECT 1 FROM hr_employments WHERE id=${input.employmentId} AND archived_at IS NULL)
        AND EXISTS (SELECT 1 FROM hr_attendance_locations WHERE id=${locationId} AND active=1)
        AND NOT EXISTS (SELECT 1 FROM hr_employee_attendance_locations WHERE employment_id=${input.employmentId} AND location_id=${locationId}
          AND (valid_to IS NULL OR valid_to > ${input.validFrom})) RETURNING id`);
  }
  /*
   * 主要位置的 pointer 要跟著同一批更新：這條路徑可以結束目前的主要位置，也可以替還沒有位置的人
   * 加上第一筆。pointer 沒指到仍有效的指派時，改指最早生效的那一筆（與單筆結束時的遞補規則相同）；
   * 原本的主要位置還有效就不動，所以這一步允許零列。
   */
  const primaryIndex = mutations.length;
  mutations.push(sql`UPDATE hr_employment_attendance_settings
    SET primary_assignment_id=(SELECT id FROM hr_employee_attendance_locations
      WHERE employment_id=${input.employmentId} AND (valid_to IS NULL OR valid_to > ${input.assignmentValidTo}) ${endingIdList}
      ORDER BY valid_from, rowid LIMIT 1), updated_at=CURRENT_TIMESTAMP
    WHERE employment_id=${input.employmentId}
      AND EXISTS (SELECT 1 FROM hr_employments WHERE id=${input.employmentId} AND archived_at IS NULL)
      AND (primary_assignment_id IS NULL${primaryEndingCondition} OR NOT EXISTS (SELECT 1 FROM hr_employee_attendance_locations
        WHERE id=hr_employment_attendance_settings.primary_assignment_id AND (valid_to IS NULL OR valid_to > ${input.assignmentValidTo})))
    RETURNING employment_id AS id`);
  return writeHrMutation(db, mutations, input.employmentId, actor, "attendance_scope_updated", "出勤設定或辦公位置已變更，請重新整理後再試。", { allowEmptyMutationIndexes: new Set([primaryIndex]) });
}

export interface HrClockEventInput {
  userId: string;
  idempotencyKey: string;
  latitudeE7: number | null;
  longitudeE7: number | null;
}

export interface HrClockLocationCheck {
  available: boolean;
  withinRadius: boolean;
  locationName: string | null;
  locationNames: string[];
  distanceMeters: number | null;
  radiusMeters: number | null;
  geolocationRequired: boolean;
  message: string | null;
}

const TAIPEI_CLOCK_FORMATTER = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function taipeiToday(value = new Date()) {
  return formatTaipeiDate(value);
}

const GENERAL_MINIMUM_SPAN_MINUTES = 60;
type HrClockCalendarAnomaly = "missing" | "incomplete" | "invalid-sequence" | "short-duration" | "late-arrival" | "early-leave" | "unscheduled";
type CalendarSchedule = { employmentId: string; workDate: string; startsAt: string; endsAt: string };

function wallClockMinutes(value: string) {
  const match = value.match(/ (\d{2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function taipeiClockMinutes(value: string) {
  const timestamp = Date.parse(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(timestamp)) return null;
  const parts = TAIPEI_CLOCK_FORMATTER.formatToParts(new Date(timestamp));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : null;
}

function scheduleForDate(schedules: CalendarSchedule[], date: string) {
  const rows = schedules.filter((schedule) => schedule.workDate === date);
  if (!rows.length) return null;
  const startsAt = rows.map((row) => row.startsAt).sort()[0]!;
  const endsAt = rows.map((row) => row.endsAt).sort().at(-1)!;
  const start = wallClockMinutes(startsAt);
  let end = wallClockMinutes(endsAt);
  if (start !== null && end !== null && end < start) end += 24 * 60;
  return { startsAt, endsAt, start, end, durationMinutes: start !== null && end !== null ? end - start : null };
}

function calendarDate(date: string, amount: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function overnightScheduleForDate(schedules: CalendarSchedule[], date: string) {
  const previousDate = calendarDate(date, -1);
  const rows = schedules.filter((schedule) => schedule.workDate === previousDate && schedule.endsAt.slice(0, 10) === date);
  return rows.length ? scheduleForDate(rows, previousDate) : null;
}

function calendarEventsForDate<T extends { eventKind: "clock_in" | "clock_out"; occurredAt: string }>(eventDates: Map<string, T[]>, date: string, schedule: ReturnType<typeof scheduleForDate>, previousOvernight: ReturnType<typeof scheduleForDate>) {
  const current = eventDates.get(date) ?? [];
  const withoutPreviousClose = previousOvernight && current[0]?.eventKind === "clock_out" ? current.slice(1) : current;
  if (!schedule || schedule.endsAt.slice(0, 10) <= date || withoutPreviousClose.at(-1)?.eventKind !== "clock_in") return withoutPreviousClose;
  const nextClose = (eventDates.get(calendarDate(date, 1)) ?? [])[0];
  return nextClose?.eventKind === "clock_out" ? [...withoutPreviousClose, nextClose] : withoutPreviousClose;
}

function calendarAnomaly(events: Array<{ eventKind: "clock_in" | "clock_out"; occurredAt: string }>, schedule: ReturnType<typeof scheduleForDate>, expectedWorkday: boolean, scheduledEmployee: boolean) {
  if (!events.length) return expectedWorkday ? { code: "missing" as const, message: "這天是預期出勤日，請確認是否忘記打卡。" } : null;
  let expectedKind: "clock_in" | "clock_out" = "clock_in";
  for (const event of events) {
    if (event.eventKind !== expectedKind) return { code: "invalid-sequence" as const, message: "打卡順序與上下班規則不符，請確認紀錄。" };
    expectedKind = expectedKind === "clock_in" ? "clock_out" : "clock_in";
  }
  if (events.length % 2 === 1) return { code: "incomplete" as const, message: "目前只有單數筆打卡，請確認是否漏刷。" };
  const first = taipeiClockMinutes(events[0]!.occurredAt);
  const last = taipeiClockMinutes(events.at(-1)!.occurredAt);
  if (first === null || last === null) return null;
  let actualEnd = last;
  if (actualEnd < first) actualEnd += 24 * 60;
  if (schedule) {
    if (schedule.start !== null && first > schedule.start) return { code: "late-arrival" as const, message: `上班打卡時間晚於排班時間 ${schedule.startsAt.slice(11, 16)}。` };
    if (schedule.end !== null && actualEnd < schedule.end) return { code: "early-leave" as const, message: `下班打卡時間早於排班結束時間 ${schedule.endsAt.slice(11, 16)}。` };
  } else if (scheduledEmployee && !expectedWorkday) {
    return { code: "unscheduled" as const, message: "這天沒有已發布排班，請確認是否誤打卡或需要補登排班。" };
  } else if (actualEnd - first < GENERAL_MINIMUM_SPAN_MINUTES) {
    return { code: "short-duration" as const, message: `本日出勤僅 ${actualEnd - first} 分鐘，低於一般出勤規則的 ${GENERAL_MINIMUM_SPAN_MINUTES} 分鐘。` };
  }
  return null;
}

export async function getHrClockCalendar(db: Database, userId: string, year: number, month: number) {
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const queryStart = calendarDate(monthStart, -1);
  const queryEnd = calendarDate(monthEnd, 1);
  const queryStartUtc = taipeiMidnightUtc(queryStart);
  // 事件查詢保留 queryEnd 當天，讓月底跨午夜班次能帶入隔日的下班打卡。
  const queryEndUtc = taipeiMidnightUtc(calendarDate(queryEnd, 1));
  const [employments, attendanceSettings, schedules, events, leaves] = await Promise.all([
    db.select({ id: hrEmployments.id, archivedAt: hrEmployments.archivedAt }).from(hrEmployments)
      .where(and(eq(hrEmployments.employeeUserId, userId), isNull(hrEmployments.archivedAt))),
    db.select({ employmentId: hrEmploymentAttendanceSettings.employmentId, attendanceMode: hrEmploymentAttendanceSettings.attendanceMode }).from(hrEmploymentAttendanceSettings)
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrEmploymentAttendanceSettings.employmentId))
      .where(and(eq(hrEmployments.employeeUserId, userId), isNull(hrEmployments.archivedAt))),
    db.select({ employmentId: hrScheduleEntries.employmentId, workDate: hrScheduleEntries.workDate, startsAt: hrScheduleEntries.startsAt, endsAt: hrScheduleEntries.endsAt })
      .from(hrScheduleEntries)
      .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleEntries.scheduleVersionId))
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrScheduleEntries.employmentId))
      .where(and(
        eq(hrEmployments.employeeUserId, userId), isNull(hrEmployments.archivedAt), eq(hrScheduleVersions.status, "published"),
        sql`${hrScheduleVersions.versionNumber} = (SELECT max(latest_schedule_version.version_number) FROM hr_schedule_versions AS latest_schedule_version WHERE latest_schedule_version.period_start = ${hrScheduleVersions.periodStart} AND latest_schedule_version.period_end = ${hrScheduleVersions.periodEnd} AND latest_schedule_version.status = 'published')`,
        sql`${hrScheduleEntries.workDate} BETWEEN ${queryStart} AND ${monthEnd}`,
      )),
    db.select({
      id: hrClockEvents.id,
      rowId: sql<number>`hr_clock_events.rowid`,
      eventKind: hrClockEvents.eventKind,
      occurredAt: hrClockEvents.occurredAt,
      locationName: sql<string | null>`coalesce(nullif(${hrClockEvents.locationNameSnapshot}, ''), ${hrAttendanceLocations.name})`,
      distanceMeters: hrClockEvents.distanceMeters,
    }).from(hrClockEvents)
      .leftJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrClockEvents.attendanceLocationId))
      .where(and(eq(hrClockEvents.employeeUserId, userId), sql`${hrClockEvents.occurredAt} >= ${queryStartUtc}`, sql`${hrClockEvents.occurredAt} < ${queryEndUtc}`))
      .orderBy(asc(hrClockEvents.occurredAt), asc(sql`hr_clock_events.rowid`)),
    db.select({ startsOn: hrLeaveRequests.startsOn, endsOn: hrLeaveRequests.endsOn }).from(hrLeaveRequests)
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
      .where(and(
        eq(hrEmployments.employeeUserId, userId), isNull(hrEmployments.archivedAt), eq(hrLeaveRequests.status, "approved"),
        sql`${hrLeaveRequests.startsOn} <= ${monthEnd}`, sql`${hrLeaveRequests.endsOn} > ${monthStart}`,
      )),
  ]);
  const eventDates = new Map<string, Array<(typeof events)[number] & { eventDate: string }>>();
  for (const event of events) {
    const datedEvent = { ...event, eventDate: taipeiDateFromUtcWallClock(event.occurredAt) };
    eventDates.set(datedEvent.eventDate, [...(eventDates.get(datedEvent.eventDate) ?? []), datedEvent]);
  }
  const modeByEmployment = new Map(attendanceSettings.map((setting) => [setting.employmentId, setting.attendanceMode]));
  const scheduleByEmployment = new Map<string, CalendarSchedule[]>();
  for (const schedule of schedules) scheduleByEmployment.set(schedule.employmentId, [...(scheduleByEmployment.get(schedule.employmentId) ?? []), schedule]);
  const today = taipeiToday();
  const days = Array.from({ length: lastDay }, (_, index) => {
    const day = index + 1;
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const dayEvents = eventDates.get(date) ?? [];
    const onLeave = leaves.some((leave) => leave.startsOn <= date && leave.endsOn > date);
    const activeEmployments = employments;
    const employed = activeEmployments.length > 0;
    const scheduledEmployment = activeEmployments.find((employment) => modeByEmployment.get(employment.id) === "scheduled");
    const scheduleRows = scheduledEmployment ? scheduleByEmployment.get(scheduledEmployment.id) ?? [] : [];
    const schedule = scheduledEmployment ? scheduleForDate(scheduleRows, date) : null;
    const previousOvernight = scheduledEmployment ? overnightScheduleForDate(scheduleRows, date) : null;
    const anomalyEvents = calendarEventsForDate(eventDates, date, schedule, previousOvernight);
    const expected = employed && (scheduledEmployment ? Boolean(schedule) : weekday !== 0 && weekday !== 6);
    const status = !employed ? "not-employed" : date > today ? "future" : onLeave ? "leave" : dayEvents.length ? "present" : date === today ? "open" : expected ? "missing" : "rest";
    const detectedAnomaly = status === "leave" || status === "future" || status === "rest" || status === "not-employed" || status === "open"
      ? null
      : calendarAnomaly(anomalyEvents, schedule, expected, Boolean(scheduledEmployment));
    const anomaly = detectedAnomaly?.code ?? null;
    return {
      date,
      weekday,
      status: status as "not-employed" | "future" | "present" | "open" | "missing" | "rest" | "leave",
      eventCount: dayEvents.length,
      firstEventAt: dayEvents[0]?.occurredAt ?? null,
      lastEventAt: dayEvents.at(-1)?.occurredAt ?? null,
      anomaly: anomaly as HrClockCalendarAnomaly | null,
      anomalyMessage: detectedAnomaly?.message ?? null,
      expectedStartAt: schedule?.startsAt ?? null,
      expectedEndAt: schedule?.endsAt ?? null,
      events: dayEvents.map(({ eventDate: _eventDate, rowId: _rowId, ...event }) => event),
    };
  });
  return { year, month, today, days };
}

/**
 * 首頁只需要異常數量；批次撈取整個月份，避免對每一位員工重複跑五次 D1 查詢。
 * 判斷規則與 getHrClockCalendar 共用同一組日曆 helper，新增摘要不會另造一套出勤語意。
 */
export async function countHrClockCalendarAnomalies(db: Database, userIds: string[], year: number, month: number) {
  if (!userIds.length) return 0;
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const queryStart = calendarDate(monthStart, -1);
  const queryEnd = calendarDate(monthEnd, 1);
  const queryStartUtc = taipeiMidnightUtc(queryStart);
  // 與個人日曆相同，保留 queryEnd 當天供月底跨午夜班次判定。
  const queryEndUtc = taipeiMidnightUtc(calendarDate(queryEnd, 1));
  const [employments, attendanceSettings, schedules, events, leaves] = await Promise.all([
    db.select({ userId: hrEmployments.employeeUserId, employmentId: hrEmployments.id, archivedAt: hrEmployments.archivedAt }).from(hrEmployments)
      .where(and(inArray(hrEmployments.employeeUserId, userIds), isNull(hrEmployments.archivedAt))),
    db.select({ employmentId: hrEmploymentAttendanceSettings.employmentId, attendanceMode: hrEmploymentAttendanceSettings.attendanceMode }).from(hrEmploymentAttendanceSettings)
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrEmploymentAttendanceSettings.employmentId))
      .where(and(inArray(hrEmployments.employeeUserId, userIds), isNull(hrEmployments.archivedAt))),
    db.select({ employmentId: hrScheduleEntries.employmentId, workDate: hrScheduleEntries.workDate, startsAt: hrScheduleEntries.startsAt, endsAt: hrScheduleEntries.endsAt }).from(hrScheduleEntries)
      .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleEntries.scheduleVersionId))
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrScheduleEntries.employmentId))
      .where(and(
        inArray(hrEmployments.employeeUserId, userIds), isNull(hrEmployments.archivedAt), eq(hrScheduleVersions.status, "published"),
        sql`${hrScheduleVersions.versionNumber} = (SELECT max(latest_schedule_version.version_number) FROM hr_schedule_versions AS latest_schedule_version WHERE latest_schedule_version.period_start = ${hrScheduleVersions.periodStart} AND latest_schedule_version.period_end = ${hrScheduleVersions.periodEnd} AND latest_schedule_version.status = 'published')`,
        sql`${hrScheduleEntries.workDate} BETWEEN ${queryStart} AND ${monthEnd}`,
      )),
    db.select({
      id: hrClockEvents.id,
      rowId: sql<number>`hr_clock_events.rowid`,
      employeeUserId: hrClockEvents.employeeUserId,
      eventKind: hrClockEvents.eventKind,
      occurredAt: hrClockEvents.occurredAt,
    }).from(hrClockEvents)
      .where(and(inArray(hrClockEvents.employeeUserId, userIds), sql`${hrClockEvents.occurredAt} >= ${queryStartUtc}`, sql`${hrClockEvents.occurredAt} < ${queryEndUtc}`))
      .orderBy(asc(hrClockEvents.occurredAt), asc(sql`hr_clock_events.rowid`)),
    db.select({ userId: hrEmployments.employeeUserId, startsOn: hrLeaveRequests.startsOn, endsOn: hrLeaveRequests.endsOn }).from(hrLeaveRequests)
      .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
      .where(and(
        inArray(hrEmployments.employeeUserId, userIds), isNull(hrEmployments.archivedAt), eq(hrLeaveRequests.status, "approved"),
        sql`${hrLeaveRequests.startsOn} <= ${monthEnd}`, sql`${hrLeaveRequests.endsOn} > ${monthStart}`,
      )),
  ]);
  const modeByEmployment = new Map(attendanceSettings.map((setting) => [setting.employmentId, setting.attendanceMode]));
  const scheduleByEmployment = new Map<string, CalendarSchedule[]>();
  for (const schedule of schedules) scheduleByEmployment.set(schedule.employmentId, [...(scheduleByEmployment.get(schedule.employmentId) ?? []), schedule]);
  const eventDatesByUser = new Map<string, Map<string, Array<(typeof events)[number] & { eventDate: string }>>>();
  for (const event of events) {
    const datedEvent = { ...event, eventDate: taipeiDateFromUtcWallClock(event.occurredAt) };
    const dates = eventDatesByUser.get(event.employeeUserId) ?? new Map<string, Array<(typeof events)[number] & { eventDate: string }>>();
    dates.set(datedEvent.eventDate, [...(dates.get(datedEvent.eventDate) ?? []), datedEvent]);
    eventDatesByUser.set(event.employeeUserId, dates);
  }
  const leavesByUser = new Map<string, typeof leaves>();
  for (const leave of leaves) leavesByUser.set(leave.userId, [...(leavesByUser.get(leave.userId) ?? []), leave]);
  const today = taipeiToday();
  let anomalyCount = 0;
  for (const userId of userIds) {
    const userEmployments = employments.filter((employment) => employment.userId === userId);
    const userEvents = eventDatesByUser.get(userId) ?? new Map<string, typeof events>();
    const userLeaves = leavesByUser.get(userId) ?? [];
    for (let day = 1; day <= lastDay; day += 1) {
      const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      const dayEvents = userEvents.get(date) ?? [];
      const onLeave = userLeaves.some((leave) => leave.startsOn <= date && leave.endsOn > date);
      const activeEmployments = userEmployments;
      const employed = activeEmployments.length > 0;
      const scheduledEmployment = activeEmployments.find((employment) => modeByEmployment.get(employment.employmentId) === "scheduled");
      const scheduleRows = scheduledEmployment ? scheduleByEmployment.get(scheduledEmployment.employmentId) ?? [] : [];
      const schedule = scheduledEmployment ? scheduleForDate(scheduleRows, date) : null;
      const previousOvernight = scheduledEmployment ? overnightScheduleForDate(scheduleRows, date) : null;
      const anomalyEvents = calendarEventsForDate(userEvents, date, schedule, previousOvernight);
      const expected = employed && (scheduledEmployment ? Boolean(schedule) : weekday !== 0 && weekday !== 6);
      const status = !employed ? "not-employed" : date > today ? "future" : onLeave ? "leave" : dayEvents.length ? "present" : date === today ? "open" : expected ? "missing" : "rest";
      if (status === "leave" || status === "future" || status === "rest" || status === "not-employed" || status === "open") continue;
      if (calendarAnomaly(anomalyEvents, schedule, expected, Boolean(scheduledEmployment))) anomalyCount += 1;
    }
  }
  return anomalyCount;
}

const clockEventFields = {
  id: hrClockEvents.id,
  eventKind: hrClockEvents.eventKind,
  occurredAt: hrClockEvents.occurredAt,
  locationName: sql<string>`coalesce(nullif(${hrClockEvents.locationNameSnapshot}, ''), ${hrAttendanceLocations.name})`,
  scopeName: sql<string>`nullif(${hrClockEvents.scopeNameSnapshot}, '')`,
  distanceMeters: hrClockEvents.distanceMeters,
  timeAnomalyKind: hrClockEvents.timeAnomalyKind,
  expectedStartMinute: hrClockEvents.expectedStartMinute,
  expectedEndMinute: hrClockEvents.expectedEndMinute,
  toleranceMinutes: hrClockEvents.toleranceMinutes,
  sourceKind: hrClockEvents.sourceKind,
  manualReason: hrClockEvents.manualReason,
  recordedBy: hrClockEvents.recordedBy,
};

async function currentEmployment(db: Database, userId: string) {
  const [employment] = await db.select({ id: hrEmployments.id }).from(hrEmployments)
    .where(and(eq(hrEmployments.employeeUserId, userId), isNull(hrEmployments.archivedAt))).limit(1);
  return employment;
}

async function currentAttendanceAssignments(db: Database, employmentId: string, today = taipeiToday()) {
  return db.select({
    id: sql<string>`${hrEmployeeAttendanceLocations.id}`.as("employee_attendance_assignment_id"),
    locationId: sql<string>`${hrEmployeeAttendanceLocations.locationId}`.as("employee_attendance_location_id"),
    locationName: sql<string>`${hrAttendanceLocations.name}`.as("attendance_location_name"),
    scopeId: hrAttendanceLocations.scopeId,
    scopeName: sql<string | null>`${scopes.name}`.as("attendance_scope_name"),
    geolocationRequired: hrAttendanceLocations.geolocationRequired,
    latitudeE7: hrAttendanceLocations.latitudeE7,
    longitudeE7: hrAttendanceLocations.longitudeE7,
    radiusMeters: hrAttendanceLocations.radiusMeters,
    isPrimary: sql<number>`CASE WHEN ${hrEmploymentAttendanceSettings.primaryAssignmentId} = ${hrEmployeeAttendanceLocations.id} THEN 1 ELSE 0 END`.as("attendance_is_primary"),
  }).from(hrEmployeeAttendanceLocations)
    .innerJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrEmployeeAttendanceLocations.locationId))
    .leftJoin(scopes, eq(scopes.id, hrAttendanceLocations.scopeId))
    .leftJoin(hrEmploymentAttendanceSettings, eq(hrEmploymentAttendanceSettings.employmentId, hrEmployeeAttendanceLocations.employmentId))
    .where(and(
      eq(hrEmployeeAttendanceLocations.employmentId, employmentId),
      sql`${hrAttendanceLocations.active} = 1`,
      sql`${hrEmployeeAttendanceLocations.validFrom} <= ${today}`,
      sql`(${hrEmployeeAttendanceLocations.validTo} IS NULL OR ${hrEmployeeAttendanceLocations.validTo} > ${today})`,
    ))
    .orderBy(desc(sql`CASE WHEN ${hrEmploymentAttendanceSettings.primaryAssignmentId} = ${hrEmployeeAttendanceLocations.id} THEN 1 ELSE 0 END`), desc(hrEmployeeAttendanceLocations.validFrom), asc(hrAttendanceLocations.name));
}

async function currentClockAssignments(db: Database, employmentId: string, today = taipeiToday()) {
  // 排班只決定當日工作時段，不授予或限制打卡位置；授權一律來自員工的有效辦公位置指派。
  return currentAttendanceAssignments(db, employmentId, today);
}

async function findClockEventByKey(db: Database, userId: string, idempotencyKey: string) {
  const [event] = await db.select(clockEventFields).from(hrClockEvents)
    .leftJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrClockEvents.attendanceLocationId))
    .where(and(eq(hrClockEvents.employeeUserId, userId), eq(hrClockEvents.idempotencyKey, idempotencyKey))).limit(1);
  return event;
}

async function findClockEventById(db: Database, id: string) {
  const [event] = await db.select(clockEventFields).from(hrClockEvents)
    .leftJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrClockEvents.attendanceLocationId))
    .where(eq(hrClockEvents.id, id)).limit(1);
  return event;
}

async function todayClockEvents(db: Database, userId: string, today = taipeiToday()) {
  const startUtc = taipeiMidnightUtc(today);
  const endUtc = taipeiMidnightUtc(calendarDate(today, 1));
  return db.select(clockEventFields).from(hrClockEvents)
    .leftJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrClockEvents.attendanceLocationId))
    .where(and(eq(hrClockEvents.employeeUserId, userId), sql`${hrClockEvents.occurredAt} >= ${startUtc}`, sql`${hrClockEvents.occurredAt} < ${endUtc}`))
    // SQLite 的 CURRENT_TIMESTAMP 只有秒精度；rowid 讓同一秒的連續按鈕仍有先後。
    .orderBy(desc(hrClockEvents.occurredAt), sql`hr_clock_events.rowid DESC`);
}

async function latestClockEvent(db: Database, userId: string) {
  const [event] = await db.select({ eventKind: hrClockEvents.eventKind }).from(hrClockEvents)
    .where(eq(hrClockEvents.employeeUserId, userId))
    .orderBy(desc(hrClockEvents.occurredAt), sql`hr_clock_events.rowid DESC`).limit(1);
  return event;
}

function distanceMeters(latitudeE7: number, longitudeE7: number, targetLatitudeE7: number, targetLongitudeE7: number) {
  const toRadians = (value: number) => value / 10_000_000 * Math.PI / 180;
  const latitude = toRadians(latitudeE7);
  const targetLatitude = toRadians(targetLatitudeE7);
  const deltaLatitude = targetLatitude - latitude;
  const deltaLongitude = toRadians(targetLongitudeE7) - toRadians(longitudeE7);
  const haversine = Math.min(1, Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(latitude) * Math.cos(targetLatitude) * Math.sin(deltaLongitude / 2) ** 2);
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)));
}

function locationNames(assignments: { locationName: string }[]) {
  return assignments.map((assignment) => assignment.locationName);
}

function geolocationRequired(assignments: { geolocationRequired: number }[]) {
  // 只要可打卡位置中有一處要求定位，就不能以另一處免定位設定繞過距離判斷。
  return assignments.some((assignment) => Boolean(assignment.geolocationRequired));
}

function nearestLocation(assignments: Awaited<ReturnType<typeof currentAttendanceAssignments>>, latitudeE7: number, longitudeE7: number) {
  return assignments.filter((assignment) => assignment.latitudeE7 !== null && assignment.longitudeE7 !== null).map((assignment) => ({
    assignment,
    distance: distanceMeters(latitudeE7, longitudeE7, assignment.latitudeE7!, assignment.longitudeE7!),
  })).sort((left, right) => left.distance - right.distance)[0];
}

export async function checkHrClockLocation(db: Database, userId: string, latitudeE7: number | null, longitudeE7: number | null): Promise<HrClockLocationCheck> {
  const employment = await currentEmployment(db, userId);
  const assignments = employment ? await currentClockAssignments(db, employment.id) : [];
  const names = locationNames(assignments);
  const requiresLocation = geolocationRequired(assignments);
  if (!employment) return { available: false, withinRadius: false, locationName: null, locationNames: [], distanceMeters: null, radiusMeters: null, geolocationRequired: false, message: "目前沒有活動員工資料，暫時無法打卡。" };
  if (!assignments.length) return { available: false, withinRadius: false, locationName: null, locationNames: [], distanceMeters: null, radiusMeters: null, geolocationRequired: false, message: "尚未指派目前辦公位置，請聯絡管理者。" };
  if (!requiresLocation) return { available: true, withinRadius: true, locationName: names.join("、"), locationNames: names, distanceMeters: null, radiusMeters: null, geolocationRequired: false, message: null };
  if (latitudeE7 === null || longitudeE7 === null) return { available: true, withinRadius: false, locationName: names.join("、"), locationNames: names, distanceMeters: null, radiusMeters: null, geolocationRequired: true, message: "尚未取得目前位置，請重新定位。" };
  const nearest = nearestLocation(assignments, latitudeE7, longitudeE7);
  if (!nearest) return { available: true, withinRadius: false, locationName: names.join("、"), locationNames: names, distanceMeters: null, radiusMeters: null, geolocationRequired: true, message: "目前沒有可用的辦公位置座標。" };
  const withinRadius = nearest.distance <= nearest.assignment.radiusMeters;
  return {
    available: true,
    withinRadius,
    locationName: nearest.assignment.locationName,
    locationNames: names,
    distanceMeters: nearest.distance,
    radiusMeters: nearest.assignment.radiusMeters,
    geolocationRequired: true,
    message: withinRadius ? null : `目前距離可打卡位置最近的「${nearest.assignment.locationName}」約 ${nearest.distance} 公尺，已超出 ${nearest.assignment.radiusMeters} 公尺打卡範圍。`,
  };
}

export async function getHrClockMapCenters(db: Database, userId: string) {
  const employment = await currentEmployment(db, userId);
  if (!employment) return [];
  const assignments = await currentClockAssignments(db, employment.id);
  return assignments.filter((assignment) => assignment.latitudeE7 !== null && assignment.longitudeE7 !== null).map((assignment) => ({
    id: assignment.locationId,
    name: assignment.locationName,
    latitude: assignment.latitudeE7! / 10_000_000,
    longitude: assignment.longitudeE7! / 10_000_000,
  }));
}

export async function getHrClockStatus(db: Database, userId: string) {
  const [events, latest] = await Promise.all([todayClockEvents(db, userId), latestClockEvent(db, userId)]);
  const employment = await currentEmployment(db, userId);
  const assignments = employment ? await currentClockAssignments(db, employment.id) : [];
  const names = locationNames(assignments);
  const requiresLocation = geolocationRequired(assignments);
  const canClock = Boolean(employment && assignments.length);
  return {
    canClock,
    message: !employment ? "目前沒有活動員工資料，暫時無法打卡。" : !assignments.length ? "尚未指派目前辦公位置，請聯絡管理者。" : null,
    nextEventKind: latest?.eventKind === "clock_in" ? "clock_out" as const : "clock_in" as const,
    geolocationRequired: requiresLocation,
    locationName: names.length ? names.join("、") : null,
    locationNames: names,
    radiusMeters: assignments.length === 1 ? assignments[0]?.radiusMeters ?? null : null,
    events,
  };
}

/*
 * 同一天可以排好幾段不重疊的班，所以不能只拿最早那一段：下午班的上下班打卡會被拿去跟上午班比，
 * 遲到早退全部判錯。上班打卡找開始時間最接近的那段，下班打卡找結束時間最接近的那段。
 * 先只看「當天開始」（上班）或「當天結束」（下班）的班，前一天跨午夜過來的班才不會搶走今天的上班打卡。
 */
async function scheduleForClock(db: Database, employmentId: string, date: string, eventKind: "clock_in" | "clock_out", minute: number) {
  const rows = await db.select({ startsAt: hrScheduleEntries.startsAt, endsAt: hrScheduleEntries.endsAt })
    .from(hrScheduleEntries).innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleEntries.scheduleVersionId))
    .where(and(eq(hrScheduleEntries.employmentId, employmentId), eq(hrScheduleVersions.status, "published"),
      sql`${hrScheduleVersions.versionNumber} = (SELECT max(latest_schedule_version.version_number) FROM hr_schedule_versions AS latest_schedule_version WHERE latest_schedule_version.period_start = ${hrScheduleVersions.periodStart} AND latest_schedule_version.period_end = ${hrScheduleVersions.periodEnd} AND latest_schedule_version.status = 'published')`,
      sql`(${hrScheduleEntries.workDate} = ${date} OR substr(${hrScheduleEntries.endsAt}, 1, 10) = ${date})`))
    .orderBy(asc(hrScheduleEntries.startsAt));
  const shifts = rows.flatMap((row) => {
    const startMinute = wallClockMinutes(row.startsAt);
    const endMinute = wallClockMinutes(row.endsAt);
    return startMinute === null || endMinute === null ? [] : [{ ...row, startMinute, endMinute }];
  });
  const anchorOf = (shift: (typeof shifts)[number]) => eventKind === "clock_in" ? { date: shift.startsAt.slice(0, 10), minute: shift.startMinute } : { date: shift.endsAt.slice(0, 10), minute: shift.endMinute };
  const sameDay = shifts.filter((shift) => anchorOf(shift).date === date);
  const candidates = sameDay.length ? sameDay : shifts;
  // 距離相同時保留排序在前（開始較早）的那段，結果才固定。
  const schedule = candidates.reduce<(typeof shifts)[number] | null>((best, shift) => !best || Math.abs(anchorOf(shift).minute - minute) < Math.abs(anchorOf(best).minute - minute) ? shift : best, null);
  return schedule ? { isRestDay: 0, startMinute: schedule.startMinute, endMinute: schedule.endMinute, toleranceMinutes: 10 } : null;
}

function serverTaipeiNow() {
  const now = new Date();
  const occurredAt = now.toISOString().slice(0, 19).replace("T", " ");
  return { occurredAt, date: taipeiToday(now), minute: taipeiClockMinutes(occurredAt)! };
}

function clockTimeAnomaly(schedule: Awaited<ReturnType<typeof scheduleForClock>>, eventKind: "clock_in" | "clock_out", minute: number) {
  if (!schedule) return null;
  if (schedule.isRestDay) return "rest_day" as const;
  const tolerance = schedule.toleranceMinutes;
  if (eventKind === "clock_in") {
    if (minute < schedule.startMinute! - tolerance) return "early" as const;
    if (minute > schedule.startMinute! + tolerance) return "late" as const;
  } else {
    if (minute < schedule.endMinute! - tolerance) return "early_leave" as const;
    if (minute > schedule.endMinute! + tolerance) return "overtime" as const;
  }
  return null;
}

export async function createHrClockEvent(db: Database, input: HrClockEventInput, actor: HrActor) {
  const existing = await findClockEventByKey(db, input.userId, input.idempotencyKey);
  if (existing) return { event: existing, idempotent: true };

  const serverNow = serverTaipeiNow();
  const employment = await currentEmployment(db, input.userId);
  if (!employment) throw new HrError(400, "目前沒有活動員工資料，暫時無法打卡。");
  const assignments = await currentClockAssignments(db, employment.id, serverNow.date);
  if (!assignments.length) throw new HrError(400, "尚未指派目前辦公位置，暫時無法打卡。");

  const requiresLocation = geolocationRequired(assignments);
  const latitudeE7 = requiresLocation ? input.latitudeE7 : null;
  const longitudeE7 = requiresLocation ? input.longitudeE7 : null;
  if (requiresLocation && (latitudeE7 === null || longitudeE7 === null)) {
    throw new HrError(400, "請允許瀏覽器定位後再打卡。");
  }
  const assignment = requiresLocation
    ? nearestLocation(assignments, latitudeE7!, longitudeE7!)?.assignment
    : assignments.find((candidate) => !candidate.geolocationRequired) ?? assignments[0];
  if (!assignment) throw new HrError(400, "目前沒有可用的辦公位置座標。");
  const distance = requiresLocation
    ? distanceMeters(latitudeE7!, longitudeE7!, assignment.latitudeE7!, assignment.longitudeE7!)
    : null;
  if (distance !== null && distance > assignment.radiusMeters) {
    throw new HrError(400, `目前位置不在可打卡辦公位置範圍內，最近的「${assignment.locationName}」約 ${distance} 公尺。`);
  }
  const latest = await latestClockEvent(db, input.userId);
  const eventKind = latest?.eventKind === "clock_in" ? "clock_out" as const : "clock_in" as const;
  const schedule = await scheduleForClock(db, employment.id, serverNow.date, eventKind, serverNow.minute);
  const timeAnomalyKind = clockTimeAnomaly(schedule, eventKind, serverNow.minute);
  const assignmentExists = sql`EXISTS (SELECT 1 FROM hr_employee_attendance_locations AS employee_assignment
      WHERE employee_assignment.id=${assignment.id} AND employee_assignment.employment_id=${employment.id}
        AND employee_assignment.valid_from <= ${serverNow.date}
        AND (employee_assignment.valid_to IS NULL OR employee_assignment.valid_to > ${serverNow.date}))`;

  const id = crypto.randomUUID();
  try {
    await writeHrMutation(db, sql`INSERT INTO hr_clock_events
      (id, employee_user_id, employment_id, attendance_location_id, scope_id, source_kind, idempotency_key, event_kind, latitude_e7, longitude_e7, distance_meters, location_name_snapshot, scope_name_snapshot, recorded_by, manual_reason, time_anomaly_kind, expected_start_minute, expected_end_minute, tolerance_minutes, occurred_at, received_at)
      SELECT ${id}, ${input.userId}, ${employment.id}, ${assignment.locationId}, ${assignment.scopeId}, 'portal', ${input.idempotencyKey}, ${eventKind},
        ${latitudeE7}, ${longitudeE7}, ${distance}, ${assignment.locationName}, ${assignment.scopeName ?? ""}, ${actor.id}, '', ${timeAnomalyKind}, ${schedule?.startMinute ?? null}, ${schedule?.endMinute ?? null}, ${schedule?.toleranceMinutes ?? null}, ${serverNow.occurredAt}, ${serverNow.occurredAt}
      WHERE EXISTS (SELECT 1 FROM hr_employments
        WHERE id=${employment.id} AND employee_user_id=${input.userId} AND archived_at IS NULL)
        AND ${assignmentExists}
        AND EXISTS (SELECT 1 FROM hr_attendance_locations
          WHERE id=${assignment.locationId} AND active=1)
        AND NOT EXISTS (SELECT 1 FROM hr_clock_events WHERE employee_user_id=${input.userId} AND idempotency_key=${input.idempotencyKey})
      RETURNING id`, id, actor, "clock_event_created", "打卡狀態已變更，請重新整理後再試。");
  } catch (error) {
    // 兩次相同請求同時抵達時，唯一鍵失敗的一方回傳先完成的事件，避免手機重試造成重複打卡。
    const duplicate = await findClockEventByKey(db, input.userId, input.idempotencyKey);
    if (duplicate) return { event: duplicate, idempotent: true };
    throw error;
  }

  const event = await findClockEventById(db, id);
  if (!event) throw new HrError(409, "打卡狀態已變更，請重新整理後再試。");
  return { event, idempotent: false };
}
