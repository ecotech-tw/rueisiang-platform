import { PERMISSIONS, type Permission, type UserStatus } from "@rueisiang/auth";
import { and, asc, desc, eq, sql } from "drizzle-orm";
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
  description: string;
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
    .select({
      id: roles.id,
      key: roles.key,
      name: roles.name,
      description: roles.description,
      isSystem: roles.isSystem,
    })
    .from(roles)
    // 系統角色排前面，自訂的接在後面——人找「管理者」的頻率遠高於找自己建的那幾個。
    .orderBy(desc(roles.isSystem), asc(roles.key));

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
    description: row.description,
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

/**
 * ── 角色維護 ──────────────────────────────────────────────────────────────
 *
 * 系統角色（isSystem）的權限是程式碼說了算，見 packages/auth 的 SYSTEM_ROLES：
 * 每次按「重新同步」都會整組重寫。所以這裡的編輯與刪除**只開放自訂角色**——
 * 讓人在 UI 改系統角色只會得到一個下次同步就消失的設定，那比不給改更糟。
 *
 * 要「像主管但不能碰出金表」這種角色，作法是複製一份成自訂角色再調整。
 */

/** 自訂角色的 key 由系統產生。人只需要取名字，不必再發明一組英數代號。 */
function newRoleKey(): string {
  return `custom-${crypto.randomUUID().slice(0, 8)}`;
}

export type RoleWriteResult =
  | { kind: "ok"; key: string }
  | { kind: "not-found" }
  | { kind: "system-role" }
  | { kind: "unknown-permission"; permission: string };

/** 未知的權限鍵值一律擋下來。默默存進去只會讓「設定看起來有給」但實際上不生效。 */
function findUnknownPermission(permissions: readonly string[]): string | null {
  return permissions.find((permission) => !(permission in PERMISSIONS)) ?? null;
}

export async function createRole(
  db: Database,
  input: { name: string; description?: string; permissions: readonly string[] },
): Promise<RoleWriteResult> {
  const unknown = findUnknownPermission(input.permissions);
  if (unknown) return { kind: "unknown-permission", permission: unknown };

  const key = newRoleKey();
  const id = `role-${crypto.randomUUID()}`;
  await db.insert(roles).values({
    id,
    key,
    name: input.name.trim(),
    description: (input.description ?? "").trim(),
    isSystem: false,
  });
  await writePermissions(db, id, input.permissions);
  return { kind: "ok", key };
}

export async function updateRole(
  db: Database,
  key: string,
  input: { name?: string; description?: string; permissions?: readonly string[] },
): Promise<RoleWriteResult> {
  if (input.permissions) {
    const unknown = findUnknownPermission(input.permissions);
    if (unknown) return { kind: "unknown-permission", permission: unknown };
  }

  const [role] = await db
    .select({ id: roles.id, isSystem: roles.isSystem })
    .from(roles)
    .where(eq(roles.key, key))
    .limit(1);
  if (!role) return { kind: "not-found" };
  if (role.isSystem) return { kind: "system-role" };

  const patch: Record<string, string> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description.trim();
  if (Object.keys(patch).length) {
    await db.update(roles).set(patch).where(eq(roles.id, role.id));
  }
  if (input.permissions) await writePermissions(db, role.id, input.permissions);

  return { kind: "ok", key };
}

/** 整組重寫而不是逐一比對。權限清單很短，差異計算省下的那點 I/O 不值得那份複雜度。 */
async function writePermissions(
  db: Database,
  roleId: string,
  permissions: readonly string[],
): Promise<void> {
  await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  if (permissions.length) {
    await db.insert(rolePermissions).values(
      [...new Set(permissions)].map((permission) => ({ roleId, permission })),
    );
  }
}

/**
 * 刪除自訂角色。指派給使用者的那幾列由 FK 的 onDelete cascade 一起帶走，
 * 所以呼叫端要先問清楚「這個角色還有幾個人在用」再送出。
 */
export async function deleteRole(db: Database, key: string): Promise<RoleWriteResult> {
  const [role] = await db
    .select({ id: roles.id, isSystem: roles.isSystem })
    .from(roles)
    .where(eq(roles.key, key))
    .limit(1);
  if (!role) return { kind: "not-found" };
  if (role.isSystem) return { kind: "system-role" };

  await db.delete(roles).where(eq(roles.id, role.id));
  return { kind: "ok", key };
}

/** 每個角色目前有幾個人持有。刪除前的確認訊息要講得出數字才有意義。 */
export async function countRoleHolders(db: Database): Promise<Record<string, number>> {
  const rows = await db
    .select({ roleKey: roles.key, holders: sql<number>`count(*)` })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .groupBy(roles.key);
  return Object.fromEntries(rows.map((row) => [row.roleKey, Number(row.holders)]));
}
