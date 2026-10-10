import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migration = "0226_odd_northstar.sql";

function apply(sqlite: DatabaseSync, file: string) {
  sqlite.exec("BEGIN");
  try {
    for (const statement of readFileSync(path.join(directory, file), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

describe("0226 LINE LIFF 身分與裝置認證 migration", () => {
  it("在 D1 transaction 中保留既有裝置，並新增唯一 LINE 關聯與認證來源", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < migration).sort()) apply(sqlite, file);
      sqlite.exec(`
        INSERT INTO users (id, email, status) VALUES
          ('line-migration-a', 'line-a@example.test', 'active'),
          ('line-migration-b', 'line-b@example.test', 'active');
        INSERT INTO auth_device_sessions (id, user_id, token_hash, rotated_at, expires_at)
          VALUES ('existing-device', 'line-migration-a', 'existing-secret-hash', '2026-09-01T00:00:00Z', '2026-09-08T00:00:00Z');
      `);

      apply(sqlite, migration);

      expect(sqlite.prepare("SELECT id, auth_method FROM auth_device_sessions WHERE id='existing-device'").get()).toEqual({
        id: "existing-device", auth_method: "device",
      });
      sqlite.prepare("INSERT INTO auth_device_sessions (id, user_id, token_hash, auth_method, rotated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("line-device", "line-migration-a", "line-secret-hash", "line_liff", "2026-09-01T00:00:00Z", "2026-09-08T00:00:00Z");
      sqlite.prepare("INSERT INTO auth_line_account_links (user_id, channel_id, line_user_id) VALUES (?, ?, ?)")
        .run("line-migration-a", "1234567890", "U-line-identity");
      expect(() => sqlite.prepare("INSERT INTO auth_line_account_links (user_id, channel_id, line_user_id) VALUES (?, ?, ?)")
        .run("line-migration-b", "1234567890", "U-line-identity")).toThrow();
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(readFileSync(path.join(directory, migration), "utf8")).not.toMatch(/PRAGMA\s+foreign_keys\s*=\s*OFF|DROP\s+TABLE/i);
    } finally {
      sqlite.close();
    }
  });
});
