import { createDatabase, recordCyberbizReportRun, upsertReportScope } from "@rueisiang/db";
import { scopes } from "@rueisiang/db/schema";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTargetOnlyD1 } from "./local-d1/d1.js";

const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migrationFiles = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

/** 照 D1 的方式套用：每一支 migration 都在自己的 transaction 內完成。 */
function applyLikeD1(sqlite: DatabaseSync, from: string | null, to: string): void {
  for (const file of migrationFiles) {
    if (from && file <= from) continue;
    if (file > to) break;
    sqlite.exec("BEGIN;");
    for (const statement of readFileSync(path.join(migrationsDir, file), "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
    sqlite.exec("COMMIT;");
  }
}

const BEFORE = "0095_crm_target_cutover.sql";
const MERGE = "0096_merge_scopes.sql";
const BEFORE_DROP_PAYOUT_STORES = "0110_drop_legacy_rbac_tables.sql";
const DROP_PAYOUT_STORES = "0111_drop_payout_stores.sql";
const BEFORE_SHOPEE_MIGRATION = "0115_massive_tinkerer.sql";
const SHOPEE_MIGRATION = "0116_shopee_sales_to_report_runs.sql";

function insertScope(sqlite: DatabaseSync, row: {
  id: string; sourceType: string; name: string; normalized: string;
  drive?: string; driveName?: string; sortOrder?: number; active?: number;
}) {
  sqlite.prepare(`
    INSERT INTO scopes (id, source_type, scope_kind, name, normalized_name, drive_folder_url, drive_folder_name, sort_order, active)
    VALUES (?, ?, 'store', ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.sourceType, row.name, row.normalized, row.drive ?? "", row.driveName ?? "", row.sortOrder ?? 0, row.active ?? 1);
}

describe("scopes 合併", () => {
  it("同一家店的兩列併成一列，drive 設定從 payout 那列搬過來", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);

    insertScope(sqlite, { id: "cyberbiz:store:abc", sourceType: "report", name: "宏匯廣場1F", normalized: "宏匯廣場1f" });
    insertScope(sqlite, { id: "uuid-1", sourceType: "payout", name: "宏匯廣場1F", normalized: "宏匯廣場1f", drive: "https://drive/x", driveName: "宏匯", sortOrder: 1 });

    applyLikeD1(sqlite, BEFORE, MERGE);

    expect(sqlite.prepare("SELECT id, source_type, drive_folder_url, drive_folder_name, sort_order FROM scopes WHERE normalized_name = ?").all("宏匯廣場1f"))
      .toEqual([{ id: "cyberbiz:store:abc", source_type: "cyberbiz", drive_folder_url: "https://drive/x", drive_folder_name: "宏匯", sort_order: 1 }]);
  });

  it("兩個 active 併成一個：任一邊停用就是停用", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);

    insertScope(sqlite, { id: "cyberbiz:store:x", sourceType: "report", name: "裕隆城", normalized: "裕隆城", active: 1 });
    insertScope(sqlite, { id: "uuid-2", sourceType: "payout", name: "裕隆城", normalized: "裕隆城", active: 0 });

    applyLikeD1(sqlite, BEFORE, MERGE);

    expect(sqlite.prepare("SELECT id, active FROM scopes WHERE normalized_name = ?").all("裕隆城")).toEqual([{ id: "cyberbiz:store:x", active: 0 }]);
  });

  it("只有一邊有的留著；蝦皮改成 channel", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);

    insertScope(sqlite, { id: "uuid-3", sourceType: "payout", name: "只有出金", normalized: "只有出金" });
    insertScope(sqlite, { id: "shopee:store:default", sourceType: "report", name: "蝦皮", normalized: "蝦皮" });

    applyLikeD1(sqlite, BEFORE, MERGE);

    expect(sqlite.prepare("SELECT id, source_type, scope_kind FROM scopes WHERE id IN ('shopee:store:default', 'uuid-3') ORDER BY id").all()).toEqual([
      { id: "shopee:store:default", source_type: "shopee", scope_kind: "channel" },
      { id: "uuid-3", source_type: "cyberbiz", scope_kind: "store" },
    ]);
  });
});

describe("payout_stores 收斂到 scopes", () => {
  it("刪舊表前把 0096 後異動的店別設定同步回 scopes", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE_DROP_PAYOUT_STORES);

    insertScope(sqlite, { id: "cyberbiz:store:abc", sourceType: "cyberbiz", name: "宏匯廣場1F", normalized: "宏匯廣場1f" });
    sqlite.prepare(`
      INSERT INTO payout_stores (id, name, drive_folder_url, drive_folder_name, enabled, sort_order)
      VALUES ('uuid-1', '宏匯廣場1F', 'https://drive/new', '宏匯新資料夾', 0, 7)
    `).run();
    sqlite.prepare(`
      INSERT INTO payout_stores (id, name, drive_folder_url, drive_folder_name, enabled, sort_order)
      VALUES ('uuid-2', '只有出金設定', 'https://drive/only', '只有出金', 1, 8)
    `).run();
    insertScope(sqlite, { id: "manual:store:old", sourceType: "cyberbiz", name: "退租店", normalized: "退租店" });
    sqlite.prepare(`
      INSERT INTO payout_stores (id, name, drive_folder_url, drive_folder_name, enabled, sort_order)
      VALUES ('uuid-3', '退租店', 'https://drive/manual-name', '同名正式店', 1, 9)
    `).run();

    applyLikeD1(sqlite, BEFORE_DROP_PAYOUT_STORES, DROP_PAYOUT_STORES);

    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'payout_stores'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT id, drive_folder_url, drive_folder_name, sort_order, active FROM scopes WHERE normalized_name = '宏匯廣場1f'").all()).toEqual([
      { id: "cyberbiz:store:abc", drive_folder_url: "https://drive/new", drive_folder_name: "宏匯新資料夾", sort_order: 7, active: 0 },
    ]);
    expect(sqlite.prepare("SELECT id, source_type, scope_kind, name, active FROM scopes WHERE normalized_name = '只有出金設定'").all()).toEqual([
      { id: "cyberbiz:store:uuid-2", source_type: "cyberbiz", scope_kind: "store", name: "只有出金設定", active: 1 },
    ]);
    expect(sqlite.prepare("SELECT id, source_type, drive_folder_url FROM scopes WHERE normalized_name = '退租店' ORDER BY id").all()).toEqual([
      { id: "cyberbiz:store:uuid-3", source_type: "cyberbiz", drive_folder_url: "https://drive/manual-name" },
      { id: "manual:store:old", source_type: "manual", drive_folder_url: "" },
    ]);
  });
});

describe("蝦皮報表設定與執行紀錄收斂", () => {
  it("沿用既有 shopee scope 的 Drive 設定，並把舊 run 搬進 report_runs", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE_SHOPEE_MIGRATION);

    insertScope(sqlite, {
      id: "shopee:store:default",
      sourceType: "shopee",
      name: "蝦皮",
      normalized: "蝦皮",
      drive: "https://drive/scope",
      driveName: "蝦皮正確資料夾",
    });
    sqlite.prepare(`
      INSERT INTO shopee_sales_settings (id, drive_folder_url, drive_folder_name)
      VALUES ('default', 'https://drive/old-settings', '舊設定')
    `).run();
    sqlite.prepare(`
      INSERT INTO shopee_sales_runs (id, request_id, start_date, end_date, drive_folder_url, actor_id, actor_email, created_at)
      VALUES ('run-shopee-1', 'request-shopee-1', '2026-08-01', '2026-08-31', 'https://drive/old-settings', 'user-1', 'manager@ecotech.tw', '2026-09-01 10:00:00')
    `).run();

    applyLikeD1(sqlite, BEFORE_SHOPEE_MIGRATION, SHOPEE_MIGRATION);

    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('shopee_sales_settings', 'shopee_sales_runs')").all()).toEqual([]);
    expect(sqlite.prepare("SELECT source_type, scope_kind, drive_folder_url, drive_folder_name FROM scopes WHERE id = 'shopee:store:default'").get()).toEqual({
      source_type: "shopee",
      scope_kind: "store",
      drive_folder_url: "https://drive/scope",
      drive_folder_name: "蝦皮正確資料夾",
    });
    expect(sqlite.prepare("SELECT id, request_id, source_type, imports_sales, imports_payout, period_kind, actor_email FROM report_runs WHERE request_id = 'request-shopee-1'").get()).toEqual({
      id: "run-shopee-1",
      request_id: "request-shopee-1",
      source_type: "shopee",
      imports_sales: 1,
      imports_payout: 1,
      period_kind: "month",
      actor_email: "manager@ecotech.tw",
    });
    expect(sqlite.prepare("SELECT report_run_id, scope_id FROM report_run_scopes WHERE report_run_id = 'run-shopee-1'").get()).toEqual({
      report_run_id: "run-shopee-1",
      scope_id: "shopee:store:default",
    });
  });
});

describe("合併之後不會再長出第二列", () => {
  it("同一家店跑銷售與出金，source_type 都是 driver 而不是報表種類", async () => {
    const d1 = createTargetOnlyD1();
    const db = createDatabase(d1 as never);

    await upsertReportScope(db, { id: "cyberbiz:store:abc", scopeKind: "store", name: "宏匯廣場1F" });
    for (const reportKind of ["sales", "payout"] as const) {
      await recordCyberbizReportRun(db, {
        requestId: crypto.randomUUID(), reportKind, periodKind: "custom",
        startDate: "2026-07-01", endDate: "2026-07-31",
        stores: ["宏匯廣場1F"], scopeIds: ["cyberbiz:store:abc"],
        actor: { id: "u1", email: "admin@ecotech.tw" },
      });
    }

    expect(await db.select({ id: scopes.id, sourceType: scopes.sourceType }).from(scopes)
      .where(eq(scopes.normalizedName, "宏匯廣場1f")).orderBy(asc(scopes.id)))
      .toEqual([{ id: "cyberbiz:store:abc", sourceType: "cyberbiz" }]);
  });
});
