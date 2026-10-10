import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

describe("據點排班負責人 migration", () => {
  it("D1 transaction 內只新增關聯表，保留父表且外鍵限制有效", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE scopes(id TEXT PRIMARY KEY); INSERT INTO users VALUES('admin'), ('scheduler'); INSERT INTO scopes VALUES('store');");
      sqlite.exec("BEGIN");
      try {
        sqlite.exec(readFileSync(new URL("../../../packages/db/migrations/0228_worthless_riptide.sql", import.meta.url), "utf8"));
        sqlite.exec("COMMIT");
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      sqlite.exec("INSERT INTO hr_schedule_managers(scope_id, user_id, updated_by) VALUES('store', 'scheduler', 'admin');");
      expect(sqlite.prepare("SELECT user_id, revision FROM hr_schedule_managers").get()).toEqual({ user_id: "scheduler", revision: 1 });
      expect(() => sqlite.exec("DELETE FROM users WHERE id='scheduler'")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("DELETE FROM scopes WHERE id='store'")).toThrow(/FOREIGN KEY/);
      expect(sqlite.prepare("SELECT count(*) AS total FROM users").get()).toEqual({ total: 2 });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { sqlite.close(); }
  });
});
