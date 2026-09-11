import { NavLink, Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "../../auth/session.js";

/** platform 只承載 HR 管理功能；員工本人入口在 hr.rueisiang.com。 */
const HR_TABS = [
  { label: "月曆排班", to: "/hr/scheduling", permission: "hr:schedule:read" as const },
  { label: "敘薪管理", to: "/hr/compensation", permission: "hr:payroll:read" as const, adminOnly: true },
  { label: "獎金管理", to: "/hr/bonus", permission: "hr:bonus:read" as const, adminOnly: true },
  { label: "薪資結算", to: "/hr/payroll-settlement", permission: "hr:payroll:read" as const, adminOnly: true },
];

const ATTENDANCE_TABS = [
  { label: "出勤紀錄", to: "/hr/attendance-records", permission: "hr:office:read" as const, adminOnly: false },
  { label: "出勤設定", to: "/hr/attendance-settings", permission: "hr:office:read" as const, adminOnly: false },
];

export function HrLayout() {
  const pathname = useLocation().pathname;
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.roles.includes("admin") ?? false;
  const isAttendance = pathname.includes("/attendance-settings") || pathname.includes("/attendance-records");
  const current = isAttendance ? "出勤管理" : pathname.includes("/scheduling") ? "月曆排班" : pathname.includes("/payroll-settlement") ? "薪資結算" : pathname.includes("/bonus") ? "獎金管理" : pathname.includes("/compensation") ? "敘薪管理" : "員工管理";
  const tabs = isAttendance ? ATTENDANCE_TABS : HR_TABS;

  return <div className="hr-module">
    <header className="hr-module-header">
      <div className="hr-module-title"><span className="hr-module-current">{current}</span></div>
      <nav className="hr-module-tabs" aria-label={isAttendance ? "出勤管理子頁面" : "HRIS 子頁面"}>
        {tabs.filter((tab) => permissions.has(tab.permission) && (!tab.adminOnly || isHrAdministrator)).map((tab) => <NavLink key={tab.to} to={tab.to} end className={({ isActive }) => `hr-module-tab${isActive ? " active" : ""}`}>{tab.label}</NavLink>)}
      </nav>
    </header>
    <Outlet />
  </div>;
}

export function HrLanding() {
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.roles.includes("admin") ?? false;
  const target = permissions.has("hr:employee:read") ? "/hr/employees" : permissions.has("hr:office:read") ? "/hr/attendance-settings" : isHrAdministrator && permissions.has("hr:payroll:read") ? "/hr/compensation" : isHrAdministrator && permissions.has("hr:bonus:read") ? "/hr/bonus" : "/";
  return <Navigate to={target} replace />;
}
