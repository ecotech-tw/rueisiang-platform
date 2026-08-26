import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export type CyberbizReportScopeType = "store" | "company";
export type CyberbizReportStatus = "staged" | "published" | "superseded";
export type CyberbizReportKind = "sales" | "payout" | "bundle";
export type CyberbizReportRunKind = "sales" | "payout";
export type CyberbizReportRunPeriodKind = "month" | "custom";

/**
 * CYBERBIZ 月報的索引，不存報表內容。
 *
 * XLSX 與 normalized JSON 放在 NAS；D1 只負責回答「哪個月份、哪個 scope
 * 有哪個版本、內容在哪裡、涵蓋到哪一天」。這樣查詢不會因為把五萬筆訂單
 * 或整本試算表塞進 D1 而增加讀取成本。
 */
export const cyberbizReportManifests = sqliteTable("cyberbiz_report_manifests", {
  id: text("id").primaryKey(),
  reportMonth: text("report_month").notNull(),
  /** sales、payout 可以分開完成；bundle 保留給既有兩份合併 publish。 */
  reportKind: text("report_kind").$type<CyberbizReportKind>().notNull().default("bundle"),
  scopeType: text("scope_type").$type<CyberbizReportScopeType>().notNull(),
  scopeId: text("scope_id").notNull(),
  scopeName: text("scope_name").notNull().default(""),
  coverageStart: text("coverage_start").notNull(),
  coverageEnd: text("coverage_end").notNull(),
  salesGranularity: text("sales_granularity").$type<"month">().notNull().default("month"),
  payoutGranularity: text("payout_granularity").$type<"day">().notNull().default("day"),
  salesSourceObjectKey: text("sales_source_object_key"),
  payoutSourceObjectKey: text("payout_source_object_key"),
  salesObjectKey: text("sales_object_key"),
  payoutObjectKey: text("payout_object_key"),
  combinedWorkbookObjectKey: text("combined_workbook_object_key"),
  driveFileId: text("drive_file_id"),
  driveUrl: text("drive_url"),
  storeIdsJson: text("store_ids_json").notNull().default("[]"),
  sourceChecksum: text("source_checksum").notNull(),
  parserVersion: text("parser_version").notNull(),
  status: text("status").$type<CyberbizReportStatus>().notNull().default("published"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_cyberbiz_report_manifest_version")
    .on(table.reportMonth, table.scopeType, table.scopeId, table.reportKind, table.sourceChecksum),
  index("idx_cyberbiz_report_manifest_lookup")
    .on(table.reportMonth, table.scopeType, table.status),
  index("idx_cyberbiz_report_manifest_scope")
    .on(table.scopeId, table.reportMonth),
]);

export type CyberbizReportManifest = typeof cyberbizReportManifests.$inferSelect;
export type NewCyberbizReportManifest = typeof cyberbizReportManifests.$inferInsert;

/**
 * 後台每次按下「執行」的 audit/job index。
 *
 * 真正的瀏覽器工作仍在 GitHub Actions；D1 只記錄誰、對哪些店、哪個區間按了哪種報表，
 * 以及這次是否符合「完整月份，可進 AI manifest」的規則。這樣頁面刷新後仍能找回操作紀錄，
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
  manifestEligible: integer("manifest_eligible").notNull().default(0),
  actorId: text("actor_id").notNull(),
  actorEmail: text("actor_email").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_cyberbiz_report_runs_request_id").on(table.requestId),
  index("idx_cyberbiz_report_runs_kind_created_at").on(table.reportKind, table.createdAt),
]);

export type CyberbizReportRun = typeof cyberbizReportRuns.$inferSelect;
