import { useSignOut } from "../auth/session.js";
import { usePageTitle } from "../shell/usePageTitle.js";
import { Alert, Button, PageHeader } from "../ui/index.js";
import { useHrQuery, type Profile as HrProfile } from "./hr/api.js";

function ProfileDetails({ profile }: { profile: HrProfile }) {
  const assignments = profile.assignments ?? [];
  return <>
    <h2>{profile.employee.employeeNumber} · {profile.employee.displayName}</h2>
    <p className="muted">帳號：{profile.employee.email}；登入狀態：{profile.employee.userStatus === "active" ? "啟用中" : profile.employee.userStatus === "invited" ? "待啟用" : "已停用"}</p>
    <p className="muted">員工資料封存後仍保留，供薪資、出勤與稽核歷史追溯。</p>
    <p className="hr-employee-supervisor">主管：<strong>{profile.employee.supervisorName ?? "尚未設定"}</strong></p>
    <table className="data-table"><thead><tr><th>職位</th><th>出勤方式</th><th>狀態</th></tr></thead>
      <tbody>{profile.employments.map((job) => <tr key={job.id}><td>{job.position}</td><td>{job.attendanceMode === "scheduled" ? "排班" : "一般辦公"}</td><td>{job.archivedAt ? `已封存（${job.archivedAt}）` : "在職"}</td></tr>)}</tbody></table>
    {!profile.employments.length ? <p>尚未建立員工資料。</p> : null}
    <h3>營運櫃點歸屬</h3>
    <table className="data-table"><thead><tr><th>櫃點</th><th>起日</th><th>迄日（不含）</th></tr></thead><tbody>
      {assignments.map((assignment) => <tr key={assignment.id}><td>{assignment.scopeName}</td><td>{assignment.validFrom}</td><td>{assignment.validTo ?? "未設定"}</td></tr>)}
    </tbody></table>
    {!assignments.length ? <p>尚無營運櫃點歸屬。</p> : null}
    <h3>辦公位置指派</h3>
    <table className="data-table"><thead><tr><th>辦公位置</th><th>起日</th><th>迄日（不含）</th></tr></thead><tbody>
      {(profile.attendanceAssignments ?? []).map((assignment) => <tr key={assignment.id}><td>{assignment.locationName}</td><td>{assignment.validFrom}</td><td>{assignment.validTo ?? "未設定"}</td></tr>)}
    </tbody></table>
    {!(profile.attendanceAssignments ?? []).length ? <p>尚未指派辦公位置。</p> : null}
  </>;
}

export function HrProfile() {
  usePageTitle("個人資訊");
  const query = useHrQuery<{ profile: HrProfile | null }>("/me");
  const signOut = useSignOut();
  // 這台手機會一直保持登入，共用裝置一定要找得到登出。
  return <div className="page hr-forms-page"><PageHeader title="個人資訊" description="這裡顯示與你登入帳號相連的任職、營運櫃點與辦公位置；資料有誤請聯絡管理者。" actions={<Button variant="secondary" onClick={() => void signOut()}>登出這台裝置</Button>} />
    {query.isPending ? <p>載入中…</p> : query.error ? <Alert tone="danger">{query.error.message}</Alert> : query.data?.profile ? <section className="panel p-6"><ProfileDetails profile={query.data.profile} /></section> : <Alert>尚未指派為員工，請聯絡管理者。</Alert>}
  </div>;
}
