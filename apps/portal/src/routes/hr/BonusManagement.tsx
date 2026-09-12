import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { Alert, Button, Dialog, FilterSelect, PageHeader, Panel, SearchFilterInput, SelectField, TextField } from "../../ui/index.js";
import { useToast } from "../../shell/Toast.js";
import { Pager } from "../../shell/Pager.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { useHrQuery, useHrWrite, type BonusAssignment, type BonusPolicy, type Employee, type NamedOption } from "./api.js";

interface EmployeeListResponse { employees: Employee[] }
interface PolicyResponse { policies: BonusPolicy[]; total: number; page: number; pageSize: number; hasMore: boolean }
interface AssignmentResponse { assignments: BonusAssignment[] }
interface ScopeResponse { scopes: NamedOption[] }
interface PolicyWriteResult { policyId: string; policyVersionId: string; versionNumber?: number; assignmentCount?: number }

const BONUS_KIND_LABEL = { team_performance: "團體績效", individual_performance: "個人績效" } as const;
const PERIOD_LABEL = { current_month: "當月業績", previous_month: "前月業績" } as const;

function money(minor: number): string {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}

function nextDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function HrBonusManagement() {
  usePageTitle("獎金管理");
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.roles.includes("admin") ?? false;
  const canRead = isHrAdministrator && permissions.has("hr:bonus:read");
  const canWrite = isHrAdministrator && permissions.has("hr:bonus:write");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  const [policyModalOpen, setPolicyModalOpen] = useState(false);
  const [filters, setFilters] = useState({ page: 1, pageSize: 25, search: "", scopeId: "all", bonusKind: "all", performancePeriod: "all" });
  const [policyName, setPolicyName] = useState("");
  const [policyScopeId, setPolicyScopeId] = useState("");
  const [bonusKind, setBonusKind] = useState<BonusPolicy["bonusKind"]>("team_performance");
  const [performancePeriod, setPerformancePeriod] = useState<BonusPolicy["performancePeriod"]>("current_month");
  const [ratePercent, setRatePercent] = useState("5");
  const [guarantee, setGuarantee] = useState("0");
  const [assignmentValidFrom, setAssignmentValidFrom] = useState(today);
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);
  const [editingPolicyVersionId, setEditingPolicyVersionId] = useState<string | null>(null);
  const [deletingPolicy, setDeletingPolicy] = useState<BonusPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);

  const employees = useHrQuery<EmployeeListResponse>("/employees?page=1&pageSize=100&status=active&sortField=name&sortDirection=asc", canRead && permissions.has("hr:employee:read"));
  const scopes = useHrQuery<ScopeResponse>("/scopes", canRead && permissions.has("hr:employee:read"));
  const policies = useHrQuery<PolicyResponse>(`/bonus/policies?page=${filters.page}&pageSize=${filters.pageSize}&search=${encodeURIComponent(filters.search)}&scopeId=${encodeURIComponent(filters.scopeId)}&bonusKind=${filters.bonusKind}&performancePeriod=${filters.performancePeriod}`, canRead);
  const assignments = useHrQuery<AssignmentResponse>("/bonus/assignments", canRead);
  const writePolicy = useHrWrite<PolicyWriteResult>();
  const deletePolicy = useHrWrite<{ policyId: string; deleted: boolean }>();
  const toast = useToast();
  if (!canRead) return <Alert tone="danger">獎金資料僅限全平台 HR 管理者查看。</Alert>;

  const employeeOptions = (employees.data?.employees ?? []).map((employee) => ({ label: `${employee.displayName}（${employee.employeeNumber}）`, value: employee.userId }));
  const scopeOptions = (scopes.data?.scopes ?? []).map((scope) => ({ label: scope.name, value: scope.id }));
  const assignmentsByVersion = new Map<string, string[]>();
  for (const item of assignments.data?.assignments ?? []) assignmentsByVersion.set(item.policyVersionId, [...(assignmentsByVersion.get(item.policyVersionId) ?? []), item.employeeName]);

  function fail(cause: Error) { setError(cause.message); }
  function succeed(text: string) { setError(null); toast.show(text); }
  function updateFilters(patch: Partial<typeof filters>) { setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 })); }

  function resetPolicyForm() {
    setEditingPolicyVersionId(null);
    setPolicyName("");
    setPolicyScopeId("");
    setBonusKind("team_performance");
    setPerformancePeriod("current_month");
    setRatePercent("5");
    setGuarantee("0");
    setAssignmentValidFrom(today);
    setSelectedEmployeeIds([]);
  }

  function openCreate() {
    resetPolicyForm();
    setError(null);
    setPolicyModalOpen(true);
  }

  function closePolicyModal() {
    if (!writePolicy.isPending) setPolicyModalOpen(false);
  }

  function startEdit(policy: BonusPolicy) {
    setError(null);
    setEditingPolicyVersionId(policy.policyVersionId);
    setPolicyName(policy.policyName);
    setPolicyScopeId(policy.scopeId);
    setBonusKind(policy.bonusKind);
    setPerformancePeriod(policy.performancePeriod);
    setRatePercent((policy.ratePpm / 10_000).toString());
    setGuarantee((policy.guaranteeMinor / 100).toString());
    setAssignmentValidFrom(today > policy.validFrom ? today : nextDate(policy.validFrom));
    setSelectedEmployeeIds([]);
    setPolicyModalOpen(true);
  }

  function toggleEmployee(employeeUserId: string) {
    setSelectedEmployeeIds((current) => current.includes(employeeUserId) ? current.filter((id) => id !== employeeUserId) : [...current, employeeUserId]);
  }

  function submitPolicy(event: React.FormEvent) {
    event.preventDefault();
    const rate = Number(ratePercent);
    const amount = Number(guarantee);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100 || !Number.isSafeInteger(amount) || amount < 0) { setError("請輸入有效的百分比與保底金額。"); return; }
    const values = { name: policyName, scopeId: policyScopeId, bonusKind, performancePeriod, ratePpm: Math.round(rate * 10_000), guaranteeMinor: amount * 100, ...(editingPolicyVersionId ? {} : { employeeUserIds: selectedEmployeeIds, assignmentValidFrom }) };
    const editing = editingPolicyVersionId !== null;
    writePolicy.mutate({ path: editing ? `/bonus/policies/${editingPolicyVersionId}` : "/bonus/policies", method: editing ? "PATCH" : "POST", values: editing ? { ...values, validFrom: assignmentValidFrom } : values }, { onSuccess: (result) => { setPolicyModalOpen(false); resetPolicyForm(); succeed(editing ? "policy 已更新，系統建立了新的版本。" : `獎金 policy 已建立${result.assignmentCount ? `，並套用到 ${result.assignmentCount} 位員工` : ""}。`); }, onError: fail });
  }

  function confirmDelete() {
    if (!deletingPolicy) return;
    deletePolicy.mutate({ path: `/bonus/policies/${deletingPolicy.policyVersionId}`, method: "DELETE", values: {} }, { onSuccess: () => { if (editingPolicyVersionId === deletingPolicy.policyVersionId) { resetPolicyForm(); setPolicyModalOpen(false); } setDeletingPolicy(null); succeed("policy 已停用；歷史薪資結果不受影響。"); }, onError: fail });
  }

  return <div className="page fills">
    <PageHeader title="獎金管理" actions={canWrite ? <Button icon="plus" onClick={openCreate}>新增 policy</Button> : undefined} />
    {error ? <Alert tone="danger">{error}</Alert> : null}

    <Panel className="grows" title="現有 policy">
      {policies.error ? <Alert tone="danger">{policies.error.message}</Alert> : null}
      {assignments.error ? <Alert tone="danger">{assignments.error.message}</Alert> : null}
      <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
        <SearchFilterInput label="搜尋" placeholder="搜尋政策名稱或通路" value={filters.search} onSearch={(search) => updateFilters({ search })} />
        <FilterSelect label="通路" value={filters.scopeId} options={[{ value: "all", label: "全部通路" }, ...scopeOptions]} onChange={(event) => updateFilters({ scopeId: event.target.value })} />
        <FilterSelect label="績效歸屬" value={filters.bonusKind} options={[{ value: "all", label: "全部績效歸屬" }, ...Object.entries(BONUS_KIND_LABEL).map(([value, label]) => ({ value, label }))]} onChange={(event) => updateFilters({ bonusKind: event.target.value })} />
        <FilterSelect label="業績期間" value={filters.performancePeriod} options={[{ value: "all", label: "全部業績期間" }, ...Object.entries(PERIOD_LABEL).map(([value, label]) => ({ value, label }))]} onChange={(event) => updateFilters({ performancePeriod: event.target.value })} />
      </form>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>名稱</th><th>績效歸屬</th><th>業績期間</th><th>通路</th><th>套用員工</th><th className="numeric">比例</th><th className="numeric">保底</th><th>版本</th><th>操作</th></tr></thead><tbody>{(policies.data?.policies ?? []).map((policy) => <tr key={policy.policyVersionId}><td data-label="名稱"><strong>{policy.policyName}</strong></td><td data-label="績效歸屬">{BONUS_KIND_LABEL[policy.bonusKind]}</td><td data-label="業績期間">{PERIOD_LABEL[policy.performancePeriod]}</td><td data-label="通路">{policy.scopeName}</td><td data-label="套用員工">{assignmentsByVersion.get(policy.policyVersionId)?.join("、") ?? "尚未指派"}</td><td data-label="比例" className="numeric">{(policy.ratePpm / 10_000).toFixed(2)}%</td><td data-label="保底" className="numeric">{money(policy.guaranteeMinor)}</td><td data-label="版本">v{policy.versionNumber}</td><td data-label="操作">{canWrite ? <div className="row-actions"><Button variant="icon" icon="edit" title={`編輯 ${policy.policyName} v${policy.versionNumber}`} aria-label={`編輯 ${policy.policyName} v${policy.versionNumber}`} onClick={() => startEdit(policy)} /><Button variant="icon" icon="trash" title={`刪除 ${policy.policyName}`} aria-label={`刪除 ${policy.policyName}`} className="danger" onClick={() => setDeletingPolicy(policy)} /></div> : <span className="muted">—</span>}</td></tr>)}</tbody></table></div>
      {policies.isPending ? <p className="muted table-note">載入中…</p> : null}
      {policies.data && !policies.data.policies.length ? <p className="muted table-note">沒有符合條件的 policy。</p> : null}
      {policies.data && policies.data.total > 0 ? <Pager page={policies.data.page} pageSize={policies.data.pageSize} pageSizes={[10, 25, 50, 100]} totalPages={Math.max(1, Math.ceil(policies.data.total / policies.data.pageSize))} totalLabel={`共 ${policies.data.total.toLocaleString("zh-TW")} 筆`} onPage={(page) => updateFilters({ page })} onPageSize={(pageSize) => updateFilters({ pageSize })} /> : null}
    </Panel>

    {policyModalOpen ? <Dialog className="hr-bonus-policy-dialog" title={editingPolicyVersionId ? "編輯獎金 policy" : "新增獎金 policy"} titleMeta={editingPolicyVersionId ? "保存後會建立新的版本" : "可在建立時直接套用員工"} onClose={closePolicyModal} closeDisabled={writePolicy.isPending} formProps={{ onSubmit: submitPolicy }} actions={<><Button variant="secondary" onClick={closePolicyModal} disabled={writePolicy.isPending}>取消</Button><Button type="submit" icon={editingPolicyVersionId ? "edit" : "plus"} loading={writePolicy.isPending}>{editingPolicyVersionId ? "保存新版本" : "建立 policy"}</Button></>}>
      <div className="admin-form hr-bonus-form">
        {employees.error ? <Alert tone="danger">{employees.error.message}</Alert> : null}
        {scopes.error ? <Alert tone="danger">{scopes.error.message}</Alert> : null}
        <TextField label="政策名稱" value={policyName} maxLength={100} required onChange={(event) => setPolicyName(event.target.value)} />
        <SelectField label="適用通路／櫃點" value={policyScopeId} options={[{ label: "請選擇", value: "" }, ...scopeOptions]} required onChange={(event) => setPolicyScopeId(event.target.value)} />
        <SelectField label="績效歸屬" value={bonusKind} options={Object.entries(BONUS_KIND_LABEL).map(([value, label]) => ({ value, label }))} onChange={(event) => setBonusKind(event.target.value as BonusPolicy["bonusKind"])} />
        <SelectField label="業績期間" value={performancePeriod} options={Object.entries(PERIOD_LABEL).map(([value, label]) => ({ value, label }))} onChange={(event) => setPerformancePeriod(event.target.value as BonusPolicy["performancePeriod"])} />
        <TextField label="百分比（%）" type="number" min="0" max="100" step="0.01" value={ratePercent} required onChange={(event) => setRatePercent(event.target.value)} />
        <TextField label="保底金額（元）" type="number" min="0" step="1" value={guarantee} hint="業績先扣除保底，剩餘金額再乘百分比；沒有保底請填 0。" required onChange={(event) => setGuarantee(event.target.value)} />
        {!editingPolicyVersionId ? <>
          <div className="field hr-bonus-member-field"><span>建立時套用員工</span><small>可複選；不選也可以先建立 policy，之後由其他流程套用。</small><div className="hr-bonus-member-picker">{employeeOptions.length ? employeeOptions.map((employee) => <label key={employee.value} className="hr-bonus-member-option"><input type="checkbox" checked={selectedEmployeeIds.includes(employee.value)} onChange={() => toggleEmployee(employee.value)} /><span>{employee.label}</span></label>) : <span className="muted">目前沒有可套用的在職員工。</span>}</div></div>
          <TextField label="員工套用生效日" type="date" value={assignmentValidFrom} required={selectedEmployeeIds.length > 0} disabled={selectedEmployeeIds.length === 0} onChange={(event) => setAssignmentValidFrom(event.target.value)} />
        </> : <p className="muted hr-bonus-edit-note">編輯會建立新的規則版本，既有員工套用會自動銜接到新版本。</p>}
      </div>
    </Dialog> : null}

    {deletingPolicy ? <Dialog title="刪除獎金 policy？" role="alertdialog" onClose={() => { if (!deletePolicy.isPending) setDeletingPolicy(null); }} closeDisabled={deletePolicy.isPending} actions={<><Button variant="secondary" onClick={() => setDeletingPolicy(null)} disabled={deletePolicy.isPending}>取消</Button><Button variant="danger" icon="trash" loading={deletePolicy.isPending} onClick={confirmDelete}>刪除 policy</Button></>}><p>「{deletingPolicy.policyName} v{deletingPolicy.versionNumber}」將停用，不再套用到新的薪資計算；已保存的歷史薪資不會被刪除。</p></Dialog> : null}
  </div>;
}
