import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * LINE channel 的關聯鍵值從 `assistant_key` 換成 `channel_key`。
 *
 * 這條路只跑一次，但跑錯的代價是正式站上的 LINE 群組授權與提及訊息全部消失，而且
 * 不可逆——`assistant_line_channels` 被重建時，指過來的外鍵配上 ON DELETE CASCADE
 * 有機會把子表整個帶走。空資料庫測不出這件事（沒有列可以被連坐），所以這裡刻意
 * 「升級一個已經有資料的庫」。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../../packages/db/migrations");

const migrationFiles = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

/** 套用 `(afterTag, lastTag]` 這一段，讓測試可以在中間停下來塞資料。 */
function apply(sqlite: DatabaseSync, afterTag: string | null, lastTag: string): void {
  const start = afterTag ? migrationFiles.findIndex((name) => name.startsWith(afterTag)) + 1 : 0;
  const end = migrationFiles.findIndex((name) => name.startsWith(lastTag));
  if (start <= 0 && afterTag) throw new Error(`找不到 migration ${afterTag}`);
  if (end < 0) throw new Error(`找不到 migration ${lastTag}`);
  for (const file of migrationFiles.slice(start, end + 1)) {
    for (const statement of fs.readFileSync(path.join(migrationsDir, file), "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) sqlite.exec(trimmed);
    }
  }
}

/** 換鍵值之前的正式環境長這樣：一個 channel、一個已授權的群組、一則提及訊息。 */
function seedLegacyData(sqlite: DatabaseSync): void {
  sqlite.exec(`
    INSERT INTO assistant_line_channels
      (assistant_key, channel_id, channel_secret_encrypted, access_token_encrypted, display_name, enabled, updated_by)
    VALUES
      ('rueisiang-xiaoxiang', 'line-channel-1', 'secret', 'token', 'Rueisiang 小香', 1, 'eli');
  `);
  sqlite.exec(`
    INSERT INTO assistant_line_groups (id, assistant_key, line_group_id, display_name, enabled)
    VALUES ('group-1', 'rueisiang-xiaoxiang', 'C1234567890', '倉庫群', 1);
  `);
  sqlite.exec(`
    INSERT INTO assistant_line_messages
      (id, assistant_key, line_group_id, source_type, webhook_event_id, line_user_id, text)
    VALUES
      ('msg-1', 'rueisiang-xiaoxiang', 'C1234567890', 'group', 'evt-1', 'U999', '@小香 倉庫還有幾箱');
  `);
  sqlite.exec(`
    INSERT INTO assistant_runs
      (id, channel, group_id, model, prompt_revision_id, input_chars, output_chars, status, duration_ms)
    VALUES
      ('run-1', 'line', 'C1234567890', 'gemini-3.6-flash', 'rev-1', 10, 20, 'success', 300);
  `);
}

describe("LINE channel 換成 channel_key", () => {
  function upgraded(): DatabaseSync {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    apply(sqlite, null, "0020");
    seedLegacyData(sqlite);
    apply(sqlite, "0020", "0024");
    return sqlite;
  }

  it("channel、群組與訊息都還在，而且都補上了 channel_key", () => {
    const sqlite = upgraded();

    const channels = sqlite.prepare("SELECT channel_key, assistant_key, channel_id FROM assistant_line_channels").all();
    expect(channels).toEqual([
      { channel_key: "rueisiang-xiaoxiang", assistant_key: "rueisiang-xiaoxiang", channel_id: "line-channel-1" },
    ]);

    // 這一條是整支測試的重點：群組被 CASCADE 帶走的話這裡會是空陣列。
    const groups = sqlite.prepare("SELECT id, channel_key, line_group_id, enabled, tool_mode FROM assistant_line_groups").all();
    expect(groups).toEqual([
      { id: "group-1", channel_key: "rueisiang-xiaoxiang", line_group_id: "C1234567890", enabled: 1, tool_mode: "inherit" },
    ]);

    const messages = sqlite.prepare("SELECT id, channel_key, text FROM assistant_line_messages").all();
    expect(messages).toEqual([
      { id: "msg-1", channel_key: "rueisiang-xiaoxiang", text: "@小香 倉庫還有幾箱" },
    ]);
  });

  it("既有的執行紀錄補上是哪個 bot 跑的", () => {
    const sqlite = upgraded();
    const runs = sqlite.prepare("SELECT id, channel, assistant_key, channel_key FROM assistant_runs").all();
    expect(runs).toEqual([
      { id: "run-1", channel: "line", assistant_key: "rueisiang-xiaoxiang", channel_key: "rueisiang-xiaoxiang" },
    ]);
  });

  it("外鍵仍然成立：刪掉 channel 會連坐帶走群組", () => {
    const sqlite = upgraded();
    sqlite.exec("DELETE FROM assistant_line_channels WHERE channel_key = 'rueisiang-xiaoxiang';");
    expect(sqlite.prepare("SELECT id FROM assistant_line_groups").all()).toEqual([]);
  });

  it("seed 只把支援 LINE 的工具寫進白名單", () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    apply(sqlite, null, "0020");
    seedLegacyData(sqlite);
    apply(sqlite, "0020", "0024");

    // crm_get_customer 的 surfaces 是 ["sandbox", "mcp"]——啟用了也不該進 LINE 白名單，
    // 否則設定頁會顯示成「已授權」，跟實際能用的工具對不上。
    for (const [key, status] of [
      ["weather_open_meteo", "enabled"],
      ["wms_search_warehouse", "enabled"],
      ["crm_get_customer", "enabled"],
      ["wms_get_activity", "development"],
    ]) {
      sqlite.exec(`INSERT INTO assistant_tool_configs (key, status, updated_by) VALUES ('${key}', '${status}', 'eli');`);
    }
    apply(sqlite, "0024", "0025");

    const granted = (sqlite.prepare("SELECT tool_key FROM assistant_channel_tools ORDER BY tool_key").all() as { tool_key: string }[])
      .map((row) => row.tool_key);
    expect(granted).toEqual(["weather_open_meteo", "wms_search_warehouse"]);
  });

  it("換鍵值之後仍然擋得住同一個 channel 的重複群組", () => {
    const sqlite = upgraded();
    expect(() => sqlite.exec(`
      INSERT INTO assistant_line_groups (id, channel_key, line_group_id, display_name, enabled)
      VALUES ('group-2', 'rueisiang-xiaoxiang', 'C1234567890', '重複的群', 1);
    `)).toThrow();
  });
});
