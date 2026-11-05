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
  collapsed: boolean;
  onNavigate: () => void;
}

/** 平台左下角的一鍵 HRIS 入口；HRIS 不再佔用一般平台導覽的主要位置。 */
export function SystemSwitcher({ permissions, collapsed, onNavigate }: SystemSwitcherProps) {
  const navigate = useNavigate();
  const guardedClick = useGuardedClick();
  const canAccessHr = HR_ACCESS_PERMISSIONS.some((permission) => permissions.has(permission));

  if (!canAccessHr) return null;

  return (
    <NavLink
      end
      to="/hr"
      className={`grid min-h-[58px] w-full min-w-0 grid-cols-[36px_minmax(0,1fr)] items-center gap-[9px] rounded-card border border-info/18 bg-info-soft px-2.5 py-[9px] text-left text-ink no-underline [box-shadow:0_1px_0_--alpha(var(--color-paper)/78%)_inset,0_8px_18px_--alpha(var(--color-info)/7%)] transition-[background-color,border-color,box-shadow,scale] duration-150 ease-out hover:border-info/34 hover:bg-info/10 hover:[box-shadow:0_1px_0_--alpha(var(--color-paper)/82%)_inset,0_10px_22px_--alpha(var(--color-info)/11%)] active:scale-96 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info ${collapsed ? "min-[901px]:flex min-[901px]:justify-center min-[901px]:gap-0 min-[901px]:p-1.5" : ""}`}
      title="切換到 HRIS"
      onClick={(event) => guardedClick(event, "/hr", () => {
        onNavigate();
        navigateAcrossHr(event, navigate, "/hr");
      })}
    >
      <span className="grid size-[34px] place-items-center rounded-[10px] bg-paper text-info [box-shadow:0_1px_0_--alpha(var(--color-paper)/72%)_inset,0_3px_8px_--alpha(var(--color-info)/8%)]" aria-hidden="true"><Icon name="people" className="size-5" /></span>
      <span className={`grid min-w-0 gap-px ${collapsed ? "min-[901px]:hidden" : ""}`}>
        <strong className="truncate text-[12px]">HRIS</strong>
        <small className="truncate text-[10px] text-muted">人資管理系統</small>
      </span>
    </NavLink>
  );
}
