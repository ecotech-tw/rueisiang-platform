import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it("D1 transaction 新增班別名單欄位，舊值保持不限制且不重建父表", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON; CREATE TABLE hr_shift_templates(id TEXT PRIMARY KEY); CREATE TABLE child(id TEXT PRIMARY KEY, template_id TEXT REFERENCES hr_shift_templates(id) ON DELETE CASCADE); INSERT INTO hr_shift_templates VALUES('shift'); INSERT INTO child VALUES('entry', 'shift');");
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(readFileSync(new URL("../../../packages/db/migrations/0233_dizzy_beyonder.sql", import.meta.url), "utf8"));
      sqlite.exec("COMMIT");
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    expect(sqlite.prepare("SELECT allowed_person_ids FROM hr_shift_templates").get()).toEqual({ allowed_person_ids: null });
    expect(sqlite.prepare("SELECT id FROM child").get()).toEqual({ id: "entry" });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { sqlite.close(); }
});
