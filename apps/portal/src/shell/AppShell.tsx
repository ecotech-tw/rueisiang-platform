import { useState } from "react";
import { Outlet } from "react-router";
import { logout, useSession } from "../auth/session.js";
import { Sidebar } from "./Sidebar.js";

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const { user, permissions } = useSession();

  return (
    <div className={`shell${collapsed ? " sidebar-collapsed" : ""}`}>
      <Sidebar
        permissions={permissions}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        user={user}
        onLogout={() => void logout()}
      />
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
