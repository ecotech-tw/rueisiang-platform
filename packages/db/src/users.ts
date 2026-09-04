import type { AuthUser, Permission, RoleAssignment, UserStatus } from "@rueisiang/auth";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { rolePermissionGrants, roles, userPermissionGrants, userRoleAssignments, users } from "./schema/auth.js";

/**
 * 載入使用者與他所有的角色指派。
 *
 * 授權判定每次請求都會呼叫這裡——刻意不快取，這樣調整權限或停權才會即時生效。
 * 舊系統的 cookie 裡雖然有 role 欄位，實際上也是每次回 DB 重讀，這裡只是把
 * 那個從不採信的欄位一併拿掉。
 */
export async function loadAuthUser(
  db: Database,
  lookup: { id: string } | { email: string },
): Promise<AuthUser | null> {
  const [row] = await db
    .select()
    .from(users)
    .where("id" in lookup ? eq(users.id, lookup.id) : eq(users.email, lookup.email.toLowerCase()))
    .limit(1);

  if (!row) return null;

  const granted = await db
    .select({
      roleKey: roles.roleKey,
      permission: rolePermissionGrants.permission,
    })
    .from(userRoleAssignments)
    .innerJoin(roles, eq(roles.id, userRoleAssignments.roleId))
    .leftJoin(rolePermissionGrants, eq(rolePermissionGrants.roleId, roles.id))
    .where(eq(userRoleAssignments.userId, row.id));

  // 同一個角色會因為多個權限而出現多列，收攏成一筆 assignment。
  const byAssignment = new Map<string, RoleAssignment>();
  for (const item of granted) {
    let assignment = byAssignment.get(item.roleKey);
    if (!assignment) {
      assignment = { roleKey: item.roleKey, permissions: [] };
      byAssignment.set(item.roleKey, assignment);
    }
    // leftJoin：角色可能一個權限都沒有，那一列的 permission 會是 null。
    if (item.permission) {
      (assignment.permissions as Permission[]).push(item.permission as Permission);
    }
  }

  /*
   * 直接授予的權限。跟角色分開撈而不是拼成一次查詢——兩者的形狀不同
   * （一個要收攏成 assignment，一個是平的清單），硬併在一起只會讓這段更難讀，
   * 而這是每個請求都會跑的路徑，可讀性比省一次往返重要。
   */
  const direct = await db
    .select({ permission: userPermissionGrants.permission })
    .from(userPermissionGrants)
    .where(eq(userPermissionGrants.userId, row.id));

  return {
    id: row.id,
    email: row.email,
    // 自己設定的顯示名稱優先，沒設才退回 Google 帳號上的姓名。
    name: row.displayName || row.googleName,
    googleName: row.googleName,
    pictureUrl: row.pictureUrl,
    status: row.status as UserStatus,
    assignments: [...byAssignment.values()],
    directPermissions: direct.map((item) => item.permission as Permission),
  };
}

/** Google 登入成功後更新識別資訊；第一次登入會把 invited 轉成 active。 */
export async function recordLogin(
  db: Database,
  userId: string,
  identity: { googleSubject: string; name: string; pictureUrl: string },
): Promise<void> {
  await db
    .update(users)
    .set({
      googleSubject: identity.googleSubject,
      googleName: identity.name,
      pictureUrl: identity.pictureUrl,
      status: "active",
      lastLoginAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(users.id, userId));
}

/**
 * 更新使用者自己能改的欄位。
 *
 * 只碰 display_name——email 是身分本身（授權與紀錄都認它），name 與 picture_url
 * 由 Google 每次登入覆寫，兩者都不該讓人從個人資料頁改掉。
 */
export async function updateProfile(
  db: Database,
  userId: string,
  input: { displayName: string },
): Promise<void> {
  await db
    .update(users)
    .set({ displayName: input.displayName.trim(), updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(users.id, userId));
}

/**
 * 還剩幾位可用的管理者（不含指定要排除的那一位）。
 *
 * 沿用 CRM 既有的保護：不允許把最後一位管理者降級或停用，
 * 否則沒有人能再進權限管理頁，只能直接改資料庫。
 */
export async function countOtherActiveAdmins(db: Database, excludeUserId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(distinct ${users.id})` })
    .from(users)
    .innerJoin(userRoleAssignments, eq(userRoleAssignments.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoleAssignments.roleId))
    .where(and(eq(roles.roleKey, "admin"), eq(users.status, "active"), ne(users.id, excludeUserId)));

  return Number(row?.value ?? 0);
}
