import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useSignOut } from "../auth/session.js";
import { Icon, type IconName } from "../shell/icons.js";
import { usePageTitle } from "../shell/usePageTitle.js";
import { Alert, Button, ConfirmDialog, EmptyState, Page, PageHeader, Panel, StatusBadge } from "../ui/index.js";
import { useHrQuery, type Employment, type Profile as HrProfile } from "./hr/api.js";
import { dateLabel } from "./hr/format.js";
import { PROFILE_CARD_TITLE, ProfileCardHeading, ProfileCardList, ProfileDataCard, ProfileInfoList } from "./hr/ProfileCard.js";
import { HrProfilePhoto } from "./hr/ProfilePhoto.js";

// 個人資料的區塊：標題帶圖示，手機上標題與說明疊成兩行、內距縮小。
const PROFILE_PANEL = {
  className: "min-w-0 max-[760px]:px-3.5 max-[760px]:py-4",
  headerClassName: "mb-4 max-[760px]:grid max-[760px]:gap-[5px] max-[760px]:mb-3.5 max-[760px]:[&>div]:min-w-0",
  titleClassName: "gap-[9px] [&_svg]:size-[19px] [&_svg]:text-brand-dark max-[760px]:text-[16px]",
};
function userStatusLabel(status: HrProfile["employee"]["userStatus"]) {
  if (status === "active") return "帳號啟用中";
  if (status === "invited") return "等待啟用";
  return "帳號已停用";
}

function ProfileSectionTitle({ icon, children }: { icon: IconName; children: ReactNode }) {
  return <><Icon name={icon} /><span>{children}</span></>;
}

function EmploymentCard({ job }: { job: Employment }) {
  const archived = Boolean(job.archivedAt);
  return <ProfileDataCard head={<>
    <ProfileCardHeading title={job.position || "職位未設定"} meta={job.serviceStartOn ? <>到職日 {dateLabel(job.serviceStartOn)}</> : null} />
    <StatusBadge tone={archived ? "neutral" : "success"}>{archived ? "已封存" : "在職"}</StatusBadge>
  </>}>
    <ProfileInfoList rows={[
      { label: "出勤方式", value: job.attendanceMode === "scheduled" ? "排班制" : "一般辦公" },
      { label: "直屬主管", value: job.supervisorName || "尚未設定" },
      ...(job.monthlyRestDays == null ? [] : [{ label: "每月休假", value: `${job.monthlyRestDays} 日` }]),
    ]} />
  </ProfileDataCard>;
}

function AssignmentCard({ name, from, to, primary }: { name: string; from: string; to: string | null; primary?: boolean }) {
  return <ProfileDataCard head={<>
    <strong className={PROFILE_CARD_TITLE}>{name}</strong>
    {primary ? <StatusBadge tone="info">主要位置</StatusBadge> : null}
  </>}>
    <div className="grid grid-cols-2 gap-2 border-t border-t-soft-line pt-2.5 max-[760px]:gap-1.5">
      {[["起始日", dateLabel(from)], ["結束日（不含）", dateLabel(to, "未設定")]].map(([label, value]) => <div key={label} className="grid min-w-0 gap-[3px]">
        <span className="text-[11px] text-muted">{label}</span>
        <strong className="text-[13px] tabular-nums [overflow-wrap:anywhere] max-[760px]:text-[12px]">{value}</strong>
      </div>)}
    </div>
  </ProfileDataCard>;
}

function ProfileDetails({ profile }: { profile: HrProfile }) {
  const employee = profile.employee;
  const employeeName = employee.legalName.trim() || employee.displayName || "員工";
  const navigate = useNavigate();
  return <>
    <Panel className="bg-[linear-gradient(125deg,var(--color-brand-soft),var(--color-paper)_72%)] max-[760px]:p-4">
      <div className="flex min-w-0 items-start gap-6 max-[760px]:gap-[18px]">
        <HrProfilePhoto profile={profile} />
        <div className="grid min-w-0 gap-[5px]">
          <div className="flex flex-wrap items-center gap-2 text-[12px] font-bold text-muted max-[760px]:gap-1.5"><span>員工編號 {employee.employeeNumber}</span><StatusBadge tone={employee.employmentStatus === "active" ? "success" : "neutral"}>{employee.employmentStatus === "active" ? "任職中" : "已封存"}</StatusBadge></div>
          <h2 className="m-0 text-[23px] leading-[1.3] max-[760px]:text-[20px]">{employeeName}</h2>
          <p className="m-0 text-[14px] text-muted">{employee.position || "尚未設定職位"}</p>
        </div>
      </div>
    </Panel>

    <div className="grid grid-cols-2 items-start gap-4 [&>[data-panel]+[data-panel]]:mt-0 max-[760px]:grid-cols-1 max-[760px]:gap-3">
      <Panel {...PROFILE_PANEL} title={<ProfileSectionTitle icon="calendar">我的假勤</ProfileSectionTitle>} description="可用特休、到期日與各月請假時數。">
        <Button variant="secondary" onClick={() => navigate("/profile/leave")}>查看假勤</Button>
      </Panel>

      <Panel {...PROFILE_PANEL} title={<ProfileSectionTitle icon="person">帳號資訊</ProfileSectionTitle>} description="與目前登入帳號連結的資訊。">
        <ProfileInfoList rows={[
          { label: "Google 帳號名稱", value: employee.accountName || "未提供" },
          { label: "登入帳號", value: employee.email || "未提供" },
          { label: "帳號狀態", value: <StatusBadge tone={employee.userStatus === "active" ? "success" : employee.userStatus === "invited" ? "warning" : "neutral"}>{userStatusLabel(employee.userStatus)}</StatusBadge> },
        ]} />
      </Panel>

      <Panel {...PROFILE_PANEL} title={<ProfileSectionTitle icon="people">任職紀錄</ProfileSectionTitle>} description="包含目前與已封存的任職資料。">
        {profile.employments.length ? <ProfileCardList>{profile.employments.map((job) => <EmploymentCard key={job.id} job={job} />)}</ProfileCardList> : <EmptyState size="compact">尚未建立任職資料。</EmptyState>}
      </Panel>

      <Panel {...PROFILE_PANEL} title={<ProfileSectionTitle icon="storefront">營運櫃點</ProfileSectionTitle>} description="依日期記錄的營運櫃點歸屬。">
        {profile.assignments?.length ? <ProfileCardList>{profile.assignments.map((assignment) => <AssignmentCard key={assignment.id} name={assignment.scopeName} from={assignment.validFrom} to={assignment.validTo} />)}</ProfileCardList> : <EmptyState size="compact">尚無營運櫃點歸屬。</EmptyState>}
      </Panel>

      <Panel {...PROFILE_PANEL} title={<ProfileSectionTitle icon="warehouse">辦公位置</ProfileSectionTitle>} description="出勤打卡所使用的辦公位置。">
        {profile.attendanceAssignments?.length ? <ProfileCardList>{profile.attendanceAssignments.map((assignment) => <AssignmentCard key={assignment.id} name={assignment.locationName} from={assignment.validFrom} to={assignment.validTo} primary={assignment.isPrimary} />)}</ProfileCardList> : <EmptyState size="compact">尚未指派辦公位置。</EmptyState>}
      </Panel>
    </div>
  </>;
}

export function HrProfile() {
  usePageTitle("個人中心");
  const query = useHrQuery<{ profile: HrProfile | null }>("/me");
  const signOut = useSignOut();
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [signOutPending, setSignOutPending] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  async function confirmSignOut() {
    setSignOutPending(true);
    setSignOutError(null);
    try {
      await signOut();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "登出失敗，請稍後再試。");
      setSignOutPending(false);
    }
  }
  return <Page className="mx-auto w-full max-w-[900px] max-[760px]:max-w-none">
    <PageHeader title="個人中心" description="管理自己的大頭貼，查看帳號、任職與工作地點資料；其他資料如有錯誤，請聯絡管理者。" />
    {query.isPending ? <Panel className="grid min-h-[84px] place-items-center"><p className="text-muted">正在載入個人資料…</p></Panel> : null}
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    {query.data?.profile ? <ProfileDetails key={query.data.profile.employee.userId} profile={query.data.profile} /> : null}
    {!query.isPending && !query.error && !query.data?.profile ? <Alert>尚未指派為員工，請聯絡管理者。</Alert> : null}
    <div className="w-full"><Button size="lg" className="w-full justify-center" icon="logout" onClick={() => setShowSignOutConfirm(true)}>登出此裝置</Button></div>
    {showSignOutConfirm ? <ConfirmDialog title="確定要登出這台裝置？" confirmLabel="確認登出" cancelLabel="繼續使用" tone="primary" pending={signOutPending} onCancel={() => { if (!signOutPending) setShowSignOutConfirm(false); }} onConfirm={confirmSignOut}>
      <p>登出後會清除這台裝置的登入狀態，並返回登入頁。要繼續嗎？</p>
      {signOutError ? <Alert tone="danger">{signOutError}</Alert> : null}
    </ConfirmDialog> : null}
  </Page>;
}
