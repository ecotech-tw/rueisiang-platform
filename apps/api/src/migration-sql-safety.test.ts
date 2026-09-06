import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

/*
 * `wrangler d1 migrations apply --remote` 把整份檔案原封不動丟給 D1 的 /query，由伺服器端
 * 自己切句。它切 `/* *\/` 區塊註解時不認裡面的 `;`，那一段會變成「只有註解」的空片段，
 * 整支 migration 以 `SQL code did not contain a statement [code: 7500]` 失敗。
 * 本機 node:sqlite 是認註解的，所以測試、dev 與 prod 備份重播全部會過，只有正式部署會炸——
 * 0095 就是這樣讓 Deploy workflow 連兩次紅的，而它的 CI 是綠的。
 *
 * 只擋區塊註解：`--` 行註解裡的 `;` 有實例（0072）成功部署過，那條路徑 D1 認得。
 */
describe("migration SQL 對 D1 的解析是安全的", () => {
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql"));

  it("有 migration 可以檢查", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s 的區塊註解裡沒有分號", (file) => {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const offenders = (sql.match(/\/\*[\s\S]*?\*\//g) ?? []).filter((comment) => comment.includes(";"));

    expect(offenders).toEqual([]);
  });
});

/*
 * 正式部署不看這份 journal：`wrangler d1 migrations apply` 直接掃 migrations 資料夾
 * （`getMigrationNames` 用 opendirSync），跟 drizzle 的紀錄無關。journal 只有 `pnpm generate`
 * 在用，它拿裡面的 idx 決定下一支的編號。
 *
 * **所以這裡不能反過來要求「每個 .sql 都要在 journal 裡」**：手寫的資料搬移 migration
 * 有 23 支從來沒登記過，而且它們全都正常部署了。那個規則會擋掉一種本來就允許的作法。
 *
 * 真正會出事的只有下面兩件：指向不存在檔案的殭屍條目，以及重複的 idx——後者會讓
 * generate 編出一個已經存在的檔名，把別人的 migration 蓋掉。
 */
describe("migration journal 的一致性", () => {
  const names = new Set(
    fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).map((file) => file.replace(/\.sql$/, "")),
  );
  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };

  it("每一條都有對應的檔案", () => {
    expect(journal.entries.filter((entry) => !names.has(entry.tag)).map((entry) => entry.tag)).toEqual([]);
  });

  it("idx 沒有重複——重複的話 generate 會編出撞號的檔名", () => {
    const seen = new Set<number>();
    const duplicated = journal.entries.filter((entry) => seen.size === seen.add(entry.idx).size);
    expect(duplicated.map((entry) => entry.tag)).toEqual([]);
  });
});
