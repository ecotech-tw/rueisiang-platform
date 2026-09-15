import type { Permission } from "@rueisiang/auth/permissions";
import { useState } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation } from "react-router";
import { useSession } from "../../auth/session.js";
import { Icon, type IconName } from "../../shell/icons.js";
import { HrOverview } from "./Overview.js";

/** platform 只承載 HR 管理功能；員工本人入口在 hr.rueisiang.com。 */
const EMPLOYEE_TABS = [
  { label: "員工列表", to: "/hr/employees", permission: "hr:employee:read" as const, icon: "list" as const, adminOnly: false, activePaths: ["/hr/employees"] },
  { label: "勞健保管理", to: "/hr/insurance", permission: "hr:employee:read" as const, icon: "payments" as const, adminOnly: true },
];

const ATTENDANCE_TABS = [
  { label: "出勤紀錄", to: "/hr/attendance-records", permission: "hr:office:read" as const, icon: "calendar" as const, adminOnly: false },
  { label: "出勤設定", to: "/hr/attendance-settings", permission: "hr:office:read" as const, icon: "tune" as const, adminOnly: false, activePaths: ["/hr/overtime"] },
  { label: "特殊上班日", to: "/hr/special-workdays", permission: "hr:office:read" as const, icon: "calendar" as const, adminOnly: false },
];

const SCHEDULING_TABS = [
  { label: "排班月曆", to: "/hr/scheduling", permission: "hr:schedule:read" as const, icon: "calendar" as const, adminOnly: false },
  { label: "辦公地點指派", to: "/hr/scheduling/locations", permission: "hr:office:read" as const, icon: "storefront" as const, adminOnly: false },
];

const PAYROLL_TABS = [
  { label: "敘薪管理", to: "/hr/compensation", permission: "hr:payroll:read" as const, icon: "payments" as const, adminOnly: true },
  { label: "獎金管理", to: "/hr/bonus", permission: "hr:bonus:read" as const, icon: "tag" as const, adminOnly: true },
  { label: "制度設定", to: "/hr/payroll-settings", permission: "hr:payroll:read" as const, icon: "tune" as const, adminOnly: true },
  { label: "薪資結算", to: "/hr/payroll-settlement", permission: "hr:payroll:read" as const, icon: "report" as const, adminOnly: true, activePaths: ["/hr/monthly-data"] },
];

const OVERVIEW_PERMISSIONS: Permission[] = ["hr:employee:read", "hr:office:read", "hr:schedule:read", "hr:payroll:read", "hr:bonus:read"];

type HrNavChild = {
  label: string;
  to: string;
  icon: IconName;
  permission: Permission;
  adminOnly?: boolean;
  activePaths?: string[];
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
  { label: "員工", to: "/hr/employees", icon: "list", permissions: ["hr:employee:read"], activePaths: ["/hr/employees", "/hr/insurance"], children: EMPLOYEE_TABS },
  { label: "出勤", to: "/hr/attendance-records", icon: "clock", permissions: ["hr:office:read"], activePaths: ["/hr/attendance-records", "/hr/attendance-settings", "/hr/special-workdays", "/hr/overtime"], children: ATTENDANCE_TABS },
  { label: "排班", to: "/hr/scheduling", icon: "calendar", permissions: ["hr:schedule:read", "hr:office:read"], activePaths: ["/hr/scheduling"], children: SCHEDULING_TABS },
  { label: "薪資獎金", to: "/hr/compensation", icon: "payments", permissions: ["hr:payroll:read", "hr:bonus:read"], adminOnly: true, activePaths: ["/hr/compensation", "/hr/bonus", "/hr/payroll-settings", "/hr/payroll-settlement", "/hr/monthly-data"], children: PAYROLL_TABS },
];

function isActive(paths: string[], pathname: string) {
  return paths.some((path) => pathname === path || (path !== "/hr" && pathname.startsWith(`${path}/`)));
}

function visibleChildren(children: HrNavChild[] | undefined, permissions: ReadonlySet<Permission>, isHrAdministrator: boolean) {
  return (children ?? []).filter((child) => permissions.has(child.permission) && (!child.adminOnly || isHrAdministrator));
}

export function HrLayout() {
  const pathname = useLocation().pathname;
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.isHrAdministrator ?? false;
  // HRIS 是一套獨立管理系統：進到 /hr 後不再借用平台側欄，避免 CRM/WMS 導覽干擾人資流程。
  const isEmployee = pathname.includes("/employees") || pathname.includes("/insurance");
  const isAttendance = pathname.includes("/attendance-settings") || pathname.includes("/attendance-records") || pathname.includes("/special-workdays") || pathname.includes("/overtime");
  const isScheduling = pathname.includes("/scheduling");
  const isPayroll = pathname.includes("/compensation") || pathname.includes("/bonus") || pathname.includes("/payroll-settlement") || pathname.includes("/monthly-data") || pathname.includes("/payroll-settings");
  const isOverview = pathname === "/hr" || pathname === "/hr/";
  const current = isOverview ? "儀表板" : isEmployee ? "員工管理" : isAttendance ? "出勤管理" : isScheduling ? "排班管理" : isPayroll ? "敘薪與獎金" : "員工管理";
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const visiblePrimaryNav = HR_PRIMARY_NAV
    .map((item) => {
      const children = visibleChildren(item.children, permissions, isHrAdministrator);
      const fallbackTo = children[0]?.to ?? item.to;
      return { ...item, to: fallbackTo, children };
    })
    .filter((item) => (item.permissions.some((permission) => permissions.has(permission)) || item.children.length > 0) && (!item.adminOnly || isHrAdministrator));

  return <div className="hr-module hr-system">
    <svg className="hr-liquid-defs" aria-hidden="true" focusable="false">
      <filter id="hr-liquid-glass-soft" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.018 0.024" numOctaves="2" seed="7" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="4" xChannelSelector="R" yChannelSelector="G" />
      </filter>
      <filter id="hr-liquid-glass-menu" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.014 0.02" numOctaves="2" seed="11" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="7" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
    <header className="hr-system-header">
      <div className="hr-system-brand">
        <img src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" width={150} height={38} />
        <span>HRIS</span>
        <strong>{current}</strong>
      </div>
      <nav className="hr-system-nav" aria-label="HRIS 主要導覽">
        {visiblePrimaryNav.map((item) => {
          const active = isActive(item.activePaths ?? [item.to], pathname);
          const open = openMenu === item.label;
          return <div
            className={`hr-system-nav-item${active ? " active" : ""}${open ? " open" : ""}`}
            key={item.label}
            onMouseEnter={() => setOpenMenu(item.label)}
            onMouseLeave={() => setOpenMenu((current) => current === item.label ? null : current)}
            onFocus={() => setOpenMenu(item.label)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setOpenMenu((current) => current === item.label ? null : current);
            }}
          >
            <NavLink
              to={item.to}
              end={item.to === "/hr"}
              className="hr-system-nav-link"
              onClick={() => setOpenMenu(null)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.children.length ? <Icon name="chevronDown" className="hr-system-nav-chevron" /> : null}
            </NavLink>
            {item.children.length ? <div className="hr-system-submenu" role="menu" aria-label={`${item.label}子選單`}>
              {item.children.map((child) => <NavLink
                key={child.to}
                to={child.to}
                className={() => `hr-system-submenu-link${isActive(child.activePaths ?? [child.to], pathname) ? " active" : ""}`}
                role="menuitem"
                onClick={() => setOpenMenu(null)}
              >
                <Icon name={child.icon} />
                <span>{child.label}</span>
              </NavLink>)}
            </div> : null}
          </div>;
        })}
      </nav>
      <Link className="hr-system-platform-link" to="/"><Icon name="chevronLeft" />返回平台</Link>
    </header>

    <div className="hr-system-main">
      <Outlet />
    </div>
  </div>;
}

export function HrLanding() {
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.isHrAdministrator ?? false;
  const target = permissions.has("hr:employee:read") ? "/hr/employees" : permissions.has("hr:office:read") ? "/hr/attendance-records" : permissions.has("hr:schedule:read") ? "/hr/scheduling" : isHrAdministrator && permissions.has("hr:payroll:read") ? "/hr/compensation" : isHrAdministrator && permissions.has("hr:bonus:read") ? "/hr/bonus" : "/";
  if (isHrAdministrator && OVERVIEW_PERMISSIONS.some((permission) => permissions.has(permission))) return <HrOverview />;
  return <Navigate to={target} replace />;
}
