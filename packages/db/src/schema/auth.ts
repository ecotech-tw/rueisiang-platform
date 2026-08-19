import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * 「全域範圍」用空字串而不是 NULL。
 *
 * SQLite 的唯一索引不會把兩個 NULL 視為重複，所以若 scope 允許 NULL，
 * 同一組 (user, role, 全域) 可以被重複插入。改用哨兵值就能用單純的唯一索引解決，
 * 查詢時也不必到處寫 IS NULL。
 */
export const GLOBAL_SCOPE = "";

/**
 * 統一的使用者表，取代 CRM 與 WMS 各自一份的 app_users。
 *
 * 沿用舊系統兩個已驗證的設計：
 *   1. 邀請制——status 從 'invited' 開始，Google 登入時必須已經有這一列，不自動建帳號。
 *   2. 停權即時生效——授權判定每次請求都回這張表重讀，不信 cookie 裡的 claim。
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  googleSubject: text("google_subject"),
  // Google 帳號上的姓名。每次登入都會被覆寫，所以不是使用者能改的東西。
  name: text("name").notNull().default(""),
  // 使用者自己設定的顯示名稱。有值時一律優先，登入不會動它。
  displayName: text("display_name").notNull().default(""),
  pictureUrl: text("picture_url").notNull().default(""),
  // invited：已邀請未登入過／active：可用／disabled：停權
  status: text("status").notNull().default("invited"),
  /*
   * 兩條登入路都通向同一列。邀請一律同時支援 Google 與帳密——
   * 對方走哪一條由他自己決定，我們不預先綁死：新同事手上不一定有公司 Google 帳號，
   * 但邀請當下沒有人知道這件事。
   */
  passwordHash: text("password_hash"),
  /** 只存邀請 token 的 SHA-256。資料庫外洩時拿到的那一串換不到帳號。 */
  invitationTokenHash: text("invitation_token_hash"),
  invitationExpiresAt: text("invitation_expires_at"),
  /** 設過密碼的時間。用來在後台區分「還沒設」與「設了但沒登入過」。 */
  passwordSetAt: text("password_set_at"),
  invitedBy: text("invited_by"),
  lastLoginAt: text("last_login_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_users_email").on(table.email),
  uniqueIndex("idx_users_google_subject").on(table.googleSubject),
  index("idx_users_status").on(table.status),
  // 拿 token 換帳號是每次開邀請連結都會做的查詢，而且必須唯一。
  uniqueIndex("idx_users_invitation_token_hash").on(table.invitationTokenHash),
]);

/** 角色。isSystem 的角色不允許從 UI 刪除。 */
export const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_roles_key").on(table.key),
]);

/**
 * 角色擁有的權限。permission 是字串鍵值（如 crm:customer:write），
 * 定義在 packages/auth 的程式碼裡而非資料表——權限鍵值是程式邏輯的一部分，
 * 放進 DB 只會讓「有哪些權限」與「程式檢查哪些權限」兩邊漂移。
 */
export const rolePermissions = sqliteTable("role_permissions", {
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  permission: text("permission").notNull(),
}, (table) => [
  primaryKey({ columns: [table.roleId, table.permission] }),
]);

/**
 * 使用者被指派的角色，附帶資料範圍。
 *
 * scopeType/scopeId 為 GLOBAL_SCOPE（空字串）＝全域，看得到所有資料。
 * 有值時代表這個角色只在該範圍內生效，例如 ('store', '誠品西門店3F')。
 * 同一個人可以拿到多列：在 A 店是主管、在 B 店只能檢視。
 */
export const userRoles = sqliteTable("user_roles", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  scopeType: text("scope_type").notNull().default(GLOBAL_SCOPE),
  scopeId: text("scope_id").notNull().default(GLOBAL_SCOPE),
  grantedBy: text("granted_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.userId, table.roleId, table.scopeType, table.scopeId] }),
  index("idx_user_roles_user").on(table.userId),
]);

/**
 * 直接授予某個人的權限，繞過角色。
 *
 * 角色回答的是「這一類人能做什麼」，這張表回答的是「這一個人另外還能做什麼」。
 * 實務上一定會出現例外：陳美玲是一般同仁，但這個月要幫忙跑出金表——為了一個
 * 人開一個新角色，角色清單很快就會長出十幾個只有一個人在用的東西。
 *
 * 只加不減：這裡的權限跟角色帶來的取聯集，沒有「扣掉某個權限」的機制。
 * 減法會讓「這個人到底能做什麼」變成要同時看兩張表才算得出來的問題，
 * 而授權判定是每個請求都要跑的路徑，愈簡單愈好。真的要收掉就換一個角色。
 */
export const userPermissions = sqliteTable("user_permissions", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  permission: text("permission").notNull(),
  grantedBy: text("granted_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.userId, table.permission] }),
]);

export type User = typeof users.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type UserRole = typeof userRoles.$inferSelect;
