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
  personKind: text("person_kind", { enum: ["employee", "worker"] as const }).notNull().default("employee"),
  employeeUserId: text("employee_user_id").references(() => users.id, { onDelete: "restrict" }),
  employeeNumber: text("employee_number").notNull(),
  legalName: text("legal_name").notNull().default(""),
  position: text("position").notNull().default("一般職員"),
  supervisorUserId: text("supervisor_user_id").references(() => users.id, { onDelete: "restrict" }),
  archivedAt: text("archived_at"),
  revision: integer("revision").notNull().default(1),
  ...timestamps(),
}, (t) => [
  uniqueIndex("idx_hr_employments_active_user").on(t.employeeUserId).where(sql`${t.archivedAt} IS NULL AND ${t.employeeUserId} IS NOT NULL AND ${t.personKind} = 'employee'`),
  uniqueIndex("idx_hr_employments_active_number").on(t.employeeNumber).where(sql`${t.archivedAt} IS NULL`),
  index("idx_hr_employments_archived").on(t.archivedAt),
  index("idx_hr_employments_person_kind_status").on(t.personKind, t.archivedAt),
  check("ck_hr_employments_person_kind", sql`${t.personKind} IN ('employee', 'worker')`),
  check("ck_hr_employments_employee_user", sql`(${t.personKind} = 'employee' AND ${t.employeeUserId} IS NOT NULL) OR (${t.personKind} = 'worker' AND ${t.employeeUserId} IS NULL)`),
  check("ck_hr_employments_number", sql`length(trim(${t.employeeNumber})) BETWEEN 1 AND 40`),
  check("ck_hr_employments_position", sql`length(trim(${t.position})) BETWEEN 1 AND 100`),
  check("ck_hr_employments_revision", sql`${t.revision} > 0`),
]);

/** 舊任職動作資料是稽核歷史，保留 table 定義避免後續 schema diff 物理刪除。 */
/** 服務年資起算日獨立於目前任職主檔；封存／復職沿用同一 employmentId 與這筆歷史。 */
export const hrEmploymentServicePeriods = sqliteTable("hr_employment_service_periods", {
  employmentId: text("employment_id").primaryKey().references(() => hrEmployments.id, { onDelete: "restrict" }),
  serviceStartOn: text("service_start_on").notNull(),
  ...timestamps(),
}, (t) => [
  check("ck_hr_employment_service_periods_date", sql`length(${t.serviceStartOn}) = 10`),
]);

/** 個資與任職分開，避免既有出勤／薪資 consumer 無意取得敏感欄位。 */
export const hrEmployeePersonalData = sqliteTable("hr_employee_personal_data", {
  employmentId: text("employment_id").primaryKey().references(() => hrEmployments.id, { onDelete: "restrict" }),
  englishName: text("english_name").notNull().default(""),
  gender: text("gender").notNull().default(""),
  nationality: text("nationality").notNull().default(""),
  birthDate: text("birth_date").notNull().default(""),
  identityNumber: text("identity_number").notNull().default(""),
  maritalStatus: text("marital_status").notNull().default(""),
  identityGroup: text("identity_group").notNull().default(""),
  militaryStatus: text("military_status").notNull().default(""),
  dischargedOn: text("discharged_on").notNull().default(""),
  heightCm: text("height_cm").notNull().default(""),
  weightKg: text("weight_kg").notNull().default(""),
  bloodType: text("blood_type").notNull().default(""),
  personalEmail: text("personal_email").notNull().default(""),
  companyPhone: text("company_phone").notNull().default(""),
  extension: text("extension").notNull().default(""),
  homePhone: text("home_phone").notNull().default(""),
  mobilePhone: text("mobile_phone").notNull().default(""),
  registeredPhone: text("registered_phone").notNull().default(""),
  registeredAddress: text("registered_address").notNull().default(""),
  mailingAddress: text("mailing_address").notNull().default(""),
  overseasAddress: text("overseas_address").notNull().default(""),
  emergencyRelation: text("emergency_relation").notNull().default(""),
  emergencyName: text("emergency_name").notNull().default(""),
  emergencyPhone: text("emergency_phone").notNull().default(""),
  ...timestamps(),
});

/** 私有照片只保留目前版本；與任職分表，讓既有 roster consumer 不會取得照片資訊。 */
export const hrEmployeePhotos = sqliteTable("hr_employee_photos", {
  employmentId: text("employment_id").primaryKey().references(() => hrEmployments.id, { onDelete: "restrict" }),
  id: text("id").notNull(),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type", { enum: ["image/jpeg", "image/png", "image/webp"] }).notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex("idx_hr_employee_photos_object_key").on(t.objectKey),
  check("ck_hr_employee_photos_content_type", sql`${t.contentType} IN ('image/jpeg', 'image/png', 'image/webp')`),
]);

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
