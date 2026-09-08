import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { scopes } from "./reports.js";

const timestamps = () => ({
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revision: integer("revision").notNull().default(1),
});

export const hrEmployers = sqliteTable("hr_employers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  registrationNumber: text("registration_number"),
  ...timestamps(),
}, (t) => [
  uniqueIndex("idx_hr_employers_registration").on(t.registrationNumber),
  check("ck_hr_employers_name", sql`length(trim(${t.name})) BETWEEN 1 AND 100`),
  check("ck_hr_employers_registration", sql`${t.registrationNumber} IS NULL OR (length(${t.registrationNumber}) = 8 AND ${t.registrationNumber} NOT GLOB '*[^0-9]*')`),
  check("ck_hr_employers_revision", sql`${t.revision} > 0`),
]);

export const hrEmployees = sqliteTable("hr_employees", {
  id: text("id").primaryKey(),
  employeeNumber: text("employee_number").notNull(),
  displayName: text("display_name").notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "restrict" }),
  ...timestamps(),
}, (t) => [
  uniqueIndex("idx_hr_employees_number").on(t.employeeNumber),
  uniqueIndex("idx_hr_employees_user").on(t.userId),
  check("ck_hr_employees_number", sql`length(trim(${t.employeeNumber})) BETWEEN 1 AND 40`),
  check("ck_hr_employees_name", sql`length(trim(${t.displayName})) BETWEEN 1 AND 100`),
  check("ck_hr_employees_revision", sql`${t.revision} > 0`),
]);

/** endedOn 是不再任職的第一天；復職新增一列，不能把舊聘僱改回未離職。 */
export const hrEmployments = sqliteTable("hr_employments", {
  id: text("id").primaryKey(),
  employeeId: text("employee_id").notNull().references(() => hrEmployees.id, { onDelete: "restrict" }),
  employerId: text("employer_id").notNull().references(() => hrEmployers.id, { onDelete: "restrict" }),
  hiredOn: text("hired_on").notNull(),
  endedOn: text("ended_on"),
  seniorityStartOn: text("seniority_start_on").notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex("idx_hr_employments_start").on(t.employeeId, t.employerId, t.hiredOn),
  index("idx_hr_employments_employer").on(t.employerId, t.hiredOn),
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
