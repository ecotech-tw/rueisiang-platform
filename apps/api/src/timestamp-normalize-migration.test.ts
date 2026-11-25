import { sameDbTimestamp } from "@rueisiang/db";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migrationFiles = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const BEFORE = "0257_icy_mauler.sql";
const NORMALIZE = "0258_normalize_timestamps.sql";

/** 照 D1 的方式套用：每一支 migration 都在自己的 transaction 內完成。 */
function applyLikeD1(sqlite: DatabaseSync, from: string | null, to: string): void {
  for (const file of migrationFiles) {
    if (from && file <= from) continue;
    if (file > to) break;
    sqlite.exec("BEGIN;");
    for (const statement of readFileSync(path.join(migrationsDir, file), "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
    sqlite.exec("COMMIT;");
  }
}

function seedActivity(sqlite: DatabaseSync, id: string, createdAt: string) {
  sqlite.prepare(`
    INSERT INTO activity_events (id, entity_type, entity_id, entity_label, event_type, summary, source, actor_type, created_at)
    VALUES (?, 'customer', 'c1', '王小明', 'customer_updated', '測試', 'crm', 'system', ?)
  `).run(id, createdAt);
}

function activityTime(sqlite: DatabaseSync, id: string): string {
  return (sqlite.prepare("SELECT created_at AS value FROM activity_events WHERE id = ?").get(id) as { value: string }).value;
}

describe("0258 把時間欄位的 ISO 轉成資料庫格式", () => {
  it("ISO 轉成 YYYY-MM-DD HH:MM:SS.SSS，同一個時間點、毫秒不變", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);
    seedActivity(sqlite, "with-ms", "2026-11-25T03:00:00.123Z");
    seedActivity(sqlite, "without-ms", "2026-11-25T03:00:00Z");
    seedActivity(sqlite, "offset", "2026-11-25T11:00:00.500+08:00");
    sqlite.prepare("INSERT INTO users (id, email, status, last_login_at) VALUES ('u1', 'a@example.test', 'active', '2026-11-25T03:00:00.123Z')").run();

    applyLikeD1(sqlite, BEFORE, NORMALIZE);

    expect(activityTime(sqlite, "with-ms")).toBe("2026-11-25 03:00:00.123");
    expect(activityTime(sqlite, "without-ms")).toBe("2026-11-25 03:00:00.000");
    expect(activityTime(sqlite, "offset")).toBe("2026-11-25 03:00:00.500");
    const lastLogin = (sqlite.prepare("SELECT last_login_at AS value FROM users WHERE id = 'u1'").get() as { value: string }).value;
    expect(lastLogin).toBe("2026-11-25 03:00:00.123");
    // 小香 DO 存的是轉換前的字串；兩者必須是同一個時間點，訊息才不會被當成舊 session 略過。
    expect(sameDbTimestamp("2026-11-25T03:00:00.123Z", activityTime(sqlite, "with-ms"))).toBe(true);
  });

  it("已經是資料庫格式的、空值、認不得的值都不動", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);
    seedActivity(sqlite, "db-format", "2026-11-25 03:00:00");
    seedActivity(sqlite, "db-format-ms", "2026-11-25 03:00:00.123");
    seedActivity(sqlite, "garbage", "2026-11-25Tnot-a-time");
    sqlite.prepare("INSERT INTO users (id, email, status) VALUES ('u1', 'a@example.test', 'active')").run();

    applyLikeD1(sqlite, BEFORE, NORMALIZE);

    expect(activityTime(sqlite, "db-format")).toBe("2026-11-25 03:00:00");
    expect(activityTime(sqlite, "db-format-ms")).toBe("2026-11-25 03:00:00.123");
    expect(activityTime(sqlite, "garbage")).toBe("2026-11-25Tnot-a-time");
    expect((sqlite.prepare("SELECT last_login_at AS value FROM users WHERE id = 'u1'").get() as { value: string | null }).value).toBeNull();
  });

  /*
   * D1 關不掉 trigger。已結帳薪資這類守門 trigger 一遇到 UPDATE 就整支 migration 失敗，
   * 所以有 UPDATE trigger 的表一張都不能出現在這支 migration 裡。
   */
  it("不碰任何有 UPDATE trigger 的表；trigger 一個都沒少，重複的索引已經拿掉", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    applyLikeD1(sqlite, null, BEFORE);
    const triggers = sqlite.prepare("SELECT tbl_name AS table_name, sql FROM sqlite_master WHERE type = 'trigger'").all() as { table_name: string; sql: string }[];
    const guarded = new Set(triggers.filter((trigger) => /\b(BEFORE|AFTER)\s+UPDATE\b/i.test(trigger.sql)).map((trigger) => trigger.table_name));
    const touched = [...readFileSync(path.join(migrationsDir, NORMALIZE), "utf8").matchAll(/^UPDATE `([^`]+)`/gm)].map((match) => match[1]!);
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((table) => guarded.has(table))).toEqual([]);

    applyLikeD1(sqlite, BEFORE, NORMALIZE);
    expect((sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").get() as { n: number }).n).toBe(triggers.length);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_hr_annual_leave_bracket_policy'").get()).toBeUndefined();
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_hr_annual_leave_bracket_start'").get()).toBeDefined();
  });
});
