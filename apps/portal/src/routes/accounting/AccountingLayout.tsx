import type { Permission } from "@rueisiang/auth/permissions";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "../../auth/session.js";
import { useDismiss } from "../../shell/AccountPanel.js";
import { HrSkins } from "../../shell/HrSkins.js";
import { Icon, type IconName } from "../../shell/icons.js";
import { GuardedNavLink } from "../../shell/UnsavedChanges.js";
import { HR_SHELL, HrBrand, HrGlassDefs, HrHeader, HrMain, HrNav, HrNavItem, hrNavIconClass, hrNavLinkClass, hrUserTriggerClass } from "../hr/HrShell.js";
import { HrUserMenu } from "../hr/HrUserMenu.js";

/*
 * 會計系統（內帳）。跟 HRIS 一樣是平台裡的獨立系統：全螢幕、沒有平台側欄，頁首、導覽、帳號選單直接用
 * HRIS 那一套元件，兩個系統長得一樣、轉場也一樣（shell/system-transition.ts）。
 *
 * 頁面刻意少：支出（一個月所有算數的支出、登記公司支出、匯出）、報帳（審核、撥款、紀錄都在同一頁用狀態分頁切）、
 * 零用金（餘額與每一筆進出）與支出類別。
 */
const NAV: { label: string; to: string; icon: IconName; permissions: Permission[] }[] = [
  { label: "支出", to: "/accounting/ledger", icon: "payments", permissions: ["accounting:expense:read"] },
  { label: "報帳", to: "/accounting/expenses", icon: "report", permissions: ["accounting:expense:read"] },
  { label: "零用金", to: "/accounting/petty-cash", icon: "box", permissions: ["accounting:expense:read"] },
  { label: "支出類別", to: "/accounting/categories", icon: "category", permissions: ["accounting:category:write"] },
];

function isActive(to: string, pathname: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function AccountingLayout() {
  const pathname = useLocation().pathname;
  const { permissions } = useSession();
  const items = NAV.filter((item) => item.permissions.some((permission) => permissions.has(permission)));
  const activeItem = items.find((item) => isActive(item.to, pathname));
  const current = activeItem?.label ?? "會計";

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setMobileNavOpen(false); }, [pathname]);
  useDismiss(headerRef, mobileNavOpen, (event) => {
    setMobileNavOpen(false);
    if (event instanceof KeyboardEvent) menuButtonRef.current?.focus();
  });

  // 選中那一格底下的玻璃膠囊：量實際位置交給 CSS 變數，作法同 HRIS。
  const navRef = useRef<HTMLElement>(null);
  const placeThumb = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const item = nav.querySelector<HTMLElement>(":scope > [data-active]");
    if (!item) { nav.removeAttribute("data-thumb"); return; }
    nav.style.setProperty("--hr-thumb-x", `${item.offsetLeft}px`);
    nav.style.setProperty("--hr-thumb-w", `${item.offsetWidth}px`);
    nav.setAttribute("data-thumb", "");
    if (!nav.hasAttribute("data-thumb-ready")) requestAnimationFrame(() => nav.setAttribute("data-thumb-ready", ""));
  }, []);
  useLayoutEffect(() => { placeThumb(); }, [placeThumb, activeItem?.to]);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const observer = new ResizeObserver(() => placeThumb());
    observer.observe(nav);
    return () => observer.disconnect();
  }, [placeThumb]);

  return <HrSkins><div data-hr-shell="" className={HR_SHELL}>
    <HrGlassDefs />
    <HrHeader ref={headerRef} onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setMobileNavOpen(false); }}>
      <HrBrand system="會計" current={current} page={current} />
      <div className="hidden max-[900px]:col-[2] max-[900px]:row-[1] max-[900px]:block">
        <button
          ref={menuButtonRef}
          type="button"
          className={hrUserTriggerClass(mobileNavOpen)}
          aria-expanded={mobileNavOpen}
          aria-controls="accounting-primary-nav"
          aria-label={mobileNavOpen ? "關閉會計選單" : "開啟會計選單"}
          onClick={() => setMobileNavOpen((open) => !open)}
        >
          <Icon name={mobileNavOpen ? "close" : "menu"} className="size-[22px] text-brand-dark" />
        </button>
      </div>
      <HrNav label="會計主要導覽" id="accounting-primary-nav" mobileOpen={mobileNavOpen} ref={navRef}>
        {items.map((item) => {
          const active = isActive(item.to, pathname);
          return <HrNavItem active={active} key={item.to}>
            <GuardedNavLink to={item.to} className={hrNavLinkClass({ active })}>
              <Icon name={item.icon} className={hrNavIconClass(active)} />
              <span>{item.label}</span>
            </GuardedNavLink>
          </HrNavItem>;
        })}
      </HrNav>
      <HrUserMenu onOpen={() => setMobileNavOpen(false)} />
    </HrHeader>
    <HrMain><Outlet /></HrMain>
  </div></HrSkins>;
}

export function AccountingLanding() {
  const { permissions } = useSession();
  const target = NAV.find((item) => item.permissions.some((permission) => permissions.has(permission)));
  return <Navigate to={target?.to ?? "/"} replace />;
}
