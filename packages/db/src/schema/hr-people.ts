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
  ...timestamps(),
}, (t) => [
  uniqueIndex("idx_hr_employees_number").on(t.employeeNumber),
  check("ck_hr_employees_number", sql`length(trim(${t.employeeNumber})) BETWEEN 1 AND 40`),
  check("ck_hr_employees_revision", sql`${t.revision} > 0`),
]);

/** endedOn 是不再任職的第一天；復職新增一列，不能把舊聘僱改回未離職。 */
export const hrEmployments = sqliteTable("hr_employments", {
  id: text("id").primaryKey(),
  employeeUserId: text("employee_user_id").notNull().references(() => hrEmployees.userId, { onDelete: "restrict" }),
  hiredOn: text("hired_on").notNull(),
  endedOn: text("ended_on"),
  seniorityStartOn: text("seniority_start_on").notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex("idx_hr_employments_start").on(t.employeeUserId, t.hiredOn),
  check("ck_hr_employments_dates", sql`length(${t.hiredOn}) = 10 AND length(${t.seniorityStartOn}) = 10 AND (${t.endedOn} IS NULL OR (length(${t.endedOn}) = 10 AND ${t.endedOn} > ${t.hiredOn})) AND ${t.seniorityStartOn} <= ${t.hiredOn}`),
  check("ck_hr_employments_revision", sql`${t.revision} > 0`),
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
