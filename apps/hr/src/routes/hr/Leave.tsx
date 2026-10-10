import { useState } from "react";
import { useNavigate } from "react-router";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, EmptyState, PageHeader, Panel, StatusBadge } from "../../ui/index.js";
import { useHrQuery, type AnnualLeavePeriod, type AnnualLeaveResponse, type LeaveMonth, type LeaveMonthsResponse } from "./api.js";
import { dateBefore, formatHours } from "./Forms.js";

function dateLabel(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[1]}/${Number(match[2])}/${Number(match[3])}` : value;
}

function AnnualLeaveCard({ period }: { period: AnnualLeavePeriod }) {
  const remaining = Math.max(0, period.balanceHalfHours);
  // periodEnd 不含當日；員工要看的是最後一天還能請假的日期。
  const lastDay = dateLabel(dateBefore(period.periodEnd));
  return <article className="hr-profile-data-card">
    <header className="hr-profile-data-card-head">
      <div><strong>{lastDay} 到期</strong><small>使用期間 {dateLabel(period.periodStart)}～{lastDay}</small></div>
      <StatusBadge tone={remaining > 0 ? "success" : "neutral"}>{remaining > 0 ? "可使用" : "已用完"}</StatusBadge>
    </header>
    <div className="hr-payslip-totals">
      <div><span>給予</span><strong>{formatHours(period.entitledHalfHours * 30)}</strong></div>
      <div><span>已使用</span><strong>{formatHours(period.usedHalfHours * 30)}</strong></div>
      <div className="net"><span>剩餘</span><strong>{formatHours(remaining * 30)}</strong></div>
    </div>
  </article>;
}

function MonthCard({ month }: { month: LeaveMonth }) {
  return <article className="hr-profile-data-card">
    <header className="hr-profile-data-card-head">
      <strong>{Number(month.month.slice(5, 7))} 月</strong>
      <strong className="tabular-nums">共 {formatHours(month.totalMinutes)}</strong>
    </header>
    <dl className="hr-profile-info-list">{month.leaveTypes.map((leaveType) => <div key={leaveType.id}><dt>{leaveType.name}</dt><dd className="tabular-nums">{formatHours(leaveType.minutes)}</dd></div>)}</dl>
  </article>;
}

export function HrLeaveSummary() {
  usePageTitle("我的假勤");
  const navigate = useNavigate();
  // 一開始不帶年份，讓伺服器用台北時間決定「今年」；可切換的範圍也由伺服器回。
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const annual = useHrQuery<AnnualLeaveResponse>("/me/annual-leave");
  const leave = useHrQuery<LeaveMonthsResponse>(selectedYear === null ? "/me/leave-months" : `/me/leave-months?year=${selectedYear}`);
  // 切換年份後新查詢還沒回來時沿用上一份的範圍，上下年按鈕才不會閃成停用。
  const [range, setRange] = useState<{ firstYear: number; lastYear: number } | null>(null);
  if (leave.data && (range?.firstYear !== leave.data.firstYear || range.lastYear !== leave.data.lastYear)) setRange({ firstYear: leave.data.firstYear, lastYear: leave.data.lastYear });
  const year = selectedYear ?? leave.data?.year ?? null;
  const periods = annual.data?.periods ?? [];
  const months = leave.data?.months ?? [];

  return <div className="page hr-payroll-history-page hr-payslip-page">
    <div className="hr-form-back-bar">
      <Button variant="link" icon="chevronLeft" className="hr-form-back-button" onClick={() => navigate("/profile")}>返回個人中心</Button>
    </div>
    <PageHeader title="我的假勤" description="可用特休與已核准的請假時數。" />

    <Panel title="特休" description="每個週期的額度各自計算，到期後不會遞延到下一期。">
      {annual.isPending ? <p className="muted">載入特休額度…</p> : null}
      {annual.error ? <Alert tone="danger">{annual.error.message}</Alert> : null}
      {periods.length ? <div className="hr-profile-card-list">{periods.map((period) => <AnnualLeaveCard key={period.entitlementId} period={period} />)}</div> : null}
      {!annual.isPending && !annual.error && !periods.length ? <EmptyState className="hr-profile-empty-note">目前沒有可用的特休額度。</EmptyState> : null}
    </Panel>

    <Panel title="請假紀錄" description="只計入已核准的請假申請；審核中的申請請到表單申請查看。">
      {year !== null && range ? <div className="hr-clock-history-toolbar mb-3">
        <Button variant="icon" icon="chevronLeft" aria-label="上一年" disabled={year <= range.firstYear} onClick={() => setSelectedYear(year - 1)} />
        <strong>{year} 年</strong>
        <Button variant="icon" icon="chevronRight" aria-label="下一年" disabled={year >= range.lastYear} onClick={() => setSelectedYear(year + 1)} />
      </div> : null}
      {leave.isPending ? <p className="muted">載入請假紀錄…</p> : null}
      {leave.error ? <Alert tone="danger">{leave.error.message}</Alert> : null}
      {months.length ? <div className="hr-profile-card-list">{months.map((month) => <MonthCard key={month.month} month={month} />)}</div> : null}
      {!leave.isPending && !leave.error && !months.length ? <EmptyState className="hr-profile-empty-note">{year} 年沒有已核准的請假。</EmptyState> : null}
    </Panel>
  </div>;
}
