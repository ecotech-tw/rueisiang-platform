import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { hrEmployments } from "./hr-people.js";
import { scopes } from "./reports.js";

const timestamps = () => ({
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revision: integer("revision").notNull().default(1),
});

/** 班次先做成版本；已發布的班表只引用固定版本，不會因為改名稱而改歷史。 */
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

export const hrShiftVersions = sqliteTable("hr_shift_versions", {
  id: text("id").primaryKey(),
  shiftTemplateId: text("shift_template_id").notNull().references(() => hrShiftTemplates.id, { onDelete: "restrict" }),
  versionNumber: integer("version_number").notNull(),
  startSecond: integer("start_second").notNull(),
  endSecond: integer("end_second").notNull(),
  endDayOffset: integer("end_day_offset").notNull().default(0),
  payFactorPpm: integer("pay_factor_ppm").notNull().default(1_000_000),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_shift_versions_number").on(table.shiftTemplateId, table.versionNumber),
  index("idx_hr_shift_versions_template").on(table.shiftTemplateId, table.createdAt),
  check("ck_hr_shift_versions_number", sql`${table.versionNumber} > 0`),
  check("ck_hr_shift_versions_start", sql`${table.startSecond} BETWEEN 0 AND 86399`),
  check("ck_hr_shift_versions_end", sql`${table.endSecond} BETWEEN 0 AND 86399`),
  check("ck_hr_shift_versions_day_offset", sql`${table.endDayOffset} BETWEEN 0 AND 1`),
  check("ck_hr_shift_versions_period", sql`${table.endDayOffset} = 1 OR ${table.endSecond} > ${table.startSecond}`),
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

export const hrScheduleEntries = sqliteTable("hr_schedule_entries", {
  id: text("id").primaryKey(),
  scheduleVersionId: text("schedule_version_id").notNull().references(() => hrScheduleVersions.id, { onDelete: "restrict" }),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  scopeId: text("scope_id").notNull().references(() => scopes.id, { onDelete: "restrict" }),
  shiftVersionId: text("shift_version_id").notNull().references(() => hrShiftVersions.id, { onDelete: "restrict" }),
  workDate: text("work_date").notNull(),
  startsAt: text("starts_at").notNull(),
  endsAt: text("ends_at").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_schedule_entries_unique").on(table.scheduleVersionId, table.employmentId, table.workDate, table.startsAt),
  index("idx_hr_schedule_entries_employment_date").on(table.employmentId, table.workDate),
  index("idx_hr_schedule_entries_scope_date").on(table.scopeId, table.workDate),
  check("ck_hr_schedule_entries_date", sql`length(${table.workDate}) = 10`),
  check("ck_hr_schedule_entries_period", sql`${table.endsAt} > ${table.startsAt}`),
]);

/** 加班申請與核定時段分開保存；只有 approved + pay 才會進入薪資試算。 */
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

export type HrScheduleVersion = typeof hrScheduleVersions.$inferSelect;
export type HrScheduleEntry = typeof hrScheduleEntries.$inferSelect;
export type HrOvertimeRequest = typeof hrOvertimeRequests.$inferSelect;
