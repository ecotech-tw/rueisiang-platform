import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const migration = "0227_redundant_zarek.sql";

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

describe("0227 LINE HR 綁定版本 migration", () => {
  it("保留舊綁定並給予版本值；新綁定可用唯一版本值撤銷舊 token", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec("PRAGMA foreign_keys=ON");
      for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql") && name < migration).sort()) apply(sqlite, file);
      sqlite.exec("INSERT INTO users (id, email, status) VALUES ('hr-link-user', 'hr-link@example.test', 'active')");
      sqlite.exec("INSERT INTO auth_line_account_links (user_id, channel_id, line_user_id) VALUES ('hr-link-user', 'login-channel', 'U-line')");

      apply(sqlite, migration);

      expect(sqlite.prepare("SELECT user_id, channel_id, line_user_id, link_version FROM auth_line_account_links").get()).toEqual({
        user_id: "hr-link-user", channel_id: "login-channel", line_user_id: "U-line", link_version: "legacy",
      });
      sqlite.prepare("UPDATE auth_line_account_links SET link_version=? WHERE user_id=?").run("rotated-version", "hr-link-user");
      expect(sqlite.prepare("SELECT link_version FROM auth_line_account_links WHERE user_id=?").get("hr-link-user")).toEqual({ link_version: "rotated-version" });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(readFileSync(path.join(directory, migration), "utf8")).not.toMatch(/PRAGMA\s+foreign_keys\s*=\s*OFF|DROP\s+TABLE/i);
    } finally {
      sqlite.close();
    }
  });
});
