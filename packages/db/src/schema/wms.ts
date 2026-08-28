import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * 倉儲管理系統。從 rueisiang-wms 搬進來。
 *
 * 原本那邊有 12 張表，這裡只有 8 張。少掉的四張：
 *
 *   app_users             被平台的 users 取代
 *   audit_logs            併進共用的 activity_events
 *   line_bot_destinations 只服務 LINE bot，那部分不搬
 *   inventory_alert_states 同上
 *
 * 表名沿用原本的（zones、inventory_items 這種），只有 webhook 那張改名——
 * 原本叫 cyberbiz_webhook_events，但平台已經有 cyberbiz_customer_webhooks，
 * 兩張都是「CYBERBIZ 推過來的事件」卻各叫各的。改成 cyberbiz_product_webhooks
 * 之後，看表名就知道是哪一種。
 */

/**
 * 倉位。地圖上的一個方塊，也是庫存的所在位置。
 *
 * x/y/width/height 是**百分比**，不是像素：畫的時候是 canvasWidth * x / 100。
 * 存百分比的好處是換畫布尺寸（warehouse_settings 有標準／寬版／大型三種）時
 * 整張圖等比例縮放，不用把每個倉位的座標重算一遍。
 */
export const zones = sqliteTable("zones", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  category: text("category").notNull().default("一般備品"),
  color: text("color").notNull().default("mint"),
  x: integer("x").notNull(),
  y: integer("y").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  /**
   * 這一區有哪幾層，JSON 陣列。
   *
   * 存 JSON 而不是另開一張表：層只有名字、沒有自己的屬性，也不會被別的東西
   * 參照——拆成一張表只是讓「讀一個倉位」變成兩次查詢。
   */
  shelfLevels: text("shelf_levels")
    .notNull()
    .default('[{"id":"top","name":"上層"},{"id":"middle","name":"中層"},{"id":"bottom","name":"底層"}]'),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** 地圖畫布的尺寸。只會有一列，id 固定。 */
export const warehouseSettings = sqliteTable("warehouse_settings", {
  id: text("id").primaryKey(),
  canvasWidth: integer("canvas_width").notNull().default(1600),
  canvasHeight: integer("canvas_height").notNull().default(900),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/**
 * 地圖上的裝飾方塊：牆、走道、門口這種。
 *
 * 跟 zones 分開是因為它們沒有庫存、也沒有層——放同一張表就得讓半數欄位可為
 * 空，然後每次查詢都要記得過濾。
 */
export const layoutElements = sqliteTable("layout_elements", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  color: text("color").notNull().default("rose"),
  x: integer("x").notNull(),
  y: integer("y").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** 商品分類字典。inventory_items.category 存的是名字，不是外鍵。 */
export const productCategories = sqliteTable("product_categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("rose"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/**
 * 庫存品項。
 *
 * zoneId 的 onDelete 是 restrict 而不是 cascade：倉位被刪掉時，裡面的東西不該
 * 跟著消失——那是「這批貨現在在哪」這個問題的答案，弄丟了沒有別的地方找得回來。
 * 要刪倉位就得先把品項搬走，那是對的順序。
 */
export const inventoryItems = sqliteTable("inventory_items", {
  id: text("id").primaryKey(),
  sku: text("sku").unique(),
  name: text("name").notNull(),
  category: text("category").notNull().default("一般備品"),
  quantity: integer("quantity").notNull().default(0),
  unit: text("unit").notNull().default("件"),
  /** 低於這個數量就算需要補貨。 */
  minStock: integer("min_stock").notNull().default(5),
  zoneId: text("zone_id").references(() => zones.id, { onDelete: "restrict" }),
  shelfLevel: text("shelf_level"),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_inventory_items_zone").on(table.zoneId),
  index("idx_inventory_items_name").on(table.name),
]);

/**
 * 外部通路 SKU 與 WMS 商品的對應。
 *
 * external_sku 不分通路儲存；同一個外部 SKU 必須只對應一個 WMS 品項。
 * 商品的正式 SKU、名稱與分類都從 inventory_items 取得，不在這裡複製。
 */
export const productSkuMappings = sqliteTable("product_sku_mappings", {
  id: text("id").primaryKey(),
  inventoryItemId: text("inventory_item_id")
    .notNull()
    .references(() => inventoryItems.id, { onDelete: "cascade" }),
  externalSku: text("external_sku").notNull().unique(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_product_sku_mappings_inventory_item").on(table.inventoryItemId),
]);

/**
 * 庫存品項與 CYBERBIZ 商品款式的對應。
 *
 * 一個品項最多對一個款式（兩邊都是 unique）：多對多會讓「這裡少了 3 件，官網
 * 要扣哪一個」變成沒有答案的問題。
 */
export const cyberbizProductLinks = sqliteTable("cyberbiz_product_links", {
  id: text("id").primaryKey(),
  inventoryItemId: text("inventory_item_id")
    .notNull()
    .unique()
    .references(() => inventoryItems.id, { onDelete: "cascade" }),
  cyberbizProductId: text("cyberbiz_product_id").notNull(),
  cyberbizVariantId: text("cyberbiz_variant_id").notNull().unique(),
  sku: text("sku").notNull(),
  /** company：公司倉／pos：某家門市的庫存。後者才需要 posShopId。 */
  warehouseScope: text("warehouse_scope").notNull().default("company"),
  posShopId: integer("pos_shop_id").notNull().default(0),
  syncStatus: text("sync_status").notNull().default("synced"),
  lastSyncedQuantity: integer("last_synced_quantity"),
  lastSyncedAt: text("last_synced_at"),
  lastError: text("last_error").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_cyberbiz_product_links_status").on(table.syncStatus),
  index("idx_cyberbiz_product_links_sku").on(table.sku),
]);

/**
 * CYBERBIZ 推過來的商品／庫存事件。
 *
 * 與 cyberbiz_customer_webhooks 同一個角色，只是另一個模組的。payloadHash 用來
 * 認出重送：CYBERBIZ 會重試，沒有這個欄位就會把同一件事處理兩次。
 */
export const cyberbizProductWebhooks = sqliteTable("cyberbiz_product_webhooks", {
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  productId: text("product_id"),
  variantId: text("variant_id"),
  sku: text("sku").notNull().default(""),
  quantity: integer("quantity"),
  payloadHash: text("payload_hash").notNull(),
  status: text("status").notNull().default("processing"),
  attempts: integer("attempts").notNull().default(1),
  result: text("result").notNull().default(""),
  lastError: text("last_error").notNull().default(""),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  processedAt: text("processed_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_cyberbiz_product_webhooks_status").on(table.status, table.receivedAt),
  index("idx_cyberbiz_product_webhooks_variant").on(table.variantId, table.receivedAt),
]);

/**
 * 倉位的照片。
 *
 * objectKey 指向物件儲存（原本是 GCS，搬進平台之後是 R2）。這張表只存索引，
 * 檔案本身不進資料庫。
 */
export const zoneImages = sqliteTable("zone_images", {
  id: text("id").primaryKey(),
  zoneId: text("zone_id").notNull().references(() => zones.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull().unique(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_zone_images_zone").on(table.zoneId),
]);

export type Zone = typeof zones.$inferSelect;
export type LayoutElement = typeof layoutElements.$inferSelect;
export type ProductCategory = typeof productCategories.$inferSelect;
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type ProductSkuMapping = typeof productSkuMappings.$inferSelect;
export type CyberbizProductLink = typeof cyberbizProductLinks.$inferSelect;
export type ZoneImage = typeof zoneImages.$inferSelect;
