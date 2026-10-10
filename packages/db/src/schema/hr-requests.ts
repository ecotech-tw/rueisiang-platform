import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { hrEmployments } from "./hr-people.js";
import { users } from "./auth.js";

const timestamps = () => ({
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** 申請保存具體欄位而非任意 JSON，讓補打卡審核與後續出勤計算能沿用同一份資料。 */
/** 通知內文上限；CHECK 與寫入端的截斷都讀這一個值。 */
export const HR_NOTIFICATION_BODY_LIMIT = 1000;

export const hrNotifications = sqliteTable("hr_notifications", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  sourceKey: text("source_key").notNull().unique(),
  kind: text("kind", { enum: ["request_submitted", "request_reviewed", "request_cancelled"] as const }).notNull(),
  entityKind: text("entity_kind", { enum: ["leave", "overtime", "clock_correction"] as const }).notNull(),
  entityId: text("entity_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  readAt: text("read_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_hr_notifications_user_created").on(table.userId, table.createdAt),
  index("idx_hr_notifications_user_unread").on(table.userId, table.readAt, table.createdAt),
  check("ck_hr_notifications_kind", sql`${table.kind} IN ('request_submitted', 'request_reviewed', 'request_cancelled')`),
  check("ck_hr_notifications_entity_kind", sql`${table.entityKind} IN ('leave', 'overtime', 'clock_correction')`),
  check("ck_hr_notifications_title", sql`length(trim(${table.title})) BETWEEN 1 AND 120`),
  check("ck_hr_notifications_body", sql`length(${table.body}) BETWEEN 1 AND ${sql.raw(String(HR_NOTIFICATION_BODY_LIMIT))}`),
]);

export const hrFormRequests = sqliteTable("hr_form_requests", {
  id: text("id").primaryKey(),
  employeeUserId: text("employee_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  formKind: text("form_kind", { enum: ["clock_correction"] as const }).notNull().default("clock_correction"),
  status: text("status", { enum: ["draft", "pending", "approved", "rejected", "cancelled"] as const }).notNull().default("draft"),
  correctionDate: text("correction_date").notNull(),
  requestedEventKind: text("requested_event_kind", { enum: ["clock_in", "clock_out"] as const }).notNull(),
  requestedAt: text("requested_at").notNull(),
  reason: text("reason").notNull(),
  approverUserId: text("approver_user_id").references(() => users.id, { onDelete: "restrict" }),
  submittedAt: text("submitted_at"),
  reviewedAt: text("reviewed_at"),
  reviewComment: text("review_comment"),
  /** approved 補打卡實際產生的 append-only clock event。 */
  correctedClockEventId: text("corrected_clock_event_id"),
  ...timestamps(),
}, (table) => [
  index("idx_hr_form_requests_employee_created").on(table.employeeUserId, table.createdAt),
  index("idx_hr_form_requests_approver_status").on(table.approverUserId, table.status),
  index("idx_hr_form_requests_corrected_event").on(table.correctedClockEventId),
  check("ck_hr_form_requests_kind", sql`${table.formKind} = 'clock_correction'`),
  check("ck_hr_form_requests_status", sql`${table.status} IN ('draft', 'pending', 'approved', 'rejected', 'cancelled')`),
  check("ck_hr_form_requests_event_kind", sql`${table.requestedEventKind} IN ('clock_in', 'clock_out')`),
  check("ck_hr_form_requests_date", sql`length(${table.correctionDate}) = 10`),
  check("ck_hr_form_requests_reason", sql`length(trim(${table.reason})) BETWEEN 1 AND 1000`),
]);
