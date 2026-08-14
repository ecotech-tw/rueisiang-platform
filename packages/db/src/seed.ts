import { SYSTEM_ROLES } from "@rueisiang/auth";
import { eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { rolePermissions, roles, userRoles, users } from "./schema/auth.js";

/**
 * 把程式碼裡定義的系統角色同步進資料庫。
 *
 * 每次部署後執行都安全（冪等）：角色照 key 對應，權限整組重寫，
 * 所以在 permissions.ts 增減權限之後跑一次就會生效，不必手動改資料。
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

/**
 * 建立第一位管理者。系統完全沒有可用管理者時才會動作，
 * 否則直接跳過——避免部署設定殘留把某個信箱一直塞回管理者。
 */
export async function ensureBootstrapAdmin(db: Database, email: string): Promise<"created" | "skipped"> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return "skipped";

  const [existingAdmin] = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(roles.key, "admin"))
    .limit(1);
  if (existingAdmin) return "skipped";

  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);

  const userId = existingUser?.id ?? `user-${crypto.randomUUID()}`;
  if (!existingUser) {
    await db.insert(users).values({ id: userId, email: normalized, invitedBy: "bootstrap" });
  }

  await db
    .insert(userRoles)
    .values({ userId, roleId: "role-admin", grantedBy: "bootstrap" })
    .onConflictDoNothing();

  await db.update(users).set({ updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(users.id, userId));
  return "created";
}
