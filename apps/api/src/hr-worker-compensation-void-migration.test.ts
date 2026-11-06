import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
function apply(sqlite: DatabaseSync, file: string) {
  sqlite.exec("BEGIN");
  try { sqlite.exec(readFileSync(path.join(directory, file), "utf8")); sqlite.exec("COMMIT"); }
  catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}

describe("支援人員敘薪撤回 migration", () => {
  it("新增撤回欄位並保留既有敘薪版本", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      const migration = "0245_familiar_iron_monger.sql";
      for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < migration).sort()) apply(sqlite, file);
      sqlite.exec(`
        INSERT INTO users (id, email, status) VALUES ('admin', 'admin@example.test', 'active');
        INSERT INTO hr_employments (id, person_kind, employee_number, legal_name, position)
          VALUES ('worker', 'worker', 'W-1', '測試支援', '支援人員');
        INSERT INTO hr_worker_compensation_versions (id, worker_id, version_number, valid_from, pay_basis, base_amount_minor, created_by)
          VALUES ('version-1', 'worker', 1, '2026-01-01', 'daily', 10000, 'admin');
      `);
      apply(sqlite, migration);
      expect(sqlite.prepare("SELECT id, base_amount_minor, voided_at, voided_by FROM hr_worker_compensation_versions WHERE id='version-1'").get())
        .toEqual({ id: "version-1", base_amount_minor: 10000, voided_at: null, voided_by: null });
      sqlite.exec("UPDATE hr_worker_compensation_versions SET voided_at='2026-01-02', voided_by='admin' WHERE id='version-1'");
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { sqlite.close(); }
  });
});
