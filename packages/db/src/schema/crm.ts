import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const crmCustomers = sqliteTable("crm_customers", {
  id: text("id").primaryKey(),
  phone: text("phone").notNull(),
  normalizedPhone: text("normalized_phone").notNull(),
  name: text("name").notNull().default(""),
  email: text("email").notNull().default(""),
  address: text("address").notNull().default(""),
  cyberbizCustomerId: text("cyberbiz_customer_id"),
  cyberbizUid: text("cyberbiz_uid"),
  rawJson: text("raw_json").notNull().default("{}"),
  cyberbizUpdatedAt: text("cyberbiz_updated_at"),
  syncStatus: text("sync_status").notNull().default("synced"),
  syncedAt: text("synced_at"),
  status: text("status").notNull().default("active"),
  blockedAt: text("blocked_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_crm_customers_cyberbiz_customer_id").on(table.cyberbizCustomerId),
  index("idx_crm_customers_phone").on(table.normalizedPhone),
  index("idx_crm_customers_status").on(table.status, table.updatedAt),
  index("idx_crm_customers_updated").on(table.updatedAt),
  index("idx_crm_customers_cb_updated").on(table.cyberbizUpdatedAt),
  index("idx_crm_customers_incomplete").on(table.id).where(sql`${table.name} = '' OR ${table.address} = ''`),
  check("ck_crm_customers_status", sql`${table.status} IN ('active', 'blocked')`),
  check("ck_crm_customers_sync_status", sql`${table.syncStatus} IN ('synced', 'failed')`),
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
  status: text("status").notNull().default("all"),
  tag: text("tag").notNull().default("all"),
  sortField: text("sort_field").notNull().default("updatedAt"),
  sortDirection: text("sort_direction").notNull().default("desc"),
  pageSize: integer("page_size").notNull().default(10),
  createdByEmail: text("created_by_email").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_crm_saved_views_name").on(table.name),
]);

/** CYBERBIZ 推過來的會員／商品事件，合併舊 customer 與 product webhook 表。 */
export const cyberbizWebhookEvents = sqliteTable("cyberbiz_webhook_events", {
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  entityType: text("entity_type").notNull(),
  externalEntityId: text("external_entity_id"),
  payloadJson: text("payload_json").notNull().default("{}"),
  status: text("status").notNull().default("processing"),
  attempts: integer("attempts").notNull().default(1),
  lastError: text("last_error").notNull().default(""),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  processedAt: text("processed_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_webhook_events_status").on(table.status, table.receivedAt),
  index("idx_webhook_events_entity").on(table.entityType, table.externalEntityId, table.receivedAt),
  check("ck_webhook_events_entity", sql`${table.entityType} IN ('customer', 'product')`),
  check("ck_webhook_events_status", sql`${table.status} IN ('processing', 'processed', 'ignored', 'failed')`),
]);

// 過渡期相容舊 service 名稱；實作會在這輪 schema overhaul 裡逐一改到新名稱。
export const customers = sqliteTable("crm_customers", {
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
  cyberbizRawJson: text("raw_json").notNull().default("{}"),
  syncStatus: text("sync_status").notNull().default("local_only"),
  syncError: text("sync_error"),
  lastSyncedAt: text("synced_at"),
  lastWebhookAt: text("last_webhook_at"),
  blockedAt: text("blocked_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}) as any;
export const savedViews = sqliteTable("crm_saved_views", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  search: text("search").notNull().default(""),
  channel: text("channel").notNull().default("all"),
  status: text("status").notNull().default("all"),
  tag: text("tag").notNull().default("all"),
  sortField: text("sort_field").notNull().default("updatedAt"),
  sortDirection: text("sort_direction").notNull().default("desc"),
  pageSize: integer("page_size").notNull().default(10),
  createdByEmail: text("created_by_email").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}) as any;
export const customerTagCatalog = crmTags as any;
export const cyberbizCustomerWebhooks = sqliteTable("cyberbiz_webhook_events", {
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  status: text("status").notNull().default("received"),
  cyberbizCustomerId: text("cyberbiz_customer_id"),
  customerId: text("customer_id"),
  payloadJson: text("payload_json").notNull(),
  resultJson: text("result_json").notNull().default("{}"),
  lastError: text("last_error"),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  processedAt: text("processed_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}) as any;

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
