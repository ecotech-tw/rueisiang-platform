import { PERMISSIONS, SYSTEM_ROLES } from "@rueisiang/auth";
import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { permissions, rolePermissionGrants, roles } from "./schema/auth.js";

/**
 * 把程式碼裡定義的初始角色同步進資料庫。
 *
 * 每次執行都安全（冪等）：全新的資料庫會以 SYSTEM_ROLES 建立初始角色；之後只校正
 * 管理員角色，非管理員角色會標成自訂、既有設定則保留。缺少的非管理員角色視為已被
 * 管理者刪除，不會在重新同步時復活。
 *
 * 由 POST /api/admin/roles/sync 呼叫，需要 admin:role:write。全新的環境要怎麼
 * 生出第一位管理者見 .claude/skills/platform-deploy/SKILL.md——那是一次性的、資料庫層的動作，
 * 不該在程式裡留一條平常沒人走的路。
 */
export async function syncSystemRoles(db: Database): Promise<void> {
  const [anyRole] = await db.select({ id: roles.id }).from(roles).limit(1);
  const isFirstInitialization = !anyRole;

  await db.insert(permissions).values(
    Object.keys(PERMISSIONS).map((permission) => ({ permission })),
  ).onConflictDoUpdate({
    target: permissions.permission,
    set: { syncedAt: new Date().toISOString() },
  });

  for (const [key, definition] of Object.entries(SYSTEM_ROLES)) {
    const [existing] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.roleKey, key))
      .limit(1);
    const roleId = existing?.id ?? `role-${key}`;

    // 以 key 做原子 upsert，避免兩個同步請求同時補同一個缺少的角色時撞 unique constraint。
    const isProtected = key === "admin";
    if (!isProtected && !existing && !isFirstInitialization) continue;
    await db.insert(roles).values({ id: roleId, roleKey: key, name: definition.name, isSystem: isProtected }).onConflictDoUpdate({
      target: roles.roleKey,
      set: isProtected ? { name: definition.name, isSystem: true } : { isSystem: false },
    });

    // admin 是唯一受保護的角色，必須永遠保有完整的系統管理權限；
    // 其他角色只在第一次建立時灌入模板，之後由管理者的設定為準。
    if (!isProtected && existing) continue;
    await db.delete(rolePermissionGrants).where(eq(rolePermissionGrants.roleId, roleId));
    if (definition.permissions.length) {
      await db.insert(rolePermissionGrants).values(
        definition.permissions.map((permission) => ({ roleId, permission })),
      ).onConflictDoNothing();
    }
  }
}
