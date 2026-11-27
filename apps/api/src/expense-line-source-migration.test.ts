import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migrationFiles = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const REBUILD = migrationFiles.find((name) => name.startsWith("0265_"))!;
const BEFORE = migrationFiles[migrationFiles.indexOf(REBUILD) - 1]!;
const TABLES = ["accounting_expenses", "accounting_expense_receipts", "accounting_petty_cash_entries"] as const;

/** 照 D1 的方式套用：每一支 migration 都在自己的 transaction 內完成，外鍵開著（transaction 裡 PRAGMA foreign_keys 無效）。 */
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

const normalize = (ddl: string) => ddl.replace(/[`"]/g, "").replace(/\s+/g, " ").trim();
const ddlOf = (sqlite: DatabaseSync, name: string) => (sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql: string }).sql;
const names = (sqlite: DatabaseSync, type: "index" | "trigger", table: string) => (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(type, table) as Array<{ name: string }>).map((row) => row.name);
const count = (sqlite: DatabaseSync, table: string) => (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

function seed(sqlite: DatabaseSync) {
  sqlite.prepare("INSERT INTO users (id, email, status) VALUES ('u1', 'a@example.test', 'active'), ('u2', 'b@example.test', 'active')").run();
  sqlite.prepare("INSERT INTO hr_employments (id, employee_user_id, employee_number, legal_name) VALUES ('emp1', 'u1', 'E001', '王小明')").run();
  const expense = sqlite.prepare("INSERT INTO accounting_expenses (id, payer_kind, status, submitter_user_id, employment_id, client_request_id, category_id, spent_on, amount_minor, description, payout_method, paid_at) VALUES (?, ?, ?, ?, ?, ?, 'expense-category-supplies', '2026-11-01', ?, ?, ?, ?)");
  expense.run("x1", "employee_advance", "paid", "u1", "emp1", "req-x1-000000", 35000, "清潔用品", "direct", "2026-11-02 01:00:00");
  expense.run("x2", "company", "paid", "u2", null, "req-x2-000000", 120000, "冷氣保養", null, "2026-11-03 01:00:00");
  expense.run("x3", "employee_advance", "pending", "u1", "emp1", "req-x3-000000", 9900, "文具", null, null);
  const receipt = sqlite.prepare("INSERT INTO accounting_expense_receipts (id, expense_id, object_key, content_type, byte_size, sort_order) VALUES (?, ?, ?, 'image/jpeg', 10, ?)");
  receipt.run("r1", "x1", "k1", 0);
  receipt.run("r2", "x1", "k2", 1);
  const petty = sqlite.prepare("INSERT INTO accounting_petty_cash_entries (id, kind, amount_minor, expense_id, corrects_entry_id, note, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'u2', '2026-11-02 01:00:00')");
  petty.run("p1", "top_up", 100000, null, null, "");
  petty.run("p2", "payout", -35000, "x1", null, "");
  petty.run("p3", "refund", 35000, "x1", null, "");
  petty.run("p4", "payout", -35000, "x1", null, "");
  petty.run("p5", "correction", -10000, null, "p1", "多打了");
}

describe("0265：報帳主表與兩張子表一起重建，讓沒綁定 LINE 的人也能送件", () => {
  it("D1 方式套用：資料、順序、外鍵、索引、trigger 都在，DDL 跟 Drizzle 的一致", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);
    seed(sqlite);
    const before = Object.fromEntries(TABLES.map((table) => [table, {
      count: count(sqlite, table),
      ddl: normalize(ddlOf(sqlite, table)),
      indexes: names(sqlite, "index", table),
      triggers: names(sqlite, "trigger", table),
    }]));
    const pettyOrder = sqlite.prepare("SELECT id FROM accounting_petty_cash_entries ORDER BY rowid").all();

    applyLikeD1(sqlite, BEFORE, REBUILD);

    for (const table of TABLES) {
      expect(count(sqlite, table), table).toBe(before[table]!.count);
      expect(names(sqlite, "index", table), table).toEqual(table === "accounting_expenses"
        ? [...before[table]!.indexes, "idx_accounting_expenses_line_request"].sort()
        : before[table]!.indexes);
      expect(names(sqlite, "trigger", table), table).toEqual(before[table]!.triggers);
    }
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE '__new_%'").all()).toEqual([]);
    // 子表的結構一個字都沒變（外鍵改名後指回 accounting_expenses）。
    expect(normalize(ddlOf(sqlite, "accounting_expense_receipts"))).toBe(before.accounting_expense_receipts!.ddl);
    expect(normalize(ddlOf(sqlite, "accounting_petty_cash_entries"))).toBe(before.accounting_petty_cash_entries!.ddl);
    // 父表就是 Drizzle 產的那份建表語句（改名後 __new_ 前綴拿掉）。
    const drizzleCreate = readFileSync(path.join(migrationsDir, REBUILD), "utf8").match(/CREATE TABLE `__new_accounting_expenses` \([\s\S]*?\n\);/)![0];
    expect(normalize(ddlOf(sqlite, "accounting_expenses"))).toBe(normalize(drizzleCreate.replace(/__new_accounting_expenses/g, "accounting_expenses").replace(/;$/, "")));
    expect(sqlite.prepare("SELECT id FROM accounting_petty_cash_entries ORDER BY rowid").all()).toEqual(pettyOrder);
    expect(sqlite.prepare("SELECT id, source, line_display_name FROM accounting_expenses ORDER BY id").all()).toEqual([
      { id: "x1", source: "platform", line_display_name: "" },
      { id: "x2", source: "platform", line_display_name: "" },
      { id: "x3", source: "platform", line_display_name: "" },
    ]);

    // 零用金的守門 trigger 行為不變。
    expect(() => sqlite.prepare("UPDATE accounting_petty_cash_entries SET note = '改'").run()).toThrow(/append_only/);
    expect(() => sqlite.prepare("DELETE FROM accounting_petty_cash_entries").run()).toThrow(/append_only/);
    expect(() => sqlite.prepare("INSERT INTO accounting_petty_cash_entries (id, kind, amount_minor, expense_id, actor_user_id) VALUES ('p9', 'payout', -999999, 'x2', 'u2')").run()).toThrow(/balance_negative/);
    // 子表的 RESTRICT 外鍵仍然擋得住刪父表的列。
    expect(() => sqlite.prepare("DELETE FROM accounting_expenses WHERE id = 'x1'").run()).toThrow(/FOREIGN KEY/);
  });

  it("新規則：沒綁定的 LINE 送件可以沒有帳號與任職資料，但要有 LINE 名稱、只能直接撥款；平台送件仍要帳號", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, REBUILD);
    const insert = sqlite.prepare("INSERT INTO accounting_expenses (id, payer_kind, submitter_user_id, source, line_user_id, line_display_name, client_request_id, category_id, spent_on, amount_minor, description, payout_method) VALUES (?, 'employee_advance', NULL, ?, ?, ?, ?, 'expense-category-other', '2026-11-27', 5000, '買膠帶', ?)");
    insert.run("g1", "line", "U1", "小美", "line-event-0001", null);
    expect(() => insert.run("g2", "line", "U1", "小美", "line-event-0001", null)).toThrow(/UNIQUE/);
    expect(() => insert.run("g3", "line", "U1", " ", "line-event-0003", null)).toThrow(/CHECK/);
    expect(() => insert.run("g4", "line", null, "小美", "line-event-0004", null)).toThrow(/CHECK/);
    expect(() => insert.run("g5", "platform", "U1", "小美", "line-event-0005", null)).toThrow(/CHECK/);
    expect(() => insert.run("g6", "line", "U1", "小美", "line-event-0006", "payroll")).toThrow(/CHECK/);
    sqlite.prepare("UPDATE accounting_expenses SET status = 'approved', payout_method = 'direct' WHERE id = 'g1'").run();
    expect(sqlite.prepare("SELECT status, payout_method FROM accounting_expenses WHERE id = 'g1'").get()).toEqual({ status: "approved", payout_method: "direct" });
  });
});
