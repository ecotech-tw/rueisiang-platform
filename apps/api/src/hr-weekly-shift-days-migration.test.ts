import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));

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

describe("每週班別時間 migration", () => {
  it("移除未被歷史排班引用的週末與國定假日版本", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < "0241").sort()) apply(sqlite, file);
      sqlite.exec(`
        INSERT INTO users(id,email,status) VALUES ('u','u@example.test','active');
        INSERT INTO hr_shift_templates(id,code,name,created_by) VALUES ('t','T','早班','u');
        INSERT INTO hr_shift_versions(id,shift_template_id,day_type,version_number,start_second,end_second,created_by) VALUES
          ('weekday','t','weekday',1,32400,64800,'u'),
          ('weekend','t','weekend',1,36000,72000,'u'),
          ('holiday','t','holiday',1,39600,72000,'u');
      `);
      apply(sqlite, "0241_weekly_shift_days.sql");
      expect(sqlite.prepare("SELECT id,day_type FROM hr_shift_versions ORDER BY id").all()).toEqual([{ id: "weekday", day_type: "weekday" }]);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
