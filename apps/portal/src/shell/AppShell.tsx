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

  const shellClass = [
    "shell",
    isHrModule ? "hr-shell" : "",
    !isHrModule && collapsed ? "sidebar-collapsed" : "",
    !isHrModule && mobileMenuOpen ? "mobile-menu-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <ToastProvider>
    <div className={shellClass}>
      {!isHrModule ? <>
        {/* 手機上 sidebar 收成抽屜，靠這條上方列開關——沿用 CRM 的作法。 */}
        <header className="mobile-topbar">
          <div className="mobile-topbar-brand">
            <img src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" />
          </div>
          <button
            type="button"
            onClick={() => setMobileMenuOpen((open) => !open)}
            aria-expanded={mobileMenuOpen}
            aria-controls="portal-sidebar"
            aria-label={mobileMenuOpen ? "關閉選單" : "開啟選單"}
          >
            <span />
            <span />
            <span />
          </button>
        </header>

        <button
          type="button"
          className="mobile-menu-backdrop"
          onClick={() => setMobileMenuOpen(false)}
          aria-label="關閉選單"
        />

        <Sidebar
          permissions={permissions}
          collapsed={collapsed}
          onToggle={() => setCollapsed((value) => !value)}
          user={user}
          onLogout={() => void logout()}
          onNavigate={() => setMobileMenuOpen(false)}
        />
      </> : null}

      <main className="content">
        <Outlet />
      </main>
    </div>
    </ToastProvider>
  );
}
