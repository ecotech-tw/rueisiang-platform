import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * 報表用的商品分類主檔。
 *
 * 這張表刻意不放在 WMS schema 裡：WMS 的分類是貨架／倉儲作業用，報表的分類則是
 * 營運分析用，兩者的生命週期與命名方式都不同。報表 SKU 只透過
 * cyberbiz_product_categories 指向這裡，寫入報表時再把名稱存成當期快照。
 */
export const reportProductCategories = sqliteTable("report_product_categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("rose"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type ReportProductCategory = typeof reportProductCategories.$inferSelect;
