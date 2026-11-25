import { normalizeDbTimestamp, sameDbTimestamp, toDbTimestamp } from "@rueisiang/db";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

/*
 * 這幾個檔的 toISOString() 不寫進資料庫：健康檢查與 CYBERBIZ 目錄是 API 回應，
 * ReportRunner 的 finishedAt 是 Container job metadata；db-timestamp.ts 本身就是轉換的地方。
 */
const NOT_STORED = new Set([
  "packages/db/src/db-timestamp.ts",
  "apps/api/src/routes/health.ts",
  "apps/api/src/cyberbiz-catalog.ts",
  "apps/api/src/report-runner-container.ts",
]);

function sources(dir: string): string[] {
  return readdirSync(path.join(repo, dir)).flatMap((name) => {
    const relative = `${dir}/${name}`;
    if (statSync(path.join(repo, relative)).isDirectory()) return name === "dev" ? [] : sources(relative);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [relative] : [];
  });
}

describe("資料庫時間的寫入格式", () => {
  it("toDbTimestamp 產生 UTC 的 YYYY-MM-DD HH:MM:SS.SSS", () => {
    expect(toDbTimestamp(Date.UTC(2026, 9, 1, 10, 0, 0, 7))).toBe("2026-10-01 10:00:00.007");
  });

  it("帶毫秒的寫入值跟 CURRENT_TIMESTAMP 直接比字串仍然照時間排序", () => {
    const values = [toDbTimestamp(Date.UTC(2026, 9, 1, 10, 0, 0, 500)), "2026-10-01 10:00:01", "2026-10-01 10:00:00", toDbTimestamp(Date.UTC(2026, 9, 1, 9, 59, 59, 999))];
    expect([...values].sort()).toEqual(["2026-10-01 09:59:59.999", "2026-10-01 10:00:00", "2026-10-01 10:00:00.500", "2026-10-01 10:00:01"]);
  });

  it("外部來的時間轉成資料庫格式，空值與認不得的原樣保留", () => {
    expect(normalizeDbTimestamp("2026-10-01T10:00:00.000Z")).toBe("2026-10-01 10:00:00.000");
    expect(normalizeDbTimestamp("")).toBe("");
    expect(normalizeDbTimestamp("not a time")).toBe("not a time");
    expect(normalizeDbTimestamp(null)).toBeNull();
  });

  it("同一個時間點換了格式仍然算相同", () => {
    expect(sameDbTimestamp("2026-10-01T10:00:00.000Z", "2026-10-01 10:00:00")).toBe(true);
    expect(sameDbTimestamp("2026-10-01T10:00:00.000Z", "2026-10-01 10:00:01")).toBe(false);
    expect(sameDbTimestamp(null, null)).toBe(true);
    expect(sameDbTimestamp(null, "2026-10-01 10:00:00")).toBe(false);
  });

  it("server 端不再用 toISOString() 產生要存的時間", () => {
    const offenders = [...sources("packages/db/src"), ...sources("apps/api/src")]
      .filter((file) => !NOT_STORED.has(file))
      .flatMap((file) => readFileSync(path.join(repo, file), "utf8").split("\n")
        // 只取日期的 slice(0, 10) 與 HR 的 slice(0, 19) 換算本來就是資料庫格式。
        .map((line, index) => /\.toISOString\(\)(?!\.slice\(0, (?:10|19)\))/.test(line) ? `${file}:${index + 1}` : null)
        .filter((hit): hit is string => hit !== null));
    expect(offenders).toEqual([]);
  });
});
