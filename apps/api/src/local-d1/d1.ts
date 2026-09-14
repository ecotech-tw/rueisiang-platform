import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 用 Node 內建的 node:sqlite 實作 D1 的介面。
 *
 * 開發機是 Windows on ARM，跑不了 workerd，所以無法用 miniflare 起真的 D1，
 * 連 `wrangler dev` 都不行。但 D1 底層就是 SQLite——照著 D1 的介面包一層，
 * 測試與本機開發就能跑真正的 SQL 與真正的 migration，而不是靠 mock 猜行為。
 *
 * 這一層只在測試與 `pnpm dev` 用得到，永遠不會進 Worker 的打包
 * （apps/api/tsconfig.json 把這個目錄排除在外，誤用 node: 內建模組會被擋下）。
 */
class LocalStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): LocalStatement {
    return new LocalStatement(this.db, this.sql, values);
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
    // Drizzle 的 D1 mapper 依欄位順序處理 join；Object.values() 會把同名欄位折疊，
    // 例如薪資批次與期間都有 status 時就會把其中一個值弄丟。
    const statement = this.prepared();
    statement.setReturnArrays(true);
    return statement.all(...(this.params as never[])) as T[];
  }
}

export class LocalD1 {
  private batchTail: Promise<unknown> = Promise.resolve();

  constructor(readonly sqlite: DatabaseSync) {}

  prepare(query: string): LocalStatement {
    return new LocalStatement(this.sqlite, query);
  }

  batch(statements: LocalStatement[]) {
    // D1 batch is one sequential, atomic unit. Serialize local batches too so an
    // awaited statement cannot let another request interleave in the transaction.
    const pending = this.batchTail.then(async () => {
      this.sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    });
    this.batchTail = pending.catch(() => undefined);
    return pending;
  }

  async exec(query: string) {
    this.sqlite.exec(query);
    return { count: 0, duration: 0 };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error("本機替身不支援 dump()。");
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../../../packages/db/migrations");

/*
 * 舊相容模式跳過的 migration。
 *
 * 0088 刪 legacy 表，那個模式的存在意義就是「legacy 還在」的世界，所以不能跑。
 * 而**任何預設 0088 已經跑過的後續 migration 也要一起跳過**：0100 要把
 * report_payout_daily_target 改名回 report_payout_daily，但在這個模式下那個名字
 * 還被沒被刪掉的 legacy 表佔著，改名會直接撞名。
 */
const LEGACY_MODE_SKIPS = new Set([
  "0088_drop_migrated_legacy_schema.sql",
  "0100_rename_payout_daily.sql",
]);

/**
 * 套用 packages/db 的真實 migration，確保跑的 schema 與正式環境一致。
 *
 * 檔案路徑省略時用記憶體資料庫（測試要的：每次都從乾淨的狀態開始）。
 * 給檔案路徑時資料會留著，所以 `pnpm dev` 重開不必重新建帳號。
 */
export interface LocalD1Options {
  /** 只建立 target schema；正式 dev server 與 destructive test 使用這個模式。 */
  targetOnly?: boolean;
}

export function createLocalD1(filename = ":memory:", options: LocalD1Options = {}): LocalD1 {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });

  const database = new LocalD1(new DatabaseSync(filename));
  database.sqlite.exec("PRAGMA foreign_keys = ON;");
  // 記下跑過哪幾支，這樣檔案型資料庫重開時不會重複套用。
  database.sqlite.exec("CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY);");

  const applied = new Set(
    (database.sqlite.prepare("SELECT name FROM _local_migrations").all() as { name: string }[])
      .map((row) => row.name),
  );

  const files = fs.readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql") && (options.targetOnly || !LEGACY_MODE_SKIPS.has(name)))
    .sort();

  /*
   * 舊相容模式保留給歷史 migration／compatibility tests；正式本機 server 必須走
   * targetOnly，否則刪掉 legacy migration 後重開會讓 fixture 又寫回不存在的表。
   */
  if (!files.length) throw new Error(`${migrationsDir} 裡沒有 migration。`);

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) database.sqlite.exec(trimmed);
    }
    database.sqlite.prepare("INSERT INTO _local_migrations (name) VALUES (?)").run(file);
  }
  return database;
}

export function createTargetOnlyD1(filename = ":memory:"): LocalD1 {
  return createLocalD1(filename, { targetOnly: true });
}
