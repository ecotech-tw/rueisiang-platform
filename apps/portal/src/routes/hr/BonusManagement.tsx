import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { Alert, Button, Dialog, DropdownSelect, FilterSelect, PageHeader, Panel, SearchFilterInput, SelectField, TextField } from "../../ui/index.js";
import { Link } from "react-router";
import { useToast } from "../../shell/Toast.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Pager } from "../../shell/Pager.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { HR_ROSTER_PATH, useHrQuery, useHrWrite, type BonusAssignment, type BonusPolicy, type Employee, type NamedOption } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

interface EmployeeListResponse { employees: Employee[] }
interface PolicyResponse { policies: BonusPolicy[]; total: number; page: number; pageSize: number; hasMore: boolean }
interface AssignmentResponse { assignments: BonusAssignment[] }
interface ScopeResponse { scopes: NamedOption[] }
interface PolicyWriteResult { policyId: string; policyVersionId: string; assignmentCount?: number }

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
  const isHrAdministrator = user?.isHrAdministrator ?? false;
  const canRead = isHrAdministrator && permissions.has("hr:bonus:read");
  const canWrite = isHrAdministrator && permissions.has("hr:bonus:write");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  const [policyModalOpen, setPolicyModalOpen] = useState(false);
  const [filters, setFilters] = useState({ page: 1, pageSize: 25, search: "", scopeId: "all", bonusKind: "all", performancePeriod: "all" });
  const [policyName, setPolicyName] = useState("");
  const [policyScopeIds, setPolicyScopeIds] = useState<string[]>([]);
  const [bonusKind, setBonusKind] = useState<BonusPolicy["bonusKind"]>("team_performance");
  const [performancePeriod, setPerformancePeriod] = useState<BonusPolicy["performancePeriod"]>("current_month");
  const [ratePercent, setRatePercent] = useState("5");
  const [guarantee, setGuarantee] = useState("0");
  const [assignmentValidFrom, setAssignmentValidFrom] = useState(today);
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);
  const [selectedEmployeeWeights, setSelectedEmployeeWeights] = useState<Record<string, string>>({});
  const [editingPolicy, setEditingPolicy] = useState<BonusPolicy | null>(null);
  const [deletingPolicy, setDeletingPolicy] = useState<BonusPolicy | null>(null);
  const [voidConfirmation, setVoidConfirmation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editingPolicyVersionId = editingPolicy?.policyVersionId ?? null;
  // 第一版沒有可以回去的上一版；整個獎金設錯要用刪除，不是解除。
  const canVoidEditingPolicy = editingPolicy !== null && editingPolicy.versionNumber > 1 && editingPolicy.isLatest !== false;

  const employees = useHrQuery<EmployeeListResponse>(HR_ROSTER_PATH, canRead && permissions.has("hr:employee:read"));
  const scopes = useHrQuery<ScopeResponse>("/scopes", canRead && permissions.has("hr:employee:read"));
  const policies = useHrQuery<PolicyResponse>(`/bonus/policies?page=${filters.page}&pageSize=${filters.pageSize}&search=${encodeURIComponent(filters.search)}&scopeId=${encodeURIComponent(filters.scopeId)}&bonusKind=${filters.bonusKind}&performancePeriod=${filters.performancePeriod}`, canRead);
  const assignments = useHrQuery<AssignmentResponse>("/bonus/assignments", canRead);
  const writePolicy = useHrWrite<PolicyWriteResult>();
  const deletePolicy = useHrWrite<{ policyId: string; deleted: boolean }>();
  const voidPolicyVersion = useHrWrite<{ policyId: string; policyVersionId: string; previousPolicyVersionId: string }>();
  const toast = useToast();
  if (!canRead) return <Alert tone="danger">獎金資料僅限全平台 HR 管理者查看。</Alert>;
  if (policies.isPending || assignments.isPending || employees.isPending || scopes.isPending) return <HrPageSkeleton variant="table" />;

  const employeeOptions = (employees.data?.employees ?? []).map((employee) => ({ label: `${employee.displayName}（${employee.employeeNumber}）`, value: employee.userId }));
  const scopeOptions = (scopes.data?.scopes ?? []).map((scope) => ({ label: scope.name, value: scope.id }));
  const assignmentsByVersion = new Map<string, BonusAssignment[]>();
  for (const item of assignments.data?.assignments ?? []) assignmentsByVersion.set(item.policyVersionId, [...(assignmentsByVersion.get(item.policyVersionId) ?? []), item]);

  function fail(cause: Error) { setError(cause.message); }
  function succeed(text: string) { setError(null); toast.show(text); }
  function updateFilters(patch: Partial<typeof filters>) { setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 })); }

  function resetPolicyForm() {
    setEditingPolicy(null);
    setVoidConfirmation(false);
    setPolicyName("");
    setPolicyScopeIds([]);
    setBonusKind("team_performance");
    setPerformancePeriod("current_month");
    setRatePercent("5");
    setGuarantee("0");
    setAssignmentValidFrom(today);
    setSelectedEmployeeIds([]);
    setSelectedEmployeeWeights({});
  }

  function openCreate() {
    resetPolicyForm();
    setError(null);
    setPolicyModalOpen(true);
  }

  function closePolicyModal() {
    if (!writePolicy.isPending && !voidPolicyVersion.isPending) setPolicyModalOpen(false);
  }

  function startEdit(policy: BonusPolicy) {
    setError(null);
    setEditingPolicy(policy);
    setPolicyName(policy.policyName);
    setPolicyScopeIds(policy.scopeIds?.length ? policy.scopeIds : [policy.scopeId]);
    setBonusKind(policy.bonusKind);
    setPerformancePeriod(policy.performancePeriod);
    setRatePercent((policy.ratePpm / 10_000).toString());
    setGuarantee((policy.guaranteeMinor / 100).toString());
    setAssignmentValidFrom(today > policy.validFrom ? today : nextDate(policy.validFrom));
    const policyAssignments = (assignments.data?.assignments ?? []).filter((assignment) => assignment.policyVersionId === policy.policyVersionId);
    setSelectedEmployeeIds(policyAssignments.map((assignment) => assignment.employeeUserId));
    setSelectedEmployeeWeights(Object.fromEntries(policyAssignments.map((assignment) => [assignment.employeeUserId, String(assignment.assignment.weightUnits)])));
    setPolicyModalOpen(true);
  }

  function addScope() {
    const next = scopeOptions.find((scope) => !policyScopeIds.includes(scope.value));
    if (next) setPolicyScopeIds((current) => [...current, next.value]);
  }
  function updateScope(index: number, scopeId: string) {
    setPolicyScopeIds((current) => current.map((value, currentIndex) => currentIndex === index ? scopeId : value));
  }
  function removeScope(index: number) {
    setPolicyScopeIds((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }
  function addEmployee() {
    const next = employeeOptions.find((employee) => !selectedEmployeeIds.includes(employee.value));
    if (!next) return;
    setSelectedEmployeeIds((current) => [...current, next.value]);
    setSelectedEmployeeWeights((current) => ({ ...current, [next.value]: current[next.value] ?? "1" }));
  }
  function updateEmployee(index: number, employeeUserId: string) {
    setSelectedEmployeeIds((current) => {
      const previous = current[index];
      const nextIds = current.map((value, currentIndex) => currentIndex === index ? employeeUserId : value);
      setSelectedEmployeeWeights((weights) => {
        const next = { ...weights, [employeeUserId]: weights[employeeUserId] ?? (previous ? weights[previous] : undefined) ?? "1" };
        if (previous && previous !== employeeUserId) delete next[previous];
        return next;
      });
      return nextIds;
    });
  }
  function removeEmployee(index: number) {
    setSelectedEmployeeIds((current) => {
      const employeeUserId = current[index];
      setSelectedEmployeeWeights((weights) => {
        if (!employeeUserId) return weights;
        const next = { ...weights };
        delete next[employeeUserId];
        return next;
      });
      return current.filter((_, currentIndex) => currentIndex !== index);
    });
  }
  function updateEmployeeWeight(employeeUserId: string, value: string) {
    setSelectedEmployeeWeights((current) => ({ ...current, [employeeUserId]: value }));
  }

  function submitPolicy(event: React.FormEvent) {
    event.preventDefault();
    const rate = Number(ratePercent);
    const amount = Number(guarantee);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100 || !Number.isSafeInteger(amount) || amount < 0) { setError("請輸入有效的百分比與保底金額。"); return; }
    if (!policyScopeIds.length) { setError("至少選擇一個適用 Scope。"); return; }
    const employeeAssignments = selectedEmployeeIds.map((employeeUserId) => ({ employeeUserId, weightUnits: Number(selectedEmployeeWeights[employeeUserId] ?? "1") }));
    if (bonusKind === "team_performance" && employeeAssignments.some((assignment) => !Number.isSafeInteger(assignment.weightUnits) || assignment.weightUnits < 1 || assignment.weightUnits > 1000)) { setError("團體績效的員工權重必須是 1～1000 的整數。"); return; }
    const assignmentValues = bonusKind === "team_performance" ? { employeeAssignments, assignmentValidFrom } : { employeeUserIds: selectedEmployeeIds, assignmentValidFrom };
    const values = { name: policyName, scopeIds: policyScopeIds, scopeId: policyScopeIds[0], bonusKind, performancePeriod, ratePpm: Math.round(rate * 10_000), guaranteeMinor: amount * 100, ...assignmentValues };
    const editing = editingPolicyVersionId !== null;
    writePolicy.mutate({ path: editing ? `/bonus/policies/${editingPolicyVersionId}` : "/bonus/policies", method: editing ? "PATCH" : "POST", values: editing ? { ...values, validFrom: assignmentValidFrom } : values }, { onSuccess: (result) => { setPolicyModalOpen(false); resetPolicyForm(); succeed(editing ? "獎金已更新。" : `獎金已建立${result.assignmentCount ? `，並套用到 ${result.assignmentCount} 位員工` : ""}。`); }, onError: fail });
  }

  function confirmDelete() {
    if (!deletingPolicy) return;
    deletePolicy.mutate({ path: `/bonus/policies/${deletingPolicy.policyVersionId}`, method: "DELETE", values: {} }, { onSuccess: () => { if (editingPolicyVersionId === deletingPolicy.policyVersionId) { resetPolicyForm(); setPolicyModalOpen(false); } setDeletingPolicy(null); succeed("獎金已停用；歷史薪資結果不受影響。"); }, onError: fail });
  }

  function confirmVoid() {
    if (!editingPolicy) return;
    voidPolicyVersion.mutate({ path: `/bonus/policies/${editingPolicy.policyVersionId}/void`, method: "POST", values: {} }, {
      onSuccess: () => { setVoidConfirmation(false); setPolicyModalOpen(false); resetPolicyForm(); succeed("已解除最新的獎金版本，規則回到上一版。"); },
      onError: (cause) => { setVoidConfirmation(false); fail(cause); },
    });
  }

  function assignmentSummary(policyVersionId: string) {
    const rows = assignmentsByVersion.get(policyVersionId) ?? [];
    if (!rows.length) return <span className="muted">尚未指派</span>;
    const totalWeight = rows.reduce((sum, item) => sum + item.assignment.weightUnits, 0);
    const names = rows.slice(0, 2).map((item) => item.employeeName).join("、");
    return <div className="hr-bonus-assignment-summary"><span>{rows.length} 位員工{totalWeight > rows.length ? ` · ${totalWeight} 份` : ""}</span><small>{names}{rows.length > 2 ? ` 等 ${rows.length} 位` : ""}</small></div>;
  }

  return <div className="page fills">
    <PageHeader title="獎金管理" actions={canWrite ? <Button icon="plus" className="add-action" onClick={openCreate}>新增獎金</Button> : undefined} />
    {/*
      * 業績沒匯入時薪資試算會提醒，但那是算完才看得到。規則是在這一頁設定的，所以
      * 先在這裡講清楚錢從哪裡來——不然設完規則的人不會知道還有一份出金表要先跑。
      */}
    <Alert tone="info">獎金的業績來源是<strong>出金表</strong>。某個月的出金還沒匯入，那幾天就會按 0 計算，薪資試算會逐項提醒。匯入請到 <Link to="/tools/reports">營運工具 → 報表執行</Link>。</Alert>
    {error ? <Alert tone="danger">{error}</Alert> : null}

    <Panel className="grows hr-bonus-panel">
      {policies.error ? <Alert tone="danger">{policies.error.message}</Alert> : null}
      {assignments.error ? <Alert tone="danger">{assignments.error.message}</Alert> : null}
      <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
        <SearchFilterInput label="搜尋" placeholder="搜尋獎金名稱或通路" value={filters.search} onSearch={(search) => updateFilters({ search })} />
        <FilterSelect label="通路" value={filters.scopeId} options={[{ value: "all", label: "全部通路" }, ...scopeOptions]} onChange={(event) => updateFilters({ scopeId: event.target.value })} />
        <FilterSelect label="績效歸屬" value={filters.bonusKind} options={[{ value: "all", label: "全部績效歸屬" }, ...Object.entries(BONUS_KIND_LABEL).map(([value, label]) => ({ value, label }))]} onChange={(event) => updateFilters({ bonusKind: event.target.value })} />
        <FilterSelect label="業績期間" value={filters.performancePeriod} options={[{ value: "all", label: "全部業績期間" }, ...Object.entries(PERIOD_LABEL).map(([value, label]) => ({ value, label }))]} onChange={(event) => updateFilters({ performancePeriod: event.target.value })} />
      </form>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>名稱</th><th>績效歸屬</th><th>業績期間</th><th>通路</th><th>套用員工</th><th className="numeric">比例</th><th className="numeric">保底</th><th>操作</th></tr></thead><tbody>{(policies.data?.policies ?? []).map((policy) => <tr key={policy.policyVersionId}><td data-label="名稱"><strong>{policy.policyName}</strong></td><td data-label="績效歸屬">{BONUS_KIND_LABEL[policy.bonusKind]}</td><td data-label="業績期間">{PERIOD_LABEL[policy.performancePeriod]}</td><td data-label="通路">{(policy.scopeNames?.length ? policy.scopeNames : [policy.scopeName]).join("、")}</td><td data-label="套用員工">{assignmentSummary(policy.policyVersionId)}</td><td data-label="比例" className="numeric">{(policy.ratePpm / 10_000).toFixed(2)}%</td><td data-label="保底" className="numeric">{money(policy.guaranteeMinor)}</td><td data-label="操作">{canWrite ? <div className="row-actions"><Button variant="icon" icon="edit" className="compensation-action-update" title={`編輯 ${policy.policyName}`} aria-label={`編輯 ${policy.policyName}`} disabled={policy.isLatest === false} onClick={() => startEdit(policy)} /><Button variant="icon" icon="trash" title={`刪除 ${policy.policyName}`} aria-label={`刪除 ${policy.policyName}`} className="danger hr-row-action-delete" onClick={() => setDeletingPolicy(policy)} /></div> : <span className="muted">—</span>}</td></tr>)}</tbody></table></div>
      {policies.isPlaceholderData ? <p className="muted table-note">載入中…</p> : null}
      {policies.data && !policies.data.policies.length ? <p className="muted table-note">沒有符合條件的獎金。</p> : null}
      {policies.data && policies.data.total > 0 ? <Pager page={policies.data.page} pageSize={policies.data.pageSize} pageSizes={[10, 25, 50, 100]} totalPages={Math.max(1, Math.ceil(policies.data.total / policies.data.pageSize))} totalLabel={`共 ${policies.data.total.toLocaleString("zh-TW")} 筆`} onPage={(page) => updateFilters({ page })} onPageSize={(pageSize) => updateFilters({ pageSize })} /> : null}
    </Panel>

    {policyModalOpen ? <Dialog className="hr-bonus-policy-dialog" title={editingPolicyVersionId ? "編輯獎金" : "新增獎金"} titleMeta={editingPolicyVersionId ? "調整後會套用到新的薪資計算" : "可在建立時直接套用員工"} onClose={closePolicyModal} closeDisabled={writePolicy.isPending} formProps={{ onSubmit: submitPolicy }} actions={<><Button variant="secondary" onClick={closePolicyModal} disabled={writePolicy.isPending || voidPolicyVersion.isPending}>取消</Button>{canVoidEditingPolicy ? <Button type="button" variant="danger" icon="history" className="hr-bonus-action-void" disabled={writePolicy.isPending || voidPolicyVersion.isPending} onClick={() => setVoidConfirmation(true)}>解除最新版本</Button> : null}<Button type="submit" icon={editingPolicyVersionId ? "edit" : "plus"} loading={writePolicy.isPending} disabled={voidPolicyVersion.isPending}>{editingPolicyVersionId ? "保存變更" : "建立獎金"}</Button></>}>
      <div className="admin-form hr-bonus-form">
        {employees.error ? <Alert tone="danger">{employees.error.message}</Alert> : null}
        {scopes.error ? <Alert tone="danger">{scopes.error.message}</Alert> : null}
        <TextField label="獎金名稱" value={policyName} maxLength={100} required onChange={(event) => setPolicyName(event.target.value)} />
        <div className="field hr-bonus-scope-field"><span>適用通路／櫃點</span><small>按新增後選擇通路；同一獎金可複選多個通路或櫃點，業績會先合計後只扣一次保底。</small><div className="hr-bonus-picker-list">{policyScopeIds.map((scopeId, index) => <div key={`${scopeId}-${index}`} className="hr-bonus-picker-row"><DropdownSelect value={scopeId} aria-label="選擇通路" options={scopeOptions.map((scope) => ({ ...scope, disabled: policyScopeIds.includes(scope.value) && scope.value !== scopeId }))} onChange={(event) => updateScope(index, event.target.value)} /><Button type="button" variant="icon" icon="trash" aria-label="移除通路" title="移除通路" onClick={() => removeScope(index)} /></div>)}{policyScopeIds.length === 0 ? <p className="muted hr-bonus-picker-empty">尚未選擇通路。</p> : null}<Button type="button" variant="chip-action" icon="plus" onClick={addScope} disabled={policyScopeIds.length >= scopeOptions.length}>{policyScopeIds.length ? "新增通路" : "新增第一個通路"}</Button></div></div>
        <SelectField label="績效歸屬" value={bonusKind} options={Object.entries(BONUS_KIND_LABEL).map(([value, label]) => ({ value, label }))} onChange={(event) => setBonusKind(event.target.value as BonusPolicy["bonusKind"])} />
        <SelectField label="業績期間" value={performancePeriod} options={Object.entries(PERIOD_LABEL).map(([value, label]) => ({ value, label }))} onChange={(event) => setPerformancePeriod(event.target.value as BonusPolicy["performancePeriod"])} />
        <TextField label="百分比（%）" type="number" min="0" max="100" step="0.01" value={ratePercent} required onChange={(event) => setRatePercent(event.target.value)} />
        <TextField label="保底金額（元）" type="number" min="0" step="1" value={guarantee} required onChange={(event) => setGuarantee(event.target.value)} />
        <>
          <div className="field hr-bonus-member-field"><span>{editingPolicyVersionId ? "套用員工與權重" : "建立時套用員工"}</span><small>{bonusKind === "team_performance" ? "按新增後選擇員工並調整分配權重；保存時會按這份清單建立套用紀錄。" : "按新增後選擇員工；個人績效不使用分配權重。"}</small><div className="hr-bonus-picker-list">{selectedEmployeeIds.map((employeeUserId, index) => {
            const employee = employeeOptions.find((option) => option.value === employeeUserId);
            return <div key={`${employeeUserId}-${index}`} className="hr-bonus-picker-row hr-bonus-employee-row"><DropdownSelect value={employeeUserId} aria-label="選擇員工" options={employeeOptions.map((option) => ({ ...option, disabled: selectedEmployeeIds.includes(option.value) && option.value !== employeeUserId }))} onChange={(event) => updateEmployee(index, event.target.value)} />{bonusKind === "team_performance" ? <div className="hr-bonus-weight-field"><input className="hr-bonus-weight-input" type="number" min="1" max="1000" step="1" value={selectedEmployeeWeights[employeeUserId] ?? "1"} aria-label={`${employee?.label ?? "員工"} 權重`} onChange={(event) => updateEmployeeWeight(employeeUserId, event.target.value)} /><span aria-hidden="true">份</span></div> : null}<Button type="button" variant="icon" icon="trash" aria-label="移除員工" title="移除員工" onClick={() => removeEmployee(index)} /></div>;
          })}{selectedEmployeeIds.length === 0 ? <p className="muted hr-bonus-picker-empty">尚未套用員工。</p> : null}<Button type="button" variant="chip-action" icon="plus" onClick={addEmployee} disabled={selectedEmployeeIds.length >= employeeOptions.length}>{selectedEmployeeIds.length ? "新增員工" : "新增第一位員工"}</Button></div></div>
          <TextField label={editingPolicyVersionId ? "變更生效日" : "員工套用生效日"} type="date" value={assignmentValidFrom} required={editingPolicyVersionId !== null || selectedEmployeeIds.length > 0} disabled={!editingPolicyVersionId && selectedEmployeeIds.length === 0} onChange={(event) => setAssignmentValidFrom(event.target.value)} />
        </>
        {/*
          * 新版本的生效日必須晚於目前版本，所以當天改錯的人在這裡會被擋下來。
          * 那個限制是對的（同一天兩套規則沒有先後），但要在畫面上說出還有解除這條路。
          */}
        {editingPolicy && nextDate(editingPolicy.validFrom) > today
          ? <p className="muted hr-bonus-edit-note">目前這一版從 {editingPolicy.validFrom} 起生效，新版本最早只能從 {nextDate(editingPolicy.validFrom)} 起算。{canVoidEditingPolicy ? "要改掉這一版本身，請改按「解除最新版本」。" : "這是第一版，整個獎金設錯請用列表上的刪除。"}</p>
          : null}
      </div>
    </Dialog> : null}

    {voidConfirmation && editingPolicy ? <ConfirmDialog
      title="解除最新獎金版本？"
      confirmLabel="解除版本"
      pending={voidPolicyVersion.isPending}
      onCancel={() => setVoidConfirmation(false)}
      onConfirm={confirmVoid}
    >
      <p>這會解除「<strong>{editingPolicy.policyName}</strong>」的第 {editingPolicy.versionNumber} 版；資料不會刪除，已結算月份的薪資也不會被改動。</p>
      <p className="muted">解除後規則回到上一版，套用員工也跟著還原；可重複解除，直到只剩第一版。</p>
    </ConfirmDialog> : null}

    {deletingPolicy ? <Dialog title="刪除獎金？" role="alertdialog" onClose={() => { if (!deletePolicy.isPending) setDeletingPolicy(null); }} closeDisabled={deletePolicy.isPending} actions={<><Button variant="secondary" onClick={() => setDeletingPolicy(null)} disabled={deletePolicy.isPending}>取消</Button><Button variant="danger" icon="trash" loading={deletePolicy.isPending} onClick={confirmDelete}>刪除獎金</Button></>}><p>「{deletingPolicy.policyName}」將停用，不再套用到新的薪資計算；已保存的歷史薪資不會被刪除。</p></Dialog> : null}
  </div>;
}
