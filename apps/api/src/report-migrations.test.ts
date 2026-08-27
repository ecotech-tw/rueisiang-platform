import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

describe("報表 scope migration", () => {
  it("0050 會用與 normalizeReportScopeName 一致的規則移除全形空白", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0049_unify_report_manifests.sql");
    sqlite.prepare(
      "INSERT INTO report_scopes (id, scope_kind, name, normalized_name, active) VALUES (?, ?, ?, ?, ?)",
    ).run("cyberbiz:store:full-width", "store", "誠品西門店　ABC", "舊的正規化值", 1);

    applyLikeD1(sqlite, "0049_unify_report_manifests.sql", "0050_recompute_report_scope_names.sql");

    expect(sqlite.prepare("SELECT normalized_name FROM report_scopes WHERE id = ?").get("cyberbiz:store:full-width"))
      .toEqual({ normalized_name: "誠品西門店abc" });
  });

  it("0051 建月表、0052 彙總日資料、0053 才刪除舊表，且歷史資料保留", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, "0049_unify_report_manifests.sql");
    sqlite.prepare(`
      INSERT INTO report_sales_daily (
        scope_id, business_date, sku, product_name, category,
        gross_quantity, return_quantity, net_quantity, sales_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("cyberbiz:store:test", "2026-07-01", "SKU-1", "商品一", "沐浴", 3, 1, 2, 180);
    sqlite.prepare(`
      INSERT INTO report_sales_daily (
        scope_id, business_date, sku, product_name, category,
        gross_quantity, return_quantity, net_quantity, sales_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("cyberbiz:store:test", "2026-07-31", "SKU-1", "商品一", "沐浴", 2, 0, 2, 200);

    applyLikeD1(sqlite, "0049_unify_report_manifests.sql", "0051_add_report_sales_monthly.sql");
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_sales_monthly'").get())
      .toEqual({ name: "report_sales_monthly" });
    applyLikeD1(sqlite, "0051_add_report_sales_monthly.sql", "0052_move_report_sales_daily_to_monthly.sql");
    expect(sqlite.prepare("SELECT scope_id, report_month, sku, gross_quantity, net_quantity, sales_amount FROM report_sales_monthly").get())
      .toEqual({ scope_id: "cyberbiz:store:test", report_month: "2026-07", sku: "SKU-1", gross_quantity: 5, net_quantity: 4, sales_amount: 380 });

    applyLikeD1(sqlite, "0052_move_report_sales_daily_to_monthly.sql", "0053_drop_report_sales_daily.sql");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM report_sales_monthly").get()).toEqual({ count: 1 });
    expect(() => sqlite.prepare("SELECT COUNT(*) FROM report_sales_daily").get()).toThrow();
  });
});
