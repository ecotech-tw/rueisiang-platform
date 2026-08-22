import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * LINE 相關 migration 的行為，一律用 D1 的方式驗證。
 *
 * 主題一：0023 在 D1 上把 LINE 群組全部連坐刪光，0028 負責救回來。
 *
 * 為什麼本機測不出來：本機的 migration runner 一句一句跑，`PRAGMA foreign_keys=OFF`
 * 有生效；但正式環境走 `wrangler d1 migrations apply`，**整支 migration 包在 transaction
 * 裡**，而 PRAGMA foreign_keys 在 transaction 裡是 no-op（SQLite 的規格）。外鍵稽核
 * 一直開著，DROP TABLE 父表就連坐刪掉了子表。
 *
 * 所以這支測試刻意用 D1 的方式跑——每一支 migration 包一個 transaction。之後任何動到
 * 有外鍵指向的表時，這裡會先炸。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../../packages/db/migrations");
const migrationFiles = fs.readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort();

/** 照 D1 的方式套用：一支 migration 一個 transaction。 */
function applyLikeD1(sqlite: DatabaseSync, from: string | null, to: string): void {
  for (const file of migrationFiles) {
    if (from && file <= from) continue;
    if (file > to) break;
    sqlite.exec("BEGIN;");
    for (const statement of fs.readFileSync(path.join(migrationsDir, file), "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
    sqlite.exec("COMMIT;");
  }
}

function seedPreMigrationState(sqlite: DatabaseSync): void {
  sqlite.exec(`
    INSERT INTO assistant_line_channels
      (assistant_key, channel_id, channel_secret_encrypted, access_token_encrypted, display_name, enabled, updated_by)
    VALUES ('rueisiang-xiaoxiang', 'ch-1', 's', 't', 'Rueisiang 小香', 1, 'eli');
  `);
  for (const [i, lineGroupId] of ["Caaa", "Cbbb", "Cccc"].entries()) {
    sqlite.exec(`
      INSERT INTO assistant_line_groups (id, assistant_key, line_group_id, display_name, enabled)
      VALUES ('g${i}', 'rueisiang-xiaoxiang', '${lineGroupId}', '群組${i}', 1);
    `);
    // 每個群組都標註過小香——這就是之後唯一還救得回來的線索。
    sqlite.exec(`
      INSERT INTO assistant_line_messages
        (id, assistant_key, line_group_id, source_type, webhook_event_id, text, created_at)
      VALUES ('m${i}', 'rueisiang-xiaoxiang', '${lineGroupId}', 'group', 'e${i}', '@小香 你好', '2026-08-20T0${i}:00:00.000Z');
    `);
  }
}

/** 從 0025 之前的狀態開始，讓測試可以自己決定要塞什麼再往下跑。 */
function freshAt(tag: string): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  applyLikeD1(sqlite, null, tag);
  return sqlite;
}

describe("0025 只把支援 LINE 的工具寫進 channel 白名單", () => {
  it("sandbox-only 的工具不會被補進去", () => {
    const sqlite = freshAt("0024_amazing_ghost_rider.sql");
    sqlite.exec(`
      INSERT INTO assistant_line_channels
        (channel_key, assistant_key, channel_id, display_name, enabled, updated_by)
      VALUES ('rueisiang-xiaoxiang', 'rueisiang-xiaoxiang', 'ch', '小香', 1, 'eli');
    `);
    // crm_get_customer 的 surfaces 是 ["sandbox", "mcp"]，啟用了也不該進 LINE 白名單；
    // wms_get_activity 是「開發中」，那是只能在 Sandbox 驗證的狀態，補進來等於偷偷放行。
    for (const [key, status] of [
      ["weather_open_meteo", "enabled"],
      ["wms_search_warehouse", "enabled"],
      ["crm_get_customer", "enabled"],
      ["wms_get_activity", "development"],
    ]) {
      sqlite.exec(`INSERT INTO assistant_tool_configs (key, status, updated_by) VALUES ('${key}', '${status}', 'eli');`);
    }

    applyLikeD1(sqlite, "0024_amazing_ghost_rider.sql", "0025_seed_channel_tools.sql");

    const granted = (sqlite.prepare("SELECT tool_key FROM assistant_channel_tools ORDER BY tool_key").all() as { tool_key: string }[])
      .map((row) => row.tool_key);
    expect(granted).toEqual(["weather_open_meteo", "wms_search_warehouse"]);
  });
});

describe("換成 channel_key 之後的結構約束", () => {
  it("同一個 channel 底下不能有重複的群組", () => {
    const sqlite = freshAt("0028_restore_line_groups.sql");
    sqlite.exec(`
      INSERT INTO assistant_line_channels
        (channel_key, assistant_key, channel_id, display_name, enabled, updated_by)
      VALUES ('ck', 'ak', 'ch', '小香', 1, 'eli');
    `);
    sqlite.exec(`
      INSERT INTO assistant_line_groups (id, channel_key, line_group_id, display_name, enabled)
      VALUES ('g1', 'ck', 'C1', '倉庫群', 1);
    `);
    // webhook 每次收到標註都會 upsert 一次，靠這個唯一索引擋掉重複發現。
    expect(() => sqlite.exec(`
      INSERT INTO assistant_line_groups (id, channel_key, line_group_id, display_name, enabled)
      VALUES ('g2', 'ck', 'C1', '重複的群', 1);
    `)).toThrow();
  });
});

describe("0031 回填「名稱是人工設定的」", () => {
  /*
   * 0030 新增的 display_name_manual 預設是 false。不回填的話，同步機制上線前管理員
   * 自己打過名字的群組，會在下一次同步時被 LINE 的原名蓋掉。
   */
  it("同步機制上線前就有名字的群組會被標記為人工命名", () => {
    const sqlite = freshAt("0029_steep_meltdown.sql");
    sqlite.exec(`
      INSERT INTO assistant_line_channels
        (channel_key, assistant_key, channel_id, display_name, enabled, updated_by)
      VALUES ('ck', 'ak', 'ch', '小香', 1, 'eli');
    `);
    sqlite.exec(`
      INSERT INTO assistant_line_groups (id, channel_key, line_group_id, display_name, enabled)
      VALUES
        ('g1', 'ck', 'C1', '倉庫群', 1),
        ('g2', 'ck', 'C2', '', 0);
    `);
    // 已經同步過的不算人工命名——那個名字是 LINE 給的。
    sqlite.exec(`
      INSERT INTO assistant_line_groups
        (id, channel_key, line_group_id, display_name, enabled, profile_synced_at)
      VALUES ('g3', 'ck', 'C3', 'LINE 給的名字', 1, '2026-08-22T00:00:00.000Z');
    `);

    applyLikeD1(sqlite, "0029_steep_meltdown.sql", "0031_backfill_manual_group_names.sql");

    const rows = sqlite.prepare(
      "SELECT id, display_name_manual FROM assistant_line_groups ORDER BY id",
    ).all();
    expect(rows).toEqual([
      { id: "g1", display_name_manual: 1 },
      { id: "g2", display_name_manual: 0 },
      { id: "g3", display_name_manual: 0 },
    ]);
  });
});

describe("0032 預設開放全部小香工具", () => {
  it("會啟用系統預設工具、保留人工停用狀態，並補齊既有 channel 白名單", () => {
    const sqlite = freshAt("0031_backfill_manual_group_names.sql");
    sqlite.exec(`
      INSERT INTO assistant_line_channels
        (channel_key, assistant_key, channel_id, display_name, enabled, updated_by)
      VALUES ('ck', 'ak', 'ch', '小香', 1, 'eli');

      INSERT INTO assistant_tool_configs (key, status, updated_by)
      VALUES
        ('weather_open_meteo', 'development', 'system'),
        ('wms_get_activity', 'development', 'eli'),
        ('crm_get_orders', 'development', 'migration:0025');

      INSERT INTO assistant_channel_tools (id, channel_key, tool_key, created_by)
      VALUES ('existing-weather', 'ck', 'weather_open_meteo', 'migration:0025');
    `);

    applyLikeD1(sqlite, "0031_backfill_manual_group_names.sql", "0032_enable_all_assistant_tools.sql");

    expect((sqlite.prepare("SELECT status FROM assistant_tool_configs WHERE key = ?").get("weather_open_meteo") as { status: string }).status)
      .toBe("enabled");
    expect((sqlite.prepare("SELECT status FROM assistant_tool_configs WHERE key = ?").get("crm_get_orders") as { status: string }).status)
      .toBe("enabled");
    expect((sqlite.prepare("SELECT status FROM assistant_tool_configs WHERE key = ?").get("wms_get_activity") as { status: string }).status)
      .toBe("development");
    expect((sqlite.prepare("SELECT status FROM assistant_tool_configs WHERE key = ?").get("crm_get_customer") as { status: string }).status)
      .toBe("enabled");

    const granted = (sqlite.prepare("SELECT tool_key FROM assistant_channel_tools WHERE channel_key = ? ORDER BY tool_key").all("ck") as { tool_key: string }[])
      .map((row) => row.tool_key);
    expect(granted).toEqual([
      "crm_get_customer",
      "crm_get_orders",
      "crm_search_customers",
      "weather_open_meteo",
      "wms_get_activity",
      "wms_get_inventory_item",
      "wms_list_inventory",
      "wms_list_low_stock_items",
      "wms_search_warehouse",
    ]);
  });
});

describe("被 0023 誤刪的 LINE 群組", () => {
  function migrated(to: string): DatabaseSync {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0020_add_crm_order_permission.sql");
    seedPreMigrationState(sqlite);
    applyLikeD1(sqlite, "0020_add_crm_order_permission.sql", to);
    return sqlite;
  }

  it("在 D1 的執行方式下，0024 跑完群組真的會全部消失", () => {
    const sqlite = migrated("0024_amazing_ghost_rider.sql");
    expect(sqlite.prepare("SELECT COUNT(*) c FROM assistant_line_groups").get()).toEqual({ c: 0 });
    // 訊息沒有外鍵，所以沒有被連坐——這是唯一還留著的線索。
    expect(sqlite.prepare("SELECT COUNT(*) c FROM assistant_line_messages").get()).toEqual({ c: 3 });
  });

  it("0028 從訊息紀錄把三個群組都救回來", () => {
    const sqlite = migrated("0028_restore_line_groups.sql");
    const rows = sqlite.prepare(
      "SELECT line_group_id, display_name, enabled, tool_mode FROM assistant_line_groups ORDER BY line_group_id",
    ).all();
    expect(rows).toEqual([
      { line_group_id: "Caaa", display_name: "", enabled: 0, tool_mode: "inherit" },
      { line_group_id: "Cbbb", display_name: "", enabled: 0, tool_mode: "inherit" },
      { line_group_id: "Cccc", display_name: "", enabled: 0, tool_mode: "inherit" },
    ]);
  });

  it("救回來的一律是未開通——名稱與開關救不回來，不該擅自替管理員決定", () => {
    const sqlite = migrated("0028_restore_line_groups.sql");
    const enabled = sqlite.prepare("SELECT COUNT(*) c FROM assistant_line_groups WHERE enabled = 1").get();
    expect(enabled).toEqual({ c: 0 });
  });

  it("重跑不會產生重複的群組", () => {
    const sqlite = migrated("0028_restore_line_groups.sql");
    const sql = fs.readFileSync(path.join(migrationsDir, "0028_restore_line_groups.sql"), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
    expect(sqlite.prepare("SELECT COUNT(*) c FROM assistant_line_groups").get()).toEqual({ c: 3 });
  });
});
