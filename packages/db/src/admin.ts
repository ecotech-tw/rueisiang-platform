import type { Permission, UserStatus } from "@rueisiang/auth";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { rolePermissions, roles, userRoles, users } from "./schema/auth.js";

/**
 * 權限管理頁用到的查詢。與 users.ts 分開：那邊是每次請求都會跑的授權讀取路徑，
 * 這裡是管理者偶爾才用的維護操作，兩者的效能考量與呼叫頻率完全不同。
 */

export interface AssignmentRow {
  roleKey: string;
  roleName: string;
}

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
  assignments: AssignmentRow[];
}

export interface RoleRow {
  key: string;
  name: string;
  isSystem: boolean;
  permissions: Permission[];
}

/** 帳號列表。先撈人再撈指派，於記憶體收攏——內部系統 10–50 人，兩次查詢就夠。 */
export async function listUsers(db: Database): Promise<AdminUserRow[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.email));

  const granted = await db
    .select({
      userId: userRoles.userId,
      roleKey: roles.key,
      roleName: roles.name,
    })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .orderBy(asc(roles.key));

  const byUser = new Map<string, AssignmentRow[]>();
  for (const item of granted) {
    const list = byUser.get(item.userId) ?? [];
    list.push({ roleKey: item.roleKey, roleName: item.roleName });
    byUser.set(item.userId, list);
  }

  return rows.map((row) => ({
    ...row,
    status: row.status as UserStatus,
    assignments: byUser.get(row.id) ?? [],
  }));
}

/** 角色與各自的權限。給前端顯示「這個角色實際上能做什麼」。 */
export async function listRoles(db: Database): Promise<RoleRow[]> {
  const rows = await db
    .select({ id: roles.id, key: roles.key, name: roles.name, isSystem: roles.isSystem })
    .from(roles)
    .orderBy(asc(roles.key));

  const granted = await db
    .select({ roleId: rolePermissions.roleId, permission: rolePermissions.permission })
    .from(rolePermissions);

  const byRole = new Map<string, Permission[]>();
  for (const item of granted) {
    const list = byRole.get(item.roleId) ?? [];
    list.push(item.permission as Permission);
    byRole.set(item.roleId, list);
  }

  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    isSystem: row.isSystem,
    permissions: byRole.get(row.id) ?? [],
  }));
}

export type InviteResult = { kind: "created"; id: string } | { kind: "duplicate" };

/**
 * 邀請一個新帳號。status 停在 invited，等對方用 Google 登入過才會變成 active
 * （recordLogin 負責），所以這裡不會、也不該建立可直接使用的帳號。
 */
export async function inviteUser(
  db: Database,
  input: { email: string; invitedBy: string },
): Promise<InviteResult> {
  const email = input.email.trim().toLowerCase();

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) return { kind: "duplicate" };

  const id = `user-${crypto.randomUUID()}`;
  await db.insert(users).values({ id, email, invitedBy: input.invitedBy });
  return { kind: "created", id };
}

export async function findUser(db: Database, id: string) {
  const [row] = await db
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row ? { ...row, status: row.status as UserStatus } : null;
}

export async function setUserStatus(db: Database, id: string, status: UserStatus): Promise<void> {
  await db
    .update(users)
    .set({ status, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(users.id, id));
}

/** 這個人是否持有某個角色（不分資料範圍）。用來判斷是不是還剩最後一位管理者。 */
export async function hasRole(db: Database, userId: string, roleKey: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, userId), eq(roles.key, roleKey)))
    .limit(1);
  return Boolean(row);
}

export interface RoleGrant {
  userId: string;
  roleKey: string;
}

/** 指派角色。已經有同一組 (人, 角色) 就當作成功，不重複插入。 */
export async function assignRole(
  db: Database,
  grant: RoleGrant & { grantedBy: string },
): Promise<"ok" | "unknown-role"> {
  const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, grant.roleKey)).limit(1);
  if (!role) return "unknown-role";

  // scope_type / scope_id 留白＝全域。欄位還在，但目前沒有東西照範圍切資料。
  await db
    .insert(userRoles)
    .values({ userId: grant.userId, roleId: role.id, grantedBy: grant.grantedBy })
    .onConflictDoNothing();
  return "ok";
}

/** 收回一筆角色指派。回傳是否真的刪到東西，讓呼叫端能回 404。 */
export async function revokeRole(db: Database, grant: RoleGrant): Promise<boolean> {
  const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, grant.roleKey)).limit(1);
  if (!role) return false;

  const result = await db
    .delete(userRoles)
    .where(and(eq(userRoles.userId, grant.userId), eq(userRoles.roleId, role.id)));
  return (result.meta?.changes ?? 0) > 0;
}
