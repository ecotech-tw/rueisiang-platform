import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Tailwind v4 的 max-[N] 是 width < N、min-[N] 是 width >= N，同一個數字才接得上（見 CLAUDE.md
 * 「手機與桌機的斷點用同一個數字」）。寫成 min-[N+1] 的話 N 那一格兩邊都不套，畫面只在剛好那個寬度
 * 壞掉，平常量不到，所以靠掃原始碼擋。JS 的 max-width 含等於，跟 CSS 差一格，一起擋。
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SOURCE_DIRS = ["apps/portal/src", "apps/hr/src", "packages/ui/src"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("斷點", () => {
  it("min-[N] 跟 max-[N] 用同一個數字，matchMedia 不用含等於的 max-width", () => {
    const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(path.join(repoRoot, dir)));
    expect(files.length).toBeGreaterThan(50);

    const usedMax = new Set<number>();
    for (const file of files) for (const [, n] of readFileSync(file, "utf8").matchAll(/max-\[(\d+)px\]:/g)) usedMax.add(Number(n));

    const offending = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const rel = path.relative(repoRoot, file).replaceAll("\\", "/");
      const offByOne = [...text.matchAll(/min-\[(\d+)px\]:/g)].filter(([, n]) => usedMax.has(Number(n) - 1)).map(([match]) => `${rel}: ${match}`);
      const inclusive = [...text.matchAll(/matchMedia\(\s*["'`]\(max-width:[^)]*\)/g)].map(([match]) => `${rel}: ${match}`);
      return [...offByOne, ...inclusive];
    });
    expect(offending).toEqual([]);
  });
});
