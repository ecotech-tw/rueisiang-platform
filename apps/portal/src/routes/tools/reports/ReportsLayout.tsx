import type { Permission } from "@rueisiang/auth/permissions";
import type { IconName } from "../../../shell/icons.js";
import type { ReportRunKind } from "../api.js";
import { Navigate, Outlet } from "react-router";
import { useSession } from "../../../auth/session.js";
import { PageTabs } from "../../../ui/index.js";

interface ReportRunTab {
  label: string;
  to: string;
  permissions: readonly Permission[];
  icon: IconName;
  kinds: readonly { kind: ReportRunKind; permission: Permission }[];
}

const RUN_TABS: readonly ReportRunTab[] = [
  { label: "出金表", to: "/tools/reports/run/cyberbiz-payout", permissions: ["tools:payout:run"], icon: "payments", kinds: [{ kind: "cyberbiz-payout", permission: "tools:payout:run" }] },
  { label: "商品銷售", to: "/tools/reports/run/cyberbiz-sales", permissions: ["tools:cyberbiz-sales:run"], icon: "report", kinds: [{ kind: "cyberbiz-sales", permission: "tools:cyberbiz-sales:run" }] },
  { label: "官網對帳單", to: "/tools/reports/run/cyberbiz-shop", permissions: ["tools:shop-report:run"], icon: "globe", kinds: [{ kind: "cyberbiz-shop", permission: "tools:shop-report:run" }] },
  { label: "上傳報表", to: "/tools/reports/run/upload", permissions: ["tools:shopee-sales:run", "tools:momo-report:run"], icon: "attachment", kinds: [{ kind: "shopee", permission: "tools:shopee-sales:run" }, { kind: "momo-sales", permission: "tools:momo-report:run" }] },
];

const LOG_TAB = { label: "執行紀錄", to: "/tools/reports/log", icon: "history" as IconName };

export function useReportTabs() {
  const { permissions } = useSession();
  const runTabs = RUN_TABS.filter((tab) => tab.permissions.some((permission) => permissions.has(permission)));
  const runKinds = [...new Set(runTabs.flatMap((tab) => tab.kinds.filter(({ permission }) => permissions.has(permission)).map(({ kind }) => kind)))];
  return { runTabs, runKinds, tabs: runTabs.length ? [...runTabs, LOG_TAB] : [] };
}

export function ReportsLayout() {
  const { tabs } = useReportTabs();
  /*
   * 這一層刻意不是 Page：子頁面自己已經是 Page，再包一層的話外層殼看到 fills 就把捲動關掉，
   * 外層不捲、內層又不是捲動區，內容超出視窗就直接被裁掉。由子頁面決定要不要 fills，這一層只負責讓它撐得開。
   */
  return (
    <div className="flex w-full min-w-0 min-h-0 flex-col gap-5 min-[761px]:has-[[data-page=fills]]:h-full min-[761px]:has-[[data-page=fills]]:overflow-hidden [&>[data-page]]:w-full [&>[data-page=fills]]:h-auto min-[761px]:[&>[data-page=fills]]:flex-[1_1_auto] min-[761px]:[&>[data-page=fills]]:overflow-hidden">
      <PageTabs label="報表執行" tabs={tabs} />
      <Outlet />
    </div>
  );
}

export function ReportsLanding() {
  const { runTabs } = useReportTabs();
  return <Navigate to={runTabs[0]?.to ?? "/"} replace />;
}
