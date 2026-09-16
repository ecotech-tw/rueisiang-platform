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

  return <div key={pathname} className={`hr-page-transition${changed ? " is-entering" : ""}`}>{children}</div>;
}
