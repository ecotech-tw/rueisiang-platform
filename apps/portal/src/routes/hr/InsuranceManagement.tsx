import { useNavigate } from "react-router";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel } from "../../ui/index.js";
import { useHrQuery, type Employee, type InsuranceVersion, type Profile } from "./api.js";

interface EmployeeListResponse { employees: Employee[] }

function today() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function currentInsurance(versions: InsuranceVersion[], scheme: InsuranceVersion["scheme"]) {
  const date = today();
  return versions.filter((version) => version.scheme === scheme).find((version) => version.validFrom <= date && (version.validTo === null || date < version.validTo))
    ?? versions.filter((version) => version.scheme === scheme && version.validFrom <= date).sort((left, right) => right.validFrom.localeCompare(left.validFrom))[0];
}

function money(minor: number) {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}

function InsuranceRow({ employee }: { employee: Employee }) {
  const navigate = useNavigate();
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(employee.userId)}`);
  if (profile.isPending) return <tr><td>{employee.displayName}</td><td colSpan={6}>載入投保資料…</td></tr>;
  if (profile.error || !profile.data) return <tr><td>{employee.displayName}</td><td colSpan={6}><span className="muted">{profile.error?.message ?? "資料載入失敗"}</span></td></tr>;
  const insurance = profile.data.insurance ?? [];
  const labor = currentInsurance(insurance, "labor");
  const health = currentInsurance(insurance, "health");
  const employment = profile.data.employments.find((item) => !item.endedOn) ?? profile.data.employments[0];
  return <tr>
    <td><strong>{employee.displayName}</strong><br /><span className="muted">{employee.employeeNumber}</span></td>
    <td>{employment ? `${employment.hiredOn}～${employment.endedOn ?? "目前"}` : "尚無任職"}</td>
    <td>{labor ? `${labor.status === "enrolled" ? "加保中" : "已退保"}／${money(labor.insuredAmountMinor)}` : "未設定"}</td>
    <td>{health ? `${health.status === "enrolled" ? "加保中" : "已退保"}／${money(health.insuredAmountMinor)}` : "未設定"}</td>
    <td>{health?.status === "enrolled" ? health.dependentCount : "—"}</td>
    <td>{labor?.sourceKind === "manual" || health?.sourceKind === "manual" ? "需人工覆核" : "—"}</td>
    <td><Button variant="secondary" onClick={() => navigate(`/hr/employees/${encodeURIComponent(employee.userId)}`)}>查看版本</Button></td>
  </tr>;
}

export function HrInsuranceManagement() {
  usePageTitle("勞健保管理");
  const { permissions, user } = useSession();
  const canRead = Boolean(user?.roles.includes("admin")) && permissions.has("hr:employee:read");
  const employees = useHrQuery<EmployeeListResponse>("/employees?page=1&pageSize=100&status=active&sortField=name&sortDirection=asc", canRead);
  if (!canRead) return <Alert tone="danger">勞健保明細僅限全平台 HR 管理者查看。</Alert>;
  return <div className="page">
    <PageHeader title="勞健保管理" description="查看全體員工的目前投保狀態；要新增加保、退保或變更級距，請進入員工內頁建立新版本。" />
    {employees.error ? <Alert tone="danger">{employees.error.message}</Alert> : null}
    <Panel>
      <div className="panel-head"><div><h2>員工投保總覽</h2><p className="muted">投保金額、眷屬與來源只在 HR 管理權限下顯示；歷史版本不可直接覆寫。</p></div></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>員工</th><th>目前任職</th><th>勞保</th><th>健保</th><th>眷屬</th><th>資料提醒</th><th>操作</th></tr></thead><tbody>
        {(employees.data?.employees ?? []).map((employee) => <InsuranceRow key={employee.userId} employee={employee} />)}
      </tbody></table></div>
      {!employees.data?.employees.length ? <p className="empty-state">尚無啟用中的員工。</p> : null}
    </Panel>
  </div>;
}
