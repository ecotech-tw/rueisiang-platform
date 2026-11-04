import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
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

describe("國定假日班別覆蓋 migration", () => {
  it("將舊週末與國定假日版本移至 legacy key，保留歷史排班外鍵", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`
        PRAGMA foreign_keys=ON;
        CREATE TABLE hr_shift_versions (id TEXT PRIMARY KEY, shift_template_id TEXT NOT NULL, day_type TEXT NOT NULL, version_number INTEGER NOT NULL, UNIQUE (shift_template_id, day_type, version_number));
        CREATE TABLE hr_schedule_entries (id TEXT PRIMARY KEY, shift_version_id TEXT NOT NULL REFERENCES hr_shift_versions(id) ON DELETE RESTRICT);
        INSERT INTO hr_shift_versions(id,shift_template_id,day_type,version_number) VALUES
          ('weekend','shift','weekend',1), ('holiday','shift','holiday',1);
        INSERT INTO hr_schedule_entries(id,shift_version_id) VALUES ('scheduled-weekend','weekend'), ('scheduled-holiday','holiday');
      `);
      apply(sqlite, "0243_hr_holiday_shift_override.sql");
      expect(sqlite.prepare("SELECT id,day_type FROM hr_shift_versions ORDER BY id").all()).toEqual([
        { id: "holiday", day_type: "legacy_holiday" },
        { id: "weekend", day_type: "legacy_weekend" },
      ]);
      expect(sqlite.prepare("SELECT id,shift_version_id FROM hr_schedule_entries ORDER BY id").all()).toEqual([
        { id: "scheduled-holiday", shift_version_id: "holiday" },
        { id: "scheduled-weekend", shift_version_id: "weekend" },
      ]);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
