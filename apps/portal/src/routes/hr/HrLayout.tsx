import type { Permission } from "@rueisiang/auth/permissions";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { HrSkins } from "../../shell/HrSkins.js";
import { GuardedNavLink } from "../../shell/UnsavedChanges.js";
import { useDismiss } from "../../shell/AccountPanel.js";
import { useSession } from "../../auth/session.js";
import { Icon, type IconName } from "../../shell/icons.js";
import { HrOverview } from "./Overview.js";
import { HrPageTransition } from "./HrPageTransition.js";
import { HR_SHELL, HrBrand, HrGlassDefs, HrHeader, HrMain, HrNav, HrNavItem, hrMenuItemClass, hrNavChevronClass, hrNavIconClass, hrNavLinkClass, hrSubmenuClass, hrUserTriggerClass } from "./HrShell.js";
import { HrUserMenu } from "./HrUserMenu.js";

/** platform 只承載 HR 管理功能；員工本人入口在 hr.rueisiang.com。 */
const EMPLOYEE_TABS = [
  { label: "人員列表", to: "/hr/employees", permission: "hr:employee:read" as const, icon: "list" as const, adminOnly: false, activePaths: ["/hr/employees"], end: false },
  { label: "支援人員", to: "/hr/support-workers", permission: "hr:schedule:read" as const, icon: "people" as const, adminOnly: true },
];

const ATTENDANCE_TABS = [
  { label: "出勤紀錄", to: "/hr/attendance-records", permission: "hr:office:read" as const, icon: "calendar" as const, adminOnly: false },
  { label: "假別管理", to: "/hr/leave-types", permission: "hr:payroll:read" as const, icon: "tag" as const, adminOnly: true },
  { label: "額度發放", to: "/hr/leave-grants", permission: "hr:payroll:read" as const, icon: "payments" as const, adminOnly: true },
  { label: "特休額度", to: "/hr/annual-leave", permission: "hr:payroll:read" as const, icon: "calendar" as const, adminOnly: true },
  { label: "特休政策", to: "/hr/annual-leave/settings", permission: "hr:payroll:read" as const, icon: "tune" as const, adminOnly: true },
  { label: "出勤範圍管理", to: "/hr/attendance-scope", permission: "hr:office:read" as const, icon: "people" as const, adminOnly: false },
  { label: "據點管理", to: "/hr/attendance-settings", permission: "hr:office:read" as const, icon: "tune" as const, adminOnly: false },
  { label: "特殊上班日", to: "/hr/special-workdays", permission: "hr:office:read" as const, icon: "calendar" as const, adminOnly: false },
];

const SCHEDULING_TABS = [
  { label: "排班月曆", to: "/hr/scheduling", permission: "hr:schedule:read" as const, icon: "calendar" as const, adminOnly: false },
  { label: "班別管理", to: "/hr/scheduling/shifts", permission: "hr:schedule:read" as const, icon: "clock" as const, adminOnly: false },
  { label: "行事曆", to: "/hr/scheduling/calendar", permission: "hr:schedule:read" as const, icon: "calendar" as const, adminOnly: false },
];

const PAYROLL_TABS = [
  { label: "敘薪管理", to: "/hr/compensation", permission: "hr:payroll:read" as const, icon: "payments" as const, adminOnly: true },
  { label: "勞健保管理", to: "/hr/insurance", permission: "hr:employee:read" as const, icon: "payments" as const, adminOnly: true },
  { label: "獎金管理", to: "/hr/bonus", permission: "hr:bonus:read" as const, icon: "tag" as const, adminOnly: true },
  { label: "制度設定", to: "/hr/payroll-settings", permission: "hr:payroll:read" as const, icon: "tune" as const, adminOnly: true },
  { label: "薪資結算", to: "/hr/payroll-settlement", permission: "hr:payroll:read" as const, icon: "report" as const, adminOnly: true, activePaths: ["/hr/monthly-data"] },
  { label: "薪資加扣項", to: "/hr/payroll-adjustments", permission: "hr:payroll:read" as const, icon: "tune" as const, adminOnly: true },
];

const OVERVIEW_PERMISSIONS: Permission[] = ["hr:employee:read", "hr:office:read", "hr:schedule:read", "hr:payroll:read", "hr:bonus:read"];

type HrNavChild = {
  label: string;
  to: string;
  icon: IconName;
  permission: Permission;
  adminOnly?: boolean;
  activePaths?: string[];
  end?: boolean;
};

type HrNavGroup = {
  label: string;
  to: string;
  icon: IconName;
  permissions: Permission[];
  adminOnly?: boolean;
  activePaths?: string[];
  children?: HrNavChild[];
};

const HR_PRIMARY_NAV: HrNavGroup[] = [
  { label: "儀表板", to: "/hr", icon: "analytics", permissions: OVERVIEW_PERMISSIONS, adminOnly: true, activePaths: ["/hr"] },
  { label: "申請與審核", to: "/hr/requests", icon: "edit", permissions: ["hr:request:review"], activePaths: ["/hr/requests"] },
  { label: "人員", to: "/hr/employees", icon: "list", permissions: ["hr:employee:read"], activePaths: ["/hr/employees", "/hr/support-workers"], children: EMPLOYEE_TABS },
  { label: "出勤", to: "/hr/attendance-records", icon: "clock", permissions: ["hr:office:read", "hr:payroll:read"], activePaths: ["/hr/attendance-records", "/hr/attendance-scope", "/hr/attendance-settings", "/hr/special-workdays", "/hr/leave-types", "/hr/leave-grants", "/hr/annual-leave"], children: ATTENDANCE_TABS },
  { label: "排班", to: "/hr/scheduling", icon: "calendar", permissions: ["hr:schedule:read", "hr:office:read"], activePaths: ["/hr/scheduling"], children: SCHEDULING_TABS },
  { label: "薪資", to: "/hr/compensation", icon: "payments", permissions: ["hr:payroll:read", "hr:bonus:read", "hr:employee:read"], adminOnly: true, activePaths: ["/hr/compensation", "/hr/insurance", "/hr/bonus", "/hr/payroll-settings", "/hr/payroll-settlement", "/hr/payroll-adjustments", "/hr/monthly-data"], children: PAYROLL_TABS },
];

function matchesPath(path: string, pathname: string) {
  return pathname === path || (path !== "/hr" && pathname.startsWith(`${path}/`));
}

function isActive(paths: string[], pathname: string) {
  return paths.some((path) => matchesPath(path, pathname));
}

function visibleChildren(children: HrNavChild[] | undefined, permissions: ReadonlySet<Permission>, isHrAdministrator: boolean) {
  return (children ?? []).filter((child) => permissions.has(child.permission) && (!child.adminOnly || isHrAdministrator));
}

function matchingPathLength(paths: string[], pathname: string) {
  return paths.reduce((longest, path) => matchesPath(path, pathname) ? Math.max(longest, path.length) : longest, -1);
}

function childActivePaths(child: HrNavChild) {
  return [child.to, ...(child.activePaths ?? [])];
}

/** 同一組子選單只有最具體的路徑可以呈現 active，避免父路徑和子路徑同時亮起。 */
function isActiveChild(children: HrNavChild[], child: HrNavChild, pathname: string) {
  const childLength = matchingPathLength(childActivePaths(child), pathname);
  if (childLength < 0) return false;
  const longestLength = Math.max(...children.map((item) => matchingPathLength(childActivePaths(item), pathname)));
  return childLength === longestLength;
}

export function HrLayout() {
  const pathname = useLocation().pathname;
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.isHrAdministrator ?? false;
  // HRIS 是一套獨立管理系統：進到 /hr 後不再借用平台側欄，避免 CRM/WMS 導覽干擾人資流程。
  const isRequests = pathname.includes("/requests");
  const isEmployee = pathname.includes("/employees") || pathname.includes("/support-workers");
  const isAttendance = pathname.includes("/attendance-settings") || pathname.includes("/attendance-scope") || pathname.includes("/attendance-records") || pathname.includes("/special-workdays") || pathname.includes("/leave-types") || pathname.includes("/leave-grants") || pathname.includes("/annual-leave");
  const isScheduling = pathname.includes("/scheduling");
  const isPayroll = pathname.includes("/compensation") || pathname.includes("/insurance") || pathname.includes("/bonus") || pathname.includes("/payroll-settlement") || pathname.includes("/payroll-adjustments") || pathname.includes("/monthly-data") || pathname.includes("/payroll-settings");
  const isOverview = pathname === "/hr" || pathname === "/hr/";
  const current = isOverview ? "儀表板" : isRequests ? "申請與審核" : isEmployee ? "員工管理" : isAttendance ? "出勤管理" : isScheduling ? "排班管理" : isPayroll ? "薪資" : "員工管理";
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const visiblePrimaryNav = HR_PRIMARY_NAV
    .map((item) => ({
      ...item,
      // 有子選單的項目只負責展開選單，不把第一個子頁當成預設轉址。
      children: visibleChildren(item.children, permissions, isHrAdministrator),
    }))
    .filter((item) => (item.permissions.some((permission) => permissions.has(permission)) || item.children.length > 0) && (!item.adminOnly || isHrAdministrator));
  const activeLabel = visiblePrimaryNav.find((item) => isActive(item.activePaths ?? [item.to], pathname))?.label ?? null;

  /*
   * 手機上導覽收在選單鈕後面。打開時順便展開目前所在的大項，要換到同一組的另一頁少點一下；
   * 換頁、點面板外面、按 Escape 都收起來。
   */
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setMobileNavOpen(false); setOpenMenu(null); }, [pathname]);
  useDismiss(headerRef, mobileNavOpen, (event) => {
    setMobileNavOpen(false);
    if (event instanceof KeyboardEvent) menuButtonRef.current?.focus();
  });
  const toggleMobileNav = () => {
    const next = !mobileNavOpen;
    setMobileNavOpen(next);
    const activeItem = visiblePrimaryNav.find((item) => item.label === activeLabel);
    setOpenMenu(next && activeItem?.children.length ? activeItem.label : null);
  };

  /*
   * 選中那一格底下的玻璃膠囊是一塊會滑動的 thumb，不是每一格各自的底色。
   * 每一格寬度跟著文字走，只能量實際的 offsetLeft / offsetWidth 再交給 CSS 變數。
   */
  const navRef = useRef<HTMLElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const placedRef = useRef<{ label: string | null; x: number }>({ label: null, x: 0 });

  const placeThumb = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return null;
    const item = nav.querySelector<HTMLElement>(":scope > [data-active]");
    if (!item) {
      nav.removeAttribute("data-thumb");
      return null;
    }
    nav.style.setProperty("--hr-thumb-x", `${item.offsetLeft}px`);
    nav.style.setProperty("--hr-thumb-w", `${item.offsetWidth}px`);
    nav.setAttribute("data-thumb", "");
    return item.offsetLeft;
  }, []);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const previous = placedRef.current;
    const x = placeThumb();
    if (x === null) {
      placedRef.current = { label: null, x: 0 };
      return;
    }
    if (!nav?.hasAttribute("data-thumb-ready")) {
      // 第一次定位不播滑動；下一個 frame 才打開 transition，否則會從最左邊滑進來。
      requestAnimationFrame(() => nav?.setAttribute("data-thumb-ready", ""));
    } else if (previous.label && previous.label !== activeLabel && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // 沿用參考範例的「拉長再回彈」：往哪邊走就從反方向那一側撐開，看起來是被拖過去的。
      const thumb = thumbRef.current;
      if (thumb) {
        thumb.style.transformOrigin = x > previous.x ? "left" : "right";
        thumb.animate([{ scale: "1 1" }, { scale: "1.1 1" }, { scale: "1 1" }], { duration: 440, easing: "ease" });
      }
    }
    placedRef.current = { label: activeLabel, x };
  }, [activeLabel, placeThumb]);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    // 字型晚到或視窗縮放都會改變每一格的寬度。
    const observer = new ResizeObserver(() => placeThumb());
    observer.observe(nav);
    return () => observer.disconnect();
  }, [placeThumb]);

  return <HrSkins><div data-hr-shell="" className={HR_SHELL}>
    <HrGlassDefs />
    <HrHeader
      ref={headerRef}
      // 鍵盤 Tab 出頁首就收起來，不然面板一直蓋在焦點所在的內容上面；點外面由 useDismiss 處理。
      onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setMobileNavOpen(false); }}
    >
      <HrBrand current={current} />
      <div className="hidden max-[900px]:col-[2] max-[900px]:row-[1] max-[900px]:block">
        <button
          ref={menuButtonRef}
          type="button"
          className={hrUserTriggerClass(mobileNavOpen)}
          aria-expanded={mobileNavOpen}
          aria-controls="hr-primary-nav"
          aria-label={mobileNavOpen ? "關閉 HRIS 選單" : "開啟 HRIS 選單"}
          onClick={toggleMobileNav}
        >
          <Icon name={mobileNavOpen ? "close" : "menu"} className="size-[22px] text-brand-dark" />
        </button>
      </div>
      <HrNav label="HRIS 主要導覽" id="hr-primary-nav" mobileOpen={mobileNavOpen} ref={navRef} thumbRef={thumbRef}>
        {visiblePrimaryNav.map((item) => {
          const active = isActive(item.activePaths ?? [item.to], pathname);
          const hasChildren = item.children.length > 0;
          const open = openMenu === item.label;
          const submenuId = `hr-system-submenu-${item.to.replace(/^\/+/, "").replaceAll("/", "-")}`;
          return <HrNavItem
            active={active}
            open={open}
            key={item.label}
            // 觸控裝置不應把合成 mouse 事件當成 hover，否則展開後可能立刻被離開事件收合。
            onPointerEnter={(event) => { if (hasChildren && event.pointerType === "mouse") setOpenMenu(item.label); }}
            onPointerLeave={(event) => { if (hasChildren && event.pointerType === "mouse") setOpenMenu((current) => current === item.label ? null : current); }}
            onFocus={(event) => { if (hasChildren && event.target.matches(":focus-visible")) setOpenMenu(item.label); }}
            onBlur={(event) => {
              if (hasChildren && !event.currentTarget.contains(event.relatedTarget)) setOpenMenu((current) => current === item.label ? null : current);
            }}
          >
            {hasChildren ? <button
              type="button"
              className={hrNavLinkClass({ active, open })}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={submenuId}
              // 滑鼠靠 hover 打開、點了也維持開著；觸控沒有 hover，點一下開、再點一下收。
              onClick={(event) => {
                const touch = (event.nativeEvent as PointerEvent).pointerType === "touch";
                setOpenMenu((current) => touch && current === item.label ? null : item.label);
              }}
            >
              <Icon name={item.icon} className={hrNavIconClass(active)} />
              <span>{item.label}</span>
              <Icon name="chevronDown" className={hrNavChevronClass(open)} />
            </button> : <GuardedNavLink
              to={item.to}
              end={item.to === "/hr"}
              className={hrNavLinkClass({ active, open })}
              onClick={() => setOpenMenu(null)}
            >
              <Icon name={item.icon} className={hrNavIconClass(active)} />
              <span>{item.label}</span>
            </GuardedNavLink>}
            {hasChildren ? <div id={submenuId} className={hrSubmenuClass(open)} role="menu" aria-label={`${item.label}子選單`} aria-hidden={!open}>
              {item.children.map((child) => <GuardedNavLink
                key={child.to}
                to={child.to}
                className={hrMenuItemClass({ active: isActiveChild(item.children, child, pathname) })}
                end={child.end ?? true}
                role="menuitem"
                onClick={() => setOpenMenu(null)}
              >
                <Icon name={child.icon} />
                <span>{child.label}</span>
              </GuardedNavLink>)}
            </div> : null}
          </HrNavItem>;
        })}
      </HrNav>
      {/* 頭像也在頁首裡，useDismiss 不會把它當成點外面；打開帳號選單時自己把導覽面板收掉，兩塊才不會疊在一起。 */}
      <HrUserMenu onOpen={() => setMobileNavOpen(false)} />
    </HrHeader>

    <HrMain>
      <HrPageTransition><Outlet /></HrPageTransition>
    </HrMain>
  </div></HrSkins>;
}

export function HrLanding() {
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.isHrAdministrator ?? false;
  const target = permissions.has("hr:employee:read") ? "/hr/employees" : permissions.has("hr:office:read") ? "/hr/attendance-records" : permissions.has("hr:schedule:read") ? "/hr/scheduling" : permissions.has("hr:request:review") ? "/hr/requests" : isHrAdministrator && permissions.has("hr:payroll:read") ? "/hr/compensation" : isHrAdministrator && permissions.has("hr:bonus:read") ? "/hr/bonus" : "/";
  if (isHrAdministrator && OVERVIEW_PERMISSIONS.some((permission) => permissions.has(permission))) return <HrOverview />;
  return <Navigate to={target} replace />;
}
