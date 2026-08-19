import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * 客戶關係管理。欄位沿用舊 CRM 的 db/schema.ts——那份本來就是 drizzle 的
 * sqlite-core，跑在 Cloud Run 上只是靠一層墊片假裝成 D1，所以搬過來幾乎不用改。
 *
 * 動到的只有名字：舊系統的 cyberbiz_webhook_events 與 WMS 那張同名（兩邊存的
 * 是完全不同的東西，一個是會員、一個是庫存），Phase 4 併進同一個資料庫時會撞。
 * 現在就照領域取名，之後 WMS 那張叫 cyberbiz_inventory_webhooks。
 */

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  phone: text("phone").notNull(),
  // 去掉分隔符號與國碼的電話，重複判定與搜尋都用這一欄。
  normalizedPhone: text("normalized_phone").notNull(),
  name: text("name").notNull().default(""),
  email: text("email").notNull().default(""),
  address: text("address").notNull().default(""),
  // manual：人工建立／cyberbiz：從官網同步進來
  sourceChannel: text("source_channel").notNull().default("manual"),
  // active：正常／blocked：封鎖
  status: text("status").notNull().default("active"),
  cyberbizCustomerId: text("cyberbiz_customer_id"),
  cyberbizUid: text("cyberbiz_uid"),
  cyberbizTagsJson: text("cyberbiz_tags_json").notNull().default("[]"),
  cyberbizUpdatedAt: text("cyberbiz_updated_at"),
  // CYBERBIZ 回來的原始 payload，欄位對應不上時可以回頭查。
  cyberbizRawJson: text("cyberbiz_raw_json").notNull().default("{}"),
  // local_only：只存在本地／synced：兩邊一致／failed：上次同步失敗
  syncStatus: text("sync_status").notNull().default("local_only"),
  syncError: text("sync_error"),
  lastSyncedAt: text("last_synced_at"),
  lastWebhookAt: text("last_webhook_at"),
  blockedAt: text("blocked_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_customers_normalized_phone").on(table.normalizedPhone),
  uniqueIndex("idx_customers_cyberbiz_customer_id").on(table.cyberbizCustomerId),
  index("idx_customers_status_channel").on(table.status, table.sourceChannel),
  index("idx_customers_updated_at").on(table.updatedAt),
  index("idx_customers_cyberbiz_updated_at").on(table.cyberbizUpdatedAt),
]);

/**
 * 客戶列表的儲存檢視。
 *
 * 沿用舊系統的設計：這是**全公司共用**的一組檢視，不屬於個人（沒有 user_id）。
 * 是否要改成個人的，等實際用起來再決定——現在改等於替一個還沒發生的需求做設計。
 */
export const savedViews = sqliteTable("saved_views", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  search: text("search").notNull().default(""),
  channel: text("channel").notNull().default("all"),
  status: text("status").notNull().default("all"),
  // 標籤篩選是這一版才有的，舊系統的檢視存不了它，所以預設 all＝不篩。
  tag: text("tag").notNull().default("all"),
  sortField: text("sort_field").notNull().default("updatedAt"),
  sortDirection: text("sort_direction").notNull().default("desc"),
  pageSize: integer("page_size").notNull().default(10),
  // 只留 email 不留 user_id：檢視是共用的，需要的是「去問誰」，而人可能已經離職。
  createdByEmail: text("created_by_email").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_saved_views_name").on(table.name),
]);

/**
 * 客戶身上發生過的事，也是操作紀錄的資料來源。
 *
 * actor_email 跟著存下來而不是只留 actor_id：人離職、帳號被刪之後，
 * 紀錄仍然要看得出當初是誰做的。
 */
export const customerEvents = sqliteTable("customer_events", {
  id: text("id").primaryKey(),
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  summary: text("summary").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  // user：有人操作／system：排程或同步自己做的
  actorType: text("actor_type").notNull().default("system"),
  actorId: text("actor_id"),
  actorEmail: text("actor_email"),
  // crm：本系統／cyberbiz：官網同步過來的
  source: text("source").notNull().default("crm"),
  status: text("status").notNull().default("succeeded"),
  error: text("error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_customer_events_customer_created").on(table.customerId, table.createdAt),
  index("idx_customer_events_source_created").on(table.source, table.createdAt),
  index("idx_customer_events_actor_created").on(table.actorId, table.createdAt),
]);

/** 標籤字典。客戶身上的標籤存在 customers.cyberbiz_tags_json，這裡是可選清單。 */
export const customerTagCatalog = sqliteTable("customer_tag_catalog", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_customer_tag_catalog_name").on(table.name),
]);

/**
 * CYBERBIZ 送來的會員 webhook。先落地再處理，處理失敗也留著，
 * 這樣才有辦法回頭補跑而不是叫對方重送。
 *
 * 舊系統這張表叫 cyberbiz_webhook_events，與 WMS 的庫存 webhook 同名。
 */
export const cyberbizCustomerWebhooks = sqliteTable("cyberbiz_customer_webhooks", {
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  // received：剛收到／processed：處理完／failed：處理失敗
  status: text("status").notNull().default("received"),
  cyberbizCustomerId: text("cyberbiz_customer_id"),
  customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
  payloadJson: text("payload_json").notNull(),
  resultJson: text("result_json").notNull().default("{}"),
  lastError: text("last_error"),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  processedAt: text("processed_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_cyberbiz_customer_webhooks_status").on(table.status, table.receivedAt),
  index("idx_cyberbiz_customer_webhooks_customer").on(table.cyberbizCustomerId, table.receivedAt),
]);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type SavedView = typeof savedViews.$inferSelect;
export type CustomerEvent = typeof customerEvents.$inferSelect;
export type CustomerTag = typeof customerTagCatalog.$inferSelect;
export type CyberbizCustomerWebhook = typeof cyberbizCustomerWebhooks.$inferSelect;
