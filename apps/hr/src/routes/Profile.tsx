import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useSignOut } from "../auth/session.js";
import { Icon, type IconName } from "../shell/icons.js";
import { usePageTitle } from "../shell/usePageTitle.js";
import { Alert, Button, ConfirmDialog, EmptyState, PageHeader, Panel, StatusBadge } from "../ui/index.js";
import { useHrQuery, type Employment, type Profile as HrProfile } from "./hr/api.js";
import { dateLabel } from "./hr/format.js";
import { HrProfilePhoto } from "./hr/ProfilePhoto.js";

function userStatusLabel(status: HrProfile["employee"]["userStatus"]) {
  if (status === "active") return "帳號啟用中";
  if (status === "invited") return "等待啟用";
  return "帳號已停用";
}

function ProfileSectionTitle({ icon, children }: { icon: IconName; children: ReactNode }) {
  return <><Icon name={icon} /><span>{children}</span></>;
}

function ProfileInfoRows({ rows }: { rows: Array<{ label: string; value: ReactNode }> }) {
  return <dl className="hr-profile-info-list">{rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>;
}

function EmploymentCard({ job }: { job: Employment }) {
  const archived = Boolean(job.archivedAt);
  return <article className="hr-profile-data-card">
    <header className="hr-profile-data-card-head">
      <div><strong>{job.position || "職位未設定"}</strong>{job.serviceStartOn ? <small>到職日 {dateLabel(job.serviceStartOn)}</small> : null}</div>
      <StatusBadge tone={archived ? "neutral" : "success"}>{archived ? "已封存" : "在職"}</StatusBadge>
    </header>
    <ProfileInfoRows rows={[
      { label: "出勤方式", value: job.attendanceMode === "scheduled" ? "排班制" : "一般辦公" },
      { label: "直屬主管", value: job.supervisorName || "尚未設定" },
      ...(job.monthlyRestDays == null ? [] : [{ label: "每月休假", value: `${job.monthlyRestDays} 日` }]),
    ]} />
  </article>;
}

function AssignmentCard({ name, from, to, primary }: { name: string; from: string; to: string | null; primary?: boolean }) {
  return <article className="hr-profile-data-card">
    <header className="hr-profile-data-card-head">
      <strong>{name}</strong>
      {primary ? <StatusBadge tone="info">主要位置</StatusBadge> : null}
    </header>
    <div className="hr-profile-date-range"><div><span>起始日</span><strong>{dateLabel(from)}</strong></div><div><span>結束日（不含）</span><strong>{dateLabel(to, "未設定")}</strong></div></div>
  </article>;
}

function ProfileDetails({ profile }: { profile: HrProfile }) {
  const employee = profile.employee;
  const employeeName = employee.legalName.trim() || employee.displayName || "員工";
  const navigate = useNavigate();
  return <>
    <Panel className="hr-profile-overview">
      <div className="hr-profile-overview-main">
        <HrProfilePhoto profile={profile} />
        <div className="hr-profile-overview-copy">
          <div className="hr-profile-overview-meta"><span>員工編號 {employee.employeeNumber}</span><StatusBadge tone={employee.employmentStatus === "active" ? "success" : "neutral"}>{employee.employmentStatus === "active" ? "任職中" : "已封存"}</StatusBadge></div>
          <h2>{employeeName}</h2>
          <p>{employee.position || "尚未設定職位"}</p>
        </div>
      </div>
    </Panel>

    <div className="hr-profile-sections">
      <Panel className="hr-profile-panel" title={<ProfileSectionTitle icon="calendar">我的假勤</ProfileSectionTitle>} description="可用特休、到期日與各月請假時數。">
        <Button variant="secondary" onClick={() => navigate("/profile/leave")}>查看假勤</Button>
      </Panel>

      <Panel className="hr-profile-panel" title={<ProfileSectionTitle icon="person">帳號資訊</ProfileSectionTitle>} description="與目前登入帳號連結的資訊。">
        <ProfileInfoRows rows={[
          { label: "Google 帳號名稱", value: employee.accountName || "未提供" },
          { label: "登入帳號", value: employee.email || "未提供" },
          { label: "帳號狀態", value: <StatusBadge tone={employee.userStatus === "active" ? "success" : employee.userStatus === "invited" ? "warning" : "neutral"}>{userStatusLabel(employee.userStatus)}</StatusBadge> },
        ]} />
      </Panel>

      <Panel className="hr-profile-panel" title={<ProfileSectionTitle icon="people">任職紀錄</ProfileSectionTitle>} description="包含目前與已封存的任職資料。">
        {profile.employments.length ? <div className="hr-profile-card-list">{profile.employments.map((job) => <EmploymentCard key={job.id} job={job} />)}</div> : <EmptyState className="hr-profile-empty-note">尚未建立任職資料。</EmptyState>}
      </Panel>

      <Panel className="hr-profile-panel" title={<ProfileSectionTitle icon="storefront">營運櫃點</ProfileSectionTitle>} description="依日期記錄的營運櫃點歸屬。">
        {profile.assignments?.length ? <div className="hr-profile-card-list">{profile.assignments.map((assignment) => <AssignmentCard key={assignment.id} name={assignment.scopeName} from={assignment.validFrom} to={assignment.validTo} />)}</div> : <EmptyState className="hr-profile-empty-note">尚無營運櫃點歸屬。</EmptyState>}
      </Panel>

      <Panel className="hr-profile-panel" title={<ProfileSectionTitle icon="warehouse">辦公位置</ProfileSectionTitle>} description="出勤打卡所使用的辦公位置。">
        {profile.attendanceAssignments?.length ? <div className="hr-profile-card-list">{profile.attendanceAssignments.map((assignment) => <AssignmentCard key={assignment.id} name={assignment.locationName} from={assignment.validFrom} to={assignment.validTo} primary={assignment.isPrimary} />)}</div> : <EmptyState className="hr-profile-empty-note">尚未指派辦公位置。</EmptyState>}
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
  return <div className="page hr-profile-page">
    <PageHeader title="個人中心" description="管理自己的大頭貼，查看帳號、任職與工作地點資料；其他資料如有錯誤，請聯絡管理者。" />
    {query.isPending ? <Panel className="hr-profile-loading"><p className="muted">正在載入個人資料…</p></Panel> : null}
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    {query.data?.profile ? <ProfileDetails key={query.data.profile.employee.userId} profile={query.data.profile} /> : null}
    {!query.isPending && !query.error && !query.data?.profile ? <Alert>尚未指派為員工，請聯絡管理者。</Alert> : null}
    <div className="hr-profile-signout"><Button size="lg" className="w-full justify-center" icon="logout" onClick={() => setShowSignOutConfirm(true)}>登出此裝置</Button></div>
    {showSignOutConfirm ? <ConfirmDialog title="確定要登出這台裝置？" confirmLabel="確認登出" cancelLabel="繼續使用" tone="primary" pending={signOutPending} onCancel={() => { if (!signOutPending) setShowSignOutConfirm(false); }} onConfirm={confirmSignOut}>
      <p>登出後會清除這台裝置的登入狀態，並返回登入頁。要繼續嗎？</p>
      {signOutError ? <Alert tone="danger">{signOutError}</Alert> : null}
    </ConfirmDialog> : null}
  </div>;
}
