import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export type CyberbizReportScopeType = "store" | "company";
export type CyberbizReportRunKind = "sales" | "payout";
export type CyberbizReportRunPeriodKind = "month" | "custom";

/**
 * 後台每次按下「執行」的 audit/job index。
 *
 * 真正的瀏覽器工作仍在 GitHub Actions；D1 只記錄誰、對哪些店、哪個區間按了哪種報表，
 * 以及這次是否符合「完整月份，可匯入每日 D1 資料」的規則。這樣頁面刷新後仍能找回操作紀錄，
 * 也不需要把 workflow 的 secrets 或報表內容放進平台。
 */
export const cyberbizReportRuns = sqliteTable("cyberbiz_report_runs", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  reportKind: text("report_kind").$type<CyberbizReportRunKind>().notNull(),
  periodKind: text("period_kind").$type<CyberbizReportRunPeriodKind>().notNull(),
  storesJson: text("stores_json").notNull().default("[]"),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  d1ImportEligible: integer("d1_import_eligible").notNull().default(0),
  actorId: text("actor_id").notNull(),
  actorEmail: text("actor_email").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_cyberbiz_report_runs_request_id").on(table.requestId),
  index("idx_cyberbiz_report_runs_kind_created_at").on(table.reportKind, table.createdAt),
]);

export type CyberbizReportRun = typeof cyberbizReportRuns.$inferSelect;
