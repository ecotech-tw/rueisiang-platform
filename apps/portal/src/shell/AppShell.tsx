import { useLayoutEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { logout, useSession } from "../auth/session.js";
import { isHrPath, settleHrTransition } from "./hr-transition.js";
import { Sidebar } from "./Sidebar.js";
import { ToastProvider } from "./Toast.js";

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { user, permissions } = useSession();
  const isHrModule = isHrPath(useLocation().pathname);

  // 新畫面已經進 DOM、還沒上色：這時放行 View Transition 拍「新狀態」才拍得到。
  useLayoutEffect(() => settleHrTransition(isHrModule), [isHrModule]);

  // 左欄寬度：HRIS 沒有 sidebar（自己有一套導覽），收合時只剩圖示欄。手機一律單欄，上面一條 topbar。
  const columns = isHrModule ? "grid-cols-[minmax(0,1fr)]" : collapsed ? "grid-cols-[76px_minmax(0,1fr)]" : "grid-cols-[252px_minmax(0,1fr)]";
  /*
   * 內容區自己捲，整頁不捲（html/body 看 data-shell 鎖住）。
   * fills 的頁面只讓表格捲、bleed 的頁面（地圖）連內距都不要；小香測試台自己分兩欄各自捲。
   */
  const content = isHrModule
    ? "p-0 [background:radial-gradient(circle_at_top_left,--alpha(var(--color-brand)/8%),transparent_34rem),var(--color-canvas)]"
    : "px-9 py-8 max-[900px]:px-4 max-[900px]:py-5";

  return (
    <ToastProvider>
    <div data-shell="" className={`grid h-screen min-h-screen overflow-hidden ${columns} transition-[grid-template-columns] duration-220 ease-out motion-reduce:transition-none max-[900px]:grid-cols-1 max-[900px]:grid-rows-[auto_minmax(0,1fr)]`}>
      {!isHrModule ? <>
        {/* 手機上 sidebar 收成抽屜，靠這條上方列開關——沿用 CRM 的作法。 */}
        <header className="sticky top-0 z-30 hidden items-center justify-between gap-3 border-b border-line bg-drawer px-4 py-2.5 max-[900px]:flex">
          <div className="flex min-w-0 items-center gap-3">
            <img className="h-auto w-[118px]" src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" />
          </div>
          <button
            type="button"
            className="grid w-10 gap-1 rounded-[11px] border border-line bg-paper p-[9px]"
            onClick={() => setMobileMenuOpen((open) => !open)}
            aria-expanded={mobileMenuOpen}
            aria-controls="portal-sidebar"
            aria-label={mobileMenuOpen ? "關閉選單" : "開啟選單"}
          >
            <span className="h-0.5 rounded-[2px] bg-brand" />
            <span className="h-0.5 rounded-[2px] bg-brand" />
            <span className="h-0.5 rounded-[2px] bg-brand" />
          </button>
        </header>

        <button
          type="button"
          className={`fixed inset-0 z-19 hidden border-0 bg-ink/38 ${mobileMenuOpen ? "max-[900px]:block" : ""}`}
          onClick={() => setMobileMenuOpen(false)}
          aria-label="關閉選單"
        />

        <Sidebar
          permissions={permissions}
          collapsed={collapsed}
          mobileOpen={mobileMenuOpen}
          onToggle={() => setCollapsed((value) => !value)}
          user={user}
          onLogout={() => void logout()}
          onNavigate={() => setMobileMenuOpen(false)}
        />
      </> : null}

      {/*
        * 「整頁不捲、只有表格自己捲」只在桌機成立。手機上表格變成卡片、沒有要釘住的表頭，
        * 篩選欄位又一欄一列往下排，鎖住高度會把表格區擠到 0；所以手機上 fills 頁面照內容長高、整頁捲。
        */}
      <main className={`h-full min-h-0 min-w-0 overflow-y-auto ${content} min-[760px]:has-[[data-page=fills]]:overflow-y-hidden max-[760px]:[&_[data-page=fills]]:h-auto has-[[data-sandbox-page]]:overflow-hidden has-[[data-page=bleed]]:overflow-hidden has-[[data-page=bleed]]:p-0`}>
        <Outlet />
      </main>
    </div>
    </ToastProvider>
  );
}
