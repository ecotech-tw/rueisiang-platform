import type { Permission } from "@rueisiang/auth/permissions";
import { NavLink, useNavigate } from "react-router";
import { navigateAcrossHr } from "./hr-transition.js";
import { useGuardedClick } from "./UnsavedChanges.js";
import { Icon } from "./icons.js";

const HR_ACCESS_PERMISSIONS: Permission[] = [
  "hr:employee:read",
  "hr:office:read",
  "hr:schedule:read",
  "hr:payroll:read",
  "hr:bonus:read",
];

interface SystemSwitcherProps {
  permissions: ReadonlySet<Permission>;
  onNavigate: () => void;
}

/** 平台左下角的一鍵 HRIS 入口；HRIS 不再佔用一般平台導覽的主要位置。 */
export function SystemSwitcher({ permissions, onNavigate }: SystemSwitcherProps) {
  const navigate = useNavigate();
  const guardedClick = useGuardedClick();
  const canAccessHr = HR_ACCESS_PERMISSIONS.some((permission) => permissions.has(permission));

  if (!canAccessHr) return null;

  return (
    <NavLink
      end
      to="/hr"
      className="system-switcher-trigger"
      title="切換到 HRIS"
      onClick={(event) => guardedClick(event, "/hr", () => {
        onNavigate();
        navigateAcrossHr(event, navigate, "/hr");
      })}
    >
      <span className="system-switcher-icon" aria-hidden="true"><Icon name="people" /></span>
      <span className="system-switcher-copy">
        <strong>HRIS</strong>
        <small>人資管理系統</small>
      </span>
    </NavLink>
  );
}
