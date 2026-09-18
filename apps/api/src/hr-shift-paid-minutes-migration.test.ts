import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
/*
 * 正式環境走 wrangler d1 migrations apply，整支 migration 包在一個 transaction 裡。
 * 一句一句 exec 會給出假的信心：那樣跑得過的 SQL 在 D1 上可能整支 rollback。
 */
function apply(sqlite: DatabaseSync, file: string) {
  sqlite.exec("BEGIN");
  try { sqlite.exec(readFileSync(path.join(directory, file), "utf8")); sqlite.exec("COMMIT"); }
  catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}

describe("班別計薪工時改成等於班別長度", () => {
  it("0165／0166 把班別與已發布排班的計薪工時補成實際時段，休息歸零", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < "0165").sort()) apply(sqlite, file);

      /*
       * 08:00–18:00 是 10 小時＝600 分鐘，但舊的預設值寫死 Math.min(480, duration)，
       * 所以班別與當時排出去的每一天都存成 480，每天少算兩小時。這就是要被補回來的情況。
       */
      sqlite.exec(`
        INSERT INTO users(id,email,status) VALUES ('u','u@example.test','active');
        INSERT INTO scopes(id,source_type,scope_kind,name,normalized_name) VALUES ('s','manual','store','測試櫃點','測試櫃點');
        INSERT INTO hr_employees(user_id,employee_number) VALUES ('u','E1');
        INSERT INTO hr_employments(id,employee_user_id,hired_on,seniority_start_on) VALUES ('j','u','2026-01-01','2026-01-01');
        INSERT INTO hr_schedule_workers(id,display_name,created_by) VALUES ('w','臨時支援','u');
        INSERT INTO hr_shift_templates(id,code,name,created_by) VALUES ('t','T1','十小時班','u');
        INSERT INTO hr_shift_versions(id,shift_template_id,version_number,start_second,end_second,end_day_offset,standard_minutes,break_minutes,created_by)
          VALUES ('v','t',1,28800,64800,0,480,60,'u');
        INSERT INTO hr_scope_shift_assignments(scope_id,shift_template_id,created_by) VALUES ('s','t','u');
        INSERT INTO hr_schedule_versions(id,period_start,period_end,version_number) VALUES ('sv','2026-08-01','2026-09-01',1);
        INSERT INTO hr_schedule_entries(id,schedule_version_id,employment_id,scope_id,shift_version_id,work_date,starts_at,ends_at,standard_minutes,break_minutes,created_by)
          VALUES ('e','sv','j','s','v','2026-08-05','2026-08-05 08:00:00','2026-08-05 18:00:00',480,60,'u');
        INSERT INTO hr_schedule_worker_entries(id,schedule_version_id,worker_id,scope_id,shift_version_id,work_date,starts_at,ends_at,standard_minutes,break_minutes,created_by)
          VALUES ('we','sv','w','s','v','2026-08-05','2026-08-05 08:00:00','2026-08-05 18:00:00',480,60,'u');
      `);

      apply(sqlite, "0165_hr_shift_paid_minutes_equals_span.sql");
      apply(sqlite, "0166_hr_schedule_entry_paid_minutes_backfill.sql");

      expect(sqlite.prepare("SELECT standard_minutes, break_minutes FROM hr_shift_versions WHERE id='v'").get()).toEqual({ standard_minutes: 600, break_minutes: 0 });
      // 薪資的時數讀的是 entry，不是班別，所以這兩筆才是真正決定發多少錢的。
      expect(sqlite.prepare("SELECT standard_minutes, break_minutes FROM hr_schedule_entries WHERE id='e'").get()).toEqual({ standard_minutes: 600, break_minutes: 0 });
      expect(sqlite.prepare("SELECT standard_minutes, break_minutes FROM hr_schedule_worker_entries WHERE id='we'").get()).toEqual({ standard_minutes: 600, break_minutes: 0 });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { sqlite.close(); }
  });

  it("跨午夜的舊排班照自己的 starts_at／ends_at 算，不會被當成負數或爆掉上限", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < "0165").sort()) apply(sqlite, file);
      sqlite.exec(`
        INSERT INTO users(id,email,status) VALUES ('u','u@example.test','active');
        INSERT INTO scopes(id,source_type,scope_kind,name,normalized_name) VALUES ('s','manual','store','測試櫃點','測試櫃點');
        INSERT INTO hr_employees(user_id,employee_number) VALUES ('u','E1');
        INSERT INTO hr_employments(id,employee_user_id,hired_on,seniority_start_on) VALUES ('j','u','2026-01-01','2026-01-01');
        INSERT INTO hr_shift_templates(id,code,name,created_by) VALUES ('t','T1','夜班','u');
        INSERT INTO hr_shift_versions(id,shift_template_id,version_number,start_second,end_second,end_day_offset,standard_minutes,break_minutes,created_by)
          VALUES ('v','t',1,82800,25200,1,420,60,'u');
        INSERT INTO hr_schedule_versions(id,period_start,period_end,version_number) VALUES ('sv','2026-08-01','2026-09-01',1);
        INSERT INTO hr_schedule_entries(id,schedule_version_id,employment_id,scope_id,shift_version_id,work_date,starts_at,ends_at,standard_minutes,break_minutes,created_by)
          VALUES ('e','sv','j','s','v','2026-08-05','2026-08-05 23:00:00','2026-08-06 07:00:00',420,60,'u');
      `);

      apply(sqlite, "0165_hr_shift_paid_minutes_equals_span.sql");
      apply(sqlite, "0166_hr_schedule_entry_paid_minutes_backfill.sql");

      // 23:00 到隔天 07:00 是 8 小時；ends_at 本來就落在隔天，所以算式直接成立（420 → 480）。
      expect(sqlite.prepare("SELECT standard_minutes, break_minutes FROM hr_schedule_entries WHERE id='e'").get()).toEqual({ standard_minutes: 480, break_minutes: 0 });
      // 班別那一支刻意跳過跨午夜的版本：它的長度不能用 end_second - start_second 回推，會變成負數。
      expect(sqlite.prepare("SELECT standard_minutes, break_minutes FROM hr_shift_versions WHERE id='v'").get()).toEqual({ standard_minutes: 420, break_minutes: 60 });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { sqlite.close(); }
  });
});
