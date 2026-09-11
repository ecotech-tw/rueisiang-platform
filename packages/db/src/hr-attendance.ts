import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, writeHrMutation, type HrActor } from "./hr-people.js";
import { hrAttendanceLocations, hrClockEvents, hrEmployeeAttendanceLocations, hrEmploymentAttendanceSettings } from "./schema/hr-attendance.js";
import { hrEmployments } from "./schema/hr-people.js";

export interface HrAttendanceLocationInput {
  name: string;
  geolocationRequired: boolean;
  latitudeE7: number | null;
  longitudeE7: number | null;
  radiusMeters: number;
}

export async function listHrAttendanceLocations(db: Database) {
  const locations = await db.select().from(hrAttendanceLocations).orderBy(asc(hrAttendanceLocations.name));
  return {
    locations: locations.map((location) => ({
      id: location.id,
      name: location.name,
      geolocationRequired: Boolean(location.geolocationRequired),
      hasCoordinates: location.latitudeE7 !== null && location.longitudeE7 !== null,
      radiusMeters: location.radiusMeters,
      createdAt: location.createdAt,
      updatedAt: location.updatedAt,
      revision: location.revision,
    })),
  };
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
    (id, name, geolocation_required, latitude_e7, longitude_e7, radius_meters)
    VALUES (${id}, ${input.name}, ${input.geolocationRequired ? 1 : 0}, ${input.latitudeE7}, ${input.longitudeE7}, ${input.radiusMeters}) RETURNING id`, id, actor, "attendance_location_created", "辦公位置名稱已存在或資料不合法。");
}

export function updateHrAttendanceLocation(db: Database, id: string, input: HrAttendanceLocationInput & { revision: number }, actor: HrActor) {
  return writeHrMutation(db, sql`UPDATE hr_attendance_locations SET
    name=${input.name}, geolocation_required=${input.geolocationRequired ? 1 : 0}, latitude_e7=${input.latitudeE7}, longitude_e7=${input.longitudeE7}, radius_meters=${input.radiusMeters}, revision=revision+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=${id} AND revision=${input.revision} RETURNING id`, id, actor, "attendance_location_updated", "辦公位置已變更、名稱重複或資料不合法，請重新整理。");
}

export async function createHrAttendanceLocationAssignment(db: Database, input: { employmentId: string; locationId: string; validFrom: string; validTo: string | null }, actor: HrActor) {
  const id = crypto.randomUUID();
  const [setting] = await db.select({ primaryAssignmentId: hrEmploymentAttendanceSettings.primaryAssignmentId })
    .from(hrEmploymentAttendanceSettings).where(eq(hrEmploymentAttendanceSettings.employmentId, input.employmentId)).limit(1);
  const mutations = [sql`INSERT INTO hr_employee_attendance_locations
    (id, employment_id, location_id, valid_from, valid_to)
    SELECT ${id}, ${input.employmentId}, ${input.locationId}, ${input.validFrom}, ${input.validTo}
    WHERE EXISTS (SELECT 1 FROM hr_employments WHERE id=${input.employmentId} AND hired_on <= ${input.validFrom}
      AND (ended_on IS NULL OR (${input.validTo} IS NOT NULL AND ${input.validTo} <= ended_on)))
      AND EXISTS (SELECT 1 FROM hr_attendance_locations WHERE id=${input.locationId})
      AND NOT EXISTS (SELECT 1 FROM hr_employee_attendance_locations WHERE employment_id=${input.employmentId} AND location_id=${input.locationId}
        AND (${input.validTo} IS NULL OR valid_from < ${input.validTo}) AND (valid_to IS NULL OR valid_to > ${input.validFrom}))
    RETURNING id`];
  // 每段任職至少保留一個主要位置；第一筆指派完成後才把 pointer 指過去，兩步同批提交。
  if (!setting?.primaryAssignmentId) mutations.push(sql`UPDATE hr_employment_attendance_settings SET primary_assignment_id=${id}, updated_at=CURRENT_TIMESTAMP
    WHERE employment_id=${input.employmentId} RETURNING employment_id AS id`);
  return writeHrMutation(db, mutations, id, actor, "attendance_location_assigned", "員工或辦公位置不存在、同一辦公位置期間重疊，請重新整理。");
}

export async function setHrAttendanceLocationPrimary(db: Database, id: string, actor: HrActor) {
  const [target] = await db.select({ employmentId: hrEmployeeAttendanceLocations.employmentId }).from(hrEmployeeAttendanceLocations).where(eq(hrEmployeeAttendanceLocations.id, id)).limit(1);
  if (!target) throw new HrError(404, "找不到這筆辦公位置指派。");
  return writeHrMutation(db, sql`UPDATE hr_employment_attendance_settings SET primary_assignment_id=${id}, updated_at=CURRENT_TIMESTAMP
    WHERE employment_id=${target.employmentId}
      AND EXISTS (SELECT 1 FROM hr_employee_attendance_locations AS assignment
        WHERE assignment.id=${id} AND assignment.valid_from <= date('now', '+8 hours')
          AND (assignment.valid_to IS NULL OR assignment.valid_to > date('now', '+8 hours')))
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
    WHERE id=${id} AND revision=${input.revision} AND valid_to IS NULL AND valid_from < ${input.validTo} RETURNING id`];
  if (isPrimary) mutations.push(sql`UPDATE hr_employment_attendance_settings SET primary_assignment_id=${replacement?.id ?? null}, updated_at=CURRENT_TIMESTAMP
    WHERE employment_id=${assignment.employmentId} RETURNING employment_id AS id`);
  return writeHrMutation(db, mutations, id, actor, "attendance_location_unassigned", "辦公位置指派已變更或日期不合法，請重新整理。");
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

function taipeiToday() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

export async function getHrClockCalendar(db: Database, userId: string, year: number, month: number) {
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const [employments, events] = await Promise.all([
    db.select({ hiredOn: hrEmployments.hiredOn, endedOn: hrEmployments.endedOn }).from(hrEmployments)
      .where(eq(hrEmployments.employeeUserId, userId)),
    db.select({ occurredAt: hrClockEvents.occurredAt, eventDate: sql<string>`date(${hrClockEvents.occurredAt}, '+8 hours')` }).from(hrClockEvents)
      .where(and(eq(hrClockEvents.employeeUserId, userId), sql`date(${hrClockEvents.occurredAt}, '+8 hours') BETWEEN ${monthStart} AND ${monthEnd}`))
      .orderBy(asc(hrClockEvents.occurredAt)),
  ]);
  const eventDates = new Map<string, { count: number; firstEventAt: string; lastEventAt: string }>();
  for (const event of events) {
    const date = event.eventDate;
    const current = eventDates.get(date);
    if (current) {
      current.count += 1;
      current.lastEventAt = event.occurredAt;
    } else {
      eventDates.set(date, { count: 1, firstEventAt: event.occurredAt, lastEventAt: event.occurredAt });
    }
  }
  const today = taipeiToday();
  const days = Array.from({ length: lastDay }, (_, index) => {
    const day = index + 1;
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const event = eventDates.get(date);
    const employed = employments.some((employment) => employment.hiredOn <= date && (!employment.endedOn || employment.endedOn > date));
    const expected = employed && weekday !== 0 && weekday !== 6;
    const status = !employed ? "not-employed" : date > today ? "future" : event ? "present" : date === today ? "open" : expected ? "missing" : "rest";
    return {
      date,
      weekday,
      status: status as "not-employed" | "future" | "present" | "open" | "missing" | "rest",
      eventCount: event?.count ?? 0,
      firstEventAt: event?.firstEventAt ?? null,
      lastEventAt: event?.lastEventAt ?? null,
    };
  });
  return { year, month, today, days, missingDates: days.filter((day) => day.status === "missing").map((day) => day.date) };
}

const clockEventFields = {
  id: hrClockEvents.id,
  eventKind: hrClockEvents.eventKind,
  occurredAt: hrClockEvents.occurredAt,
  locationName: hrAttendanceLocations.name,
  distanceMeters: hrClockEvents.distanceMeters,
};

async function currentEmployment(db: Database, userId: string) {
  const [employment] = await db.select({ id: hrEmployments.id }).from(hrEmployments)
    .where(and(
      eq(hrEmployments.employeeUserId, userId),
      sql`${hrEmployments.hiredOn} <= date('now', '+8 hours')`,
      sql`(${hrEmployments.endedOn} IS NULL OR ${hrEmployments.endedOn} > date('now', '+8 hours'))`,
    ))
    .orderBy(desc(hrEmployments.hiredOn)).limit(1);
  return employment;
}

async function currentAttendanceAssignments(db: Database, employmentId: string) {
  return db.select({
    id: hrEmployeeAttendanceLocations.id,
    locationId: hrEmployeeAttendanceLocations.locationId,
    locationName: hrAttendanceLocations.name,
    geolocationRequired: hrAttendanceLocations.geolocationRequired,
    latitudeE7: hrAttendanceLocations.latitudeE7,
    longitudeE7: hrAttendanceLocations.longitudeE7,
    radiusMeters: hrAttendanceLocations.radiusMeters,
    isPrimary: sql<number>`CASE WHEN ${hrEmploymentAttendanceSettings.primaryAssignmentId} = ${hrEmployeeAttendanceLocations.id} THEN 1 ELSE 0 END`,
  }).from(hrEmployeeAttendanceLocations)
    .innerJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrEmployeeAttendanceLocations.locationId))
    .leftJoin(hrEmploymentAttendanceSettings, eq(hrEmploymentAttendanceSettings.employmentId, hrEmployeeAttendanceLocations.employmentId))
    .where(and(
      eq(hrEmployeeAttendanceLocations.employmentId, employmentId),
      sql`${hrEmployeeAttendanceLocations.validFrom} <= date('now', '+8 hours')`,
      sql`(${hrEmployeeAttendanceLocations.validTo} IS NULL OR ${hrEmployeeAttendanceLocations.validTo} > date('now', '+8 hours'))`,
    ))
    .orderBy(desc(sql`CASE WHEN ${hrEmploymentAttendanceSettings.primaryAssignmentId} = ${hrEmployeeAttendanceLocations.id} THEN 1 ELSE 0 END`), desc(hrEmployeeAttendanceLocations.validFrom), asc(hrAttendanceLocations.name));
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

async function todayClockEvents(db: Database, userId: string) {
  return db.select(clockEventFields).from(hrClockEvents)
    .leftJoin(hrAttendanceLocations, eq(hrAttendanceLocations.id, hrClockEvents.attendanceLocationId))
    .where(and(eq(hrClockEvents.employeeUserId, userId), sql`date(${hrClockEvents.occurredAt}, '+8 hours') = date('now', '+8 hours')`))
    // SQLite 的 CURRENT_TIMESTAMP 只有秒精度；rowid 讓同一秒的連續按鈕仍有先後。
    .orderBy(desc(hrClockEvents.occurredAt), sql`hr_clock_events.rowid DESC`);
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
  return assignments.length > 0 && assignments.every((assignment) => Boolean(assignment.geolocationRequired));
}

function nearestLocation(assignments: Awaited<ReturnType<typeof currentAttendanceAssignments>>, latitudeE7: number, longitudeE7: number) {
  return assignments.filter((assignment) => assignment.latitudeE7 !== null && assignment.longitudeE7 !== null).map((assignment) => ({
    assignment,
    distance: distanceMeters(latitudeE7, longitudeE7, assignment.latitudeE7!, assignment.longitudeE7!),
  })).sort((left, right) => left.distance - right.distance)[0];
}

export async function checkHrClockLocation(db: Database, userId: string, latitudeE7: number | null, longitudeE7: number | null): Promise<HrClockLocationCheck> {
  const employment = await currentEmployment(db, userId);
  const assignments = employment ? await currentAttendanceAssignments(db, employment.id) : [];
  const names = locationNames(assignments);
  const requiresLocation = geolocationRequired(assignments);
  if (!employment) return { available: false, withinRadius: false, locationName: null, locationNames: [], distanceMeters: null, radiusMeters: null, geolocationRequired: false, message: "目前沒有有效任職，暫時無法打卡。" };
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
  const assignments = await currentAttendanceAssignments(db, employment.id);
  return assignments.filter((assignment) => assignment.latitudeE7 !== null && assignment.longitudeE7 !== null).map((assignment) => ({
    id: assignment.locationId,
    name: assignment.locationName,
    latitude: assignment.latitudeE7! / 10_000_000,
    longitude: assignment.longitudeE7! / 10_000_000,
  }));
}

export async function getHrClockStatus(db: Database, userId: string) {
  const events = await todayClockEvents(db, userId);
  const employment = await currentEmployment(db, userId);
  const assignments = employment ? await currentAttendanceAssignments(db, employment.id) : [];
  const names = locationNames(assignments);
  const requiresLocation = geolocationRequired(assignments);
  const canClock = Boolean(employment && assignments.length);
  return {
    canClock,
    message: !employment ? "目前沒有有效任職，暫時無法打卡。" : !assignments.length ? "尚未指派目前辦公位置，請聯絡管理者。" : null,
    nextEventKind: events[0]?.eventKind === "clock_in" ? "clock_out" as const : "clock_in" as const,
    geolocationRequired: requiresLocation,
    locationName: names.length ? names.join("、") : null,
    locationNames: names,
    radiusMeters: assignments.length === 1 ? assignments[0]?.radiusMeters ?? null : null,
    events,
  };
}

export async function createHrClockEvent(db: Database, input: HrClockEventInput, actor: HrActor) {
  const existing = await findClockEventByKey(db, input.userId, input.idempotencyKey);
  if (existing) return { event: existing, idempotent: true };

  const employment = await currentEmployment(db, input.userId);
  if (!employment) throw new HrError(400, "目前沒有有效任職，暫時無法打卡。");
  const assignments = await currentAttendanceAssignments(db, employment.id);
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

  const id = crypto.randomUUID();
  try {
    await writeHrMutation(db, sql`INSERT INTO hr_clock_events
      (id, employee_user_id, employment_id, attendance_location_id, source_kind, idempotency_key, event_kind, latitude_e7, longitude_e7, distance_meters)
      SELECT ${id}, ${input.userId}, ${employment.id}, ${assignment.locationId}, 'portal', ${input.idempotencyKey},
        CASE WHEN coalesce((SELECT event_kind FROM hr_clock_events
          WHERE employee_user_id=${input.userId} AND date(occurred_at, '+8 hours') = date('now', '+8 hours')
          ORDER BY occurred_at DESC, rowid DESC LIMIT 1), 'clock_out') = 'clock_in'
          THEN 'clock_out' ELSE 'clock_in' END,
        ${latitudeE7}, ${longitudeE7}, ${distance}
      WHERE EXISTS (SELECT 1 FROM hr_employments
        WHERE id=${employment.id} AND employee_user_id=${input.userId}
          AND hired_on <= date('now', '+8 hours')
          AND (ended_on IS NULL OR ended_on > date('now', '+8 hours')))
        AND EXISTS (SELECT 1 FROM hr_employee_attendance_locations assignment
          WHERE assignment.id=${assignment.id} AND assignment.employment_id=${employment.id}
            AND assignment.valid_from <= date('now', '+8 hours')
            AND (assignment.valid_to IS NULL OR assignment.valid_to > date('now', '+8 hours')))
        AND EXISTS (SELECT 1 FROM hr_attendance_locations
          WHERE id=${assignment.locationId})
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
