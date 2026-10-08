import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));

/** D1 會把每支 migration 包在 transaction；外鍵開啟時不能靠 PRAGMA 關閉它。 */
function apply(sqlite: DatabaseSync, file: string) {
  sqlite.exec("BEGIN");
  try {
    sqlite.exec(readFileSync(path.join(directory, file), "utf8"));
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

describe("班別需求人力 migration", () => {
  it("0216～0218 在 D1 transaction 中保留班別關聯、回填日型需求人力並限制值域", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < "0215").sort()) {
        apply(sqlite, file);
      }

      sqlite.exec(`
        INSERT INTO users(id, email, status) VALUES ('u', 'u@example.test', 'active');
        INSERT INTO scopes(id, source_type, scope_kind, name, normalized_name)
          VALUES ('s', 'manual', 'store', '測試櫃點', '測試櫃點');
        INSERT INTO hr_shift_templates(id, code, name, created_by)
          VALUES ('t', 'T1', '測試班別', 'u');
        INSERT INTO hr_shift_versions(id, shift_template_id, version_number, start_second, end_second, created_by)
          VALUES ('v', 't', 1, 28800, 64800, 'u');
        INSERT INTO hr_scope_shift_assignments(scope_id, shift_template_id, created_by)
          VALUES ('s', 't', 'u');
      `);

      apply(sqlite, "0215_large_dracula.sql");
      apply(sqlite, "0216_worthless_wither.sql");
      sqlite.prepare("UPDATE hr_shift_templates SET required_headcount = 4 WHERE id = 't'").run();
      apply(sqlite, "0217_modern_onslaught.sql");
      apply(sqlite, "0218_backfill_shift_version_headcount.sql");

      expect(sqlite.prepare("SELECT required_headcount FROM hr_shift_templates WHERE id = 't'").get()).toEqual({ required_headcount: 4 });
      expect(sqlite.prepare("SELECT shift_template_id, required_headcount FROM hr_shift_versions WHERE id = 'v'").get()).toEqual({ shift_template_id: "t", required_headcount: 4 });
      expect(sqlite.prepare("SELECT shift_template_id FROM hr_scope_shift_assignments WHERE scope_id = 's'").get()).toEqual({ shift_template_id: "t" });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      expect(() => sqlite.prepare(`
        INSERT INTO hr_shift_templates(id, code, name, required_headcount, created_by)
        VALUES ('invalid', 'T2', '無效班別', 0, 'u')
      `).run()).toThrow("hr_shift_templates_headcount_invalid");
      expect(() => sqlite.prepare("UPDATE hr_shift_templates SET required_headcount = 101 WHERE id = 't'").run()).toThrow("hr_shift_templates_headcount_invalid");
      expect(() => sqlite.prepare(`
        INSERT INTO hr_shift_versions(id, shift_template_id, required_headcount, version_number, start_second, end_second, created_by)
        VALUES ('invalid-version', 't', 0, 1, 28800, 64800, 'u')
      `).run()).toThrow("hr_shift_versions_headcount_invalid");
      expect(() => sqlite.prepare("UPDATE hr_shift_versions SET required_headcount = 101 WHERE id = 'v'").run()).toThrow("hr_shift_versions_headcount_invalid");
    } finally {
      sqlite.close();
    }
  });
});
