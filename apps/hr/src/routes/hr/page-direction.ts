export type SlideDirection = "forward" | "back";

function depth(pathname: string): number {
  return pathname.split("/").filter(Boolean).length;
}

// 方向只看「選單上的位置」與「同一區裡的深度」，不靠各頁自己在 navigate 時標記：
// 標記的作法漏一個地方就會滑錯邊，而且瀏覽器的上一頁根本帶不到標記。
// 回傳 null 代表判斷不出方向（同一頁換查詢參數），呼叫端要沿用上一次的值——
// 換掉 animation-name 會讓還在畫面上的頁面重播一次進場。
export function pageDirection(sections: readonly string[], from: string, to: string): SlideDirection | null {
  const sectionOf = (pathname: string) => sections.findIndex((section) => pathname === section || pathname.startsWith(`${section}/`));
  const delta = sectionOf(to) - sectionOf(from) || depth(to) - depth(from);
  return delta === 0 ? null : delta > 0 ? "forward" : "back";
}

// 手指左滑是「往右邊那一個」，跟頁面進場的方向一致；到頭就不動，不繞回另一端。
export function swipeTarget<T>(items: readonly T[], current: T, deltaX: number): T | null {
  const index = items.indexOf(current);
  return items[index + (deltaX < 0 ? 1 : -1)] ?? null;
}
