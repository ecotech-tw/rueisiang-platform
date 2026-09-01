import { SYSTEM_ROLES } from "@rueisiang/auth";
import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { rolePermissions, roles } from "./schema/auth.js";

/**
 * 把程式碼裡定義的初始角色同步進資料庫。
 *
 * 每次執行都安全（冪等）：缺少的角色會以 SYSTEM_ROLES 建立，管理員角色會校正回
 * 完整權限；非管理員角色會標成自訂，既有設定則保留，讓管理者可以從 UI 自由維護。
 *
 * 由 POST /api/admin/roles/sync 呼叫，需要 admin:role:write。全新的環境要怎麼
 * 生出第一位管理者見 .claude/skills/platform-deploy/SKILL.md——那是一次性的、資料庫層的動作，
 * 不該在程式裡留一條平常沒人走的路。
 */
export async function syncSystemRoles(db: Database): Promise<void> {
  for (const [key, definition] of Object.entries(SYSTEM_ROLES)) {
    const [existing] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, key))
      .limit(1);
    const roleId = existing?.id ?? `role-${key}`;

    // 以 key 做原子 upsert，避免兩個同步請求同時補同一個缺少的角色時撞 unique constraint。
    const isProtected = key === "admin";
    await db.insert(roles).values({ id: roleId, key, name: definition.name, isSystem: isProtected }).onConflictDoUpdate({
      target: roles.key,
      set: isProtected ? { name: definition.name, isSystem: true } : { isSystem: false },
    });

    // admin 是唯一受保護的角色，必須永遠保有完整的系統管理權限；
    // 其他角色只在第一次建立時灌入模板，之後由管理者的設定為準。
    if (!isProtected && existing) continue;
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    if (definition.permissions.length) {
      await db.insert(rolePermissions).values(
        definition.permissions.map((permission) => ({ roleId, permission })),
      ).onConflictDoNothing();
    }
  }
}
