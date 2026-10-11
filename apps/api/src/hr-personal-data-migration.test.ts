import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migration = "0230_mixed_blob.sql";
function apply(db: DatabaseSync, file: string) {
  db.exec("BEGIN");
  try { db.exec(readFileSync(path.join(directory, file), "utf8")); db.exec("COMMIT"); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

describe("員工個資新增式 migration", () => {
  it("逐支交易升級保留既有任職與打卡，個資外鍵禁止刪除父表", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < migration).sort()) apply(db, file);
      db.exec("INSERT INTO users(id,email,status) VALUES ('u','u@example.test','active'); INSERT INTO hr_employments(id,employee_user_id,employee_number,legal_name) VALUES ('e','u','E1','原姓名'); INSERT INTO hr_clock_events(id,employee_user_id,employment_id,idempotency_key,event_kind) VALUES ('c','u','e','c','clock_in');");
      apply(db, migration);
      expect(db.prepare("SELECT legal_name FROM hr_employments WHERE id='e'").get()).toEqual({ legal_name: "原姓名" });
      expect(db.prepare("SELECT employment_id FROM hr_clock_events WHERE id='c'").get()).toEqual({ employment_id: "e" });
      db.exec("INSERT INTO hr_employee_personal_data(employment_id,mobile_phone) VALUES ('e','0912345678')");
      expect(db.prepare("SELECT english_name,birth_date,mobile_phone FROM hr_employee_personal_data").get()).toEqual({ english_name: "", birth_date: "", mobile_phone: "0912345678" });
      expect(() => db.exec("INSERT INTO hr_employee_personal_data(employment_id) VALUES ('missing')")).toThrow(/FOREIGN KEY/);
      expect(() => db.exec("DELETE FROM hr_employments WHERE id='e'")).toThrow(/FOREIGN KEY/);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });
});
