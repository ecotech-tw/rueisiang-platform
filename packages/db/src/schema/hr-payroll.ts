import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { hrEmployments } from "./hr-people.js";
import { hrScheduleWorkers } from "./hr-scheduling.js";

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
/** 沒有平台帳號的排班支援人員也需要薪資版本；目前主要使用日薪。 */
export const hrCompensationItems = sqliteTable("hr_compensation_items", {
  id: text("id").primaryKey(),
  compensationVersionId: text("compensation_version_id").notNull().references(() => hrCompensationVersions.id, { onDelete: "restrict" }),
  itemName: text("item_name").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  itemKind: text("item_kind", { enum: ["fixed", "variable"] as const }).notNull(),
  includeOvertime: integer("include_overtime").notNull().default(0),
  includeInsurance: integer("include_insurance").notNull().default(0),
  includeTax: integer("include_tax").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
}, (table) => [
  index("idx_hr_compensation_items_version").on(table.compensationVersionId),
  check("ck_hr_compensation_items_name", sql`length(trim(${table.itemName})) BETWEEN 1 AND 100`),
  check("ck_hr_compensation_items_amount", sql`${table.amountMinor} >= 0`),
  check("ck_hr_compensation_items_kind", sql`${table.itemKind} IN ('fixed', 'variable')`),
  check("ck_hr_compensation_items_flags", sql`${table.includeOvertime} IN (0, 1) AND ${table.includeInsurance} IN (0, 1) AND ${table.includeTax} IN (0, 1)`),
]);

export const hrWorkerCompensationVersions = sqliteTable("hr_worker_compensation_versions", {
  id: text("id").primaryKey(),
  workerId: text("worker_id").notNull().references(() => hrScheduleWorkers.id, { onDelete: "restrict" }),
  versionNumber: integer("version_number").notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  payBasis: text("pay_basis", { enum: ["monthly", "daily", "hourly"] as const }).notNull(),
  baseAmountMinor: integer("base_amount_minor").notNull(),
  note: text("note").notNull().default(""),
  ...historyTimestamps(),
}, (table) => [
  uniqueIndex("idx_hr_worker_compensation_versions_number").on(table.workerId, table.versionNumber),
  index("idx_hr_worker_compensation_versions_period").on(table.workerId, table.validFrom),
  check("ck_hr_worker_compensation_versions_number", sql`${table.versionNumber} > 0`),
  check("ck_hr_worker_compensation_versions_dates", sql`length(${table.validFrom}) = 10 AND (${table.validTo} IS NULL OR (length(${table.validTo}) = 10 AND ${table.validTo} > ${table.validFrom}))`),
  check("ck_hr_worker_compensation_versions_basis", sql`${table.payBasis} IN ('monthly', 'daily', 'hourly')`),
  check("ck_hr_worker_compensation_versions_amount", sql`${table.baseAmountMinor} >= 0`),
  check("ck_hr_worker_compensation_versions_note", sql`length(${table.note}) <= 1000`),
]);

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
/** 假別主檔供月度人工登記使用；舊的 hr_leave_requests 流程保留供歷史資料相容。 */
export const hrInsuranceContributionRules = sqliteTable("hr_insurance_contribution_rules", {
  id: text("id").primaryKey(),
  scheme: text("scheme", { enum: ["labor", "health"] as const }).notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  employeeRatePpm: integer("employee_rate_ppm").notNull(),
  employerRatePpm: integer("employer_rate_ppm").notNull(),
  dependentRatePpm: integer("dependent_rate_ppm").notNull().default(1_000_000),
  sourceKind: text("source_kind", { enum: ["official", "manual"] as const }).notNull(),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_hr_insurance_contribution_rules_period").on(table.scheme, table.validFrom, table.validTo),
  check("ck_hr_insurance_contribution_rules_dates", sql`length(${table.validFrom}) = 10 AND (${table.validTo} IS NULL OR (length(${table.validTo}) = 10 AND ${table.validTo} > ${table.validFrom}))`),
  check("ck_hr_insurance_contribution_rules_rate", sql`${table.employeeRatePpm} BETWEEN 0 AND 1000000 AND ${table.employerRatePpm} BETWEEN 0 AND 1000000 AND ${table.dependentRatePpm} BETWEEN 0 AND 1000000`),
  check("ck_hr_insurance_contribution_rules_source", sql`${table.sourceKind} IN ('official', 'manual')`),
  check("ck_hr_insurance_contribution_rules_note", sql`length(${table.note}) <= 1000`),
]);

export const hrInsuranceRateTables = sqliteTable("hr_insurance_rate_tables", {
  id: text("id").primaryKey(),
  scheme: text("scheme", { enum: ["labor", "health"] as const }).notNull(),
  year: integer("year").notNull(),
  status: text("status", { enum: ["draft", "active", "archived"] as const }).notNull().default("draft"),
  sourceUrl: text("source_url").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  dataJson: text("data_json").notNull(),
  contentHash: text("content_hash").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  activatedAt: text("activated_at"),
  activatedBy: text("activated_by").references(() => users.id, { onDelete: "restrict" }),
}, (table) => [
  uniqueIndex("idx_hr_insurance_rate_tables_scheme_year_status").on(table.scheme, table.year, table.status).where(sql`${table.status} IN ('draft', 'active')`),
  index("idx_hr_insurance_rate_tables_year").on(table.year, table.scheme),
  check("ck_hr_insurance_rate_tables_scheme", sql`${table.scheme} IN ('labor', 'health')`),
  check("ck_hr_insurance_rate_tables_year", sql`${table.year} BETWEEN 1900 AND 9999`),
  check("ck_hr_insurance_rate_tables_status", sql`${table.status} IN ('draft', 'active', 'archived')`),
  check("ck_hr_insurance_rate_tables_url", sql`length(${table.sourceUrl}) BETWEEN 1 AND 500`),
]);

export const hrLeaveTypes = sqliteTable("hr_leave_types", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  defaultPayRatePpm: integer("default_pay_rate_ppm").notNull().default(1_000_000),
  active: integer("active").notNull().default(1),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_leave_types_name").on(table.name),
  check("ck_hr_leave_types_name", sql`length(trim(${table.name})) BETWEEN 1 AND 80`),
  check("ck_hr_leave_types_rate", sql`${table.defaultPayRatePpm} BETWEEN 0 AND 1000000`),
  check("ck_hr_leave_types_active", sql`${table.active} IN (0, 1)`),
]);

/** 月度假勤是薪資前的人工登記，不走申請／簽核流程；金額以新臺幣元保存。 */
export const hrMonthlyLeaveEntries = sqliteTable("hr_monthly_leave_entries", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  leaveTypeId: text("leave_type_id").notNull().references(() => hrLeaveTypes.id, { onDelete: "restrict" }),
  leaveDate: text("leave_date").notNull(),
  hoursHalfUnits: integer("hours_half_units").notNull(),
  payRatePpm: integer("pay_rate_ppm").notNull(),
  deductionAmount: integer("deduction_amount").notNull(),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: text("updated_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revision: integer("revision").notNull().default(1),
}, (table) => [
  uniqueIndex("idx_hr_monthly_leave_entries_unique").on(table.employmentId, table.leaveTypeId, table.leaveDate),
  index("idx_hr_monthly_leave_entries_date").on(table.leaveDate, table.employmentId),
  check("ck_hr_monthly_leave_entries_date", sql`length(${table.leaveDate}) = 10`),
  check("ck_hr_monthly_leave_entries_hours", sql`${table.hoursHalfUnits} > 0`),
  check("ck_hr_monthly_leave_entries_rate", sql`${table.payRatePpm} BETWEEN 0 AND 1000000`),
  check("ck_hr_monthly_leave_entries_deduction", sql`${table.deductionAmount} >= 0`),
  check("ck_hr_monthly_leave_entries_note", sql`length(${table.note}) <= 1000`),
  check("ck_hr_monthly_leave_entries_revision", sql`${table.revision} > 0`),
]);

/** 時薪每月人工登記；hours_half_units 以 0.5 小時為一單位，no_work 明確表示本期無工時。 */
export const hrMonthlyHourlyEntries = sqliteTable("hr_monthly_hourly_entries", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  workDate: text("work_date").notNull(),
  hoursHalfUnits: integer("hours_half_units").notNull().default(0),
  noWork: integer("no_work").notNull().default(0),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: text("updated_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revision: integer("revision").notNull().default(1),
}, (table) => [
  uniqueIndex("idx_hr_monthly_hourly_entries_unique").on(table.employmentId, table.workDate),
  index("idx_hr_monthly_hourly_entries_date").on(table.workDate, table.employmentId),
  check("ck_hr_monthly_hourly_entries_date", sql`length(${table.workDate}) = 10`),
  check("ck_hr_monthly_hourly_entries_hours", sql`${table.hoursHalfUnits} >= 0`),
  check("ck_hr_monthly_hourly_entries_no_work", sql`${table.noWork} IN (0, 1)`),
  check("ck_hr_monthly_hourly_entries_state", sql`${table.noWork} = 1 OR ${table.hoursHalfUnits} > 0`),
  check("ck_hr_monthly_hourly_entries_note", sql`length(${table.note}) <= 1000`),
  check("ck_hr_monthly_hourly_entries_revision", sql`${table.revision} > 0`),
]);

export const hrLeaveRequests = sqliteTable("hr_leave_requests", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  leaveType: text("leave_type").notNull(),
  status: text("status", { enum: ["draft", "pending", "approved", "rejected", "cancelled"] as const }).notNull(),
  startsOn: text("starts_on").notNull(),
  endsOn: text("ends_on").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  /** 請假提交時凍結給薪比例；不靠 leaveType 名稱猜測是否扣薪。 */
  payRatePpm: integer("pay_rate_ppm").notNull().default(1_000_000),
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
  check("ck_hr_leave_requests_pay_rate", sql`${table.payRatePpm} BETWEEN 0 AND 1000000`),
  check("ck_hr_leave_requests_reason", sql`length(${table.reason}) <= 1000`),
]);

export type HrCompensationItem = typeof hrCompensationItems.$inferSelect;
export type HrInsuranceContributionRule = typeof hrInsuranceContributionRules.$inferSelect;
export type HrInsuranceRateTable = typeof hrInsuranceRateTables.$inferSelect;
export type HrLeaveType = typeof hrLeaveTypes.$inferSelect;
export type HrMonthlyLeaveEntry = typeof hrMonthlyLeaveEntries.$inferSelect;
export type HrMonthlyHourlyEntry = typeof hrMonthlyHourlyEntries.$inferSelect;
