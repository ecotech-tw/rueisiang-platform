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

describe("HR 薪資與出勤設定 migration", () => {
  it("不重建既有 HR 表，並為既有任職回填主要辦公位置", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < "0133").sort()) apply(sqlite, file);
      sqlite.exec("INSERT INTO users(id,email) VALUES ('u','u@example.test'); INSERT INTO hr_employees(user_id,employee_number) VALUES ('u','E1'); INSERT INTO hr_employments(id,employee_user_id,hired_on,seniority_start_on) VALUES ('j','u','2026-01-01','2026-01-01'); INSERT INTO hr_attendance_locations(id,name,geolocation_required) VALUES ('l','辦公室',0); INSERT INTO hr_employee_attendance_locations(id,employment_id,location_id,valid_from) VALUES ('a','j','l','2026-01-01');");
      apply(sqlite, "0133_sticky_dracula.sql");
      apply(sqlite, "0134_backfill_hr_attendance_settings.sql");
      expect(sqlite.prepare("SELECT attendance_mode, primary_assignment_id FROM hr_employment_attendance_settings WHERE employment_id='j'").get()).toEqual({ attendance_mode: "general", primary_assignment_id: "a" });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { sqlite.close(); }
  });
});
