import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

describe("據點排班鎖定 migration", () => {
  it("以 D1 transaction 建立據點與月份鎖定，且不允許刪除仍被引用的帳號或據點", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE scopes(id TEXT PRIMARY KEY); INSERT INTO users VALUES('admin'); INSERT INTO scopes VALUES('store-a');");
      sqlite.exec("BEGIN");
      try {
        sqlite.exec(readFileSync(new URL("../../../packages/db/migrations/0236_nifty_liz_osborn.sql", import.meta.url), "utf8"));
        sqlite.exec("COMMIT");
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      sqlite.exec("INSERT INTO hr_schedule_scope_locks(period_start, scope_id, locked_at, locked_by, updated_by) VALUES('2026-02-01', 'store-a', CURRENT_TIMESTAMP, 'admin', 'admin');");
      expect(sqlite.prepare("SELECT revision FROM hr_schedule_scope_locks").get()).toEqual({ revision: 1 });
      expect(() => sqlite.exec("DELETE FROM users WHERE id='admin'")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("DELETE FROM scopes WHERE id='store-a'")).toThrow(/FOREIGN KEY/);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { sqlite.close(); }
  });
});
