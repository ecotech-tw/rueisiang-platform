import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { items } from "./items.js";

export type ScopeKind = "store" | "channel" | "company";
export type ReportRunPeriodKind = "month" | "custom";
export type ReportRunStatus = "queued" | "running" | "succeeded" | "failed";
export type ReportRecordOrigin = "imported" | "manual";
export type ReportExternalProductResolution = "mapped" | "ignored";
export type ReportIngestIssueType = "unmapped" | "ambiguous" | "invalid";

/** 報表資料的據點／通路，合併舊 report_scopes、payout_stores 與蝦皮設定。 */
export const scopes = sqliteTable("scopes", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  scopeKind: text("scope_kind").$type<ScopeKind>().notNull(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  driveFolderUrl: text("drive_folder_url").notNull().default(""),
  driveFolderName: text("drive_folder_name").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_scopes_source_normalized").on(table.sourceType, table.normalizedName),
  index("idx_scopes_pick").on(table.scopeKind, table.active, table.sortOrder),
  check("ck_scopes_kind", sql`${table.scopeKind} IN ('store', 'channel', 'company')`),
]);

/** 外部通路商品的對應或忽略設定。 */
export const reportExternalProducts = sqliteTable("report_external_products", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  externalKey: text("external_key").notNull(),
  externalVariantKey: text("external_variant_key").notNull().default(""),
  externalName: text("external_name").notNull().default(""),
  resolution: text("resolution").$type<ReportExternalProductResolution>().notNull(),
  itemId: text("item_id").references(() => items.id, { onDelete: "restrict" }),
  ignoredReason: text("ignored_reason").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_report_external_products_key").on(table.sourceType, table.externalKey, table.externalVariantKey),
  index("idx_report_external_products_item").on(table.itemId).where(sql`${table.itemId} IS NOT NULL`),
  check("ck_report_external_products_resolution", sql`${table.resolution} IN ('mapped', 'ignored')`),
  check("ck_report_external_products_mapped_item", sql`(${table.resolution} = 'mapped') = (${table.itemId} IS NOT NULL)`),
  check("ck_report_external_products_reason", sql`${table.resolution} = 'ignored' OR ${table.ignoredReason} = ''`),
]);

/** 每次按下「執行」的紀錄，合併 CYBERBIZ、出金與蝦皮的 run 表。 */
export const reportRuns = sqliteTable("report_runs", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  sourceType: text("source_type").notNull(),
  importsSales: integer("imports_sales").notNull().default(0),
  importsPayout: integer("imports_payout").notNull().default(0),
  periodKind: text("period_kind").$type<ReportRunPeriodKind>().notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  status: text("status").$type<ReportRunStatus>().notNull().default("queued"),
  workflowRunId: text("workflow_run_id"),
  importedSalesRows: integer("imported_sales_rows").notNull().default(0),
  importedPayoutRows: integer("imported_payout_rows").notNull().default(0),
  skippedRows: integer("skipped_rows").notNull().default(0),
  lastError: text("last_error").notNull().default(""),
  actorEmail: text("actor_email").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_report_runs_request_id").on(table.requestId),
  index("idx_report_runs_created").on(table.createdAt),
  check("ck_report_runs_kind", sql`${table.importsSales} = 1 OR ${table.importsPayout} = 1`),
  check("ck_report_runs_status", sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed')`),
  check("ck_report_runs_period", sql`${table.periodKind} IN ('month', 'custom')`),
]);

/** 一次執行跑了哪些 scope。 */
export const reportRunScopes = sqliteTable("report_run_scopes", {
  reportRunId: text("report_run_id").notNull().references(() => reportRuns.id, { onDelete: "cascade" }),
  scopeId: text("scope_id").notNull().references(() => scopes.id, { onDelete: "restrict" }),
}, (table) => [
  primaryKey({ columns: [table.reportRunId, table.scopeId] }),
  index("idx_report_run_scopes_scope").on(table.scopeId),
]);

/** driver 產的執行報告（Markdown）。 */
export const reportRunReports = sqliteTable("report_run_reports", {
  reportRunId: text("report_run_id").primaryKey().references(() => reportRuns.id, { onDelete: "cascade" }),
  reportMd: text("report_md").notNull().default(""),
});

/** 商品銷售月報；分類不存 snapshot，本輪先用 item_id join 目前分類。 */
export const reportItemSalesMonthly = sqliteTable("report_item_sales_monthly", {
  scopeId: text("scope_id").notNull().references(() => scopes.id, { onDelete: "restrict" }),
  reportMonth: text("report_month").notNull(),
  itemId: text("item_id").notNull().references(() => items.id, { onDelete: "restrict" }),
  recordOrigin: text("record_origin").$type<ReportRecordOrigin>().notNull(),
  reportRunId: text("report_run_id").references(() => reportRuns.id, { onDelete: "restrict" }),
  grossQuantity: integer("gross_quantity").notNull().default(0),
  returnQuantity: integer("return_quantity").notNull().default(0),
  netQuantity: integer("net_quantity").notNull().default(0),
  salesAmount: integer("sales_amount").notNull().default(0),
  updatedByEmail: text("updated_by_email").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.scopeId, table.reportMonth, table.itemId, table.recordOrigin] }),
  index("idx_item_sales_month").on(table.reportMonth, table.scopeId),
  index("idx_item_sales_item").on(table.itemId, table.reportMonth),
  check("ck_item_sales_origin", sql`${table.recordOrigin} IN ('imported', 'manual')`),
  check("ck_item_sales_run", sql`(${table.recordOrigin} = 'imported') = (${table.reportRunId} IS NOT NULL)`),
  check("ck_item_sales_actor", sql`${table.recordOrigin} = 'manual' OR ${table.updatedByEmail} = ''`),
]);

/** 每日出金；匯入與人工修訂合併在 record_origin。 */
export const targetReportPayoutDaily = sqliteTable("report_payout_daily_target", {
  scopeId: text("scope_id").notNull().references(() => scopes.id, { onDelete: "restrict" }),
  businessDate: text("business_date").notNull(),
  recordOrigin: text("record_origin").$type<ReportRecordOrigin>().notNull(),
  reportRunId: text("report_run_id").references(() => reportRuns.id, { onDelete: "restrict" }),
  payoutAmount: integer("payout_amount").notNull().default(0),
  updatedByEmail: text("updated_by_email").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.scopeId, table.businessDate, table.recordOrigin] }),
  index("idx_payout_daily_date").on(table.businessDate, table.scopeId),
  check("ck_payout_daily_origin", sql`${table.recordOrigin} IN ('imported', 'manual')`),
  check("ck_payout_daily_run", sql`(${table.recordOrigin} = 'imported') = (${table.reportRunId} IS NOT NULL)`),
  check("ck_payout_daily_actor", sql`${table.recordOrigin} = 'manual' OR ${table.updatedByEmail} = ''`),
]);

/** 匯入時被略過或出問題的外部商品。 */
export const reportIngestIssues = sqliteTable("report_ingest_issues", {
  reportRunId: text("report_run_id").notNull().references(() => reportRuns.id, { onDelete: "cascade" }),
  externalKey: text("external_key").notNull(),
  externalVariantKey: text("external_variant_key").notNull().default(""),
  externalName: text("external_name").notNull().default(""),
  issueType: text("issue_type").$type<ReportIngestIssueType>().notNull(),
  detail: text("detail").notNull().default(""),
  rowCount: integer("row_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.reportRunId, table.externalKey, table.externalVariantKey, table.issueType] }),
  index("idx_ingest_issues_key").on(table.externalKey, table.externalVariantKey),
  check("ck_ingest_issues_type", sql`${table.issueType} IN ('unmapped', 'ambiguous', 'invalid')`),
]);

export type Scope = typeof scopes.$inferSelect;
export type ReportExternalProduct = typeof reportExternalProducts.$inferSelect;
export type ReportRun = typeof reportRuns.$inferSelect;
export type ReportItemSalesMonthly = typeof reportItemSalesMonthly.$inferSelect;
export type TargetReportPayoutDaily = typeof targetReportPayoutDaily.$inferSelect;
export type ReportIngestIssue = typeof reportIngestIssues.$inferSelect;

// 過渡期相容舊 service 名稱；實作會在這輪 schema overhaul 裡逐一改到新名稱。
export {
  reportManualPayoutDaily,
  reportManualSalesMonthly,
  reportPayoutDaily,
  reportSalesMonthly,
  reportScopes,
  type NewReportPayoutDaily,
  type NewReportSalesMonthly,
  type ReportManualPayoutDaily,
  type ReportManualSalesMonthly,
  type ReportManualSkuSource,
  type ReportPayoutDaily,
  type ReportSalesMonthly,
  type ReportScope,
  type ReportScopeKind,
} from "./legacy-reports.js";
