import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, FilterSelect, PageHeader, Panel, SearchFilterInput } from "../../ui/index.js";
import { useHrQuery, type Employee, type Employment, type InsuranceVersion, type Profile } from "./api.js";
import { InsuranceEditor } from "./InsuranceEditor.js";
import { InsuranceRateManagementDialog } from "./InsuranceRateManagementDialog.js";
import { HrPageSkeleton, HrSkeletonTableRow } from "./HrSkeleton.js";

interface EmployeePageResponse { employees: Employee[]; total: number; page: number; pageSize: number; hasMore: boolean }
interface InsuranceEdit { employment: Employment; existing: boolean; defaultSalary?: number; dependentCount?: number }

const EMPLOYEE_PAGE_SIZES = [10, 25, 50, 100] as const;

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

export function currentSalary(profile: Profile, employment: Employment, date = today()) {
  const version = profile.compensation?.filter((item) => item.employmentId === employment.id && item.validFrom <= date && (item.validTo === null || date < item.validTo))
    .sort((left, right) => right.validFrom.localeCompare(left.validFrom))[0];
  return version === undefined ? undefined : version.baseAmountMinor + (version.items ?? []).reduce((total, item) => total + item.amountMinor, 0);
}

function money(minor: number) {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}

function InsuranceRow({ employee, canWrite, onEdit }: { employee: Employee; canWrite: boolean; onEdit: (edit: InsuranceEdit) => void }) {
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(employee.userId)}`, true, { keepPreviousData: false });
  if (profile.isPending) return <HrSkeletonTableRow columns={7} />;
  if (profile.error || !profile.data) return <tr><td data-label="員工">{employee.displayName}</td><td data-label="狀態" colSpan={6}><span className="muted">{profile.error?.message ?? "資料載入失敗"}</span></td></tr>;
  const insurance = profile.data.insurance ?? [];
  const labor = currentInsurance(insurance, "labor");
  const health = currentInsurance(insurance, "health");
  const employment = profile.data.employments.find((item) => !item.archivedAt);
  const defaultSalary = employment ? currentSalary(profile.data, employment) : undefined;
  const hasInsurance = Boolean(labor || health);
  return <tr>
    <td data-label="員工"><strong>{employee.displayName}</strong><br /><span className="muted">{employee.employeeNumber}</span></td>
    <td data-label="目前職位">{employment ? `${employment.employeeNumber} · ${employment.position}` : "尚無任職"}</td>
    <td data-label="勞保">{labor ? `${labor.status === "enrolled" ? "加保中" : "已退保"}／${money(labor.insuredAmountMinor)}` : "未設定"}</td>
    <td data-label="健保">{health ? `${health.status === "enrolled" ? "加保中" : "已退保"}／${money(health.insuredAmountMinor)}` : "未設定"}</td>
    <td data-label="眷屬">{health?.status === "enrolled" ? health.dependentCount : "—"}</td>
    <td data-label="資料提醒">{labor?.sourceKind === "manual" || health?.sourceKind === "manual" ? "需人工覆核" : hasInsurance ? "—" : "待新增"}</td>
    <td data-label="操作"><div className="row-actions">
      {canWrite && employment ? <Button variant="icon" icon={hasInsurance ? "edit" : "plus"} className={hasInsurance ? "compensation-action-update" : "compensation-action-add"} title={`${hasInsurance ? "編輯勞健保" : "新增加保資料"}：${employee.displayName}`} aria-label={`${hasInsurance ? "編輯勞健保" : "新增加保資料"}：${employee.displayName}`} onClick={() => onEdit({ employment, existing: hasInsurance, defaultSalary: defaultSalary === undefined ? undefined : defaultSalary / 100, dependentCount: health?.dependentCount })} /> : null}
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
  const [employeeFilters, setEmployeeFilters] = useState({ page: 1, pageSize: 25, search: "", status: "all", sortField: "employeeNumber", sortDirection: "asc" as "asc" | "desc" });
  const employeeTablePath = `/employees?page=${employeeFilters.page}&pageSize=${employeeFilters.pageSize}&search=${encodeURIComponent(employeeFilters.search)}&status=${employeeFilters.status}&employmentStatus=active&sortField=${employeeFilters.sortField}&sortDirection=${employeeFilters.sortDirection}`;
  const employeeTable = useHrQuery<EmployeePageResponse>(employeeTablePath, canRead);
  const [editing, setEditing] = useState<InsuranceEdit | null>(null);
  const [rateManagementOpen, setRateManagementOpen] = useState(false);
  if (!canRead) return <Alert tone="danger">勞健保明細僅限全平台 HR 管理者查看。</Alert>;
  if (employeeTable.isPending) return <HrPageSkeleton variant="table" />;
  return <div className="page fills">
    <PageHeader title="勞健保管理" description="在本頁查看全體員工投保狀態，並一次建立勞保與健保的加退保、級距與眷屬版本；歷史版本不可直接覆寫。" actions={canWrite ? <Button icon="tune" onClick={() => setRateManagementOpen(true)}>級距管理</Button> : null} />
    <Panel className="grows">
      <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
        <SearchFilterInput label="搜尋" placeholder="搜尋員工編號、姓名或 Email" value={employeeFilters.search} onSearch={(search) => setEmployeeFilters((current) => ({ ...current, search, page: 1 }))} />
        <FilterSelect label="狀態" value={employeeFilters.status} onChange={(event) => setEmployeeFilters((current) => ({ ...current, status: event.target.value, page: 1 }))} options={[{ value: "all", label: "全部狀態" }, { value: "employable", label: "可任職" }, { value: "disabled", label: "已停用帳號" }]} />
      </form>
      {employeeTable.error ? <Alert tone="danger">{employeeTable.error.message}</Alert> : null}
      <div className="table-scroll"><table className="data-table"><thead><tr>
        <SortableHeader label="員工" field="name" active={employeeFilters.sortField} direction={employeeFilters.sortDirection} onSort={(sortField, sortDirection) => setEmployeeFilters((current) => ({ ...current, sortField, sortDirection, page: 1 }))} />
        <th>目前任職</th><th>勞保</th><th>健保</th><th>眷屬</th><th>資料提醒</th><th>操作</th>
      </tr></thead><tbody>
        {(employeeTable.data?.employees ?? []).map((employee) => <InsuranceRow key={employee.userId} employee={employee} canWrite={canWrite} onEdit={setEditing} />)}
      </tbody></table></div>
      {!employeeTable.data?.employees.length ? <p className="empty-state">{employeeTable.data?.total ? "沒有符合條件的員工。" : "尚無員工。"}</p> : null}
      {employeeTable.data && employeeTable.data.total > 0 ? <Pager page={employeeTable.data.page} pageSize={employeeTable.data.pageSize} pageSizes={EMPLOYEE_PAGE_SIZES} totalPages={Math.max(1, Math.ceil(employeeTable.data.total / employeeTable.data.pageSize))} totalLabel={`共 ${employeeTable.data.total.toLocaleString("zh-TW")} 位`} onPage={(page) => setEmployeeFilters((current) => ({ ...current, page }))} onPageSize={(pageSize) => setEmployeeFilters((current) => ({ ...current, pageSize, page: 1 }))} /> : null}
    </Panel>
    {editing ? <InsuranceEditor employment={editing.employment} existing={editing.existing} defaultSalary={editing.defaultSalary} defaultDependentCount={editing.dependentCount} onClose={() => setEditing(null)} /> : null}
    {rateManagementOpen ? <InsuranceRateManagementDialog year={Number(year)} onClose={() => setRateManagementOpen(false)} /> : null}
  </div>;
}
