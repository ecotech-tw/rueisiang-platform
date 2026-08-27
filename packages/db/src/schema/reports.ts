import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export type ReportScopeKind = "store" | "company";

/** 使用者可選的 scope；scope ID 本身必須是全域唯一的，例如 cyberbiz:store:...。 */
export const reportScopes = sqliteTable("report_scopes", {
  id: text("id").primaryKey(),
  scopeKind: text("scope_kind").$type<ReportScopeKind>().notNull(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_report_scopes_name").on(table.scopeKind, table.normalizedName, table.active),
  index("idx_report_scopes_active").on(table.scopeKind, table.active),
]);

/** 每個據點每月每個 SKU 一筆；商品銷售總表本身只有月彙總粒度。 */
export const reportSalesMonthly = sqliteTable("report_sales_monthly", {
  scopeId: text("scope_id").notNull(),
  reportMonth: text("report_month").notNull(),
  sku: text("sku").notNull(),
  productName: text("product_name").notNull().default(""),
  category: text("category").notNull().default("未分類"),
  grossQuantity: integer("gross_quantity").notNull().default(0),
  returnQuantity: integer("return_quantity").notNull().default(0),
  netQuantity: integer("net_quantity").notNull().default(0),
  salesAmount: integer("sales_amount").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.scopeId, table.reportMonth, table.sku] }),
  index("idx_report_sales_monthly_month").on(table.scopeId, table.reportMonth),
  index("idx_report_sales_monthly_sku").on(table.scopeId, table.sku, table.reportMonth),
  index("idx_report_sales_monthly_category").on(table.scopeId, table.category, table.reportMonth),
]);

/** 同一據點同一天的出金已在匯入前加總，不再保留支付方式或 POS 維度。 */
export const reportPayoutDaily = sqliteTable("report_payout_daily", {
  scopeId: text("scope_id").notNull(),
  businessDate: text("business_date").notNull(),
  payoutAmount: integer("payout_amount").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.scopeId, table.businessDate] }),
  index("idx_report_payout_daily_date").on(table.scopeId, table.businessDate),
]);

export type ReportScope = typeof reportScopes.$inferSelect;
export type NewReportScope = typeof reportScopes.$inferInsert;
export type ReportSalesMonthly = typeof reportSalesMonthly.$inferSelect;
export type NewReportSalesMonthly = typeof reportSalesMonthly.$inferInsert;
export type ReportPayoutDaily = typeof reportPayoutDaily.$inferSelect;
export type NewReportPayoutDaily = typeof reportPayoutDaily.$inferInsert;
