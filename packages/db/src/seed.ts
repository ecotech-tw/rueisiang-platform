import { SYSTEM_ROLES } from "@rueisiang/auth";
import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { rolePermissions, roles } from "./schema/auth.js";

/**
 * 把程式碼裡定義的系統角色同步進資料庫。
 *
 * 每次執行都安全（冪等）：角色照 key 對應，權限整組重寫，
 * 所以在 permissions.ts 增減權限之後跑一次就會生效，不必手動改資料。
 *
 * 由 POST /api/admin/roles/sync 呼叫，需要 admin:role:write。全新的環境要怎麼
 * 生出第一位管理者見 docs/deployment-setup.md——那是一次性的、資料庫層的動作，
 * 不該在程式裡留一條平常沒人走的路。
 */
export async function syncSystemRoles(db: Database): Promise<void> {
  for (const [key, definition] of Object.entries(SYSTEM_ROLES)) {
    const roleId = `role-${key}`;
    await db
      .insert(roles)
      .values({ id: roleId, key, name: definition.name, isSystem: true })
      .onConflictDoUpdate({
        target: roles.key,
        set: { name: definition.name, isSystem: true },
      });

    // 整組重寫而不是逐一比對：權限清單是程式碼說了算，資料庫只是投影。
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    if (definition.permissions.length) {
      await db.insert(rolePermissions).values(
        definition.permissions.map((permission) => ({ roleId, permission })),
      );
    }
  }
}
