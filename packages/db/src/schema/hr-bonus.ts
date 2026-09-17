import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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

/** Policy 版本的 Scope 集合；scope_id 留在版本表作為舊資料相容欄位，新的計算以本表為準。 */
export const hrBonusPolicyVersionScopes = sqliteTable("hr_bonus_policy_version_scopes", {
  policyVersionId: text("policy_version_id").notNull().references(() => hrBonusPolicyVersions.id, { onDelete: "restrict" }),
  scopeId: text("scope_id").notNull().references(() => scopes.id, { onDelete: "restrict" }),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.policyVersionId, table.scopeId] }),
  index("idx_hr_bonus_policy_version_scopes_scope").on(table.scopeId, table.policyVersionId),
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

export type HrBonusPolicyVersion = typeof hrBonusPolicyVersions.$inferSelect;
export type HrBonusPolicyVersionScope = typeof hrBonusPolicyVersionScopes.$inferSelect;
export type HrBonusPolicyMember = typeof hrBonusPolicyMembers.$inferSelect;
