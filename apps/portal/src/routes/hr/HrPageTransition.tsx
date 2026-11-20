import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router";

/** 只在 HRIS 內切換路由時播放；第一次進入不播，避免載入畫面自己滑入。 */
export function HrPageTransition({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const previousPath = useRef(pathname);
  const changed = previousPath.current !== pathname;

  useLayoutEffect(() => {
    previousPath.current = pathname;
  }, [pathname]);

  // fills 的頁面高度吃滿，但不裁掉頁首按鈕的外陰影；限制整個內容區的是外層的 HrMain。keyframes 在 hr.css。
  return <div key={pathname} className={`relative block w-full min-w-0 min-h-0 justify-self-stretch min-[760px]:has-[[data-page=fills]]:h-full has-[[data-page=fills]]:overflow-visible [&>[data-page]]:w-full ${changed ? "animate-[hr-page-enter_560ms_cubic-bezier(0.2,0,0,1)_both] motion-reduce:animate-none" : ""}`}>{children}</div>;
}
