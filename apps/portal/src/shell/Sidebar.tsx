import type { Permission } from "@rueisiang/auth/permissions";
import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router";
import type { SessionUser } from "../auth/session.js";
import { AccountPanel } from "./AccountPanel.js";
import { Icon } from "./icons.js";
import {
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

function Item({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  const location = useLocation();
  const children = item.children ?? [];
  // 子項只在父項那一段路徑底下時才展開，不必讓人自己點開。
  const expanded = children.length > 0 && containsPath(item, location.pathname);

  return (
    <div className="nav-node">
      <NavLink
        to={item.to}
        end
        onClick={onNavigate}
        className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
        title={item.label}
      >
        <Icon name={item.icon} className="nav-icon" />
        <span className="nav-label">{item.label}</span>
      </NavLink>

      {expanded ? (
        <div className="nav-children">
          {children.map((child) => (
            <Item key={child.to} item={child} onNavigate={onNavigate} />
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
        <Icon name={section.icon} className="nav-icon" />
        <span className="nav-label">{section.label}</span>
        <span className="nav-chevron" aria-hidden="true" />
      </button>

      {/* 項目往內縮並掛在一條垂直線上，讓「這些屬於上面那個大項」不必用猜的。 */}
      <div className="nav-section-items">
        {items.map((item) => (
          <Item key={item.to} item={item} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}

export function Sidebar({ permissions, collapsed, onToggle, user, onLogout, onNavigate }: SidebarProps) {
  const navRef = useRef<HTMLElement>(null);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);

  /**
   * 收合成圖示欄時捲軸是藏起來的（見 styles.css），所以要自己給一個「下面還有」的提示。
   * 展開時看得到捲軸，這個箭頭就不出現。
   */
  const measure = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    setHasMoreBelow(nav.scrollHeight - nav.scrollTop - nav.clientHeight > 4);
  }, []);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    measure();
    nav.addEventListener("scroll", measure, { passive: true });
    // 展開／收合大項會改變高度，視窗縮放也會，兩者都要重新量。
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    for (const child of Array.from(nav.children)) observer.observe(child);

    return () => {
      nav.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure, collapsed]);

  return (
    <aside className="sidebar" id="portal-sidebar">
      <div className="brand-row">
        <img className="brand-logo" src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" width={142} height={38} />
        <img className="brand-icon" src="/ruei-siang-icon.png" alt="RUEI SIANG" width={34} height={34} />
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

      <div className="nav-viewport">
        <nav className="primary-nav" aria-label="主要導覽" ref={navRef}>
          {NAV_SECTIONS.map((section) => (
            <Section key={section.key} section={section} permissions={permissions} onNavigate={onNavigate} />
          ))}
        </nav>

        {hasMoreBelow ? (
          <button
            type="button"
            className="nav-scroll-hint"
            aria-label="往下捲動看更多項目"
            onClick={() => navRef.current?.scrollBy({ top: 160, behavior: "smooth" })}
          >
            <span className="nav-scroll-arrow" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="sidebar-foot">
        <AccountPanel user={user} onLogout={onLogout} onNavigate={onNavigate} />
      </div>
    </aside>
  );
}
