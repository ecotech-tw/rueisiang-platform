import { ALL_PERMISSIONS } from "@rueisiang/auth";
import { createDatabase } from "@rueisiang/db";
import { rolePermissions, roles } from "@rueisiang/db/schema";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLocalD1 } from "./local-d1/d1.js";

const REPAIR_MIGRATION = fileURLToPath(
  new URL("../../../packages/db/migrations/0019_restore_admin_permissions.sql", import.meta.url),
);
const ORDER_PERMISSION_MIGRATION = fileURLToPath(
  new URL("../../../packages/db/migrations/0020_add_crm_order_permission.sql", import.meta.url),
);

describe("bootstrap 管理員權限 migration", () => {
  it("把只有三個 admin 權限的既有管理員補齊，而且可以安全重跑", async () => {
    const d1 = createLocalD1();
    const db = createDatabase(d1 as never);

    await db.insert(roles).values({
      id: "role-admin",
      key: "admin",
      name: "管理者",
      isSystem: true,
    });
    await db.insert(rolePermissions).values([
      { roleId: "role-admin", permission: "admin:user:read" },
      { roleId: "role-admin", permission: "admin:user:write" },
      { roleId: "role-admin", permission: "admin:role:write" },
    ]);

    const sql = readFileSync(REPAIR_MIGRATION, "utf8");
    d1.sqlite.exec(sql);
    d1.sqlite.exec(sql);
    const orderPermissionSql = readFileSync(ORDER_PERMISSION_MIGRATION, "utf8");
    d1.sqlite.exec(orderPermissionSql);
    d1.sqlite.exec(orderPermissionSql);

    const permissions = await db.select().from(rolePermissions);
    expect(permissions).toHaveLength(ALL_PERMISSIONS.length);
    expect(new Set(permissions.map((row) => row.permission))).toEqual(new Set(ALL_PERMISSIONS));
  });
});
