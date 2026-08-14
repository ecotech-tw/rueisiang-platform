import type { Permission } from "@rueisiang/auth/permissions";
import { NavLink } from "react-router";
import type { SessionUser } from "../auth/session.js";
import { ADMIN_SECTION, NAV_SECTIONS, type NavSection } from "./nav.js";

interface SidebarProps {
  permissions: ReadonlySet<Permission>;
  collapsed: boolean;
  onToggle: () => void;
  user: SessionUser | null;
  onLogout: () => void;
}

function Section({ section, permissions }: { section: NavSection; permissions: ReadonlySet<Permission> }) {
  const visible = section.items.filter((item) => permissions.has(item.permission));
  if (!visible.length) return null;

  return (
    <div className="nav-section">
      <div className="nav-section-label">{section.label}</div>
      {visible.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
          end={item.to.endsWith("/new") || item.to.endsWith("/settings")}
        >
          {item.label}
        </NavLink>
      ))}
    </div>
  );
}

export function Sidebar({ permissions, collapsed, onToggle, user, onLogout }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand-row">
        <strong className="brand-name">RUEI SIANG</strong>
        {!collapsed && <span className="product-badge">內部系統</span>}
      </div>

      <nav aria-label="主要導覽" className="nav">
        {NAV_SECTIONS.map((section) => (
          <Section key={section.key} section={section} permissions={permissions} />
        ))}
      </nav>

      <div className="nav-footer">
        <Section section={ADMIN_SECTION} permissions={permissions} />

        {user && !collapsed ? (
          <div className="account">
            <div className="account-name" title={user.email}>{user.name || user.email}</div>
            <button type="button" className="link-button" onClick={onLogout}>登出</button>
          </div>
        ) : null}

        <button type="button" className="sidebar-toggle" onClick={onToggle}>
          {collapsed ? "»" : "« 收合選單"}
        </button>
      </div>
    </aside>
  );
}
