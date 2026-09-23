import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { hrEmployments } from "./hr-people.js";
import { scopes } from "./reports.js";

const timestamps = () => ({
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revision: integer("revision").notNull().default(1),
});

export const HR_CALENDAR_SPECIAL_KINDS = ["none", "typhoon_stop"] as const;
export type HrCalendarSpecialKind = (typeof HR_CALENDAR_SPECIAL_KINDS)[number];

/**
 * 行事曆只存「例外」的日子，不存一整年。
 *
 * 「週六日是週末、其他是平日」用星期幾就算得出來，存 365 列只是把同一條規則抄一份，
 * 之後兩邊還會對不起來。真正算不出來的只有國定假日與補班日——補班日是星期六卻要上班，
 * 中秋看月亮——那些才寫進這張表，一列蓋掉那天的預設值。
 *
 * 所以「某天是哪一型」的唯一來源是 hr-calendar.ts 的 resolveDayTypes，不是這張表；
 * 沒有對應列時它回傳星期幾算出來的預設值。任何地方都不要自己再寫一次星期幾的判斷。
 */
export const hrCalendarDays = sqliteTable("hr_calendar_days", {
  date: text("date").primaryKey(),
  dayType: text("day_type", { enum: ["weekday", "weekend", "holiday"] as const }).notNull(),
  name: text("name").notNull().default(""),
  specialKind: text("special_kind", { enum: HR_CALENDAR_SPECIAL_KINDS }).notNull().default("none"),
  updatedBy: text("updated_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_hr_calendar_days_type").on(table.dayType, table.date),
  check("ck_hr_calendar_days_date", sql`length(${table.date}) = 10`),
  check("ck_hr_calendar_days_type", sql`${table.dayType} IN ('weekday', 'weekend', 'holiday')`),
  check("ck_hr_calendar_days_special_kind", sql`${table.specialKind} IN ('none', 'typhoon_stop')`),
  check("ck_hr_calendar_days_name", sql`length(${table.name}) <= 100`),
]);

/** 颱風停班可只套用到部分門市；沒有子列代表所有門市／地區。 */
export const hrCalendarDayScopes = sqliteTable("hr_calendar_day_scopes", {
  date: text("date").notNull().references(() => hrCalendarDays.date, { onDelete: "cascade" }),
  scopeId: text("scope_id").notNull().references(() => scopes.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.date, table.scopeId] }),
  index("idx_hr_calendar_day_scopes_scope").on(table.scopeId, table.date),
]);

/** 班次先做成版本；已發布的班表引用固定版本並保存工時快照，不會因為改名稱或工時而改歷史。 */
export const hrShiftTemplates = sqliteTable("hr_shift_templates", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  active: integer("active").notNull().default(1),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  ...timestamps(),
}, (table) => [
  uniqueIndex("idx_hr_shift_templates_code").on(table.code),
  check("ck_hr_shift_templates_code", sql`length(trim(${table.code})) BETWEEN 1 AND 40`),
  check("ck_hr_shift_templates_name", sql`length(trim(${table.name})) BETWEEN 1 AND 100`),
  check("ck_hr_shift_templates_active", sql`${table.active} IN (0, 1)`),
  check("ck_hr_shift_templates_revision", sql`${table.revision} > 0`),
]);

/** 同一套班別可套用到多個實體 scope；關聯本身不複製班別時間。 */
export const hrScopeShiftAssignments = sqliteTable("hr_scope_shift_assignments", {
  scopeId: text("scope_id").notNull().references(() => scopes.id, { onDelete: "restrict" }),
  shiftTemplateId: text("shift_template_id").notNull().references(() => hrShiftTemplates.id, { onDelete: "restrict" }),
  isDefault: integer("is_default").notNull().default(0),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.scopeId, table.shiftTemplateId] }),
  index("idx_hr_scope_shift_assignments_scope").on(table.scopeId, table.isDefault),
  check("ck_hr_scope_shift_assignments_default", sql`${table.isDefault} IN (0, 1)`),
]);

export const hrShiftVersions = sqliteTable("hr_shift_versions", {
  id: text("id").primaryKey(),
  shiftTemplateId: text("shift_template_id").notNull().references(() => hrShiftTemplates.id, { onDelete: "restrict" }),
  /*
   * 同一個班別在平日、週末與國定假日各有一組時間。舊資料一律回填 weekday，那正是它原本的語意。
   *
   * 這裡刻意不加 CHECK：drizzle 對 SQLite 加約束會產出「建新表、搬資料、刪舊表」，而這張表被
   * hr_schedule_entries 與 hr_schedule_worker_entries 用外鍵指著，DROP 在 D1 的單一 transaction
   * 裡會連坐（見 CLAUDE.md 的 0023）。值域由 TS 的 enum 與 assertDayType 把關。
   */
  dayType: text("day_type", { enum: ["weekday", "weekend", "holiday"] as const }).notNull().default("weekday"),
  versionNumber: integer("version_number").notNull(),
  startSecond: integer("start_second").notNull(),
  endSecond: integer("end_second").notNull(),
  endDayOffset: integer("end_day_offset").notNull().default(0),
  standardMinutes: integer("standard_minutes").notNull().default(480),
  breakMinutes: integer("break_minutes").notNull().default(60),
  payFactorPpm: integer("pay_factor_ppm").notNull().default(1_000_000),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  // 版本號是每個班別的每個日型各自數的：早班的平日版與週末版都可以是第 1 版。
  uniqueIndex("idx_hr_shift_versions_number").on(table.shiftTemplateId, table.dayType, table.versionNumber),
  index("idx_hr_shift_versions_template").on(table.shiftTemplateId, table.createdAt),
  check("ck_hr_shift_versions_number", sql`${table.versionNumber} > 0`),
  check("ck_hr_shift_versions_start", sql`${table.startSecond} BETWEEN 0 AND 86399`),
  check("ck_hr_shift_versions_end", sql`${table.endSecond} BETWEEN 0 AND 86399`),
  check("ck_hr_shift_versions_day_offset", sql`${table.endDayOffset} BETWEEN 0 AND 1`),
  check("ck_hr_shift_versions_period", sql`${table.endDayOffset} = 1 OR ${table.endSecond} > ${table.startSecond}`),
  check("ck_hr_shift_versions_standard", sql`${table.standardMinutes} BETWEEN 0 AND 1440`),
  check("ck_hr_shift_versions_break", sql`${table.breakMinutes} BETWEEN 0 AND 1440`),
  check("ck_hr_shift_versions_factor", sql`${table.payFactorPpm} BETWEEN 0 AND 10000000`),
]);

/** 班表版本本身可送審／發布；發布後新增版本，不在原列上改日期或人員。 */
export const hrScheduleVersions = sqliteTable("hr_schedule_versions", {
  id: text("id").primaryKey(),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  versionNumber: integer("version_number").notNull(),
  status: text("status", { enum: ["draft", "pending", "published", "rejected", "superseded"] as const }).notNull().default("draft"),
  submittedBy: text("submitted_by").references(() => users.id, { onDelete: "restrict" }),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "restrict" }),
  decisionReason: text("decision_reason").notNull().default(""),
  // 排班直接發布；lockedAt 只控制是否允許後續調整，不再走草稿／送審／復原狀態。
  lockedAt: text("locked_at"),
  ...timestamps(),
}, (table) => [
  uniqueIndex("idx_hr_schedule_versions_period").on(table.periodStart, table.periodEnd, table.versionNumber),
  index("idx_hr_schedule_versions_status").on(table.status, table.periodStart),
  check("ck_hr_schedule_versions_dates", sql`length(${table.periodStart}) = 10 AND length(${table.periodEnd}) = 10 AND ${table.periodEnd} > ${table.periodStart}`),
  check("ck_hr_schedule_versions_number", sql`${table.versionNumber} > 0`),
  check("ck_hr_schedule_versions_status", sql`${table.status} IN ('draft', 'pending', 'published', 'rejected', 'superseded')`),
  check("ck_hr_schedule_versions_reason", sql`length(${table.decisionReason}) <= 1000`),
  check("ck_hr_schedule_versions_revision", sql`${table.revision} > 0`),
]);

/** 沒有平台帳號的臨時支援人員只存在於排班，不會混入 users／hr_employments。 */
export const hrScheduleWorkers = sqliteTable("hr_schedule_workers", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  active: integer("active").notNull().default(1),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  ...timestamps(),
}, (table) => [
  index("idx_hr_schedule_workers_active_name").on(table.active, table.displayName),
  check("ck_hr_schedule_workers_name", sql`length(trim(${table.displayName})) BETWEEN 1 AND 100`),
  check("ck_hr_schedule_workers_active", sql`${table.active} IN (0, 1)`),
  check("ck_hr_schedule_workers_revision", sql`${table.revision} > 0`),
]);

/** 正式員工的已發布排班；starts／ends 與計薪／休息分鐘都是發布當下的快照。 */
export const hrScheduleEntries = sqliteTable("hr_schedule_entries", {
  id: text("id").primaryKey(),
  scheduleVersionId: text("schedule_version_id").notNull().references(() => hrScheduleVersions.id, { onDelete: "restrict" }),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  scopeId: text("scope_id").notNull().references(() => scopes.id, { onDelete: "restrict" }),
  shiftVersionId: text("shift_version_id").notNull().references(() => hrShiftVersions.id, { onDelete: "restrict" }),
  workDate: text("work_date").notNull(),
  startsAt: text("starts_at").notNull(),
  endsAt: text("ends_at").notNull(),
  standardMinutes: integer("standard_minutes").notNull().default(480),
  breakMinutes: integer("break_minutes").notNull().default(60),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_schedule_entries_unique").on(table.scheduleVersionId, table.employmentId, table.workDate, table.startsAt),
  index("idx_hr_schedule_entries_employment_date").on(table.employmentId, table.workDate),
  index("idx_hr_schedule_entries_scope_date").on(table.scopeId, table.workDate),
  check("ck_hr_schedule_entries_date", sql`length(${table.workDate}) = 10`),
  check("ck_hr_schedule_entries_period", sql`${table.endsAt} > ${table.startsAt}`),
  check("ck_hr_schedule_entries_standard", sql`${table.standardMinutes} BETWEEN 0 AND 1440`),
  check("ck_hr_schedule_entries_break", sql`${table.breakMinutes} BETWEEN 0 AND 1440`),
]);

/** 支援人員的已發布排班；同樣保存班別工時快照。 */
export const hrScheduleWorkerEntries = sqliteTable("hr_schedule_worker_entries", {
  id: text("id").primaryKey(),
  scheduleVersionId: text("schedule_version_id").notNull().references(() => hrScheduleVersions.id, { onDelete: "restrict" }),
  workerId: text("worker_id").notNull().references(() => hrScheduleWorkers.id, { onDelete: "restrict" }),
  scopeId: text("scope_id").notNull().references(() => scopes.id, { onDelete: "restrict" }),
  shiftVersionId: text("shift_version_id").notNull().references(() => hrShiftVersions.id, { onDelete: "restrict" }),
  workDate: text("work_date").notNull(),
  startsAt: text("starts_at").notNull(),
  endsAt: text("ends_at").notNull(),
  standardMinutes: integer("standard_minutes").notNull().default(480),
  breakMinutes: integer("break_minutes").notNull().default(60),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_schedule_worker_entries_unique").on(table.scheduleVersionId, table.workerId, table.workDate, table.startsAt),
  index("idx_hr_schedule_worker_entries_worker_date").on(table.workerId, table.workDate),
  index("idx_hr_schedule_worker_entries_scope_date").on(table.scopeId, table.workDate),
  check("ck_hr_schedule_worker_entries_date", sql`length(${table.workDate}) = 10`),
  check("ck_hr_schedule_worker_entries_period", sql`${table.endsAt} > ${table.startsAt}`),
  check("ck_hr_schedule_worker_entries_standard", sql`${table.standardMinutes} BETWEEN 0 AND 1440`),
  check("ck_hr_schedule_worker_entries_break", sql`${table.breakMinutes} BETWEEN 0 AND 1440`),
]);

export const hrSpecialWorkdayRules = sqliteTable("hr_special_workday_rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  active: integer("active").notNull().default(1),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revision: integer("revision").notNull().default(1),
}, (table) => [
  check("ck_hr_special_workday_rules_name", sql`length(trim(${table.name})) BETWEEN 1 AND 100`),
  check("ck_hr_special_workday_rules_active", sql`${table.active} IN (0, 1)`),
  check("ck_hr_special_workday_rules_revision", sql`${table.revision} > 0`),
]);

export const hrSpecialWorkdayRuleVersions = sqliteTable("hr_special_workday_rule_versions", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id").notNull().references(() => hrSpecialWorkdayRules.id, { onDelete: "restrict" }),
  versionNumber: integer("version_number").notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  wageKind: text("wage_kind", { enum: ["fixed_hourly", "multiplier"] as const }).notNull(),
  fixedAmountMinor: integer("fixed_amount_minor"),
  multiplierPpm: integer("multiplier_ppm"),
  // 0146 的舊欄位保留供既有資料相容；新版本的特殊日加班設定存於下方級距表。
  overtimeRule: text("overtime_rule").notNull(),
  workSource: text("work_source", { enum: ["schedule", "hourly", "manual"] as const }).notNull(),
  note: text("note").notNull().default(""),
  /** 誤設版本以解除保留，不能物理刪除，避免歷史套用與薪資快照失去來源。 */
  voidedAt: text("voided_at"),
  voidedBy: text("voided_by").references(() => users.id, { onDelete: "restrict" }),
  /*
   * 建立新版本時會先把上一版的 valid_to 收尾；原值放在上一版自己的欄位，
   * 解除最新版本時才能準確還原，而不是猜它原本是不是不限期。
   */
  supersededValidTo: text("superseded_valid_to"),
  supersededByVersionId: text("superseded_by_version_id").references((): AnySQLiteColumn => hrSpecialWorkdayRuleVersions.id, { onDelete: "restrict" }),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_special_workday_versions_number").on(table.ruleId, table.versionNumber),
  index("idx_hr_special_workday_versions_period").on(table.validFrom, table.validTo),
  check("ck_hr_special_workday_versions_dates", sql`length(${table.validFrom}) = 10 AND (${table.validTo} IS NULL OR (length(${table.validTo}) = 10 AND ${table.validTo} > ${table.validFrom}))`),
  check("ck_hr_special_workday_versions_wage", sql`(${table.wageKind} = 'fixed_hourly' AND ${table.fixedAmountMinor} IS NOT NULL AND ${table.fixedAmountMinor} >= 0 AND ${table.multiplierPpm} IS NULL) OR (${table.wageKind} = 'multiplier' AND ${table.fixedAmountMinor} IS NULL AND ${table.multiplierPpm} IS NOT NULL AND ${table.multiplierPpm} >= 0)`),
  check("ck_hr_special_workday_versions_overtime", sql`length(trim(${table.overtimeRule})) BETWEEN 1 AND 100`),
  check("ck_hr_special_workday_versions_source", sql`${table.workSource} IN ('schedule', 'hourly', 'manual')`),
  check("ck_hr_special_workday_versions_note", sql`length(${table.note}) <= 1000`),
]);

/** 特殊上班日的加班級距；fromHalfHours 是 1-based 半小時單位索引，前端以 0.0 小時起算的半開區間呈現。 */
export const hrSpecialWorkdayOvertimeRules = sqliteTable("hr_special_workday_overtime_rules", {
  id: text("id").primaryKey(),
  ruleVersionId: text("rule_version_id").notNull().references(() => hrSpecialWorkdayRuleVersions.id, { onDelete: "restrict" }),
  fromHalfHours: integer("from_half_hours").notNull(),
  toHalfHours: integer("to_half_hours"),
  rateKind: text("rate_kind", { enum: ["fixed_hourly", "multiplier"] as const }).notNull(),
  fixedAmountMinor: integer("fixed_amount_minor"),
  multiplierPpm: integer("multiplier_ppm"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_special_workday_overtime_rules_version_from").on(table.ruleVersionId, table.fromHalfHours),
  index("idx_hr_special_workday_overtime_rules_version").on(table.ruleVersionId),
  check("ck_hr_special_workday_overtime_rules_range", sql`${table.fromHalfHours} >= 1 AND (${table.toHalfHours} IS NULL OR ${table.toHalfHours} >= ${table.fromHalfHours})`),
  check("ck_hr_special_workday_overtime_rules_rate", sql`(${table.rateKind} = 'fixed_hourly' AND ${table.fixedAmountMinor} IS NOT NULL AND ${table.fixedAmountMinor} >= 0 AND ${table.multiplierPpm} IS NULL) OR (${table.rateKind} = 'multiplier' AND ${table.fixedAmountMinor} IS NULL AND ${table.multiplierPpm} IS NOT NULL AND ${table.multiplierPpm} >= 0)`),
]);

export const hrSpecialWorkdayAllowances = sqliteTable("hr_special_workday_allowances", {
  id: text("id").primaryKey(),
  ruleVersionId: text("rule_version_id").notNull().references(() => hrSpecialWorkdayRuleVersions.id, { onDelete: "restrict" }),
  itemName: text("item_name").notNull(),
  unitAmountMinor: integer("unit_amount_minor").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_hr_special_workday_allowances_version").on(table.ruleVersionId),
  check("ck_hr_special_workday_allowances_name", sql`length(trim(${table.itemName})) BETWEEN 1 AND 100`),
  check("ck_hr_special_workday_allowances_amount", sql`${table.unitAmountMinor} >= 0`),
]);

export const hrSpecialWorkdayAssignments = sqliteTable("hr_special_workday_assignments", {
  id: text("id").primaryKey(),
  ruleVersionId: text("rule_version_id").notNull().references(() => hrSpecialWorkdayRuleVersions.id, { onDelete: "restrict" }),
  employmentId: text("employment_id").references(() => hrEmployments.id, { onDelete: "restrict" }),
  workerId: text("worker_id").references(() => hrScheduleWorkers.id, { onDelete: "restrict" }),
  workDate: text("work_date").notNull(),
  ruleNameSnapshot: text("rule_name_snapshot").notNull(),
  wageKindSnapshot: text("wage_kind_snapshot").notNull(),
  fixedAmountMinorSnapshot: integer("fixed_amount_minor_snapshot"),
  multiplierPpmSnapshot: integer("multiplier_ppm_snapshot"),
  workSourceSnapshot: text("work_source_snapshot").notNull(),
  allowanceSnapshotJson: text("allowance_snapshot_json").notNull().default("[]"),
  allowanceQuantity: integer("allowance_quantity").notNull().default(0),
  appliedBy: text("applied_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  appliedAt: text("applied_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_special_workday_assignments_employment_date").on(table.employmentId, table.workDate),
  uniqueIndex("idx_hr_special_workday_assignments_worker_date").on(table.workerId, table.workDate),
  index("idx_hr_special_workday_assignments_date").on(table.workDate, table.employmentId, table.workerId),
  check("ck_hr_special_workday_assignments_target", sql`(${table.employmentId} IS NOT NULL AND ${table.workerId} IS NULL) OR (${table.employmentId} IS NULL AND ${table.workerId} IS NOT NULL)`),
  check("ck_hr_special_workday_assignments_date", sql`length(${table.workDate}) = 10`),
  check("ck_hr_special_workday_assignments_quantity", sql`${table.allowanceQuantity} >= 0`),
]);

export const hrOvertimeRequests = sqliteTable("hr_overtime_requests", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  scopeId: text("scope_id").references(() => scopes.id, { onDelete: "restrict" }),
  requestedStart: text("requested_start").notNull(),
  requestedEnd: text("requested_end").notNull(),
  actualStart: text("actual_start"),
  actualEnd: text("actual_end"),
  settlementKind: text("settlement_kind", { enum: ["pay", "compensatory"] as const }).notNull(),
  status: text("status", { enum: ["draft", "pending", "approved", "rejected", "cancelled"] as const }).notNull().default("pending"),
  ratePpm: integer("rate_ppm").notNull().default(1_333_333),
  reason: text("reason").notNull().default(""),
  reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "restrict" }),
  reviewedAt: text("reviewed_at"),
  decisionReason: text("decision_reason").notNull().default(""),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  ...timestamps(),
}, (table) => [
  index("idx_hr_overtime_employment_start").on(table.employmentId, table.requestedStart),
  uniqueIndex("idx_hr_overtime_unique_request").on(table.employmentId, table.requestedStart, table.requestedEnd),
  index("idx_hr_overtime_status").on(table.status, table.requestedStart),
  check("ck_hr_overtime_requested_period", sql`${table.requestedEnd} > ${table.requestedStart}`),
  check("ck_hr_overtime_actual_pair", sql`(${table.actualStart} IS NULL AND ${table.actualEnd} IS NULL) OR (${table.actualStart} IS NOT NULL AND ${table.actualEnd} IS NOT NULL AND ${table.actualEnd} > ${table.actualStart})`),
  check("ck_hr_overtime_settlement", sql`${table.settlementKind} IN ('pay', 'compensatory')`),
  check("ck_hr_overtime_status", sql`${table.status} IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')`),
  check("ck_hr_overtime_rate", sql`${table.ratePpm} BETWEEN 0 AND 10000000`),
  check("ck_hr_overtime_reason", sql`length(${table.reason}) <= 1000`),
  check("ck_hr_overtime_decision_reason", sql`length(${table.decisionReason}) <= 1000`),
  check("ck_hr_overtime_revision", sql`${table.revision} > 0`),
]);

/** 平日／週末／國定假日。班別時間與行事曆共用同一組值，兩邊才對得起來。 */
export type HrDayType = (typeof hrCalendarDays.$inferSelect)["dayType"];
export type HrCalendarDay = typeof hrCalendarDays.$inferSelect;
export type HrScopeShiftAssignment = typeof hrScopeShiftAssignments.$inferSelect;
export type HrScheduleVersion = typeof hrScheduleVersions.$inferSelect;
export type HrScheduleEntry = typeof hrScheduleEntries.$inferSelect;
export type HrScheduleWorker = typeof hrScheduleWorkers.$inferSelect;
export type HrScheduleWorkerEntry = typeof hrScheduleWorkerEntries.$inferSelect;
export type HrOvertimeRequest = typeof hrOvertimeRequests.$inferSelect;
export type HrSpecialWorkdayRule = typeof hrSpecialWorkdayRules.$inferSelect;
export type HrSpecialWorkdayRuleVersion = typeof hrSpecialWorkdayRuleVersions.$inferSelect;
export type HrSpecialWorkdayAllowance = typeof hrSpecialWorkdayAllowances.$inferSelect;
export type HrSpecialWorkdayAssignment = typeof hrSpecialWorkdayAssignments.$inferSelect;
