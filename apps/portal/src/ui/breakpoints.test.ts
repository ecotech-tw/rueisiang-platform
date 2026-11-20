import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Tailwind v4 的 max-[N] 是 width < N、min-[N] 是 width >= N，同一個數字才接得上（見 CLAUDE.md
 * 「手機與桌機的斷點用同一個數字」）。寫成 min-[N+1] 的話 N 那一格兩邊都不套，畫面只在剛好那個寬度
 * 壞掉，平常量不到，所以靠掃原始碼擋。media query 的 max-width 含等於，跟 CSS 差一格，一起擋；
 * 不只看 matchMedia( 裡面，因為 query 常常先抽成常數。
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SOURCE_DIRS = ["apps/portal/src", "apps/hr/src", "packages/ui/src"];
const SOURCE_FILES = ["packages/ui/theme.css"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("斷點", () => {
  it("min-[N] 跟 max-[N] 用同一個數字，media query 不用含等於的 max-width", () => {
    const sources = [...SOURCE_DIRS.flatMap((dir) => sourceFiles(path.join(repoRoot, dir))), ...SOURCE_FILES.map((file) => path.join(repoRoot, file))]
      .map((file) => ({ rel: path.relative(repoRoot, file).replaceAll("\\", "/"), text: readFileSync(file, "utf8") }));
    expect(sources.length).toBeGreaterThan(50);

    const usedMax = new Set(sources.flatMap(({ text }) => [...text.matchAll(/max-\[(\d+)px\]:/g)].map(([, n]) => Number(n))));

    const offending = sources.flatMap(({ rel, text }) => [
      ...[...text.matchAll(/min-\[(\d+)px\]:/g)].filter(([, n]) => usedMax.has(Number(n) - 1)).map(([match]) => `${rel}: ${match}`),
      ...[...text.matchAll(/\(\s*max-width\s*:[^)]*\)/g)].map(([match]) => `${rel}: ${match}`),
    ]);
    expect(offending).toEqual([]);
  });
});
