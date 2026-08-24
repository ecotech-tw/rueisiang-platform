import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * 營運工具的表。出金表與蝦皮銷售報表共用這個模組，但各自保留設定與執行紀錄。
 *
 * 出金表真正的執行在 GitHub Actions 的 runner 上——這裡不跑 Chrome、不碰
 * CYBERBIZ 或 Google 的憑證，只保管「有哪些店」與「誰按過執行」。
 */

/**
 * 出金表的店別清單。
 *
 * 舊的 Worker 把 stores.json 打包進程式碼裡，所以設定頁改完之後要下載檔案、
 * commit 回 repo、重新部署，執行頁才會看到——實務上沒有人會這樣改。搬進來
 * 之後改存 D1，設定頁存檔就生效。
 *
 * **但 GitHub Actions 上的 driver 仍然讀它自己 repo 裡的 stores.json。**
 * 這張表決定「網頁上看得到哪幾家店」，driver 決定「那家店的檔案上傳到哪個
 * Drive 資料夾」。在這裡新增一家帳務 repo 沒有的店，執行時會失敗——所以設定頁
 * 仍然提供 stores.json 下載，而且要把這件事講清楚。
 */
export const payoutStores = sqliteTable("payout_stores", {
  id: text("id").primaryKey(),
  /** 必須與 CYBERBIZ 後台的 POS 商店名稱完全一致，driver 靠它找店。 */
  name: text("name").notNull(),
  driveFolderUrl: text("drive_folder_url").notNull().default(""),
  driveFolderName: text("drive_folder_name").notNull().default(""),
  /** 顯示順序。同仁習慣的店序跟建立時間無關，所以另外存。 */
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_payout_stores_name").on(table.name),
]);

/**
 * 誰按了執行、跑了哪幾家店、哪一段區間。
 *
 * 舊的 Worker 沒有這一層：任何拿到網址的人都能觸發，事後也查不出是誰。
 * 搬進平台之後執行要 tools:payout:run，順手把這件事記下來——出金表會動到
 * 正式帳務的 Drive 檔案，出問題時「上次是誰跑的」是第一個要問的問題。
 */
export const payoutRuns = sqliteTable("payout_runs", {
  id: text("id").primaryKey(),
  /**
   * 送進 workflow 的識別碼。workflow_dispatch 不會回傳 run id，只能靠它
   * 在後來的清單裡認出這一次是哪一筆（run-name 會帶上它）。
   */
  requestId: text("request_id").notNull(),
  storesJson: text("stores_json").notNull().default("[]"),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  actorId: text("actor_id").notNull(),
  // email 跟著存：人離職、帳號被刪之後仍然看得出當初是誰跑的。
  actorEmail: text("actor_email").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_payout_runs_request_id").on(table.requestId),
  index("idx_payout_runs_created_at").on(table.createdAt),
]);

export type PayoutStore = typeof payoutStores.$inferSelect;
export type PayoutRun = typeof payoutRuns.$inferSelect;

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
