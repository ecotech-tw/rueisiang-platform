import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { hrEmployments } from "./hr-people.js";

export const HR_RFID_PROTOCOL_CODE = "0002";

/** 卡片只保存觀察到的識別碼；原廠確認前不把它命名或視為 UID。 */
export const hrEmployeeRfidCards = sqliteTable("hr_employee_rfid_cards", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  cardCode: text("card_code").notNull(),
  protocolCode: text("protocol_code").notNull(),
  linkedBy: text("linked_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  linkedAt: text("linked_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revokedBy: text("revoked_by").references(() => users.id, { onDelete: "restrict" }),
  revokedAt: text("revoked_at"),
}, (table) => [
  uniqueIndex("idx_hr_employee_rfid_cards_active_code").on(table.cardCode).where(sql`${table.revokedAt} IS NULL`),
  uniqueIndex("idx_hr_employee_rfid_cards_active_employment").on(table.employmentId).where(sql`${table.revokedAt} IS NULL`),
  index("idx_hr_employee_rfid_cards_employment").on(table.employmentId, table.linkedAt),
  check("ck_hr_employee_rfid_cards_code", sql`length(${table.cardCode}) = 8 AND ${table.cardCode} NOT GLOB '*[^0-9A-F]*'`),
  check("ck_hr_employee_rfid_cards_protocol", sql`${table.protocolCode} = ${sql.raw(`'${HR_RFID_PROTOCOL_CODE}'`)}`),
  check("ck_hr_employee_rfid_cards_revocation", sql`(${table.revokedAt} IS NULL AND ${table.revokedBy} IS NULL) OR (${table.revokedAt} IS NOT NULL AND ${table.revokedBy} IS NOT NULL)`),
]);

/** Enrollment 是短期且全 Reader 單一作用中的操作，避免同一張掃描被綁到多位員工。 */
export const hrRfidEnrollmentSessions = sqliteTable("hr_rfid_enrollment_sessions", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  status: text("status", { enum: ["listening", "captured", "confirmed", "cancelled", "expired"] as const }).notNull(),
  candidateCardCode: text("candidate_card_code"),
  candidateProtocolCode: text("candidate_protocol_code"),
  deviceId: text("device_id"),
  startedBy: text("started_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
  scannedAt: text("scanned_at"),
  finishedAt: text("finished_at"),
}, (table) => [
  uniqueIndex("idx_hr_rfid_enrollment_one_listener").on(table.status).where(sql`${table.status} = 'listening'`),
  index("idx_hr_rfid_enrollment_employment").on(table.employmentId, table.startedAt),
  check("ck_hr_rfid_enrollment_status", sql`${table.status} IN ('listening', 'captured', 'confirmed', 'cancelled', 'expired')`),
  check("ck_hr_rfid_enrollment_candidate", sql`(${table.candidateCardCode} IS NULL AND ${table.candidateProtocolCode} IS NULL) OR (length(${table.candidateCardCode}) = 8 AND ${table.candidateCardCode} NOT GLOB '*[^0-9A-F]*' AND ${table.candidateProtocolCode} = ${sql.raw(`'${HR_RFID_PROTOCOL_CODE}'`)})`),
  check("ck_hr_rfid_enrollment_device", sql`${table.deviceId} IS NULL OR length(trim(${table.deviceId})) BETWEEN 1 AND 100`),
]);
