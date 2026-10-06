import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
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
const D1_MAX_BOUND_PARAMETERS = 100;

class LocalStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): LocalStatement {
    /*
     * D1 文件寫單一語句最多 100 個綁定參數，node:sqlite 卻收得下三萬多個。不在這裡照著擋的話，
     * 「IN 清單太長」「一次寫太多列」這種錯在測試與本機永遠是綠的，只會在正式環境整句被拒絕。
     * 長清單用 packages/db/src/sql-lists.ts 的 inJsonArray／jsonArrayValues，多列寫入用同一個檔案的 chunks 切批。
     */
    if (values.length > D1_MAX_BOUND_PARAMETERS) {
      throw new Error(`D1_ERROR: too many SQL variables（${values.length} 個綁定參數，D1 單一語句上限 ${D1_MAX_BOUND_PARAMETERS}）: ${this.sql.slice(0, 120)}`);
    }
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

type Migration = { name: string; sql: string };

const migrationsCache = new Map<boolean, readonly Migration[]>();
const snapshotCache = new Map<boolean, string>();
const snapshotWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
const SNAPSHOT_FORMAT_VERSION = "local-d1-snapshot-v2";
const SNAPSHOT_LOCK_TIMEOUT_MS = 120_000;

/*
 * Vitest 會把 test file 分到不同的 worker process；只放在 module-level Map 仍會讓
 * 每個 worker 各跑一次 migration。因此 snapshot 放在 temp，檔名綁 migration 內容，
 * 用 exclusive lock + atomic rename 讓整個 test run 只建立一份，worker 只需 exec snapshot。
 */
function getMigrations(targetOnly: boolean): readonly Migration[] {
  const cached = migrationsCache.get(targetOnly);
  if (cached) return cached;

  const files = fs.readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql") && (targetOnly || !LEGACY_MODE_SKIPS.has(name)))
    .sort();
  if (!files.length) throw new Error(`${migrationsDir} 裡沒有 migration。`);

  const migrations = files.map((name) => ({
    name,
    sql: fs.readFileSync(path.join(migrationsDir, name), "utf8"),
  }));
  migrationsCache.set(targetOnly, migrations);
  return migrations;
}

function applyMigrations(database: DatabaseSync, targetOnly: boolean): void {
  database.exec("PRAGMA foreign_keys = ON");
  // 記下跑過哪幾支，這樣檔案型資料庫重開時不會重複套用。
  database.exec("CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY);");

  const applied = new Set(
    (database.prepare("SELECT name FROM _local_migrations").all() as { name: string }[])
      .map((row) => row.name),
  );

  /*
   * 舊相容模式保留給歷史 migration／compatibility tests；正式本機 server 必須走
   * targetOnly，否則刪掉 legacy migration 後重開會讓 fixture 又寫回不存在的表。
   */
  for (const migration of getMigrations(targetOnly)) {
    if (applied.has(migration.name)) continue;
    for (const statement of migration.sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) database.exec(trimmed);
    }
    database.prepare("INSERT INTO _local_migrations (name) VALUES (?)").run(migration.name);
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  throw new Error(`無法複製 SQLite 值：${typeof value}`);
}

function serializeDatabase(database: DatabaseSync): string {
  type SchemaObject = { type: string; name: string; sql: string };
  type TableColumn = { name: string };
  type TableRow = Record<string, unknown>;

  const objects = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY rowid
  `).all() as SchemaObject[];
  const tables = objects.filter((object) => object.type === "table");
  const chunks = ["PRAGMA foreign_keys = OFF;"];

  for (const table of tables) {
    chunks.push(`${table.sql};`);
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all() as TableColumn[];
    if (!columns.length) continue;

    const rows = database.prepare(`SELECT * FROM ${quoteIdentifier(table.name)}`).all() as TableRow[];
    for (const row of rows) {
      chunks.push(
        `INSERT INTO ${quoteIdentifier(table.name)} VALUES (${columns
          .map((column) => quoteValue(row[column.name]))
          .join(",")});`,
      );
    }
  }

  const hasSequence = database
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'")
    .get();
  if (hasSequence) {
    for (const row of database.prepare("SELECT name, seq FROM sqlite_sequence").all() as TableRow[]) {
      chunks.push(`INSERT INTO sqlite_sequence(name, seq) VALUES (${quoteValue(row.name)}, ${quoteValue(row.seq)});`);
    }
  }

  for (const object of objects) {
    if (object.type !== "table") chunks.push(`${object.sql};`);
  }
  chunks.push("PRAGMA foreign_keys = ON;");
  return chunks.join("\n");
}

function getMigrationFingerprint(targetOnly: boolean): string {
  const hash = createHash("sha256")
    .update(SNAPSHOT_FORMAT_VERSION)
    .update(String(targetOnly));
  for (const migration of getMigrations(targetOnly)) {
    hash.update(migration.name).update("\0").update(migration.sql).update("\0");
  }
  return hash.digest("hex").slice(0, 24);
}

function readSnapshot(snapshotPath: string): string | undefined {
  try {
    return fs.readFileSync(snapshotPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function buildSharedSnapshot(targetOnly: boolean, snapshotPath: string): void {
  const database = new DatabaseSync(":memory:");
  try {
    applyMigrations(database, targetOnly);
    const snapshot = serializeDatabase(database);
    const temporaryPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, snapshot, "utf8");
    fs.renameSync(temporaryPath, snapshotPath);
  } finally {
    database.close();
  }
}

function getMigrationSnapshot(targetOnly: boolean): string {
  const cached = snapshotCache.get(targetOnly);
  if (cached) return cached;

  const fingerprint = getMigrationFingerprint(targetOnly);
  const directory = path.join(os.tmpdir(), "rueisiang-local-d1-snapshots", fingerprint);
  const snapshotPath = path.join(directory, `${targetOnly ? "target" : "legacy"}.sql`);
  const lockPath = `${snapshotPath}.lock`;
  fs.mkdirSync(directory, { recursive: true });

  for (;;) {
    const existing = readSnapshot(snapshotPath);
    if (existing !== undefined) {
      snapshotCache.set(targetOnly, existing);
      return existing;
    }

    let lock: number;
    try {
      lock = fs.openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > SNAPSHOT_LOCK_TIMEOUT_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      Atomics.wait(snapshotWaitBuffer, 0, 0, 10);
      continue;
    }

    try {
      // Another process can finish between the first read and acquiring the lock.
      const ready = readSnapshot(snapshotPath);
      if (ready !== undefined) {
        snapshotCache.set(targetOnly, ready);
        return ready;
      }
      buildSharedSnapshot(targetOnly, snapshotPath);
      const snapshot = fs.readFileSync(snapshotPath, "utf8");
      snapshotCache.set(targetOnly, snapshot);
      return snapshot;
    } finally {
      fs.closeSync(lock);
      fs.rmSync(lockPath, { force: true });
    }
  }
}

function createMemoryDatabase(options: LocalD1Options): LocalD1 {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(getMigrationSnapshot(options.targetOnly === true));
    return new LocalD1(database);
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * 套用 packages/db 的真實 migration，確保檔案型資料庫與正式環境一致。
 *
 * 記憶體資料庫是測試的主要路徑：每個 test 仍拿到獨立的可寫資料庫，但從同一個
 * 已完成 migration 的 SQLite template snapshot 還原，不再每次重跑整份歷史 migration。
 * 給檔案路徑時資料會留著，所以 `pnpm dev` 重開不必重新建帳號。
 */
export interface LocalD1Options {
  /** 只建立 target schema；正式 dev server 與 destructive test 使用這個模式。 */
  targetOnly?: boolean;
}

export function createLocalD1(filename = ":memory:", options: LocalD1Options = {}): LocalD1 {
  if (filename === ":memory:") return createMemoryDatabase(options);

  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const database = new LocalD1(new DatabaseSync(filename));
  applyMigrations(database.sqlite, options.targetOnly === true);
  return database;
}

export function createTargetOnlyD1(filename = ":memory:"): LocalD1 {
  return createLocalD1(filename, { targetOnly: true });
}
