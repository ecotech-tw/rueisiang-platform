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
