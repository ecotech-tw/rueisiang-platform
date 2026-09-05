import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const crmCustomers = sqliteTable("crm_customers", {
  id: text("id").primaryKey(),
  phone: text("phone").notNull(),
  normalizedPhone: text("normalized_phone").notNull(),
  name: text("name").notNull().default(""),
  email: text("email").notNull().default(""),
  address: text("address").notNull().default(""),
  sourceChannel: text("source_channel").notNull().default("manual"),
  status: text("status").notNull().default("active"),
  cyberbizCustomerId: text("cyberbiz_customer_id"),
  cyberbizUid: text("cyberbiz_uid"),
  cyberbizTagsJson: text("cyberbiz_tags_json").notNull().default("[]"),
  cyberbizUpdatedAt: text("cyberbiz_updated_at"),
  rawJson: text("raw_json").notNull().default("{}"),
  syncStatus: text("sync_status").notNull().default("local_only"),
  syncError: text("sync_error"),
  syncedAt: text("synced_at"),
  lastWebhookAt: text("last_webhook_at"),
  blockedAt: text("blocked_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_customers_cyberbiz_customer_id").on(table.cyberbizCustomerId),
  index("idx_customers_normalized_phone").on(table.normalizedPhone),
  index("idx_customers_status_channel").on(table.status, table.sourceChannel),
  index("idx_customers_updated_at").on(table.updatedAt),
  index("idx_customers_cyberbiz_updated_at").on(table.cyberbizUpdatedAt),
  // 補資料的清單頁專用：只有姓名或地址是空的才進索引。
  index("idx_customers_incomplete").on(table.id).where(sql`${table.name} = '' OR ${table.address} = ''`),
]);

/** 標籤字典。 */
export const crmTags = sqliteTable("crm_tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_crm_tags_name").on(table.name),
]);

/** 客戶身上的標籤關聯。 */
export const crmCustomerTags = sqliteTable("crm_customer_tags", {
  customerId: text("customer_id").notNull().references(() => crmCustomers.id, { onDelete: "cascade" }),
  crmTagId: text("crm_tag_id").notNull().references(() => crmTags.id, { onDelete: "cascade" }),
}, (table) => [
  primaryKey({ columns: [table.customerId, table.crmTagId] }),
  index("idx_crm_customer_tags_tag").on(table.crmTagId),
]);

/** 客戶列表的全公司共用儲存視圖。 */
export const crmSavedViews = sqliteTable("crm_saved_views", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  search: text("search").notNull().default(""),
  channel: text("channel").notNull().default("all"),
  status: text("status").notNull().default("all"),
  sortField: text("sort_field").notNull().default("updatedAt"),
  sortDirection: text("sort_direction").notNull().default("desc"),
  pageSize: integer("page_size").notNull().default(10),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  tag: text("tag").notNull().default("all"),
  createdByEmail: text("created_by_email").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_saved_views_name").on(table.name),
]);

/** CYBERBIZ 推過來的會員／商品事件，合併舊 customer 與 product webhook 表。 */
export const cyberbizWebhookEvents = sqliteTable("cyberbiz_webhook_events", {
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  status: text("status").notNull().default("received"),
  // cyberbizCustomerId／customerId／resultJson 是會員 webhook 時代留下的欄位，
  // entityType 那三欄才是合併商品 webhook 之後的形狀。兩套現在都還在正式庫裡。
  cyberbizCustomerId: text("cyberbiz_customer_id"),
  customerId: text("customer_id").references(() => crmCustomers.id, { onDelete: "set null" }),
  payloadJson: text("payload_json").notNull(),
  resultJson: text("result_json").notNull().default("{}"),
  lastError: text("last_error"),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  processedAt: text("processed_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  entityType: text("entity_type"),
  externalEntityId: text("external_entity_id"),
  attempts: integer("attempts").notNull().default(0),
}, (table) => [
  index("idx_webhook_events_status").on(table.status, table.receivedAt),
  index("idx_webhook_events_customer").on(table.cyberbizCustomerId, table.receivedAt),
  index("idx_webhook_events_entity").on(table.entityType, table.externalEntityId, table.receivedAt),
]);

// 舊名稱先留成別名，consumer 改完再拿掉。它們指向同一個 table 物件，
// 不是另一份定義——同一張實體表有兩個 sqliteTable 會讓 drizzle 只看見其中一份，
// 另一份宣告的索引與約束就整組消失（#180 的索引漂移就是這樣來的）。
export const customers = crmCustomers;
export const savedViews = crmSavedViews;
export const customerTagCatalog = crmTags;
export const cyberbizCustomerWebhooks = cyberbizWebhookEvents;

export type CrmCustomer = typeof crmCustomers.$inferSelect;
export type NewCrmCustomer = typeof crmCustomers.$inferInsert;
export type Customer = CrmCustomer;
export type NewCustomer = NewCrmCustomer;
export type CrmSavedView = typeof crmSavedViews.$inferSelect;
export type SavedView = CrmSavedView;
export type CrmTag = typeof crmTags.$inferSelect;
export type CustomerTag = CrmTag;
export type CyberbizWebhookEvent = typeof cyberbizWebhookEvents.$inferSelect;
export type CyberbizCustomerWebhook = CyberbizWebhookEvent;
