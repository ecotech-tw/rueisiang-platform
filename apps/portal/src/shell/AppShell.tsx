import type { Permission } from "@rueisiang/auth/permissions";
import { useState } from "react";
import { Outlet } from "react-router";
import { Sidebar } from "./Sidebar.js";

interface AppShellProps {
  permissions: ReadonlySet<Permission>;
}

export function AppShell({ permissions }: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`shell${collapsed ? " sidebar-collapsed" : ""}`}>
      <Sidebar
        permissions={permissions}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
      />
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
