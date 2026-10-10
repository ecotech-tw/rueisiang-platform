import { useState } from "react";
import { useNavigate } from "react-router";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, EmptyState, PageHeader, Panel, StatusBadge } from "../../ui/index.js";
import { useHrQuery, type LeaveSummaryResponse } from "./api.js";

function currentTaipeiYear() {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric" }).format(new Date()));
}

function summaryPath(year: number) {
  return `/me/leave-summary?year=${year}`;
}

function hours(minutes: number) {
  return `${(minutes / 60).toFixed(1)} 小時`;
}

function dateLabel(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[1]}/${Number(match[2])}/${Number(match[3])}` : value;
}

/** periodEnd 是不含當日的結束日；員工要看的是最後一天還能請假的日期。 */
function lastUsableDate(periodEnd: string) {
  const date = new Date(`${periodEnd}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return periodEnd;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function AnnualLeaveCard({ period }: { period: LeaveSummaryResponse["annualLeave"][number] }) {
  const remaining = Math.max(0, period.balanceHalfHours);
  return <article className="hr-profile-data-card">
    <header className="hr-profile-data-card-head">
      <div><strong>{dateLabel(lastUsableDate(period.periodEnd))} 到期</strong><small>使用期間 {dateLabel(period.periodStart)}～{dateLabel(lastUsableDate(period.periodEnd))}</small></div>
      <StatusBadge tone={remaining > 0 ? "success" : "neutral"}>{remaining > 0 ? "可使用" : "已用完"}</StatusBadge>
    </header>
    <div className="hr-payslip-totals">
      <div><span>給予</span><strong>{hours(period.entitledHalfHours * 30)}</strong></div>
      <div><span>已使用</span><strong>{hours(period.usedHalfHours * 30)}</strong></div>
      <div className="net"><span>剩餘</span><strong>{hours(remaining * 30)}</strong></div>
    </div>
  </article>;
}

function MonthCard({ month }: { month: LeaveSummaryResponse["months"][number] }) {
  return <article className="hr-profile-data-card">
    <header className="hr-profile-data-card-head">
      <strong>{Number(month.month.slice(5, 7))} 月</strong>
      <strong className="tabular-nums">共 {hours(month.totalMinutes)}</strong>
    </header>
    <dl className="hr-profile-info-list">{month.leaveTypes.map((leaveType) => <div key={leaveType.name}><dt>{leaveType.name}</dt><dd className="tabular-nums">{hours(leaveType.minutes)}</dd></div>)}</dl>
  </article>;
}

export function HrLeaveSummary() {
  usePageTitle("我的假勤");
  const navigate = useNavigate();
  const thisYear = currentTaipeiYear();
  const [year, setYear] = useState(thisYear);
  // 特休額度跟年份無關；固定讀今年那一份，切換年份時額度區塊才不會跟著閃成載入中。
  const current = useHrQuery<LeaveSummaryResponse>(summaryPath(thisYear));
  const selected = useHrQuery<LeaveSummaryResponse>(summaryPath(year));
  const annualLeave = current.data?.annualLeave ?? [];
  const months = selected.data?.months ?? [];

  return <div className="page hr-payroll-history-page hr-payslip-page">
    <div className="hr-form-back-bar">
      <Button variant="link" icon="chevronLeft" className="hr-form-back-button" onClick={() => navigate("/profile", { state: { transition: "back" } })}>返回個人中心</Button>
    </div>
    <PageHeader title="我的假勤" description="可用特休與已核准的請假時數。" />

    <Panel title="特休" description="每個週期的額度各自計算，到期後不會遞延到下一期。">
      {current.isPending ? <p className="muted">載入特休額度…</p> : null}
      {current.error ? <Alert tone="danger">{current.error.message}</Alert> : null}
      {annualLeave.length ? <div className="hr-profile-card-list">{annualLeave.map((period) => <AnnualLeaveCard key={period.entitlementId} period={period} />)}</div> : null}
      {!current.isPending && !current.error && !annualLeave.length ? <EmptyState className="hr-profile-empty-note">目前沒有可用的特休額度。</EmptyState> : null}
    </Panel>

    <Panel title="請假紀錄" description="只計入已核准的請假申請；審核中的申請請到表單申請查看。">
      <div className="hr-clock-history-toolbar mb-3">
        <Button variant="icon" icon="chevronLeft" aria-label="上一年" onClick={() => setYear(year - 1)} />
        <strong>{year} 年</strong>
        <Button variant="icon" icon="chevronRight" aria-label="下一年" disabled={year >= thisYear} onClick={() => setYear(year + 1)} />
      </div>
      {selected.isPending ? <p className="muted">載入請假紀錄…</p> : null}
      {selected.error ? <Alert tone="danger">{selected.error.message}</Alert> : null}
      {months.length ? <div className="hr-profile-card-list">{months.map((month) => <MonthCard key={month.month} month={month} />)}</div> : null}
      {!selected.isPending && !selected.error && !months.length ? <EmptyState className="hr-profile-empty-note">{year} 年沒有已核准的請假。</EmptyState> : null}
    </Panel>
  </div>;
}
