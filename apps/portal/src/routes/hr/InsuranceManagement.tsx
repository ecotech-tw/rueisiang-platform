import { useState } from "react";
import { useNavigate } from "react-router";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type Employee, type Employment, type InsuranceRateTableRecord, type InsuranceVersion, type Profile } from "./api.js";
import { InsuranceEditor } from "./InsuranceEditor.js";

interface EmployeeListResponse { employees: Employee[] }
interface InsuranceEdit { employment: Employment; defaultSalary?: number; dependentCount?: number }

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

function currentSalary(profile: Profile, employment: Employment) {
  const date = today();
  return profile.compensation?.filter((version) => version.employmentId === employment.id && version.validFrom <= date && (version.validTo === null || date < version.validTo))
    .sort((left, right) => right.validFrom.localeCompare(left.validFrom))[0]?.baseAmountMinor;
}

function money(minor: number) {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}

function InsuranceRow({ employee, canWrite, onEdit }: { employee: Employee; canWrite: boolean; onEdit: (edit: InsuranceEdit) => void }) {
  const navigate = useNavigate();
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(employee.userId)}`);
  if (profile.isPending) return <tr><td>{employee.displayName}</td><td colSpan={7}>載入投保資料…</td></tr>;
  if (profile.error || !profile.data) return <tr><td>{employee.displayName}</td><td colSpan={7}><span className="muted">{profile.error?.message ?? "資料載入失敗"}</span></td></tr>;
  const insurance = profile.data.insurance ?? [];
  const labor = currentInsurance(insurance, "labor");
  const health = currentInsurance(insurance, "health");
  const employment = profile.data.employments.find((item) => !item.endedOn) ?? profile.data.employments[0];
  const defaultSalary = employment ? currentSalary(profile.data, employment) : undefined;
  const hasInsurance = Boolean(labor || health);
  return <tr>
    <td><strong>{employee.displayName}</strong><br /><span className="muted">{employee.employeeNumber}</span></td>
    <td>{employment ? `${employment.hiredOn}～${employment.endedOn ?? "目前"}` : "尚無任職"}</td>
    <td>{labor ? `${labor.status === "enrolled" ? "加保中" : "已退保"}／${money(labor.insuredAmountMinor)}` : "未設定"}</td>
    <td>{health ? `${health.status === "enrolled" ? "加保中" : "已退保"}／${money(health.insuredAmountMinor)}` : "未設定"}</td>
    <td>{health?.status === "enrolled" ? health.dependentCount : "—"}</td>
    <td>{labor?.sourceKind === "manual" || health?.sourceKind === "manual" ? "需人工覆核" : hasInsurance ? "—" : "待新增"}</td>
    <td><div className="row-actions">
      {canWrite && employment ? <Button variant="secondary" onClick={() => onEdit({ employment, defaultSalary: defaultSalary === undefined ? undefined : defaultSalary / 100, dependentCount: health?.dependentCount })}>{hasInsurance ? "編輯勞健保" : "新增加保資料"}</Button> : null}
      <Button variant="secondary" onClick={() => navigate(`/hr/employees/${encodeURIComponent(employee.userId)}`)}>查看內頁</Button>
    </div></td>
  </tr>;
}

export function HrInsuranceManagement() {
  usePageTitle("勞健保管理");
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.isHrAdministrator ?? false;
  const canRead = isHrAdministrator && permissions.has("hr:employee:read");
  const canWrite = isHrAdministrator && permissions.has("hr:employee:write");
  const year = today().slice(0, 4);
  const employees = useHrQuery<EmployeeListResponse>("/employees?page=1&pageSize=100&status=active&sortField=name&sortDirection=asc", canRead);
  const rates = useHrQuery<{ tables: InsuranceRateTableRecord[] }>(`/insurance-rates?year=${year}`, canRead);
  const syncRates = useHrWrite();
  const activateRate = useHrWrite();
  const [editing, setEditing] = useState<InsuranceEdit | null>(null);
  if (!canRead) return <Alert tone="danger">勞健保明細僅限全平台 HR 管理者查看。</Alert>;
  return <div className="page">
    <PageHeader title="勞健保管理" description="在本頁查看全體員工投保狀態，並一次建立勞保與健保的加退保、級距與眷屬版本；歷史版本不可直接覆寫。" />
    {employees.error ? <Alert tone="danger">{employees.error.message}</Alert> : null}
    <Panel>
      <div className="panel-head"><div><h2>官方級距版本</h2><p className="muted">同步後先保存為待審閱版本；確認內容與來源後，才可啟用供投保版本使用。</p></div>{canWrite ? <Button loading={syncRates.isPending} onClick={() => syncRates.mutate({ path: "/insurance-rates/sync", method: "POST", values: { year: Number(year) } })}>同步 {year} 官方級距</Button> : null}</div>
      {rates.error || syncRates.error || activateRate.error ? <Alert tone="danger">{rates.error?.message ?? syncRates.error?.message ?? activateRate.error?.message}</Alert> : null}
      <div className="table-scroll"><table className="data-table compact"><thead><tr><th>種類</th><th>狀態</th><th>來源</th><th>抓取時間</th><th>操作</th></tr></thead><tbody>{(rates.data?.tables ?? []).map((table) => <tr key={table.id}><td>{table.scheme === "labor" ? "勞保" : "健保"}</td><td>{table.status === "active" ? "已啟用" : table.status === "draft" ? "待審閱" : "已封存"}</td><td><a href={table.sourceUrl} target="_blank" rel="noreferrer">官方來源</a></td><td>{table.fetchedAt}</td><td>{canWrite && table.status === "draft" ? <Button variant="secondary" loading={activateRate.isPending} onClick={() => activateRate.mutate({ path: `/insurance-rates/${table.id}/activate`, method: "POST", values: {} })}>啟用</Button> : "—"}</td></tr>)}</tbody></table></div>
      {!rates.data?.tables.length ? <p className="empty-state">尚未同步本年度官方級距。</p> : null}
    </Panel>

    <Panel>
      <div className="panel-head"><div><h2>員工投保總覽</h2><p className="muted">投保金額、眷屬與來源只在 HR 管理權限下顯示；新增異動會保存新的生效版本。</p></div></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>員工</th><th>目前任職</th><th>勞保</th><th>健保</th><th>眷屬</th><th>資料提醒</th><th>操作</th></tr></thead><tbody>
        {(employees.data?.employees ?? []).map((employee) => <InsuranceRow key={employee.userId} employee={employee} canWrite={canWrite} onEdit={setEditing} />)}
      </tbody></table></div>
      {!employees.data?.employees.length ? <p className="empty-state">尚無啟用中的員工。</p> : null}
    </Panel>
    {editing ? <InsuranceEditor employment={editing.employment} defaultSalary={editing.defaultSalary} defaultDependentCount={editing.dependentCount} onClose={() => setEditing(null)} /> : null}
  </div>;
}
