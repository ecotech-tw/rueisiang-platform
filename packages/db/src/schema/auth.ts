import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  googleSubject: text("google_subject"),
  googleName: text("google_name").notNull().default(""),
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
}, (table) => [
  uniqueIndex("idx_users_email").on(table.email),
  uniqueIndex("idx_users_google_subject").on(table.googleSubject),
  uniqueIndex("idx_users_invitation_token_hash").on(table.invitationTokenHash),
  index("idx_users_status").on(table.status),
  check("ck_users_status", sql`${table.status} IN ('invited', 'active', 'disabled')`),
]);

export const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  roleKey: text("role_key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_roles_role_key").on(table.roleKey),
]);

/** 權限目錄是 permissions.ts 的 D1 鏡像，只為了讓授權表有 FK 可指。 */
export const permissions = sqliteTable("permissions", {
  permission: text("permission").primaryKey(),
  syncedAt: text("synced_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const rolePermissionGrants = sqliteTable("role_permission_grants", {
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  // RESTRICT 不是 CASCADE：從 permissions.ts 拿掉一個權限時，sync 刪那一列會靜靜
  // 把所有人的授權一起刪光（0023 就是這樣）。要的是刪不掉、當場報錯。
  permission: text("permission").notNull().references(() => permissions.permission, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.roleId, table.permission] }),
  index("idx_role_permission_grants_permission").on(table.permission),
]);

export const userRoleAssignments = sqliteTable("user_role_assignments", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  grantedBy: text("granted_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.userId, table.roleId] }),
]);

export const userPermissionGrants = sqliteTable("user_permission_grants", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  permission: text("permission").notNull().references(() => permissions.permission, { onDelete: "restrict" }),
  grantedBy: text("granted_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.userId, table.permission] }),
  index("idx_user_permission_grants_permission").on(table.permission),
]);

export const GLOBAL_SCOPE = "";

// 過渡期相容舊 service 名稱；實作會在這輪 schema overhaul 裡逐一改到新名稱。
export const rolePermissions = sqliteTable("role_permissions", {
  roleId: text("role_id").notNull(),
  permission: text("permission").notNull(),
}, (table) => [primaryKey({ columns: [table.roleId, table.permission] })]);

export const userRoles = sqliteTable("user_roles", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  // 資料範圍。目前一律留白＝全域，但欄位與主鍵都保留著：哪天真的有模組要按店別
  // 切資料時不必再開一次 migration。理由見 packages/auth/src/rbac.ts 的 can()。
  scopeType: text("scope_type").notNull().default(GLOBAL_SCOPE),
  scopeId: text("scope_id").notNull().default(GLOBAL_SCOPE),
  grantedBy: text("granted_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.userId, table.roleId, table.scopeType, table.scopeId] }),
  // 主鍵是 (user_id, role_id)，「這個人有哪些角色」用得到前綴，「這個角色有誰」用不到。
  index("idx_user_roles_user").on(table.userId),
]);

export const userPermissions = sqliteTable("user_permissions", {
  userId: text("user_id").notNull(),
  permission: text("permission").notNull(),
  grantedBy: text("granted_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [primaryKey({ columns: [table.userId, table.permission] })]);

export type User = typeof users.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type UserRoleAssignment = typeof userRoleAssignments.$inferSelect;
export type UserRole = UserRoleAssignment;
export type UserPermissionGrant = typeof userPermissionGrants.$inferSelect;
