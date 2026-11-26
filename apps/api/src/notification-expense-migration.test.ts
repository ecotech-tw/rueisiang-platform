import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migrationFiles = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const BEFORE = "0260_seed_expense_categories.sql";
const REBUILD = migrationFiles.find((name) => name.startsWith("0261_"))!;

/** 照 D1 的方式套用：每一支 migration 都在自己的 transaction 內完成（PRAGMA foreign_keys 在 transaction 裡無效）。 */
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

/*
 * 0261 為了讓通知多一種 entity_kind（報帳）重建 hr_notifications。重建是 DROP 舊表再改名，
 * 所以要確認：舊通知與已讀狀態都還在、索引與唯一鍵重建回來、新種類寫得進去、亂填的種類仍然擋。
 */
describe("0261 讓 hr_notifications 收得下報帳通知", () => {
  it("重建後舊通知、已讀狀態與索引都在，報帳通知寫得進去", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);
    sqlite.prepare("INSERT INTO users (id, email, status) VALUES ('u1', 'a@example.test', 'active')").run();
    const insert = sqlite.prepare("INSERT INTO hr_notifications (id, user_id, source_key, kind, entity_kind, entity_id, title, body, read_at, created_at) VALUES (?, 'u1', ?, 'request_reviewed', ?, 'e1', '標題', '內文', ?, '2026-11-20 01:00:00')");
    insert.run("n-leave", "k-leave", "leave", "2026-11-21 02:00:00");
    insert.run("n-overtime", "k-overtime", "overtime", null);
    expect(() => insert.run("n-expense-early", "k-expense-early", "expense", null)).toThrow(/CHECK/);

    applyLikeD1(sqlite, BEFORE, REBUILD);

    expect(sqlite.prepare("SELECT id, entity_kind, read_at, created_at FROM hr_notifications ORDER BY id").all()).toEqual([
      { id: "n-leave", entity_kind: "leave", read_at: "2026-11-21 02:00:00", created_at: "2026-11-20 01:00:00" },
      { id: "n-overtime", entity_kind: "overtime", read_at: null, created_at: "2026-11-20 01:00:00" },
    ]);
    insert.run("n-expense", "k-expense", "expense", null);
    expect(() => insert.run("n-bad", "k-bad", "invoice", null)).toThrow(/CHECK/);
    expect(() => insert.run("n-dup", "k-leave", "leave", null)).toThrow(/UNIQUE/);
    const indexes = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'hr_notifications'").all() as Array<{ name: string }>).map((row) => row.name).sort();
    expect(indexes).toEqual(expect.arrayContaining(["hr_notifications_source_key_unique", "idx_hr_notifications_user_created", "idx_hr_notifications_user_unread"]));
    expect(sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = '__new_hr_notifications'").get()).toEqual({ n: 0 });
  });
});
