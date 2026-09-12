import type { Permission } from "@rueisiang/auth/permissions";
import type { IconName } from "../../../shell/icons.js";
import type { ReportRunKind } from "../api.js";
import { Navigate, Outlet } from "react-router";
import { useSession } from "../../../auth/session.js";
import { PageTabs } from "../../../ui/index.js";

/**
 * 報表執行。四種報表以前是四個 nav 項目，但它們做的是同一件事——挑條件、觸發
 * GitHub workflow、看進度——而且執行紀錄本來就都寫在同一張 report_runs。
 *
 * 分頁只顯示看得到的那幾個。這純粹是外觀：真正的把關在每一條 API 路由上。
 */
const RUN_TABS: Array<{ label: string; to: string; permission: Permission; icon: IconName; kind: ReportRunKind }> = [
  { label: "出金表", to: "/tools/reports/run/cyberbiz-payout", permission: "tools:payout:run", icon: "payments", kind: "cyberbiz-payout" },
  { label: "商品銷售", to: "/tools/reports/run/cyberbiz-sales", permission: "tools:cyberbiz-sales:run", icon: "report", kind: "cyberbiz-sales" },
  { label: "官網對帳單", to: "/tools/reports/run/cyberbiz-shop", permission: "tools:shop-report:run", icon: "globe", kind: "cyberbiz-shop" },
  { label: "蝦皮", to: "/tools/reports/run/shopee", permission: "tools:shopee-sales:run", icon: "shoppingBag", kind: "shopee" },
];

const LOG_TAB = { label: "執行紀錄", to: "/tools/reports/log", icon: "history" as IconName };

export function useReportTabs() {
  const { permissions } = useSession();
  const runTabs = RUN_TABS.filter((tab) => permissions.has(tab.permission));
  return { runTabs, tabs: runTabs.length ? [...runTabs, LOG_TAB] : [] };
}

export function ReportsLayout() {
  const { tabs } = useReportTabs();
  return (
    <div className="page-tabs-layout">
      <PageTabs label="報表執行" tabs={tabs} />
      <Outlet />
    </div>
  );
}

/**
 * `/tools/reports` 自己不是一個畫面，導去第一個有權限的分頁。
 *
 * 一個權限都沒有的人不會從 sidebar 看到這一區，但網址是打得進來的——導回首頁，
 * 不要留一個空殼子讓人以為壞了。
 */
export function ReportsLanding() {
  const { runTabs } = useReportTabs();
  return <Navigate to={runTabs[0]?.to ?? "/"} replace />;
}
