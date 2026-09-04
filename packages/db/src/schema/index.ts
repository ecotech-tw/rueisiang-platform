// 每個模組一個 schema 檔。activity 是跨模組共用的操作紀錄，不屬於任何一個。
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { itemCategories, itemComponents, items } from "./items.js";
export { reportProductCategories } from "./report-products.js";

export * from "./activity.js";
export * from "./assistant.js";
export {
  GLOBAL_SCOPE,
  permissions,
  rolePermissionGrants,
  rolePermissions,
  userPermissionGrants,
  userPermissions,
  userRoleAssignments,
  userRoles,
  type Role,
  type User,
  type UserPermissionGrant,
  type UserRole,
  type UserRoleAssignment,
} from "./auth.js";
export * from "./crm.js";
export { itemCategories, itemComponents, items, cyberbizProducts as targetCyberbizProducts } from "./items.js";
export type ItemCategory = typeof itemCategories.$inferSelect;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type CyberbizProduct = any;
export type ItemComponent = typeof itemComponents.$inferSelect;
export * from "./media.js";
export * from "./reports.js";
export * from "./tools.js";
export {
  cyberbizProductCategories,
  cyberbizProductLinks,
  cyberbizProductWebhooks,
  cyberbizProducts,
  customReportProducts,
  inventoryItems,
  layoutElements,
  productBundleComponents,
  productSkuMappings,
  reportSkuIgnores,
  warehouseCategories,
  warehouseSettings,
  wmsCategories,
  wmsItems,
  wmsLayoutElements,
  wmsLayouts,
  wmsShelves,
  wmsZoneImages,
  wmsZones,
  zoneImages,
  zones,
  type InventoryItem,
  type LayoutElement,
  type WarehouseCategory,
  type WmsCategory,
  type WmsItem,
  type WmsLayout,
  type WmsLayoutElement,
  type WmsShelf,
  type WmsZone,
  type WmsZoneImage,
  type Zone,
  type ZoneImage,
} from "./wms.js";

// 測試與少數 route 會直接從 schema barrel 使用舊欄位名稱；實作會在本輪逐一改掉。
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  googleSubject: text("google_subject"),
  name: text("google_name").notNull().default(""),
  displayName: text("display_name").notNull().default(""),
  pictureUrl: text("picture_url").notNull().default(""),
  status: text("status").notNull().default("invited"),
  passwordHash: text("password_hash"),
  invitationTokenHash: text("invitation_token_hash"),
  invitationExpiresAt: text("invitation_expires_at"),
  passwordSetAt: text("password_set_at"),
  invitedBy: text("invited_by"),
  lastLoginAt: text("last_login_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}) as any;

export const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  key: text("role_key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}) as any;
