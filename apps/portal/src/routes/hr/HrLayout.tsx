import { NavLink, Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "../../auth/session.js";
import type { Permission } from "@rueisiang/auth/permissions";
import { PageTabs } from "../../ui/index.js";

/** platform 只承載 HR 管理功能；員工本人入口在 hr.rueisiang.com。 */
const HR_DOMAINS = [
  { label: "員工管理", to: "/hr/employees", paths: ["/hr/employees"], permission: "hr:employee:read" as const },
  { label: "出勤管理", to: "/hr/attendance-records", paths: ["/hr/attendance-records", "/hr/attendance-settings", "/hr/special-workdays", "/hr/overtime"], permission: ["hr:office:read", "hr:request:review"] as const },
  { label: "排班管理", to: "/hr/scheduling", paths: ["/hr/scheduling"], permission: "hr:schedule:read" as const },
  { label: "敘薪與獎金", to: "/hr/compensation", paths: ["/hr/compensation", "/hr/bonus", "/hr/payroll-settlement", "/hr/monthly-data"], permission: "hr:payroll:read" as const },
] as const;

const PAYROLL_TABS = [
  { label: "敘薪管理", to: "/hr/compensation", permission: "hr:payroll:read" as const, icon: "payments" as const, adminOnly: true },
  { label: "獎金管理", to: "/hr/bonus", permission: "hr:bonus:read" as const, icon: "tag" as const, adminOnly: true },
  { label: "薪資結算", to: "/hr/payroll-settlement", permission: "hr:payroll:read" as const, icon: "report" as const, adminOnly: true },
  { label: "月度資料登記", to: "/hr/monthly-data", permission: "hr:payroll:read" as const, icon: "edit" as const, adminOnly: true },
];

const ATTENDANCE_TABS = [
  { label: "出勤紀錄", to: "/hr/attendance-records", permission: "hr:office:read" as const, icon: "calendar" as const, adminOnly: false },
  { label: "出勤設定", to: "/hr/attendance-settings", permission: "hr:office:read" as const, icon: "tune" as const, adminOnly: false },
  { label: "特殊上班日", to: "/hr/special-workdays", permission: "hr:office:read" as const, icon: "calendar" as const, adminOnly: false },
  { label: "加班審核", to: "/hr/overtime", permission: "hr:request:review" as const, icon: "calendar" as const, adminOnly: false },
];

function pathMatches(pathname: string, paths: readonly string[]) {
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}
function canAccessDomain(permissions: ReadonlySet<Permission>, permission: Permission | readonly Permission[]) {
  return typeof permission === "string" ? permissions.has(permission) : permission.some((item) => permissions.has(item));
}

export function HrLayout() {
  const pathname = useLocation().pathname;
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.roles.includes("admin") ?? false;
  const currentDomain = HR_DOMAINS.find((domain) => pathMatches(pathname, domain.paths)) ?? HR_DOMAINS[0];
  const visibleDomains = HR_DOMAINS.filter((domain) => canAccessDomain(permissions, domain.permission));
  const isAttendance = currentDomain.label === "出勤管理";
  const isPayroll = currentDomain.label === "敘薪與獎金";
  const tabs = isAttendance ? ATTENDANCE_TABS : isPayroll ? PAYROLL_TABS : [];
  const visibleTabs = tabs.filter((tab) => permissions.has(tab.permission) && (!tab.adminOnly || isHrAdministrator));

  return <div className="hr-module">
    <header className="hr-module-header">
      <div className="hr-module-title"><span className="hr-module-kicker">HRIS</span><span className="hr-module-current">{currentDomain.label}</span></div>
      <nav className="hr-domain-nav" aria-label="HRIS 工作領域">
        {visibleDomains.map((domain) => <NavLink key={domain.to} to={domain.to} className={`hr-domain-tab${pathMatches(pathname, domain.paths) ? " active" : ""}`}>{domain.label}</NavLink>)}
      </nav>
    </header>
    {visibleTabs.length ? <div className="hr-module-subnav"><PageTabs label={`${currentDomain.label}子頁面`} tabs={visibleTabs} /></div> : null}
    <Outlet />
  </div>;
}

export function HrLanding() {
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.roles.includes("admin") ?? false;
  const target = permissions.has("hr:employee:read") ? "/hr/employees" : permissions.has("hr:office:read") ? "/hr/attendance-settings" : isHrAdministrator && permissions.has("hr:payroll:read") ? "/hr/compensation" : isHrAdministrator && permissions.has("hr:bonus:read") ? "/hr/bonus" : "/";
  return <Navigate to={target} replace />;
}
