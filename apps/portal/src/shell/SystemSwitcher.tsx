import type { Permission } from "@rueisiang/auth/permissions";
import { NavLink, useNavigate } from "react-router";
import { navigateAcrossSystem } from "./system-transition.js";
import { useGuardedClick } from "./UnsavedChanges.js";
import { Icon, type IconName } from "./icons.js";

interface SystemEntry {
  to: string;
  title: string;
  subtitle: string;
  icon: IconName;
  /** 有其中任何一個權限就看得到入口；真正的把關在 API。 */
  permissions: Permission[];
}

/*
 * 平台裡的獨立系統。它們的使用者與節奏跟平台側欄的模組不一樣（見 docs/platform-navigation.md 第 4 節），
 * 所以不佔側欄的大項，收在左下角各一張入口卡。
 */
const SYSTEMS: SystemEntry[] = [
  {
    to: "/hr",
    title: "HRIS",
    subtitle: "人資管理系統",
    icon: "people",
    permissions: ["hr:employee:read", "hr:office:read", "hr:schedule:read", "hr:payroll:read", "hr:bonus:read"],
  },
  {
    to: "/accounting",
    title: "會計",
    subtitle: "報帳審核與支出",
    icon: "payments",
    permissions: ["accounting:expense:read", "accounting:expense:review", "accounting:expense:write", "accounting:category:write", "accounting:petty-cash:write"],
  },
];

interface SystemSwitcherProps {
  permissions: ReadonlySet<Permission>;
  collapsed: boolean;
  onNavigate: () => void;
}

/** 平台左下角的系統入口；每個系統一張卡，沒有權限的系統不顯示。 */
export function SystemSwitcher({ permissions, collapsed, onNavigate }: SystemSwitcherProps) {
  const navigate = useNavigate();
  const guardedClick = useGuardedClick();
  const systems = SYSTEMS.filter((system) => system.permissions.some((permission) => permissions.has(permission)));
  if (!systems.length) return null;

  return <div className="grid gap-2">
    {systems.map((system) => <NavLink
      key={system.to}
      end
      to={system.to}
      className={`grid min-h-[58px] w-full min-w-0 grid-cols-[36px_minmax(0,1fr)] items-center gap-[9px] rounded-card border border-info/18 bg-info-soft px-2.5 py-[9px] text-left text-ink no-underline [box-shadow:0_1px_0_--alpha(var(--color-paper)/78%)_inset,0_8px_18px_--alpha(var(--color-info)/7%)] transition-[background-color,border-color,box-shadow,scale] duration-150 ease-out hover:border-info/34 hover:bg-info/10 hover:[box-shadow:0_1px_0_--alpha(var(--color-paper)/82%)_inset,0_10px_22px_--alpha(var(--color-info)/11%)] active:scale-96 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info ${collapsed ? "min-[900px]:flex min-[900px]:justify-center min-[900px]:gap-0 min-[900px]:p-1.5" : ""}`}
      title={`切換到${system.title}`}
      onClick={(event) => guardedClick(event, system.to, () => {
        onNavigate();
        navigateAcrossSystem(event, navigate, system.to);
      })}
    >
      <span className="grid size-[34px] place-items-center rounded-[10px] bg-paper text-info [box-shadow:0_1px_0_--alpha(var(--color-paper)/72%)_inset,0_3px_8px_--alpha(var(--color-info)/8%)]" aria-hidden="true"><Icon name={system.icon} className="size-5" /></span>
      <span className={`grid min-w-0 gap-px ${collapsed ? "min-[900px]:hidden" : ""}`}>
        <strong className="truncate text-[12px]">{system.title}</strong>
        <small className="truncate text-[10px] text-muted">{system.subtitle}</small>
      </span>
    </NavLink>)}
  </div>;
}
