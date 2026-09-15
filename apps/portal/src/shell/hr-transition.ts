import type { MouseEvent } from "react";
import type { NavigateFunction } from "react-router";

/** HRIS 是 /hr 底下的獨立系統；只有跨過這條邊界才播沉浸式轉場，站內換頁不播。 */
export function isHrPath(pathname: string) {
  return pathname === "/hr" || pathname.startsWith("/hr/");
}

let pending: { toHr: boolean; resolve: () => void } | null = null;
let latestId = 0;

/**
 * 用 View Transition 包住「進入／離開 HRIS」這一次導覽。
 *
 * BrowserRouter 預設把路由更新包在 startTransition 裡，flushSync 催不動，
 * 瀏覽器會在新畫面還沒畫出來前就拍下「新狀態」。所以更新回呼改回傳 promise，
 * 等 AppShell 的 layout effect 確認已經換到另一邊（settleHrTransition）才放行。
 *
 * 不支援 View Transition、要求減少動態、或是中鍵／Ctrl 開新分頁時什麼都不做，
 * 讓 <Link> 照原本的方式導覽。
 */
export function navigateAcrossHr(event: MouseEvent<HTMLAnchorElement>, navigate: NavigateFunction, to: string) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (!("startViewTransition" in document) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  event.preventDefault();
  const toHr = isHrPath(to);
  const root = document.documentElement;
  const id = ++latestId;
  root.dataset.hrTransition = toHr ? "enter" : "leave";

  const transition = document.startViewTransition(() => new Promise<void>((resolve) => {
    pending = { toHr, resolve };
    // 保險：萬一目的地沒有觸發 settle，畫面也不會一直凍在舊的快照上。
    window.setTimeout(resolve, 600);
    navigate(to);
  }));
  void transition.finished.finally(() => {
    /*
     * 進入動畫還沒播完就點回平台時，瀏覽器會丟掉上一次轉場，而它的 finished 晚一個 microtask 才結束——
     * 那時下一次已經掛上 data-hr-transition="leave"。不比對就會把新的狀態清掉，離開只剩預設的淡入淡出。
     */
    if (id !== latestId) return;
    delete root.dataset.hrTransition;
    pending = null;
  });
}

export function settleHrTransition(inHr: boolean) {
  if (pending?.toHr !== inHr) return;
  pending.resolve();
  pending = null;
}
