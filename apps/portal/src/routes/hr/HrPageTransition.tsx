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
  // 手機上整頁捲，min-h-0 會讓這一格被 HrMain 的 grid 壓成視窗高、內容溢出；HrMain 的下內距就落在溢出的內容中間，最底下的分頁貼著畫面邊緣。
  return <div key={pathname} className={`relative block w-full min-w-0 min-h-0 max-[760px]:min-h-auto justify-self-stretch min-[760px]:has-[[data-page=fills]]:h-full has-[[data-page=fills]]:overflow-visible [&>[data-page]]:w-full ${changed ? "animate-[hr-page-enter_560ms_cubic-bezier(0.2,0,0,1)_both] motion-reduce:animate-none" : ""}`}>{children}</div>;
}
