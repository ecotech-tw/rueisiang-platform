import type { Permission } from "@rueisiang/auth/permissions";
import { Link } from "react-router";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Icon, type IconName } from "../../shell/icons.js";
import { Alert, EmptyState, FormHint, Page, PageHeader, StatusBadge } from "../../ui/index.js";
import { useHrQuery, type HrOverview } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

const OVERVIEW_PERMISSIONS: Permission[] = ["hr:employee:read", "hr:office:read", "hr:schedule:read", "hr:payroll:read", "hr:bonus:read"];
const PAYROLL_STATUS: Record<HrOverview["payroll"]["status"], string> = {
  not_started: "尚未試算", calculating: "計算中", ready: "待覆核", approved: "已核准", closed: "已結帳", failed: "計算失敗",
};

type OverviewTone = "warning" | "success" | "info";

// 概覽卡跟玻璃面板（Panel 的 glass）是同一塊玻璃，數值共用 theme 裡的 token。
const CARD = "group relative isolate grid min-h-[190px] gap-[13px] overflow-hidden rounded-[18px] border border-transparent bg-paper/24 p-[18px] text-ink no-underline [box-shadow:var(--shadow-glass-panel)] [-webkit-backdrop-filter:blur(7px)_saturate(150%)_contrast(102%)] [backdrop-filter:blur(7px)_saturate(150%)_contrast(102%)] [transition-property:background-color,box-shadow,transform] [transition-duration:150ms] [transition-timing-function:ease-out] before:pointer-events-none before:absolute before:inset-px before:-z-1 before:rounded-[inherit] before:[background:var(--glass-panel-sheen)] before:content-[''] after:pointer-events-none after:absolute after:inset-0 after:-z-1 after:rounded-[inherit] after:[box-shadow:var(--shadow-glass-panel-glow)] after:content-[''] hover:bg-paper/42 hover:[box-shadow:0_1px_0_--alpha(var(--color-paper)/62%)_inset,0_18px_42px_--alpha(var(--color-ink)/11%)] hover:[transform:translateY(-2px)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary max-[620px]:min-h-0";
const ICON_TONE: Record<OverviewTone, string> = { warning: "bg-warn-soft text-warn", success: "bg-ok-soft text-ok", info: "bg-info-soft text-info" };

function periodLabel(periodKey: string) {
  const [year, month] = periodKey.split("-");
  return `${year} 年 ${Number(month)} 月`;
}

export function HrOverview() {
  usePageTitle("HRIS 儀表板");
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.isHrAdministrator ?? false;
  const canViewOverview = OVERVIEW_PERMISSIONS.some((permission) => permissions.has(permission));
  const overview = useHrQuery<HrOverview>("/overview", canViewOverview);

  if (!canViewOverview) return <Alert tone="danger">你沒有檢視 HRIS 概覽的權限。</Alert>;
  if (overview.isPending) return <HrPageSkeleton variant="dashboard" />;
  if (overview.error || !overview.data) return <Page><Alert tone="danger">{overview.error?.message ?? "概覽資料載入失敗。"}</Alert></Page>;

  const data = overview.data;
  const cards: Array<{ title: string; value: string; description: string; action: string; to: string; icon: IconName; tone: OverviewTone }> = [];
  if (permissions.has("hr:office:read")) cards.push({
    title: "出勤異常", value: `${data.attendance.anomalyCount.toLocaleString("zh-TW")} 筆`, description: `目前月份 ${periodLabel(data.periodKey)} 的待確認異常`, action: "查看出勤紀錄", to: isHrAdministrator ? "/hr/attendance-records" : "/hr/attendance-settings", icon: "calendar", tone: data.attendance.anomalyCount ? "warning" : "success",
  });
  if (permissions.has("hr:schedule:read")) cards.push({
    title: "排班待發布", value: data.schedule.status === "not_applicable" ? "不適用" : data.schedule.missingEmployeeCount ? `${data.schedule.missingEmployeeCount} 位` : data.schedule.status === "published" ? "已完成" : "尚未建立", description: data.schedule.status === "not_applicable" ? "目前沒有採用排班制的員工" : data.schedule.missingEmployeeCount ? "有排班人員尚未出現在本月已發布班表" : data.schedule.status === "published" ? `目前月份已發布並涵蓋 ${data.schedule.scheduledEmployeeCount} 位排班員工` : "目前月份尚未建立排班版本", action: "前往排班月曆", to: "/hr/scheduling", icon: "calendar", tone: data.schedule.missingEmployeeCount || data.schedule.status === "not_started" || data.schedule.status === "pending" ? "warning" : "success",
  });
  if (isHrAdministrator && permissions.has("hr:employee:read")) cards.push({
    title: "投保資料缺漏", value: data.insurance.missingEmployeeCount ? `${data.insurance.missingEmployeeCount} 位` : "已完整", description: data.insurance.missingEmployeeCount ? `目前 ${data.insurance.totalEmployeeCount} 位啟用員工中有勞健保資料缺漏` : "目前啟用員工都有勞保與健保版本", action: "前往勞健保管理", to: "/hr/insurance", icon: "payments", tone: data.insurance.missingEmployeeCount ? "warning" : "success",
  });
  if (isHrAdministrator && permissions.has("hr:payroll:read")) cards.push({
    title: "本月薪資", value: PAYROLL_STATUS[data.payroll.status], description: data.payroll.status === "not_started" ? `目前月份 ${periodLabel(data.periodKey)} 尚未建立試算批次` : `最新批次完成 ${data.payroll.completedCount}／${data.payroll.expectedCount} 筆`, action: data.payroll.status === "not_started" ? "開始試算" : "查看薪資結算", to: "/hr/payroll-settlement", icon: "report", tone: data.payroll.status === "failed" ? "warning" : data.payroll.status === "closed" ? "success" : "info",
  });

  return <Page>
    <PageHeader title="HRIS 儀表板" description={`只顯示目前月份 ${periodLabel(data.periodKey)} 的待辦數量與處理入口，不在儀表板展開薪資或投保明細。`} />
    {overview.isFetching ? <FormHint>更新中…</FormHint> : null}
    <section>
      <div className="grid grid-cols-4 gap-[14px] max-[1100px]:grid-cols-2 max-[620px]:grid-cols-[1fr]">{cards.map((card) => <Link className={CARD} to={card.to} key={card.title}>
        <div className="flex items-center justify-between gap-2"><span className={`grid size-9 place-items-center rounded-[12px] [&_svg]:size-[19px] ${ ICON_TONE[card.tone] }`}><Icon name={card.icon} /></span><StatusBadge tone={card.tone}>{card.title}</StatusBadge></div>
        <strong className="text-[length:clamp(22px,2vw,30px)] tracking-[-.02em]">{card.value}</strong>
        <p className="m-0 min-h-[42px] text-[12px] leading-[1.65] text-muted max-[620px]:min-h-0">{card.description}</p>
        <span className="self-end text-[13px] font-extrabold text-brand-dark">{card.action} <span className="ml-[3px] inline-block [transition-property:transform] [transition-duration:150ms] [transition-timing-function:ease-out] group-hover:[transform:translateX(3px)]" aria-hidden="true">→</span></span>
      </Link>)}</div>
      {!cards.length ? <EmptyState className="mt-[18px]">目前帳號沒有可顯示的 HRIS 待辦。</EmptyState> : null}
    </section>
  </Page>;
}
