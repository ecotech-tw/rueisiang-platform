import type { Permission } from "@rueisiang/auth/permissions";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { GuardedNavLink } from "./UnsavedChanges.js";
import type { SessionUser } from "../auth/session.js";
import { AccountPanel } from "./AccountPanel.js";
import { SystemSwitcher } from "./SystemSwitcher.js";
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

/** 沒有權限的項目直接不畫出來；父項的子項也要一起過濾。陣列是「任一個」。 */
function visibleItems(items: NavItem[], permissions: ReadonlySet<Permission>): NavItem[] {
  return items
    .filter((item) => (Array.isArray(item.permission) ? item.permission : [item.permission])
      .some((permission) => permissions.has(permission)))
    .map((item) => ({ ...item, children: visibleItems(item.children ?? [], permissions) }));
}

function Item({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  const location = useLocation();
  const children = item.children ?? [];
  // 子項只在父項那一段路徑底下時才展開，不必讓人自己點開。
  const expanded = children.length > 0 && containsPath(item, location.pathname);

  return (
    <div className="nav-node">
      <GuardedNavLink
        to={item.to}
        end
        onClick={onNavigate}
        className={`nav-item${containsPath(item, location.pathname) ? " active" : ""}`}
        title={item.label}
      >
        <Icon name={item.icon} className="nav-icon" />
        <span className="nav-label">{item.label}</span>
      </GuardedNavLink>

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
  open,
  onToggle,
  onNavigate,
}: {
  section: NavSection;
  permissions: ReadonlySet<Permission>;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  const location = useLocation();
  const items = visibleItems(section.items, permissions);
  if (!items.length) return null;

  if (items.length === 1 && section.homePath) {
    const item = items[0]!;
    return (
      <div className="nav-section single">
        <GuardedNavLink
          to={item.to}
          end
          onClick={onNavigate}
          className={`nav-section-head nav-section-link${sectionContainsPath(section, location.pathname) ? " active" : ""}`}
          title={section.label}
        >
          <Icon name={section.icon} className="nav-icon" />
          <span className="nav-label">{section.label}</span>
        </GuardedNavLink>
      </div>
    );
  }

  return (
    <div className={`nav-section${open ? " open" : ""}`}>
      <button
        type="button"
        className="nav-section-head"
        aria-expanded={open}
        onClick={onToggle}
        title={section.label}
      >
        <Icon name={section.icon} className="nav-icon" />
        <span className="nav-label">{section.label}</span>
        <span className="nav-chevron" aria-hidden="true" />
      </button>

      {/*
        展開的動畫用 grid-template-rows 0fr → 1fr。
        max-height 那種要先猜一個高度，猜太小會截斷、猜太大會讓動畫看起來拖很久；
        grid 這招不必知道內容多高。
      */}
      <div className="nav-section-items" aria-hidden={!open}>
        <div className="nav-section-items-inner">
          {items.map((item) => (
            <Item key={item.to} item={item} onNavigate={onNavigate} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function Sidebar({ permissions, collapsed, onToggle, user, onLogout, onNavigate }: SidebarProps) {
  const navRef = useRef<HTMLElement>(null);
  const location = useLocation();
  const [hasMoreBelow, setHasMoreBelow] = useState(false);

  /*
   * 一次只開一段。四段全開的話清單會長到要捲，反而更難找——手風琴式的展開
   * 讓「現在在哪一段」永遠只有一個答案。
   */
  const [openKey, setOpenKey] = useState<string | null>(
    () => NAV_SECTIONS.find((section) => sectionContainsPath(section, location.pathname))?.key ?? null,
  );

  // 從別的地方跳進某一段（網址列直接打、或選單外的連結）時要自動切過去。
  useEffect(() => {
    const active = NAV_SECTIONS.find((section) => sectionContainsPath(section, location.pathname));
    if (active) setOpenKey(active.key);
  }, [location.pathname]);

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
        <img className="brand-logo" src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" width={184} height={46} />
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
            <Section
              key={section.key}
              section={section}
              permissions={permissions}
              open={openKey === section.key}
              onToggle={() => setOpenKey((current) => (current === section.key ? null : section.key))}
              onNavigate={onNavigate}
            />
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
        <SystemSwitcher permissions={permissions} onNavigate={onNavigate} />
        <AccountPanel user={user} onLogout={onLogout} onNavigate={onNavigate} />
      </div>
    </aside>
  );
}
