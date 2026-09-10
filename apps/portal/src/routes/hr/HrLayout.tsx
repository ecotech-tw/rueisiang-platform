import { NavLink, Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "../../auth/session.js";

/** platform 只承載 HR 管理功能；員工本人入口在 hr.rueisiang.com。 */
const HR_TABS = [
  { label: "敘薪管理", to: "/hr/compensation", permission: "hr:payroll:read" as const },
  { label: "獎金管理", to: "/hr/bonus", permission: "hr:bonus:read" as const },
  { label: "薪資結算", to: "/hr/payroll-settlement", permission: "hr:payroll:read" as const },
];

export function HrLayout() {
  const pathname = useLocation().pathname;
  const { permissions } = useSession();
  const current = pathname.includes("/attendance-settings") ? "出勤設定" : pathname.includes("/payroll-settlement") ? "薪資結算" : pathname.includes("/bonus") ? "獎金管理" : pathname.includes("/compensation") ? "敘薪管理" : "員工管理";

  return <div className="hr-module">
    <header className="hr-module-header">
      <div className="hr-module-title"><span className="hr-module-current">{current}</span></div>
      <nav className="hr-module-tabs" aria-label="HRIS 子頁面">
        {HR_TABS.filter((tab) => permissions.has(tab.permission)).map((tab) => <NavLink key={tab.to} to={tab.to} end className={({ isActive }) => `hr-module-tab${isActive ? " active" : ""}`}>{tab.label}</NavLink>)}
      </nav>
    </header>
    <Outlet />
  </div>;
}

export function HrLanding() {
  const { permissions } = useSession();
  const target = permissions.has("hr:employee:read") ? "/hr/employees" : permissions.has("hr:office:read") ? "/hr/attendance-settings" : permissions.has("hr:payroll:read") ? "/hr/compensation" : permissions.has("hr:bonus:read") ? "/hr/bonus" : "/";
  return <Navigate to={target} replace />;
}
