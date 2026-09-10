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

/** 獎金政策本體可改名，但計算永遠引用不可變的版本。 */
export const hrBonusPolicies = sqliteTable("hr_bonus_policies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  active: integer("active").notNull().default(1),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  ...timestamps(),
}, (table) => [
  check("ck_hr_bonus_policies_name", sql`length(trim(${table.name})) BETWEEN 1 AND 100`),
  check("ck_hr_bonus_policies_active", sql`${table.active} IN (0, 1)`),
  check("ck_hr_bonus_policies_revision", sql`${table.revision} > 0`),
]);

export const hrBonusPolicyVersions = sqliteTable("hr_bonus_policy_versions", {
  id: text("id").primaryKey(),
  policyId: text("policy_id").notNull().references(() => hrBonusPolicies.id, { onDelete: "restrict" }),
  versionNumber: integer("version_number").notNull(),
  scopeId: text("scope_id").notNull().references(() => scopes.id, { onDelete: "restrict" }),
  performanceKind: text("performance_kind", { enum: ["scheduled_daily"] as const }).notNull(),
  revenueKind: text("revenue_kind", { enum: ["sales_amount"] as const }).notNull(),
  bonusKind: text("bonus_kind", { enum: ["team_performance", "individual_performance"] as const }).notNull().default("team_performance"),
  performancePeriod: text("performance_period", { enum: ["current_month", "previous_month"] as const }).notNull().default("current_month"),
  ratePpm: integer("rate_ppm").notNull(),
  // 舊版欄位名為 threshold_minor；業務語意是 policy 的獨立保底門檻。
  guaranteeMinor: integer("threshold_minor").notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_bonus_policy_versions_number").on(table.policyId, table.versionNumber),
  index("idx_hr_bonus_policy_versions_scope_period").on(table.scopeId, table.validFrom),
  check("ck_hr_bonus_policy_versions_number", sql`${table.versionNumber} > 0`),
  check("ck_hr_bonus_policy_versions_kind", sql`${table.performanceKind} = 'scheduled_daily' AND ${table.revenueKind} = 'sales_amount'`),
  check("ck_hr_bonus_policy_versions_rate", sql`${table.ratePpm} BETWEEN 0 AND 1000000`),
  check("ck_hr_bonus_policy_versions_threshold", sql`${table.guaranteeMinor} >= 0`),
  check("ck_hr_bonus_policy_versions_dates", sql`length(${table.validFrom}) = 10 AND (${table.validTo} IS NULL OR (length(${table.validTo}) = 10 AND ${table.validTo} > ${table.validFrom}))`),
]);

export const hrBonusPolicyMembers = sqliteTable("hr_bonus_policy_members", {
  id: text("id").primaryKey(),
  policyVersionId: text("policy_version_id").notNull().references(() => hrBonusPolicyVersions.id, { onDelete: "restrict" }),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  weightUnits: integer("weight_units").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_bonus_policy_members_start").on(table.policyVersionId, table.employmentId, table.validFrom),
  index("idx_hr_bonus_policy_members_employment").on(table.employmentId, table.validFrom),
  check("ck_hr_bonus_policy_members_dates", sql`length(${table.validFrom}) = 10 AND (${table.validTo} IS NULL OR (length(${table.validTo}) = 10 AND ${table.validTo} > ${table.validFrom}))`),
  check("ck_hr_bonus_policy_members_weight", sql`${table.weightUnits} > 0`),
]);

/** 業績在建立獎金池時複製成快照，報表重匯後舊獎金仍可重現。 */
export const hrBonusPools = sqliteTable("hr_bonus_pools", {
  id: text("id").primaryKey(),
  policyVersionId: text("policy_version_id").notNull().references(() => hrBonusPolicyVersions.id, { onDelete: "restrict" }),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  calculationVersion: integer("calculation_version").notNull(),
  status: text("status", { enum: ["calculated", "approved", "closed", "failed"] as const }).notNull().default("calculated"),
  poolAmountMinor: integer("pool_amount_minor").notNull().default(0),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  ...timestamps(),
}, (table) => [
  uniqueIndex("idx_hr_bonus_pools_version_period").on(table.policyVersionId, table.periodStart, table.periodEnd, table.calculationVersion),
  index("idx_hr_bonus_pools_period").on(table.periodStart, table.periodEnd, table.status),
  check("ck_hr_bonus_pools_dates", sql`length(${table.periodStart}) = 10 AND length(${table.periodEnd}) = 10 AND ${table.periodEnd} > ${table.periodStart}`),
  check("ck_hr_bonus_pools_version", sql`${table.calculationVersion} > 0`),
  check("ck_hr_bonus_pools_status", sql`${table.status} IN ('calculated', 'approved', 'closed', 'failed')`),
  check("ck_hr_bonus_pools_amount", sql`${table.poolAmountMinor} >= 0`),
  check("ck_hr_bonus_pools_revision", sql`${table.revision} > 0`),
]);

/** 薪資計算前可被政策讀取的業績輸入；獎金池仍會另外保存不可變結果快照。 */
export const hrBonusPerformanceSnapshots = sqliteTable("hr_bonus_performance_snapshots", {
  id: text("id").primaryKey(),
  scopeId: text("scope_id").notNull().references(() => scopes.id, { onDelete: "restrict" }),
  employmentId: text("employment_id").references(() => hrEmployments.id, { onDelete: "restrict" }),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  sourceKind: text("source_kind", { enum: ["manual", "report"] as const }).notNull(),
  sourceRef: text("source_ref").notNull().default(""),
  provenanceJson: text("provenance_json").notNull().default("{}"),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_hr_bonus_performance_scope_period").on(table.scopeId, table.periodStart, table.periodEnd),
  index("idx_hr_bonus_performance_employment_period").on(table.employmentId, table.periodStart, table.periodEnd),
  uniqueIndex("idx_hr_bonus_performance_source").on(table.scopeId, table.employmentId, table.periodStart, table.periodEnd, table.sourceRef),
  check("ck_hr_bonus_performance_period", sql`${table.periodEnd} > ${table.periodStart}`),
  check("ck_hr_bonus_performance_amount", sql`${table.amountMinor} >= 0`),
  check("ck_hr_bonus_performance_kind", sql`${table.sourceKind} IN ('manual', 'report')`),
  check("ck_hr_bonus_performance_provenance", sql`length(${table.provenanceJson}) <= 10000`),
]);

export const hrBonusRevenueSnapshots = sqliteTable("hr_bonus_revenue_snapshots", {
  id: text("id").primaryKey(),
  bonusPoolId: text("bonus_pool_id").notNull().references(() => hrBonusPools.id, { onDelete: "restrict" }),
  scopeId: text("scope_id").notNull().references(() => scopes.id, { onDelete: "restrict" }),
  employmentId: text("employment_id").references(() => hrEmployments.id, { onDelete: "restrict" }),
  sourceKind: text("source_kind", { enum: ["manual", "report"] as const }).notNull(),
  sourceRef: text("source_ref").notNull().default(""),
  sourceStart: text("source_start").notNull(),
  sourceEnd: text("source_end").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  capturedAt: text("captured_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  provenanceJson: text("provenance_json").notNull().default("{}"),
}, (table) => [
  uniqueIndex("idx_hr_bonus_revenue_snapshots_source").on(table.bonusPoolId, table.scopeId, table.employmentId, table.sourceStart),
  index("idx_hr_bonus_revenue_snapshots_period").on(table.scopeId, table.sourceStart, table.sourceEnd),
  check("ck_hr_bonus_revenue_snapshots_kind", sql`${table.sourceKind} IN ('manual', 'report')`),
  check("ck_hr_bonus_revenue_snapshots_period", sql`${table.sourceEnd} > ${table.sourceStart}`),
  check("ck_hr_bonus_revenue_snapshots_provenance", sql`length(${table.provenanceJson}) <= 10000`),
]);

export const hrBonusAllocations = sqliteTable("hr_bonus_allocations", {
  id: text("id").primaryKey(),
  bonusPoolId: text("bonus_pool_id").notNull().references(() => hrBonusPools.id, { onDelete: "restrict" }),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  weightUnits: integer("weight_units").notNull(),
  scheduledDays: integer("scheduled_days").notNull(),
  revenueMinor: integer("revenue_minor").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  roundingAdjustmentMinor: integer("rounding_adjustment_minor").notNull().default(0),
  explanationJson: text("explanation_json").notNull().default("{}"),
}, (table) => [
  uniqueIndex("idx_hr_bonus_allocations_pool_employment").on(table.bonusPoolId, table.employmentId),
  check("ck_hr_bonus_allocations_weight", sql`${table.weightUnits} > 0`),
  check("ck_hr_bonus_allocations_days", sql`${table.scheduledDays} >= 0`),
  check("ck_hr_bonus_allocations_revenue", sql`${table.revenueMinor} >= 0`),
  check("ck_hr_bonus_allocations_amount", sql`${table.amountMinor} >= 0`),
]);

export type HrBonusPolicyVersion = typeof hrBonusPolicyVersions.$inferSelect;
export type HrBonusPolicyMember = typeof hrBonusPolicyMembers.$inferSelect;
export type HrBonusPerformanceSnapshot = typeof hrBonusPerformanceSnapshots.$inferSelect;
export type HrBonusPool = typeof hrBonusPools.$inferSelect;
export type HrBonusAllocation = typeof hrBonusAllocations.$inferSelect;
