import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migration = readdirSync(directory).find((file) => file.startsWith("0123_") && file.endsWith(".sql"));
if (!migration) throw new Error("找不到 HR migration");
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
      sqlite.exec("INSERT INTO hr_employees(user_id,employee_number) VALUES ('u','E1');");
      expect(() => sqlite.exec("INSERT INTO hr_employees(user_id,employee_number) VALUES ('u','E2')")).toThrow(/UNIQUE/);
      expect(() => sqlite.exec("INSERT INTO hr_employees(user_id,employee_number) VALUES ('missing','E2')")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("INSERT INTO hr_employees(user_id,employee_number) VALUES ('u',' ')")).toThrow(/UNIQUE|CHECK/);
      sqlite.exec("INSERT INTO hr_employments(id,employee_user_id,hired_on,seniority_start_on) VALUES ('j','u','2026-01-01','2026-01-01'); INSERT INTO hr_employee_scopes(id,employment_id,scope_id,valid_from) VALUES ('a','j','s','2026-01-01');");
      expect(() => sqlite.exec("DELETE FROM users WHERE id='u'")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("DELETE FROM hr_employees WHERE user_id='u'")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("DELETE FROM hr_employments WHERE id='j'")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("DELETE FROM scopes WHERE id='s'")).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.exec("UPDATE hr_employments SET ended_on='2025-01-01' WHERE id='j'")).toThrow(/CHECK/);
      expect(() => sqlite.exec("UPDATE hr_employee_scopes SET revision=0 WHERE id='a'")).toThrow(/CHECK/);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { sqlite.close(); }
  });
});
