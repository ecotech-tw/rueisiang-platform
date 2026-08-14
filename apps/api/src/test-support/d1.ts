import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 用 Node 24 內建的 node:sqlite 實作 D1 的介面。
 *
 * 開發機是 Windows on ARM，跑不了 workerd，所以無法用 miniflare 起真的 D1。
 * 但 D1 底層就是 SQLite——照著 D1 的介面包一層，測試就能跑真正的 SQL 與
 * 真正的 migration，而不是靠 mock 猜行為。
 */
class TestStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): TestStatement {
    return new TestStatement(this.db, this.sql, values);
  }

  private prepared() {
    return this.db.prepare(this.sql);
  }

  async all<T = Record<string, unknown>>() {
    const results = this.prepared().all(...(this.params as never[])) as T[];
    return { results, success: true as const, meta: {} };
  }

  async run() {
    const info = this.prepared().run(...(this.params as never[]));
    return {
      results: [],
      success: true as const,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    };
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const row = this.prepared().get(...(this.params as never[])) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return (column ? row[column] : row) as T;
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.prepared().all(...(this.params as never[])) as Record<string, unknown>[];
    return rows.map((row) => Object.values(row)) as T[];
  }
}

export class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(query: string): TestStatement {
    return new TestStatement(this.sqlite, query);
  }

  async batch(statements: TestStatement[]) {
    const results = [];
    for (const statement of statements) results.push(await statement.all());
    return results;
  }

  async exec(query: string) {
    this.sqlite.exec(query);
    return { count: 0, duration: 0 };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error("測試替身不支援 dump()。");
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../../../packages/db/migrations");

/** 套用 packages/db 的真實 migration，確保測試跑的 schema 與正式環境一致。 */
export function createTestD1(): TestD1 {
  const database = new TestD1();
  database.sqlite.exec("PRAGMA foreign_keys = ON;");

  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  if (!files.length) throw new Error(`${migrationsDir} 裡沒有 migration。`);

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) database.sqlite.exec(trimmed);
    }
  }
  return database;
}
