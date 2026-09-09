import type { Permission } from "@rueisiang/auth/permissions";
import { Navigate, NavLink, Outlet } from "react-router";
import { useSession } from "../../auth/session.js";

interface HrModuleItem {
  label: string;
  to: string;
  permission?: Permission;
}

const selfItems: HrModuleItem[] = [
  { label: "我的 HR 資料", to: "/hr/me" },
];

const managementItems: HrModuleItem[] = [
  { label: "員工管理", to: "/hr/employees", permission: "hr:employee:read" },
];

function ModuleLink({ item }: { item: HrModuleItem }) {
  return (
    <NavLink
      to={item.to}
      end
      className={({ isActive }) => `hr-module-link${isActive ? " active" : ""}`}
    >
      {item.label}
    </NavLink>
  );
}

/** HRIS 內層導覽只分組，不把員工入口混進管理者的 Sidebar。 */
export function HrLayout() {
  const { user, permissions } = useSession();
  const visibleManagementItems = managementItems.filter((item) => !item.permission || permissions.has(item.permission));

  return (
    <div className="hr-module">
      <header className="hr-module-header">
        <div className="hr-module-title">
          <span className="hr-module-kicker">RUEI SIANG</span>
          <strong>HRIS</strong>
        </div>
        <nav className="hr-module-nav" aria-label="HRIS 導覽">
          {user?.isEmployee ? (
            <div className="hr-module-group">
              <span className="hr-module-group-label">我的</span>
              {selfItems.map((item) => <ModuleLink key={item.to} item={item} />)}
            </div>
          ) : null}
          {visibleManagementItems.length ? (
            <div className="hr-module-group">
              <span className="hr-module-group-label">管理</span>
              {visibleManagementItems.map((item) => <ModuleLink key={item.to} item={item} />)}
            </div>
          ) : null}
        </nav>
      </header>
      <Outlet />
    </div>
  );
}

export function HrLanding() {
  const { user, permissions } = useSession();
  const target = permissions.has("hr:employee:read") ? "/hr/employees" : user?.isEmployee ? "/hr/me" : "/";
  return <Navigate to={target} replace />;
}
