import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { hrEmployments } from "./hr-people.js";

const historyTimestamps = () => ({
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
});

/** 薪資只新增版本，不覆寫舊資料；validTo 是不再適用的第一天。 */
export const hrCompensationVersions = sqliteTable("hr_compensation_versions", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  versionNumber: integer("version_number").notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  payBasis: text("pay_basis", { enum: ["monthly", "daily", "hourly"] as const }).notNull(),
  baseAmountMinor: integer("base_amount_minor").notNull(),
  note: text("note").notNull().default(""),
  ...historyTimestamps(),
}, (table) => [
  uniqueIndex("idx_hr_compensation_versions_number").on(table.employmentId, table.versionNumber),
  index("idx_hr_compensation_versions_period").on(table.employmentId, table.validFrom),
  check("ck_hr_compensation_versions_number", sql`${table.versionNumber} > 0`),
  check("ck_hr_compensation_versions_dates", sql`length(${table.validFrom}) = 10 AND (${table.validTo} IS NULL OR (length(${table.validTo}) = 10 AND ${table.validTo} > ${table.validFrom}))`),
  check("ck_hr_compensation_versions_basis", sql`${table.payBasis} IN ('monthly', 'daily', 'hourly')`),
  check("ck_hr_compensation_versions_amount", sql`${table.baseAmountMinor} >= 0`),
  check("ck_hr_compensation_versions_note", sql`length(${table.note}) <= 1000`),
]);

/** 勞保與健保分開留存；每次加保、退保或級距變更都是不可覆寫的版本。 */
export const hrInsuranceVersions = sqliteTable("hr_insurance_versions", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  scheme: text("scheme", { enum: ["labor", "health"] as const }).notNull(),
  versionNumber: integer("version_number").notNull(),
  status: text("status", { enum: ["enrolled", "withdrawn"] as const }).notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  insuredAmountMinor: integer("insured_amount_minor").notNull(),
  dependentCount: integer("dependent_count").notNull().default(0),
  rateYear: integer("rate_year").notNull(),
  sourceKind: text("source_kind", { enum: ["official", "manual"] as const }).notNull(),
  sourceUrl: text("source_url").notNull().default(""),
  note: text("note").notNull().default(""),
  ...historyTimestamps(),
}, (table) => [
  uniqueIndex("idx_hr_insurance_versions_number").on(table.employmentId, table.scheme, table.versionNumber),
  index("idx_hr_insurance_versions_period").on(table.employmentId, table.scheme, table.validFrom),
  check("ck_hr_insurance_versions_scheme", sql`${table.scheme} IN ('labor', 'health')`),
  check("ck_hr_insurance_versions_number", sql`${table.versionNumber} > 0`),
  check("ck_hr_insurance_versions_status", sql`${table.status} IN ('enrolled', 'withdrawn')`),
  check("ck_hr_insurance_versions_dates", sql`length(${table.validFrom}) = 10 AND (${table.validTo} IS NULL OR (length(${table.validTo}) = 10 AND ${table.validTo} > ${table.validFrom}))`),
  check("ck_hr_insurance_versions_amount", sql`${table.insuredAmountMinor} >= 0`),
  check("ck_hr_insurance_versions_dependents", sql`${table.dependentCount} BETWEEN 0 AND 3`),
  check("ck_hr_insurance_versions_year", sql`${table.rateYear} BETWEEN 1900 AND 9999`),
  check("ck_hr_insurance_versions_source", sql`${table.sourceKind} IN ('official', 'manual')`),
  check("ck_hr_insurance_versions_source_url", sql`length(${table.sourceUrl}) <= 500`),
  check("ck_hr_insurance_versions_note", sql`length(${table.note}) <= 1000`),
]);

/** 假勤資料可能由其他流程匯入；員工內頁先以歷史檢視為主。 */
export const hrLeaveRequests = sqliteTable("hr_leave_requests", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  leaveType: text("leave_type").notNull(),
  status: text("status", { enum: ["draft", "pending", "approved", "rejected", "cancelled"] as const }).notNull(),
  startsOn: text("starts_on").notNull(),
  endsOn: text("ends_on").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  reason: text("reason").notNull().default(""),
  reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "restrict" }),
  reviewedAt: text("reviewed_at"),
  reviewComment: text("review_comment"),
  ...historyTimestamps(),
}, (table) => [
  index("idx_hr_leave_requests_employment_period").on(table.employmentId, table.startsOn),
  check("ck_hr_leave_requests_type", sql`length(trim(${table.leaveType})) BETWEEN 1 AND 80`),
  check("ck_hr_leave_requests_status", sql`${table.status} IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')`),
  check("ck_hr_leave_requests_dates", sql`length(${table.startsOn}) = 10 AND length(${table.endsOn}) = 10 AND ${table.endsOn} > ${table.startsOn}`),
  check("ck_hr_leave_requests_duration", sql`${table.durationMinutes} > 0`),
  check("ck_hr_leave_requests_reason", sql`length(${table.reason}) <= 1000`),
]);
