import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export type ItemSource = "cyberbiz" | "custom";
export type ItemKind = "sellable" | "supply";

/** 品項分類（營運分析用）。固定兩層：大分類與小分類。 */
export const itemCategories = sqliteTable("item_categories", {
  id: text("id").primaryKey(),
  depth: integer("depth").notNull().default(0),
  parentId: text("parent_id"),
  parentDepth: integer("parent_depth"),
  name: text("name").notNull(),
  color: text("color").notNull().default("rose"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_item_categories_id_depth").on(table.id, table.depth),
  uniqueIndex("idx_item_categories_root_name").on(table.name).where(sql`${table.parentId} IS NULL`),
  uniqueIndex("idx_item_categories_child_name").on(table.parentId, table.name).where(sql`${table.parentId} IS NOT NULL`),
  index("idx_item_categories_parent").on(table.parentId, table.sortOrder),
  foreignKey({
    columns: [table.parentId, table.parentDepth],
    foreignColumns: [table.id, table.depth],
  }).onDelete("restrict"),
  check("ck_item_categories_depth", sql`${table.depth} IN (0, 1)`),
  check("ck_item_categories_parent_by_depth", sql`(${table.depth} = 0) = (${table.parentId} IS NULL)`),
  check("ck_item_categories_parent_depth", sql`${table.parentId} IS NULL OR ${table.parentDepth} = 0`),
]);

/** 全平台的品項身分樞紐：WMS、CYBERBIZ 鏡像與報表對應都指向這裡。 */
export const items = sqliteTable("items", {
  id: text("id").primaryKey(),
  source: text("source").$type<ItemSource>().notNull(),
  kind: text("kind").$type<ItemKind>().notNull().default("sellable"),
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  categoryId: text("category_id").references(() => itemCategories.id, { onDelete: "set null" }),
  listPrice: integer("list_price"),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_items_source_sku").on(table.source, table.sku),
  index("idx_items_category").on(table.categoryId, table.active),
  index("idx_items_name").on(table.name),
  check("ck_items_source", sql`${table.source} IN ('cyberbiz', 'custom')`),
  check("ck_items_kind", sql`${table.kind} IN ('sellable', 'supply')`),
]);

/** CYBERBIZ 商品目錄在 D1 的鏡像；與 items 共用主鍵的延伸表。 */
export const cyberbizProducts = sqliteTable("cyberbiz_products", {
  itemId: text("item_id").primaryKey().references(() => items.id, { onDelete: "cascade" }),
  cyberbizProductId: text("cyberbiz_product_id").notNull(),
  cyberbizVariantId: text("cyberbiz_variant_id").notNull(),
  productName: text("product_name").notNull().default(""),
  variantName: text("variant_name").notNull().default(""),
  published: integer("published").notNull().default(1),
  rawJson: text("raw_json").notNull().default("{}"),
  cyberbizUpdatedAt: text("cyberbiz_updated_at"),
  syncStatus: text("sync_status").notNull().default("synced"),
  syncedAt: text("synced_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_cyberbiz_products_external_id").on(table.cyberbizProductId, table.cyberbizVariantId),
  check("ck_cyberbiz_products_sync_status", sql`${table.syncStatus} IN ('synced', 'failed')`),
]);

/** 品項的組成（BOM）。報表存賣出去的 item，材料用量另由這張表推導。 */
export const itemComponents = sqliteTable("item_components", {
  parentItemId: text("parent_item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  componentItemId: text("component_item_id").notNull().references(() => items.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.parentItemId, table.componentItemId] }),
  index("idx_item_components_component").on(table.componentItemId),
  check("ck_item_components_not_self", sql`${table.parentItemId} <> ${table.componentItemId}`),
  check("ck_item_components_quantity", sql`${table.quantity} > 0`),
]);

export type ItemCategory = typeof itemCategories.$inferSelect;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type CyberbizProduct = typeof cyberbizProducts.$inferSelect;
export type ItemComponent = typeof itemComponents.$inferSelect;
