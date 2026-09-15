import type { Permission } from "@rueisiang/auth/permissions";
import { Link } from "react-router";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Icon, type IconName } from "../../shell/icons.js";
import { Alert, PageHeader, Panel, StatusBadge } from "../../ui/index.js";
import { useHrQuery, type HrOverview } from "./api.js";

const OVERVIEW_PERMISSIONS: Permission[] = ["hr:employee:read", "hr:office:read", "hr:schedule:read", "hr:payroll:read", "hr:bonus:read"];
const PAYROLL_STATUS: Record<HrOverview["payroll"]["status"], string> = {
  not_started: "尚未試算", calculating: "計算中", ready: "待覆核", approved: "已核准", closed: "已結帳", failed: "計算失敗",
};

function periodLabel(periodKey: string) {
  const [year, month] = periodKey.split("-");
  return `${year} 年 ${Number(month)} 月`;
}

export function HrOverview() {
  usePageTitle("HRIS 概覽");
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.roles.includes("admin") ?? false;
  const canViewOverview = OVERVIEW_PERMISSIONS.some((permission) => permissions.has(permission));
  const overview = useHrQuery<HrOverview>("/overview", canViewOverview);

  if (!canViewOverview) return <Alert tone="danger">你沒有檢視 HRIS 概覽的權限。</Alert>;
  if (overview.isPending) return <div className="page"><div className="boot">載入 HRIS 概覽…</div></div>;
  if (overview.error || !overview.data) return <div className="page"><Alert tone="danger">{overview.error?.message ?? "概覽資料載入失敗。"}</Alert></div>;

  const data = overview.data;
  const cards: Array<{ title: string; value: string; description: string; action: string; to: string; icon: IconName; tone: "warning" | "success" | "info" }> = [];
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

  return <div className="page hr-overview-page">
    <PageHeader title="HRIS 概覽" description={`只顯示目前月份 ${periodLabel(data.periodKey)} 的待辦數量與處理入口，不在首頁展開薪資或投保明細。`} />
    {overview.isFetching ? <p className="form-hint">更新中…</p> : null}
    <Panel className="hr-overview-panel">
      <div className="hr-overview-grid">{cards.map((card) => <Link className="hr-overview-card" to={card.to} key={card.title}>
        <div className="hr-overview-card-head"><span className={`hr-overview-icon hr-overview-icon-${card.tone}`}><Icon name={card.icon} /></span><StatusBadge tone={card.tone}>{card.title}</StatusBadge></div>
        <strong className="hr-overview-value">{card.value}</strong>
        <p>{card.description}</p>
        <span className="hr-overview-action">{card.action} <span aria-hidden="true">→</span></span>
      </Link>)}</div>
      {!cards.length ? <p className="empty-state">目前帳號沒有可顯示的 HRIS 待辦。</p> : null}
    </Panel>
  </div>;
}
