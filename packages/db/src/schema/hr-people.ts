/**
 * 人事資料的唯一基準是 hr_employments：有未封存列的 User 才是目前員工。
 * 任職不是版本鏈；升遷／調職直接更新 position，薪資版本另由敘薪資料管理。
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { scopes } from "./reports.js";

const timestamps = () => ({
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const hrEmployments = sqliteTable("hr_employments", {
  id: text("id").primaryKey(),
  employeeUserId: text("employee_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  employeeNumber: text("employee_number").notNull(),
  position: text("position").notNull().default("一般職員"),
  supervisorUserId: text("supervisor_user_id").references(() => users.id, { onDelete: "restrict" }),
  archivedAt: text("archived_at"),
  revision: integer("revision").notNull().default(1),
  ...timestamps(),
}, (t) => [
  uniqueIndex("idx_hr_employments_active_user").on(t.employeeUserId).where(sql`${t.archivedAt} IS NULL`),
  uniqueIndex("idx_hr_employments_active_number").on(t.employeeNumber).where(sql`${t.archivedAt} IS NULL`),
  index("idx_hr_employments_archived").on(t.archivedAt),
  check("ck_hr_employments_number", sql`length(trim(${t.employeeNumber})) BETWEEN 1 AND 40`),
  check("ck_hr_employments_position", sql`length(trim(${t.position})) BETWEEN 1 AND 100`),
  check("ck_hr_employments_revision", sql`${t.revision} > 0`),
]);

/** 舊任職動作資料是稽核歷史，保留 table 定義避免後續 schema diff 物理刪除。 */
export const hrEmploymentActions = sqliteTable("hr_employment_actions", {
  id: text("id").primaryKey(),
  employeeUserId: text("employee_user_id").notNull(),
  employmentId: text("employment_id").notNull(),
  actionKind: text("action_kind").notNull(),
  beforeEndedOn: text("before_ended_on"),
  afterEndedOn: text("after_ended_on"),
  expectedRevision: integer("expected_revision").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  undoneAt: text("undone_at"),
  undoneBy: text("undone_by"),
  endedScopeAssignments: text("ended_scope_assignments").notNull().default("[]"),
  endedAttendanceAssignments: text("ended_attendance_assignments").notNull().default("[]"),
  beforePrimaryAssignmentId: text("before_primary_assignment_id"),
}, (t) => [
  index("idx_hr_employment_actions_employee_created").on(t.employeeUserId, t.createdAt),
  check("ck_hr_employment_actions_kind", sql`${t.actionKind} IN ('employee_assigned', 'employment_created', 'employment_ended')`),
  check("ck_hr_employment_actions_revision", sql`${t.expectedRevision} > 0`),
]);

export const hrEmployeeScopes = sqliteTable("hr_employee_scopes", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  scopeId: text("scope_id").notNull().references(() => scopes.id, { onDelete: "restrict" }),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  revision: integer("revision").notNull().default(1),
  ...timestamps(),
}, (t) => [
  uniqueIndex("idx_hr_employee_scopes_start").on(t.employmentId, t.scopeId, t.validFrom),
  index("idx_hr_employee_scopes_scope").on(t.scopeId, t.validFrom),
  check("ck_hr_employee_scopes_dates", sql`length(${t.validFrom}) = 10 AND (${t.validTo} IS NULL OR (length(${t.validTo}) = 10 AND ${t.validTo} > ${t.validFrom}))`),
  check("ck_hr_employee_scopes_revision", sql`${t.revision} > 0`),
]);
