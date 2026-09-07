import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * 營運工具的表。出金表店別已併入 reports.ts 的 scopes；這裡只剩尚未 target 化的
 * 蝦皮報表設定與執行紀錄。
 */

/**
 * 蝦皮報表的全域設定。
 *
 * 蝦皮報表不是依 POS 店別分開上傳；一個月份產出一份檔案，所以只需要一個
 * Drive 資料夾目標。報表密碼不落資料庫，只會隨著 R2 暫存檔案短暫保存，交給 Actions
 * 取檔時使用，工作完成後清理暫存檔案。
 */
export const shopeeSalesSettings = sqliteTable("shopee_sales_settings", {
  id: text("id").primaryKey(),
  driveFolderUrl: text("drive_folder_url").notNull().default(""),
  driveFolderName: text("drive_folder_name").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** 誰執行了哪一段蝦皮報表，以及當時指定的 Drive 目標。 */
export const shopeeSalesRuns = sqliteTable("shopee_sales_runs", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  driveFolderUrl: text("drive_folder_url").notNull().default(""),
  actorId: text("actor_id").notNull(),
  actorEmail: text("actor_email").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_shopee_sales_runs_request_id").on(table.requestId),
  index("idx_shopee_sales_runs_created_at").on(table.createdAt),
]);

export type ShopeeSalesSettings = typeof shopeeSalesSettings.$inferSelect;
export type ShopeeSalesRun = typeof shopeeSalesRuns.$inferSelect;
