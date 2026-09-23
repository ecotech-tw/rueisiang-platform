import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { hrEmployments } from "./hr-people.js";
import { hrScheduleWorkers } from "./hr-scheduling.js";

const historyTimestamps = () => ({
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
});

/** 薪資只新增版本，不覆寫舊資料；誤登時以 voidedAt 解除，validTo 是不再適用的第一天。 */
export const hrCompensationVersions = sqliteTable("hr_compensation_versions", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  versionNumber: integer("version_number").notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  payBasis: text("pay_basis", { enum: ["monthly", "daily", "hourly"] as const }).notNull(),
  baseAmountMinor: integer("base_amount_minor").notNull(),
  note: text("note").notNull().default(""),
  voidedAt: text("voided_at"),
  voidedBy: text("voided_by").references(() => users.id, { onDelete: "restrict" }),
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
export const hrCompensationItems = sqliteTable("hr_compensation_items", {
  id: text("id").primaryKey(),
  compensationVersionId: text("compensation_version_id").notNull().references(() => hrCompensationVersions.id, { onDelete: "restrict" }),
  itemName: text("item_name").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  itemKind: text("item_kind", { enum: ["fixed", "variable"] as const }).notNull(),
  /*
   * 這筆金額是「每月」「每工作日」還是「每小時」給付，跟本薪的計薪方式分開。
   * 日薪人員的職務津貼通常仍是月給；沒有這個欄位時津貼會被當成日給，上班 20 天就乘 20 倍。
   */
  amountBasis: text("amount_basis", { enum: ["monthly", "daily", "hourly"] as const }).notNull().default("monthly"),
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
  /*
   * amount_basis 沒有 CHECK：SQLite 不能 ALTER 加 CHECK，drizzle 會改成「建新表→搬→刪舊表」，
   * 那種 migration 在 D1 的交易裡會連坐刪資料（見 CLAUDE.md 的 0023）。值域由 TS 的 enum 與 API 驗證把關。
   */
  check("ck_hr_compensation_items_flags", sql`${table.includeOvertime} IN (0, 1) AND ${table.includeInsurance} IN (0, 1) AND ${table.includeTax} IN (0, 1)`),
]);

/** 沒有平台帳號的排班支援人員也需要薪資版本；新版本可選日薪或時薪，monthly 僅保留給既有歷史資料。 */
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
  /** 舊資料為 NULL；勞保新規則以普通事故與就業保險分開保存。 */
  component: text("component", { enum: ["ordinary_accident", "employment"] as const }),
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
  index("idx_hr_insurance_contribution_rules_period").on(table.scheme, table.component, table.validFrom, table.validTo),
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
  /** 特休額度由週年制台帳扣除；其他假別維持獨立規則與額度。 */
  leaveKind: text("leave_kind", { enum: ["annual", "other"] as const }).notNull().default("other"),
  defaultPayRatePpm: integer("default_pay_rate_ppm").notNull().default(1_000_000),
  active: integer("active").notNull().default(1),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_leave_types_name").on(table.name),
  check("ck_hr_leave_types_name", sql`length(trim(${table.name})) BETWEEN 1 AND 80`),
  // leave_kind 是新增欄位；避免重建既有假別表造成歷史資料搬移風險，值域由 API 與 TypeScript enum 把關。
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
  /** 新申請保存假別主檔關聯；舊資料仍保留 leaveType snapshot。 */
  leaveTypeId: text("leave_type_id").references(() => hrLeaveTypes.id, { onDelete: "restrict" }),
  leaveType: text("leave_type").notNull(),
  status: text("status", { enum: ["draft", "pending", "approved", "rejected", "cancelled"] as const }).notNull(),
  /** 台北時間轉成 canonical UTC wall-clock 保存；startsOn／endsOn 是相容用的日期覆蓋範圍。 */
  startsAt: text("starts_at").notNull().default(""),
  endsAt: text("ends_at").notNull().default(""),
  startsOn: text("starts_on").notNull(),
  endsOn: text("ends_on").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  /** 請假提交時由所選假別凍結；不接受申請人自訂給薪比例。 */
  payRatePpm: integer("pay_rate_ppm").notNull().default(1_000_000),
  reason: text("reason").notNull().default(""),
  reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "restrict" }),
  reviewedAt: text("reviewed_at"),
  reviewComment: text("review_comment"),
  ...historyTimestamps(),
}, (table) => [
  index("idx_hr_leave_requests_employment_period").on(table.employmentId, table.startsOn),
  index("idx_hr_leave_requests_employment_time").on(table.employmentId, table.startsAt),
  index("idx_hr_leave_requests_leave_type").on(table.leaveTypeId),
  check("ck_hr_leave_requests_type", sql`length(trim(${table.leaveType})) BETWEEN 1 AND 80`),
  check("ck_hr_leave_requests_status", sql`${table.status} IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')`),
  check("ck_hr_leave_requests_dates", sql`length(${table.startsOn}) = 10 AND length(${table.endsOn}) = 10 AND ${table.endsOn} > ${table.startsOn}`),
  check("ck_hr_leave_requests_duration", sql`${table.durationMinutes} > 0`),
  check("ck_hr_leave_requests_pay_rate", sql`${table.payRatePpm} BETWEEN 0 AND 1000000`),
  check("ck_hr_leave_requests_reason", sql`length(${table.reason}) <= 1000`),
]);

/** 公司共用的特休政策版本；法定級距是資料，不散落在計算程式裡。 */
export const hrAnnualLeavePolicyVersions = sqliteTable("hr_annual_leave_policy_versions", {
  id: text("id").primaryKey(),
  policyKey: text("policy_key").notNull().default("annual_leave"),
  versionNumber: integer("version_number").notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  basis: text("basis", { enum: ["anniversary"] as const }).notNull().default("anniversary"),
  dailyMinutes: integer("daily_minutes").notNull().default(480),
  minimumUnitMinutes: integer("minimum_unit_minutes").notNull().default(30),
  carryoverAllowed: integer("carryover_allowed").notNull().default(0),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_annual_leave_policy_version").on(table.policyKey, table.versionNumber),
  index("idx_hr_annual_leave_policy_period").on(table.policyKey, table.validFrom),
  check("ck_hr_annual_leave_policy_dates", sql`length(${table.validFrom}) = 10 AND (${table.validTo} IS NULL OR (length(${table.validTo}) = 10 AND ${table.validTo} > ${table.validFrom}))`),
  check("ck_hr_annual_leave_policy_basis", sql`${table.basis} = 'anniversary'`),
  check("ck_hr_annual_leave_policy_minutes", sql`${table.dailyMinutes} > 0 AND ${table.dailyMinutes} % ${table.minimumUnitMinutes} = 0 AND ${table.minimumUnitMinutes} = 30`),
  check("ck_hr_annual_leave_policy_carryover", sql`${table.carryoverAllowed} IN (0, 1)`),
  check("ck_hr_annual_leave_policy_note", sql`length(${table.note}) <= 1000`),
]);

/** 特休年資級距；10 年以上的上限也以版本資料列表示。 */
export const hrAnnualLeaveBrackets = sqliteTable("hr_annual_leave_brackets", {
  id: text("id").primaryKey(),
  policyVersionId: text("policy_version_id").notNull().references(() => hrAnnualLeavePolicyVersions.id, { onDelete: "restrict" }),
  minServiceMonths: integer("min_service_months").notNull(),
  maxServiceMonths: integer("max_service_months"),
  entitledDays: integer("entitled_days").notNull(),
  label: text("label").notNull().default(""),
}, (table) => [
  uniqueIndex("idx_hr_annual_leave_bracket_start").on(table.policyVersionId, table.minServiceMonths),
  index("idx_hr_annual_leave_bracket_policy").on(table.policyVersionId, table.minServiceMonths),
  check("ck_hr_annual_leave_bracket_range", sql`${table.minServiceMonths} >= 6 AND (${table.maxServiceMonths} IS NULL OR ${table.maxServiceMonths} > ${table.minServiceMonths})`),
  check("ck_hr_annual_leave_bracket_days", sql`${table.entitledDays} > 0 AND ${table.entitledDays} <= 30`),
  check("ck_hr_annual_leave_bracket_label", sql`length(${table.label}) <= 100`),
]);

/** 每個 employment 的週年特休額度；periodEnd 採半開區間，等於下一個週年生效日。 */
export const hrAnnualLeaveEntitlements = sqliteTable("hr_annual_leave_entitlements", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  policyVersionId: text("policy_version_id").notNull().references(() => hrAnnualLeavePolicyVersions.id, { onDelete: "restrict" }),
  bracketId: text("bracket_id").notNull().references(() => hrAnnualLeaveBrackets.id, { onDelete: "restrict" }),
  serviceMonths: integer("service_months").notNull(),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  entitledHalfHours: integer("entitled_half_hours").notNull(),
  status: text("status", { enum: ["open", "settled"] as const }).notNull().default("open"),
  settledAt: text("settled_at"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_annual_leave_entitlement_period").on(table.employmentId, table.periodStart),
  index("idx_hr_annual_leave_entitlement_employee").on(table.employmentId, table.periodEnd),
  check("ck_hr_annual_leave_entitlement_dates", sql`length(${table.periodStart}) = 10 AND length(${table.periodEnd}) = 10 AND ${table.periodEnd} > ${table.periodStart}`),
  check("ck_hr_annual_leave_entitlement_service", sql`${table.serviceMonths} >= 6`),
  check("ck_hr_annual_leave_entitlement_amount", sql`${table.entitledHalfHours} > 0`),
  check("ck_hr_annual_leave_entitlement_status", sql`${table.status} IN ('open', 'settled')`),
]);

/** 特休額度 append-only 台帳；未休結算與人工調整也不覆寫原始 grant。 */
export const hrAnnualLeaveLedger = sqliteTable("hr_annual_leave_ledger", {
  id: text("id").primaryKey(),
  entitlementId: text("entitlement_id").notNull().references(() => hrAnnualLeaveEntitlements.id, { onDelete: "restrict" }),
  /** settlement_reversal 也承載已核准請假取消的反向紀錄；ledger 永遠不覆寫。 */
  entryKind: text("entry_kind", { enum: ["grant", "leave_request", "manual_adjustment", "settlement", "settlement_reversal"] as const }).notNull(),
  deltaHalfHours: integer("delta_half_hours").notNull(),
  sourceKey: text("source_key").notNull(),
  leaveRequestId: text("leave_request_id").references(() => hrLeaveRequests.id, { onDelete: "restrict" }),
  note: text("note").notNull().default(""),
  createdBy: text("created_by").references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_annual_leave_ledger_source").on(table.sourceKey),
  index("idx_hr_annual_leave_ledger_entitlement").on(table.entitlementId, table.createdAt),
  check("ck_hr_annual_leave_ledger_kind", sql`${table.entryKind} IN ('grant', 'leave_request', 'manual_adjustment', 'settlement', 'settlement_reversal')`),
  check("ck_hr_annual_leave_ledger_delta", sql`${table.deltaHalfHours} <> 0`),
  check("ck_hr_annual_leave_ledger_note", sql`length(${table.note}) <= 1000`),
]);

export type HrCompensationItem = typeof hrCompensationItems.$inferSelect;
export type HrInsuranceContributionRule = typeof hrInsuranceContributionRules.$inferSelect;
export type HrInsuranceRateTable = typeof hrInsuranceRateTables.$inferSelect;
export type HrLeaveType = typeof hrLeaveTypes.$inferSelect;
export type HrMonthlyLeaveEntry = typeof hrMonthlyLeaveEntries.$inferSelect;
export type HrMonthlyHourlyEntry = typeof hrMonthlyHourlyEntries.$inferSelect;
