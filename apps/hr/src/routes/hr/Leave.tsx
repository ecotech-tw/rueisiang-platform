import { useState } from "react";
import { useNavigate } from "react-router";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, EmptyState, Page, PageHeader, Panel, StatusBadge } from "../../ui/index.js";
import { useHrQuery, type AnnualLeavePeriod, type AnnualLeaveResponse, type LeaveMonth, type LeaveMonthsResponse } from "./api.js";
import { dateBefore, dateLabel, formatHours } from "./format.js";
import { HrBackBar } from "./HrBackBar.js";
import { PeriodToolbar } from "./PeriodToolbar.js";
import { PROFILE_CARD_TITLE, ProfileCardHeading, ProfileCardList, ProfileDataCard, ProfileInfoList } from "./ProfileCard.js";

function AnnualLeaveCard({ period }: { period: AnnualLeavePeriod }) {
  const remaining = Math.max(0, period.balanceHalfHours);
  const lastDay = dateLabel(dateBefore(period.periodEnd));
  return <ProfileDataCard head={<>
    <ProfileCardHeading title={<>{lastDay} 到期</>} meta={<>使用期間 {dateLabel(period.periodStart)}～{lastDay}</>} />
    <StatusBadge tone={remaining > 0 ? "success" : "neutral"}>{remaining > 0 ? "可使用" : "已用完"}</StatusBadge>
  </>}>
    <div className="hr-payslip-totals">
      <div><span>給予</span><strong>{formatHours(period.grantedHalfHours * 30)}</strong></div>
      <div><span>已使用</span><strong>{formatHours(period.usedHalfHours * 30)}</strong></div>
      <div className="net"><span>剩餘</span><strong>{formatHours(remaining * 30)}</strong></div>
    </div>
  </ProfileDataCard>;
}

function MonthCard({ month }: { month: LeaveMonth }) {
  return <ProfileDataCard head={<>
    <strong className={PROFILE_CARD_TITLE}>{Number(month.month.slice(5, 7))} 月</strong>
    <strong className={`${PROFILE_CARD_TITLE} tabular-nums`}>共 {formatHours(month.totalMinutes)}</strong>
  </>}>
    <ProfileInfoList valueClassName="tabular-nums" rows={month.leaveTypes.map((leaveType) => ({ key: leaveType.id, label: leaveType.name, value: formatHours(leaveType.minutes) }))} />
  </ProfileDataCard>;
}

export function HrLeaveSummary() {
  usePageTitle("我的假勤");
  const navigate = useNavigate();
  // null 代表今年：哪一年算今年（台北時間）由伺服器決定，回到今年時也才會用回同一份快取。
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const annual = useHrQuery<AnnualLeaveResponse>("/me/annual-leave");
  const leave = useHrQuery<LeaveMonthsResponse>(selectedYear === null ? "/me/leave-months" : `/me/leave-months?year=${selectedYear}`, true, true);
  const range = leave.data;
  const year = selectedYear ?? range?.currentYear ?? null;
  const loadingMonths = leave.isPending || leave.isPlaceholderData;
  const periods = annual.data?.periods ?? [];
  const months = loadingMonths ? [] : leave.data?.months ?? [];
  const selectYear = (next: number) => setSelectedYear(next === range?.currentYear ? null : next);

  return <Page className="hr-payroll-history-page hr-payslip-page [&>[data-page-head]]:mt-2">
    <HrBackBar label="返回個人中心" onBack={() => navigate("/profile")} />
    <PageHeader title="我的假勤" description="可用特休與已核准的請假時數。" />

    <Panel title="特休" description="每個週期的額度各自計算，到期後不會遞延到下一期。">
      {annual.isPending ? <p className="muted">載入特休額度…</p> : null}
      {annual.error ? <Alert tone="danger">{annual.error.message}</Alert> : null}
      {periods.length ? <ProfileCardList>{periods.map((period) => <AnnualLeaveCard key={period.entitlementId} period={period} />)}</ProfileCardList> : null}
      {!annual.isPending && !annual.error && !periods.length ? <EmptyState size="compact">目前沒有可用的特休額度。</EmptyState> : null}
    </Panel>

    <Panel title="請假紀錄" description="只計入已核准的請假申請；審核中的申請請到表單申請查看。">
      {year !== null && range ? <PeriodToolbar
        className="mb-3"
        label={`${year} 年`}
        previous={{ label: "上一年", disabled: year <= range.firstYear, onClick: () => selectYear(year - 1) }}
        next={{ label: "下一年", disabled: year >= range.lastYear, onClick: () => selectYear(year + 1) }}
      /> : null}
      {loadingMonths && !leave.error ? <p className="muted">載入請假紀錄…</p> : null}
      {leave.error ? <Alert tone="danger">{leave.error.message}</Alert> : null}
      {months.length ? <ProfileCardList>{months.map((month) => <MonthCard key={month.month} month={month} />)}</ProfileCardList> : null}
      {!loadingMonths && !leave.error && !months.length ? <EmptyState size="compact">{year} 年沒有已核准的請假。</EmptyState> : null}
    </Panel>
  </Page>;
}
