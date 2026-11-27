import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migrationFiles = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const GUARDS = migrationFiles.find((name) => name.endsWith("_petty_cash_guards.sql"))!;

/** 照 D1 的方式套用：每一支 migration 都在自己的 transaction 內完成。 */
function applyLikeD1(sqlite: DatabaseSync, to: string): void {
  for (const file of migrationFiles) {
    if (file > to) break;
    sqlite.exec("BEGIN;");
    for (const statement of readFileSync(path.join(migrationsDir, file), "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
    sqlite.exec("COMMIT;");
  }
}

describe("零用金紀錄的守門 trigger", () => {
  it("D1 方式套完後：紀錄只能新增，餘額不能變負，正常的增加與減少照寫", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, GUARDS);
    const triggers = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'accounting_petty_cash_entries'").all() as Array<{ name: string }>).map((row) => row.name).sort();
    expect(triggers).toEqual(["trg_accounting_petty_cash_no_delete", "trg_accounting_petty_cash_no_update", "trg_accounting_petty_cash_not_negative"]);

    sqlite.prepare("INSERT INTO users (id, email, status) VALUES ('u1', 'a@example.test', 'active')").run();
    const insert = sqlite.prepare("INSERT INTO accounting_petty_cash_entries (id, kind, amount_minor, note, actor_user_id) VALUES (?, ?, ?, ?, 'u1')");
    insert.run("e1", "top_up", 10000, "");
    expect(() => insert.run("e4", "reduce", -1, "  ")).toThrow(/CHECK/);
    expect(() => insert.run("e5", "payout", -1, "")).toThrow(/CHECK/);
    insert.run("e2", "reduce", -10000, "全部減掉");
    expect(() => insert.run("e3", "reduce", -1, "再減一塊")).toThrow(/balance_negative/);
    expect(() => sqlite.prepare("UPDATE accounting_petty_cash_entries SET note = '改'").run()).toThrow(/append_only/);
    expect(() => sqlite.prepare("DELETE FROM accounting_petty_cash_entries WHERE id = 'e1'").run()).toThrow(/append_only/);
    expect(sqlite.prepare("SELECT count(*) AS n, sum(amount_minor) AS total FROM accounting_petty_cash_entries").get()).toEqual({ n: 2, total: 0 });
  });
});
