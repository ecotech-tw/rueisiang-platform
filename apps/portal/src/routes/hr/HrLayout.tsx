import { Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "../../auth/session.js";
import { PageTabs } from "../../ui/index.js";

/** platform 只承載 HR 管理功能；員工本人入口在 hr.rueisiang.com。 */
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

export function HrLayout() {
  const pathname = useLocation().pathname;
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.roles.includes("admin") ?? false;
  // Sidebar 的 HRIS 子項已經是第一層；這裡只顯示目前領域的第二層頁籤，避免同一份 sitemap 畫兩次。
  const isAttendance = pathname.includes("/attendance-settings") || pathname.includes("/attendance-records") || pathname.includes("/special-workdays") || pathname.includes("/overtime");
  const isScheduling = pathname.includes("/scheduling");
  const isPayroll = pathname.includes("/compensation") || pathname.includes("/bonus") || pathname.includes("/payroll-settlement") || pathname.includes("/monthly-data");
  const current = isAttendance ? "出勤管理" : isScheduling ? "排班管理" : isPayroll ? "敘薪與獎金" : "員工管理";
  const tabs = isAttendance ? ATTENDANCE_TABS : isPayroll ? PAYROLL_TABS : [];
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
  return <Navigate to={target} replace />;
}
