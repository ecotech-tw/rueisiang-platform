import { Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "../../auth/session.js";

/** platform 只承載 HR 管理功能；員工本人入口在 hr.rueisiang.com。 */
export function HrLayout() {
  const pathname = useLocation().pathname;
  const current = pathname.includes("/attendance-settings")
    ? "出勤設定"
    : pathname.includes("/management-scopes")
      ? "範圍授權"
      : pathname.includes("/audit")
        ? "稽核紀錄"
        : "員工管理";

  return <div className="hr-module">
    <header className="hr-module-header">
      <div className="hr-module-title"><span className="hr-module-current">{current}</span></div>
    </header>
    <Outlet />
  </div>;
}

export function HrLanding() {
  const { permissions } = useSession();
  const target = permissions.has("hr:employee:read") ? "/hr/employees" : permissions.has("hr:office:read") ? "/hr/attendance-settings" : "/";
  return <Navigate to={target} replace />;
}
