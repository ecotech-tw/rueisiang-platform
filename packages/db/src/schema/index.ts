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
  userPermissionGrants,
  userRoleAssignments,
  type Role,
  type User,
  type UserPermissionGrant,
  type UserRole,
  type UserRoleAssignment,
} from "./auth.js";
export * from "./crm.js";
export * from "./hr-people.js";
export * from "./hr-attendance.js";
export * from "./hr-requests.js";
export * from "./hr-payroll.js";
export {
  itemCategories,
  itemComponents,
  items,
  cyberbizProducts,
  // 暫時保留舊 alias，consumer 應改用 canonical cyberbizProducts。
  cyberbizProducts as cyberbizProductCatalog,
  type CyberbizProduct,
} from "./items.js";
export type ItemCategory = typeof itemCategories.$inferSelect;
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type ItemComponent = typeof itemComponents.$inferSelect;
export * from "./media.js";
export * from "./reports.js";
export * from "./tools.js";
export {
  cyberbizSyncLocks,
  wmsCategories,
  wmsItems,
  wmsLayoutElements,
  wmsLayouts,
  wmsShelves,
  wmsZoneImages,
  wmsZones,
  type CyberbizSyncLock,
  type WmsCategory,
  type WmsItem,
  type WmsLayout,
  type WmsLayoutElement,
  type WmsShelf,
  type WmsZone,
  type WmsZoneImage,
} from "./wms.js";
