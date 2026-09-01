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
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalD1, LocalD1 } from "./local-d1/d1.js";

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
const SKU_MAPPING_PERMISSION_MIGRATION = fileURLToPath(
  new URL("../../../packages/db/migrations/0065_sku_mapping_permission.sql", import.meta.url),
);
const ANALYTICS_PERMISSION_MIGRATION = fileURLToPath(
  new URL("../../../packages/db/migrations/0066_analytics_permission.sql", import.meta.url),
);
const CYBERBIZ_REPORT_WRITE_PERMISSION_MIGRATION = fileURLToPath(
  new URL("../../../packages/db/migrations/0067_cyberbiz_report_write_permission.sql", import.meta.url),
);
const ROLE_CLASSIFICATION_MIGRATION = fileURLToPath(
  new URL("../../../packages/db/migrations/0070_roles_except_admin_are_custom.sql", import.meta.url),
);
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();

/** 照 D1 的方式套用：每一支 migration 都在自己的 transaction 內完成。 */
function applyLikeD1(sqlite: DatabaseSync, from: string | null, to: string): void {
  for (const file of MIGRATION_FILES) {
    if (from && file <= from) continue;
    if (file > to) break;
    sqlite.exec("BEGIN;");
    for (const statement of readFileSync(path.join(MIGRATIONS_DIR, file), "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
    sqlite.exec("COMMIT;");
  }
}

function freshAt(tag: string): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applyLikeD1(sqlite, null, tag);
  return sqlite;
}

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
    const skuMappingPermissionSql = readFileSync(SKU_MAPPING_PERMISSION_MIGRATION, "utf8")
      .split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);
    for (const statement of [...skuMappingPermissionSql, ...skuMappingPermissionSql]) d1.sqlite.exec(statement);
    const analyticsPermissionSql = readFileSync(ANALYTICS_PERMISSION_MIGRATION, "utf8");
    d1.sqlite.exec(analyticsPermissionSql);
    d1.sqlite.exec(analyticsPermissionSql);
    const cyberbizReportWritePermissionSql = readFileSync(CYBERBIZ_REPORT_WRITE_PERMISSION_MIGRATION, "utf8");
    d1.sqlite.exec(cyberbizReportWritePermissionSql);
    d1.sqlite.exec(cyberbizReportWritePermissionSql);

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
    const sqlite = freshAt("0047_remove_shopee_settings_permission.sql");
    const d1 = new LocalD1(sqlite);
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

    sqlite.prepare(`
      INSERT INTO cyberbiz_report_runs
        (id, request_id, report_kind, period_kind, stores_json, start_date, end_date, manifest_eligible, actor_id, actor_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legacy-run", "legacy-request", "sales", "month", "[\"舊版門市\"]", "2026-07-01", "2026-07-31", 1, "legacy", "legacy@example.com");
    sqlite.prepare(`
      INSERT INTO cyberbiz_report_manifests
        (id, report_month, scope_type, scope_id, scope_name, coverage_start, coverage_end, source_checksum, parser_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legacy-manifest", "2026-07", "store", "store-legacy", "舊版門市", "2026-07-01", "2026-07-31", "checksum", "legacy");

    applyLikeD1(sqlite, "0047_remove_shopee_settings_permission.sql", "0048_rename_report_tool_keys.sql");
    applyLikeD1(sqlite, "0047_remove_shopee_settings_permission.sql", "0048_rename_report_tool_keys.sql");

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM assistant_line_groups").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM assistant_chat_tools").get()).toEqual({ count: 2 });

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

    applyLikeD1(sqlite, "0048_rename_report_tool_keys.sql", "0049_unify_report_manifests.sql");

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM assistant_chat_tools").get()).toEqual({ count: 2 });
    expect(sqlite.prepare("SELECT d1_import_eligible FROM cyberbiz_report_runs WHERE id = ?").get("legacy-run"))
      .toEqual({ d1_import_eligible: 1 });
    expect(sqlite.prepare("SELECT id, scope_kind, normalized_name FROM report_scopes WHERE id = ?").get("store-legacy"))
      .toEqual({ id: "store-legacy", scope_kind: "store", normalized_name: "舊版門市" });
  });
});

describe("角色分類 migration", () => {
  it("把非管理員既有系統角色改成自訂，而且可以安全重跑", () => {
    const sqlite = freshAt("0069_pink_giant_man.sql");
    sqlite.prepare("INSERT INTO roles (id, key, name, is_system) VALUES (?, ?, ?, ?)").run(
      "role-admin",
      "admin",
      "管理者",
      1,
    );
    sqlite.prepare("INSERT INTO roles (id, key, name, is_system) VALUES (?, ?, ?, ?)").run(
      "role-manager",
      "manager",
      "主管",
      1,
    );
    sqlite.prepare("INSERT INTO roles (id, key, name, is_system) VALUES (?, ?, ?, ?)").run(
      "role-custom",
      "custom-existing",
      "既有自訂角色",
      0,
    );

    const sql = readFileSync(ROLE_CLASSIFICATION_MIGRATION, "utf8");
    sqlite.exec(sql);
    sqlite.exec(sql);

    expect(sqlite.prepare("SELECT key, is_system FROM roles ORDER BY key").all()).toEqual([
      { key: "admin", is_system: 1 },
      { key: "custom-existing", is_system: 0 },
      { key: "manager", is_system: 0 },
    ]);
  });
});
