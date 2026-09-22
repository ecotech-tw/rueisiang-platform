import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { scopes } from "./reports.js";

const timestamps = () => ({
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revision: integer("revision").notNull().default(1),
});

/** 員工是平台使用者的人事延伸，不再維護第二份姓名或可更換的登入關聯。 */
export const hrEmployees = sqliteTable("hr_employees", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "restrict" }),
  employeeNumber: text("employee_number").notNull(),
  supervisorUserId: text("supervisor_user_id").references(() => users.id, { onDelete: "restrict" }),
  ...timestamps(),
}, (t) => [
  uniqueIndex("idx_hr_employees_number").on(t.employeeNumber),
  check("ck_hr_employees_number", sql`length(trim(${t.employeeNumber})) BETWEEN 1 AND 40`),
  check("ck_hr_employees_revision", sql`${t.revision} > 0`),
]);

/** endedOn 是不再任職的第一天；revokedAt 是錯誤任職的 soft-delete 標記，資料只在稽核與外鍵歷史中保留，不再接受新的關聯。 */
export const hrEmployments = sqliteTable("hr_employments", {
  id: text("id").primaryKey(),
  employeeUserId: text("employee_user_id").notNull().references(() => hrEmployees.userId, { onDelete: "restrict" }),
  hiredOn: text("hired_on").notNull(),
  endedOn: text("ended_on"),
  seniorityStartOn: text("seniority_start_on").notNull(),
  revokedAt: text("revoked_at"),
  revokedBy: text("revoked_by").references(() => users.id, { onDelete: "restrict" }),
  ...timestamps(),
}, (t) => [
  uniqueIndex("idx_hr_employments_start").on(t.employeeUserId, t.hiredOn).where(sql`${t.revokedAt} IS NULL`),
  check("ck_hr_employments_dates", sql`length(${t.hiredOn}) = 10 AND length(${t.seniorityStartOn}) = 10 AND (${t.endedOn} IS NULL OR (length(${t.endedOn}) = 10 AND ${t.endedOn} > ${t.hiredOn})) AND ${t.seniorityStartOn} <= ${t.hiredOn}`),
  check("ck_hr_employments_revision", sql`${t.revision} > 0`),
]);

/**
 * 任職異動的可復原操作索引。
 *
 * 這張表刻意不設任職外鍵：新增任職的「復原」在確認沒有下游資料後會撤銷空白任職，
 * 但操作紀錄仍要留下來，讓 HR 看得到誰在什麼時候做過什麼。正式歷史資料仍由
 * hr_employments 的 restrict 外鍵保護，不會因為復原按鈕把薪資或出勤資料連坐刪除。
 */
export const hrEmploymentActions = sqliteTable("hr_employment_actions", {
  id: text("id").primaryKey(),
  employeeUserId: text("employee_user_id").notNull(),
  employmentId: text("employment_id").notNull(),
  actionKind: text("action_kind").notNull(),
  beforeEndedOn: text("before_ended_on"),
  afterEndedOn: text("after_ended_on"),
  expectedRevision: integer("expected_revision").notNull(),
  /** 任職結束自動收合的指派快照，供「復原上一動」恢復原 validTo 與 revision。 */
  endedScopeAssignments: text("ended_scope_assignments").notNull().default("[]"),
  endedAttendanceAssignments: text("ended_attendance_assignments").notNull().default("[]"),
  beforePrimaryAssignmentId: text("before_primary_assignment_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  undoneAt: text("undone_at"),
  undoneBy: text("undone_by"),
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
  ...timestamps(),
}, (t) => [
  uniqueIndex("idx_hr_employee_scopes_start").on(t.employmentId, t.scopeId, t.validFrom),
  index("idx_hr_employee_scopes_scope").on(t.scopeId, t.validFrom),
  check("ck_hr_employee_scopes_dates", sql`length(${t.validFrom}) = 10 AND (${t.validTo} IS NULL OR (length(${t.validTo}) = 10 AND ${t.validTo} > ${t.validFrom}))`),
  check("ck_hr_employee_scopes_revision", sql`${t.revision} > 0`),
]);
