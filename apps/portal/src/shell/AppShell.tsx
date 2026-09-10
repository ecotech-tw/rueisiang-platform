import { useState } from "react";
import { Outlet, useLocation } from "react-router";
import { logout, useSession } from "../auth/session.js";
import { Sidebar } from "./Sidebar.js";
import { ToastProvider } from "./Toast.js";

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { user, permissions } = useSession();
  const isHrModule = useLocation().pathname.startsWith("/hr");

  const shellClass = [
    "shell",
    collapsed ? "sidebar-collapsed" : "",
    mobileMenuOpen ? "mobile-menu-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <ToastProvider>
    <div className={shellClass}>
      {/* 手機上 sidebar 收成抽屜，靠這條上方列開關——沿用 CRM 的作法。 */}
      <header className="mobile-topbar">
        <div className="mobile-topbar-brand">
          <img src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" />
          {isHrModule ? <strong>HRIS</strong> : null}
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

      <main className="content">
        <Outlet />
      </main>
    </div>
    </ToastProvider>
  );
}
