import { ALL_PERMISSIONS } from "@rueisiang/auth";
import { createDatabase } from "@rueisiang/db";
import {
  assistantChannelTools,
  assistantChatTools,
  assistantLineChannels,
  assistantLineGroups,
  assistantToolConfigs,
  rolePermissions,
  roles,
  userPermissions,
  users,
} from "@rueisiang/db/schema";
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
const SHOPEE_MIGRATION = fileURLToPath(
  new URL("../../../packages/db/migrations/0039_medical_stone_men.sql", import.meta.url),
);
const CYBERBIZ_REPORT_MIGRATION = fileURLToPath(
  new URL("../../../packages/db/migrations/0041_sturdy_colossus.sql", import.meta.url),
);
const CYBERBIZ_SALES_PERMISSION_MIGRATION = fileURLToPath(
  new URL("../../../packages/db/migrations/0046_cyberbiz_sales_permission.sql", import.meta.url),
);
const REMOVE_SHOPEE_SETTINGS_PERMISSION_MIGRATION = fileURLToPath(
  new URL("../../../packages/db/migrations/0047_remove_shopee_settings_permission.sql", import.meta.url),
);
const RENAME_REPORT_TOOL_KEYS_MIGRATION = fileURLToPath(
  new URL("../../../packages/db/migrations/0048_rename_report_tool_keys.sql", import.meta.url),
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
    const shopeeMigrationSql = readFileSync(SHOPEE_MIGRATION, "utf8");
    const shopeePermissionSql = shopeeMigrationSql.slice(
      shopeeMigrationSql.indexOf("INSERT OR IGNORE INTO role_permissions"),
    );
    d1.sqlite.exec(shopeePermissionSql);
    d1.sqlite.exec(shopeePermissionSql);
    const cyberbizReportMigrationSql = readFileSync(CYBERBIZ_REPORT_MIGRATION, "utf8");
    const cyberbizReportPermissionSql = cyberbizReportMigrationSql.slice(
      cyberbizReportMigrationSql.indexOf("INSERT OR IGNORE INTO role_permissions"),
    );
    d1.sqlite.exec(cyberbizReportPermissionSql);
    d1.sqlite.exec(cyberbizReportPermissionSql);
    const cyberbizSalesPermissionSql = readFileSync(CYBERBIZ_SALES_PERMISSION_MIGRATION, "utf8");
    d1.sqlite.exec(cyberbizSalesPermissionSql);
    d1.sqlite.exec(cyberbizSalesPermissionSql);
    const removeShopeeSettingsPermissionSql = readFileSync(REMOVE_SHOPEE_SETTINGS_PERMISSION_MIGRATION, "utf8");
    d1.sqlite.exec(removeShopeeSettingsPermissionSql);
    d1.sqlite.exec(removeShopeeSettingsPermissionSql);

    const permissions = await db.select().from(rolePermissions);
    expect(permissions).toHaveLength(ALL_PERMISSIONS.length);
    expect(new Set(permissions.map((row) => row.permission))).toEqual(new Set(ALL_PERMISSIONS));
  });

  it("移除蝦皮設定權限時保留既有角色與直接授權", async () => {
    const d1 = createLocalD1();
    const db = createDatabase(d1 as never);

    await db.insert(roles).values({ id: "role-legacy", key: "legacy", name: "舊設定角色", isSystem: false });
    await db.insert(rolePermissions).values({ roleId: "role-legacy", permission: "tools:shopee-sales:config" });
    await db.insert(users).values({ id: "user-legacy", email: "legacy@ecotech.tw", status: "active" });
    await db.insert(userPermissions).values({
      userId: "user-legacy",
      permission: "tools:shopee-sales:config",
      grantedBy: "bootstrap",
    });

    const sql = readFileSync(REMOVE_SHOPEE_SETTINGS_PERMISSION_MIGRATION, "utf8");
    d1.sqlite.exec(sql);
    d1.sqlite.exec(sql);

    const roleRows = await db.select().from(rolePermissions);
    expect(roleRows).toContainEqual({ roleId: "role-legacy", permission: "tools:payout:config" });
    expect(roleRows).not.toContainEqual({ roleId: "role-legacy", permission: "tools:shopee-sales:config" });

    const userRows = await db.select().from(userPermissions);
    expect(userRows).toContainEqual({ userId: "user-legacy", permission: "tools:payout:config", grantedBy: "bootstrap", createdAt: expect.any(String) });
    expect(userRows).not.toContainEqual(expect.objectContaining({ permission: "tools:shopee-sales:config" }));
  });

  it("報表工具改名時保留既有設定、LINE 白名單與對話工具綁定", async () => {
    const d1 = createLocalD1();
    const db = createDatabase(d1 as never);

    await db.insert(assistantToolConfigs).values([
      { key: "cyberbiz_query_sales_report", status: "disabled", updatedBy: "legacy" },
      { key: "cyberbiz_query_payout_report", status: "enabled", updatedBy: "legacy" },
    ]);
    await db.insert(assistantLineChannels).values({
      channelKey: "legacy-channel",
      assistantKey: "rueisiang-xiaoxiang",
      channelId: "channel-id",
      enabled: true,
      updatedBy: "legacy",
    });
    await db.insert(assistantLineGroups).values({
      id: "legacy-group",
      channelKey: "legacy-channel",
      lineGroupId: "line-group",
      enabled: true,
    });
    await db.insert(assistantChannelTools).values([
      { id: "legacy-sales-tool", channelKey: "legacy-channel", toolKey: "cyberbiz_query_sales_report", createdBy: "legacy" },
      { id: "legacy-payout-tool", channelKey: "legacy-channel", toolKey: "cyberbiz_query_payout_report", createdBy: "legacy" },
    ]);
    await db.insert(assistantChatTools).values([
      { id: "legacy-sales-chat-tool", groupId: "legacy-group", channelToolId: "legacy-sales-tool", createdBy: "legacy" },
      { id: "legacy-payout-chat-tool", groupId: "legacy-group", channelToolId: "legacy-payout-tool", createdBy: "legacy" },
    ]);

    const sql = readFileSync(RENAME_REPORT_TOOL_KEYS_MIGRATION, "utf8");
    d1.sqlite.exec(sql);
    d1.sqlite.exec(sql);

    expect(await db.select().from(assistantToolConfigs)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "query_sales_report", status: "disabled", updatedBy: "legacy" }),
      expect.objectContaining({ key: "query_payout_report", status: "enabled", updatedBy: "legacy" }),
    ]));
    expect((await db.select().from(assistantToolConfigs)).map((row) => row.key)).not.toEqual(expect.arrayContaining([
      "cyberbiz_query_sales_report",
      "cyberbiz_query_payout_report",
    ]));
    expect(await db.select().from(assistantChannelTools)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "legacy-sales-tool", toolKey: "query_sales_report" }),
      expect.objectContaining({ id: "legacy-payout-tool", toolKey: "query_payout_report" }),
    ]));
    expect(await db.select().from(assistantChatTools)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "legacy-sales-chat-tool", channelToolId: "legacy-sales-tool" }),
      expect.objectContaining({ id: "legacy-payout-chat-tool", channelToolId: "legacy-payout-tool" }),
    ]));
  });
});
