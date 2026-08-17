import type { Permission } from "@rueisiang/auth/permissions";
import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router";
import type { SessionUser } from "../auth/session.js";
import { AccountPanel } from "./AccountPanel.js";
import {
  ADMIN_SECTION,
  NAV_SECTIONS,
  containsPath,
  sectionContainsPath,
  type NavItem,
  type NavSection,
} from "./nav.js";

interface SidebarProps {
  permissions: ReadonlySet<Permission>;
  collapsed: boolean;
  onToggle: () => void;
  user: SessionUser | null;
  onLogout: () => void;
  onNavigate: () => void;
}

/** 沒有權限的項目直接不畫出來；父項的子項也要一起過濾。 */
function visibleItems(items: NavItem[], permissions: ReadonlySet<Permission>): NavItem[] {
  return items
    .filter((item) => permissions.has(item.permission))
    .map((item) => ({ ...item, children: visibleItems(item.children ?? [], permissions) }));
}

function Item({ item, depth, onNavigate }: { item: NavItem; depth: number; onNavigate: () => void }) {
  const location = useLocation();
  const children = item.children ?? [];
  // 子項只在父項那一段路徑底下時才展開，不必讓人自己點開。
  const expanded = children.length > 0 && containsPath(item, location.pathname);

  return (
    <div className={`nav-node depth-${depth}`}>
      <NavLink
        to={item.to}
        end
        onClick={onNavigate}
        className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
        title={item.label}
      >
        <span className="nav-icon" aria-hidden="true">{item.icon}</span>
        <span className="nav-label">{item.label}</span>
      </NavLink>

      {expanded ? (
        <div className="nav-children">
          {children.map((child) => (
            <Item key={child.to} item={child} depth={depth + 1} onNavigate={onNavigate} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  section,
  permissions,
  onNavigate,
}: {
  section: NavSection;
  permissions: ReadonlySet<Permission>;
  onNavigate: () => void;
}) {
  const location = useLocation();
  const items = visibleItems(section.items, permissions);
  const [open, setOpen] = useState(() => sectionContainsPath(section, location.pathname));

  // 從別的地方跳進這一段（例如網址列直接打）時要自動打開。
  useEffect(() => {
    if (sectionContainsPath(section, location.pathname)) setOpen(true);
  }, [location.pathname, section]);

  if (!items.length) return null;

  return (
    <div className={`nav-section${open ? " open" : ""}`}>
      <button
        type="button"
        className="nav-section-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={section.label}
      >
        <span className="nav-icon section-icon" aria-hidden="true">{section.icon}</span>
        <span className="nav-label">{section.label}</span>
        <span className="nav-chevron" aria-hidden="true" />
      </button>

      <div className="nav-section-items">
        {items.map((item) => (
          <Item key={item.to} item={item} depth={0} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}

export function Sidebar({ permissions, collapsed, onToggle, user, onLogout, onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar" id="portal-sidebar">
      <div className="brand-row">
        <img className="brand-logo" src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" width={142} height={38} />
        <img className="brand-icon" src="/ruei-siang-icon.png" alt="RUEI SIANG" width={34} height={34} />
        <span className="product-badge">內部系統</span>
      </div>

      <button
        type="button"
        className="sidebar-toggle"
        onClick={onToggle}
        aria-label={collapsed ? "展開側邊選單" : "收合側邊選單"}
        aria-expanded={!collapsed}
      >
        <span className={collapsed ? "arrow-right" : "arrow-left"} />
      </button>

      <nav className="primary-nav" aria-label="主要導覽">
        {NAV_SECTIONS.map((section) => (
          <Section key={section.key} section={section} permissions={permissions} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="sidebar-foot">
        <Section section={ADMIN_SECTION} permissions={permissions} onNavigate={onNavigate} />
        <AccountPanel user={user} onLogout={onLogout} onNavigate={onNavigate} permissions={permissions} />
      </div>
    </aside>
  );
}
