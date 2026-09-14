import { Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "../../auth/session.js";
import { PageTabs } from "../../ui/index.js";
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

export function HrLayout() {
  const pathname = useLocation().pathname;
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.roles.includes("admin") ?? false;
  // Sidebar 的 HRIS 子項已經是第一層；這裡只顯示目前領域的第二層頁籤，避免同一份 sitemap 畫兩次。
  const isEmployee = pathname.includes("/employees") || pathname.includes("/insurance");
  const isAttendance = pathname.includes("/attendance-settings") || pathname.includes("/attendance-records") || pathname.includes("/special-workdays") || pathname.includes("/overtime");
  const isScheduling = pathname.includes("/scheduling");
  const isPayroll = pathname.includes("/compensation") || pathname.includes("/bonus") || pathname.includes("/payroll-settlement") || pathname.includes("/monthly-data") || pathname.includes("/payroll-settings");
  const isOverview = pathname === "/hr" || pathname === "/hr/";
  const current = isOverview ? "概覽" : isEmployee ? "員工管理" : isAttendance ? "出勤管理" : isScheduling ? "排班管理" : isPayroll ? "敘薪與獎金" : "員工管理";
  const tabs = isEmployee ? EMPLOYEE_TABS : isAttendance ? ATTENDANCE_TABS : isScheduling ? SCHEDULING_TABS : isPayroll ? PAYROLL_TABS : [];
  const visibleTabs = tabs.filter((tab) => permissions.has(tab.permission) && (!tab.adminOnly || isHrAdministrator));

  return <div className="hr-module">
    <header className="hr-module-header">
      <div className="hr-module-title"><span className="hr-module-kicker">HRIS</span><span className="hr-module-current">{current}</span></div>
    </header>
    {visibleTabs.length ? <div className="hr-module-subnav"><PageTabs label={`${current}子頁面`} tabs={visibleTabs} /></div> : null}
    <Outlet />
  </div>;
}

export function HrLanding() {
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.roles.includes("admin") ?? false;
  const target = permissions.has("hr:employee:read") ? "/hr/employees" : permissions.has("hr:office:read") ? "/hr/attendance-settings" : isHrAdministrator && permissions.has("hr:payroll:read") ? "/hr/compensation" : isHrAdministrator && permissions.has("hr:bonus:read") ? "/hr/bonus" : "/";
  if (isHrAdministrator && (["hr:employee:read", "hr:office:read", "hr:schedule:read", "hr:payroll:read", "hr:bonus:read"] as const).some((permission) => permissions.has(permission))) return <HrOverview />;
  return <Navigate to={target} replace />;
}
