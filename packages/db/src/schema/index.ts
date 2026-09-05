// 每個模組一個 schema 檔。activity 是跨模組共用的操作紀錄，不屬於任何一個。
import { itemCategories, itemComponents, items } from "./items.js";

export * from "./activity.js";
export * from "./assistant.js";
export {
  GLOBAL_SCOPE,
  permissions,
  roles,
  users,
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
export { itemCategories, itemComponents, items, cyberbizProducts as cyberbizProductCatalog, type CyberbizProduct } from "./items.js";
export type ItemCategory = typeof itemCategories.$inferSelect;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type ItemComponent = typeof itemComponents.$inferSelect;
export * from "./media.js";
export * from "./reports.js";
export * from "./tools.js";
export {
  cyberbizProductWebhooks,
  wmsCategories,
  wmsCyberbizLinks,
  wmsItems,
  wmsLayoutElements,
  wmsLayouts,
  wmsShelves,
  wmsZoneImages,
  wmsZones,
  type CyberbizProductWebhook,
  type WmsCategory,
  type WmsCyberbizLink,
  type WmsItem,
  type WmsLayout,
  type WmsLayoutElement,
  type WmsShelf,
  type WmsZone,
  type WmsZoneImage,
} from "./wms.js";
