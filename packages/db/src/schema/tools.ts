import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * 營運工具的表。出金表與蝦皮銷售報表共用這個模組，但各自保留設定與執行紀錄。
 *
 * 出金表真正的執行在 GitHub Actions 的 runner 上——這裡不跑 Chrome、不碰
 * CYBERBIZ 或 Google 的憑證，只保管「有哪些店」與「誰按過執行」。
 */

/**
 * 出金表與商品銷售報表的店別清單。**這張表是唯一來源。**
 *
 * 舊的 Worker 把 stores.json 打包進程式碼裡，所以設定頁改完之後要下載檔案、
 * commit 回 repo、重新部署，執行頁才會看到。搬進 D1 之後設定頁存檔就生效，
 * 但 runner 那邊仍然讀它自己 repo 裡的 stores.json——同一份清單存在三個地方
 * （D1、stores.json、config.json），改了一個另外兩個不會跟著動。
 *
 * 現在店別是**觸發執行時跟著 dispatch 傳給 runner 的**（見 cyberbiz-scope.ts
 * 的 runnerStores），stores.json 已經移除。
 */
export const payoutStores = sqliteTable("payout_stores", {
  id: text("id").primaryKey(),
  /** 必須與 CYBERBIZ 後台的 POS 商店名稱完全一致，driver 靠它找店。 */
  name: text("name").notNull(),
  driveFolderUrl: text("drive_folder_url").notNull().default(""),
  driveFolderName: text("drive_folder_name").notNull().default(""),
  /** 關閉後只保留設定，不會出現在出金表與商品銷售報表的執行頁，也不會被送給 runner。 */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** 顯示順序。同仁習慣的店序跟建立時間無關，所以另外存。 */
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_payout_stores_name").on(table.name),
]);

export type PayoutStore = typeof payoutStores.$inferSelect;

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
