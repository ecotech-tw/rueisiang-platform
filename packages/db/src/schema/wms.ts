import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { items } from "./items.js";
import { mediaObjects } from "./media.js";

export type WmsLayoutElementType = "zone" | "decoration";

/** 倉儲作業用分類；與營運分析的 item_categories 分開。 */
export const wmsCategories = sqliteTable("wms_categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color").notNull().default("rose"),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_wms_categories_name").on(table.name),
]);

/** 倉庫裡的一個區域；幾何位置在 wms_layout_elements。 */
export const wmsZones = sqliteTable("wms_zones", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  color: text("color").notNull().default("mint"),
  notes: text("notes").notNull().default(""),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_wms_zones_code").on(table.code),
]);

/** 倉位裡的層；wms_items 指向這裡而不是 JSON 字串。 */
export const wmsShelves = sqliteTable("wms_shelves", {
  id: text("id").primaryKey(),
  zoneId: text("zone_id").notNull().references(() => wmsZones.id, { onDelete: "restrict" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_wms_shelves_zone_code").on(table.zoneId, table.code),
  index("idx_wms_shelves_zone").on(table.zoneId, table.sortOrder),
]);

/** 倉庫地圖。 */
export const wmsLayouts = sqliteTable("wms_layouts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  canvasWidth: integer("canvas_width").notNull().default(1600),
  canvasHeight: integer("canvas_height").notNull().default(900),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_wms_layouts_name").on(table.name),
]);

/** 地圖上的方塊：倉位或裝飾元素。 */
export const wmsLayoutElements = sqliteTable("wms_layout_elements", {
  id: text("id").primaryKey(),
  layoutId: text("layout_id").notNull().references(() => wmsLayouts.id, { onDelete: "cascade" }),
  elementType: text("element_type").$type<WmsLayoutElementType>().notNull(),
  zoneId: text("zone_id").references(() => wmsZones.id, { onDelete: "cascade" }),
  label: text("label").notNull().default(""),
  color: text("color").notNull().default("rose"),
  x: integer("x").notNull(),
  y: integer("y").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  zIndex: integer("z_index").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_wms_layout_elements_layout").on(table.layoutId, table.zIndex),
  index("idx_wms_layout_elements_zone").on(table.zoneId),
  check("ck_wms_layout_elements_type", sql`${table.elementType} IN ('zone', 'decoration')`),
  check("ck_wms_layout_elements_zone", sql`(${table.elementType} = 'zone') = (${table.zoneId} IS NOT NULL)`),
]);

/** 倉位照片連結；檔案 metadata 在 media_objects。 */
export const wmsZoneImages = sqliteTable("wms_zone_images", {
  zoneId: text("zone_id").notNull().references(() => wmsZones.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull().references(() => mediaObjects.objectKey, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.zoneId, table.objectKey] }),
  index("idx_wms_zone_images_zone").on(table.zoneId, table.sortOrder),
]);

/** 進了倉庫的品項；不是每個 item 都一定有一列。 */
export const wmsItems = sqliteTable("wms_items", {
  itemId: text("item_id").primaryKey().references(() => items.id, { onDelete: "cascade" }),
  wmsCategoryId: text("wms_category_id").references(() => wmsCategories.id, { onDelete: "set null" }),
  shelfId: text("shelf_id").references(() => wmsShelves.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull().default(0),
  unit: text("unit").notNull().default("件"),
  minStock: integer("min_stock").notNull().default(5),
  notes: text("notes").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_wms_items_shelf").on(table.shelfId),
  index("idx_wms_items_category").on(table.wmsCategoryId),
  index("idx_wms_items_low_stock").on(table.itemId).where(sql`${table.quantity} < ${table.minStock}`),
]);

export type WmsCategory = typeof wmsCategories.$inferSelect;
export type WmsZone = typeof wmsZones.$inferSelect;
export type WmsShelf = typeof wmsShelves.$inferSelect;
export type WmsLayout = typeof wmsLayouts.$inferSelect;
export type WmsLayoutElement = typeof wmsLayoutElements.$inferSelect;
export type WmsZoneImage = typeof wmsZoneImages.$inferSelect;
export type WmsItem = typeof wmsItems.$inferSelect;
