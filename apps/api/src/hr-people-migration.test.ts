import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migration = "0123_jazzy_mysterio.sql";
function apply(sqlite: DatabaseSync, file: string) {
  sqlite.exec("BEGIN");
  try { sqlite.exec(readFileSync(path.join(directory, file), "utf8")); sqlite.exec("COMMIT"); }
  catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}

describe("HR 新增式 migration", () => {
  it("逐支交易由空庫升級，既有 users／scopes 保留，外鍵與唯一性生效", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < migration).sort()) apply(sqlite, file);
      sqlite.exec("INSERT INTO users(id,email) VALUES ('u','u@example.test'); INSERT INTO scopes(id,source_type,scope_kind,name,normalized_name) VALUES ('s','manual','store','測試櫃','測試櫃');");
      apply(sqlite, migration);
      expect(sqlite.prepare("SELECT email FROM users WHERE id='u'").get()).toEqual({ email: "u@example.test" });
      expect(sqlite.prepare("SELECT name FROM scopes WHERE id='s'").get()).toEqual({ name: "測試櫃" });
      sqlite.exec("INSERT INTO hr_employers(id,name) VALUES ('b','雇主'); INSERT INTO hr_employees(id,employee_number,display_name,user_id) VALUES ('e','E1','姓名','u');");
      expect(() => sqlite.exec("INSERT INTO hr_employees(id,employee_number,display_name,user_id) VALUES ('e2','E2','姓名','u')")).toThrow(/UNIQUE/);
      expect(() => sqlite.exec("INSERT INTO hr_employees(id,employee_number,display_name) VALUES ('e2','E1','姓名')")).toThrow(/UNIQUE/);
      expect(() => sqlite.exec("INSERT INTO hr_employees(id,employee_number,display_name) VALUES ('e2','E2',' ')")).toThrow(/CHECK/);
      sqlite.exec("INSERT INTO hr_employments(id,employee_id,employer_id,hired_on,seniority_start_on) VALUES ('j','e','b','2026-01-01','2026-01-01'); INSERT INTO hr_employee_scopes(id,employment_id,scope_id,valid_from) VALUES ('a','j','s','2026-01-01');");
      for (const [table, id] of [["users", "u"], ["scopes", "s"], ["hr_employees", "e"], ["hr_employers", "b"], ["hr_employments", "j"]]) {
        expect(() => sqlite.prepare(`DELETE FROM ${table} WHERE id=?`).run(id!)).toThrow(/FOREIGN KEY/);
      }
      expect(() => sqlite.exec("UPDATE hr_employments SET ended_on='2025-01-01' WHERE id='j'")).toThrow(/CHECK/);
      expect(() => sqlite.exec("UPDATE hr_employee_scopes SET revision=0 WHERE id='a'")).toThrow(/CHECK/);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { sqlite.close(); }
  });
});
