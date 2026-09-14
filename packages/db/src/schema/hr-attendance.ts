import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { hrEmployees, hrEmployments } from "./hr-people.js";
import { scopes } from "./reports.js";

const timestamps = () => ({
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revision: integer("revision").notNull().default(1),
});

/** 地點資料和報表 scope 分開；scope 是營運資料，這裡才是出勤地理規則的來源。 */
export const hrAttendanceLocations = sqliteTable("hr_attendance_locations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // 舊辦公位置先允許未對應，避免升級時猜錯既有資料；新建與編輯由 API 要求 scope。
  scopeId: text("scope_id").references(() => scopes.id, { onDelete: "restrict" }),
  geolocationRequired: integer("geolocation_required").notNull().default(1),
  latitudeE7: integer("latitude_e7"),
  longitudeE7: integer("longitude_e7"),
  radiusMeters: integer("radius_meters").notNull().default(50),
  // 0124 的歷史欄位先保留，管理端不再提供停用／啟用這個概念。
  active: integer("active").notNull().default(1),
  ...timestamps(),
}, (table) => [
  uniqueIndex("idx_hr_attendance_locations_name").on(table.name),
  index("idx_hr_attendance_locations_scope").on(table.scopeId, table.active, table.name),
  index("idx_hr_attendance_locations_active").on(table.active, table.name),
  check("ck_hr_attendance_locations_name", sql`length(trim(${table.name})) BETWEEN 1 AND 100`),
  check("ck_hr_attendance_locations_geo_required", sql`${table.geolocationRequired} IN (0, 1)`),
  check("ck_hr_attendance_locations_active", sql`${table.active} IN (0, 1)`),
  check("ck_hr_attendance_locations_radius", sql`${table.radiusMeters} BETWEEN 1 AND 10000`),
  check("ck_hr_attendance_locations_latitude", sql`${table.latitudeE7} IS NULL OR ${table.latitudeE7} BETWEEN -900000000 AND 900000000`),
  check("ck_hr_attendance_locations_longitude", sql`${table.longitudeE7} IS NULL OR ${table.longitudeE7} BETWEEN -1800000000 AND 1800000000`),
  check("ck_hr_attendance_locations_geo_pair", sql`(${table.geolocationRequired} = 0) OR (${table.latitudeE7} IS NOT NULL AND ${table.longitudeE7} IS NOT NULL)`),
]);

/** 辦公位置週期工時；星期日=0，休息日不保存上下班時間。 */
export const hrAttendanceLocationSchedules = sqliteTable("hr_attendance_location_schedules", {
  id: text("id").primaryKey(),
  locationId: text("location_id").notNull().references(() => hrAttendanceLocations.id, { onDelete: "restrict" }),
  dayOfWeek: integer("day_of_week").notNull(),
  isRestDay: integer("is_rest_day").notNull().default(0),
  startMinute: integer("start_minute"),
  endMinute: integer("end_minute"),
  standardMinutes: integer("standard_minutes").notNull().default(480),
  toleranceMinutes: integer("tolerance_minutes").notNull().default(10),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revision: integer("revision").notNull().default(1),
}, (table) => [
  uniqueIndex("idx_hr_attendance_location_schedules_day").on(table.locationId, table.dayOfWeek),
  check("ck_hr_attendance_location_schedules_day", sql`${table.dayOfWeek} BETWEEN 0 AND 6`),
  check("ck_hr_attendance_location_schedules_rest", sql`${table.isRestDay} IN (0, 1)`),
  check("ck_hr_attendance_location_schedules_start", sql`${table.startMinute} IS NULL OR ${table.startMinute} BETWEEN 0 AND 1439`),
  check("ck_hr_attendance_location_schedules_end", sql`${table.endMinute} IS NULL OR ${table.endMinute} BETWEEN 0 AND 1439`),
  check("ck_hr_attendance_location_schedules_period", sql`${table.isRestDay} = 1 OR (${table.startMinute} IS NOT NULL AND ${table.endMinute} IS NOT NULL AND ${table.endMinute} > ${table.startMinute})`),
  check("ck_hr_attendance_location_schedules_standard", sql`${table.standardMinutes} BETWEEN 0 AND 1440`),
  check("ck_hr_attendance_location_schedules_tolerance", sql`${table.toleranceMinutes} BETWEEN 0 AND 1440`),
  check("ck_hr_attendance_location_schedules_revision", sql`${table.revision} > 0`),
]);

/** 同一段任職可同時指派多個辦公位置；每個位置各自用期間資料保留指派歷史。 */
export const hrEmployeeAttendanceLocations = sqliteTable("hr_employee_attendance_locations", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  locationId: text("location_id").notNull().references(() => hrAttendanceLocations.id, { onDelete: "restrict" }),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  ...timestamps(),
}, (table) => [
  uniqueIndex("idx_hr_employee_attendance_locations_start").on(table.employmentId, table.locationId, table.validFrom),
  index("idx_hr_employee_attendance_locations_location").on(table.locationId, table.validFrom),
  check("ck_hr_employee_attendance_locations_dates", sql`length(${table.validFrom}) = 10 AND (${table.validTo} IS NULL OR (length(${table.validTo}) = 10 AND ${table.validTo} > ${table.validFrom}))`),
  check("ck_hr_employee_attendance_locations_revision", sql`${table.revision} > 0`),
]);

/** 打卡事件不可覆寫；按鈕只會新增事件，摘要再由事件 kind 判斷。 */
/** 一段任職的出勤方式與主要辦公位置。主要位置用 assignment id 指向，避免在歷史指派列上覆寫狀態。 */
export const hrEmploymentAttendanceSettings = sqliteTable("hr_employment_attendance_settings", {
  employmentId: text("employment_id").primaryKey().references(() => hrEmployments.id, { onDelete: "restrict" }),
  attendanceMode: text("attendance_mode", { enum: ["general", "scheduled"] as const }).notNull().default("general"),
  primaryAssignmentId: text("primary_assignment_id").references(() => hrEmployeeAttendanceLocations.id, { onDelete: "restrict" }),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("ck_hr_employment_attendance_settings_mode", sql`${table.attendanceMode} IN ('general', 'scheduled')`),
]);

export const hrClockEvents = sqliteTable("hr_clock_events", {
  id: text("id").primaryKey(),
  employeeUserId: text("employee_user_id").notNull().references(() => hrEmployees.userId, { onDelete: "restrict" }),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  attendanceLocationId: text("attendance_location_id").references(() => hrAttendanceLocations.id, { onDelete: "restrict" }),
  scopeId: text("scope_id").references(() => scopes.id, { onDelete: "restrict" }),
  sourceKind: text("source_kind").notNull().default("portal"),
  idempotencyKey: text("idempotency_key").notNull(),
  eventKind: text("event_kind", { enum: ["clock_in", "clock_out"] as const }).notNull(),
  latitudeE7: integer("latitude_e7"),
  longitudeE7: integer("longitude_e7"),
  distanceMeters: integer("distance_meters"),
  // 歷史顯示不能跟著辦公位置／scope 改名；舊資料由 migration 回填當時可查到的名稱。
  locationNameSnapshot: text("location_name_snapshot").notNull().default(""),
  scopeNameSnapshot: text("scope_name_snapshot").notNull().default(""),
  recordedBy: text("recorded_by").references(() => users.id, { onDelete: "restrict" }),
  manualReason: text("manual_reason").notNull().default(""),
  timeAnomalyKind: text("time_anomaly_kind"),
  expectedStartMinute: integer("expected_start_minute"),
  expectedEndMinute: integer("expected_end_minute"),
  toleranceMinutes: integer("tolerance_minutes"),
  occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_clock_events_idempotency").on(table.idempotencyKey),
  index("idx_hr_clock_events_employee_occurred").on(table.employeeUserId, table.occurredAt),
  check("ck_hr_clock_events_source", sql`${table.sourceKind} IN ('portal', 'rfid', 'line', 'manual')`),
  check("ck_hr_clock_events_kind", sql`${table.eventKind} IN ('clock_in', 'clock_out')`),
  check("ck_hr_clock_events_coordinate_pair", sql`(${table.latitudeE7} IS NULL AND ${table.longitudeE7} IS NULL) OR (${table.latitudeE7} IS NOT NULL AND ${table.longitudeE7} IS NOT NULL)`),
  check("ck_hr_clock_events_latitude", sql`${table.latitudeE7} IS NULL OR ${table.latitudeE7} BETWEEN -900000000 AND 900000000`),
  check("ck_hr_clock_events_longitude", sql`${table.longitudeE7} IS NULL OR ${table.longitudeE7} BETWEEN -1800000000 AND 1800000000`),
  check("ck_hr_clock_events_distance", sql`${table.distanceMeters} IS NULL OR ${table.distanceMeters} >= 0`),
  check("ck_hr_clock_events_anomaly", sql`${table.timeAnomalyKind} IS NULL OR ${table.timeAnomalyKind} IN ('early', 'late', 'early_leave', 'overtime', 'rest_day')`),
  check("ck_hr_clock_events_expected_start", sql`${table.expectedStartMinute} IS NULL OR ${table.expectedStartMinute} BETWEEN 0 AND 1439`),
  check("ck_hr_clock_events_expected_end", sql`${table.expectedEndMinute} IS NULL OR ${table.expectedEndMinute} BETWEEN 0 AND 1439`),
  check("ck_hr_clock_events_tolerance", sql`${table.toleranceMinutes} IS NULL OR ${table.toleranceMinutes} BETWEEN 0 AND 1440`),
]);

export type HrAttendanceLocationSchedule = typeof hrAttendanceLocationSchedules.$inferSelect;
