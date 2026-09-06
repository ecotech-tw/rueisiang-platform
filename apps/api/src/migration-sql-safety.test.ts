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
