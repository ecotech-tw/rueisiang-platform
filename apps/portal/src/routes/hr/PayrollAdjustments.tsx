import { useRef, useState, type FormEvent } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, LegacyButton as Button, DataTable, Dialog, EmptyState, FilterInput, FilterToolbar, PageHeader, Panel, SelectField, TextField, Tooltip } from "../../ui/index.js";
import { hrEmployeeLabel, useHrPersonnelRoster, useHrQuery, useHrWrite, type Employee, type PayrollAdjustment } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

interface PayrollAdjustmentsResponse { adjustments: PayrollAdjustment[] }
interface AdjustmentItemDraft { key: string; itemName: string; direction: "earning" | "deduction"; amount: string }

type PersonnelWithEmployment = Employee & { employmentId: string };

export function payrollAdjustmentPersonnelLabel(person: Pick<Employee, "personKind" | "employeeNumber" | "legalName">): string {
  if (person.personKind !== "worker") return hrEmployeeLabel(person);
  const name = person.legalName.trim();
  return name ? `${name}（支援人員）・${person.employeeNumber}` : `${person.employeeNumber}（支援人員）`;
}

function taipeiMonth() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${parts.find((item) => item.type === "year")?.value ?? ""}-${parts.find((item) => item.type === "month")?.value ?? ""}`;
}
function periodLabel(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return match ? `${match[1]} 年 ${Number(match[2])} 月` : value;
}
function signedMoney(minor: number) {
  const sign = minor < 0 ? "-" : "+";
  return `${sign}NT$ ${Math.abs(Math.round(minor / 100)).toLocaleString("zh-TW")}`;
}
function totalMinor(adjustment: PayrollAdjustment) {
  return adjustment.items.reduce((sum, item) => sum + item.amountMinor, 0);
}
function asPersonnelOptions(employees: Employee[]): PersonnelWithEmployment[] {
  return employees.filter((person): person is PersonnelWithEmployment => Boolean(person.employmentId)
    && (person.personKind === "worker" || person.userStatus === "active" || person.userStatus === "invited"));
}
function initialItems(adjustment?: PayrollAdjustment): AdjustmentItemDraft[] {
  if (adjustment?.items.length) return adjustment.items.map((item, index) => ({
    key: `${item.id}-${index}`,
    itemName: item.itemName,
    direction: item.amountMinor < 0 ? "deduction" : "earning",
    amount: String(Math.abs(item.amountMinor) / 100),
  }));
  return [{ key: crypto.randomUUID(), itemName: "", direction: "earning", amount: "" }];
}

function PayrollAdjustmentDialog({
  employees,
  employeesPending,
  employeesError,
  adjustment,
  onClose,
  onSuccess,
}: {
  employees: Employee[];
  employeesPending: boolean;
  employeesError: Error | null;
  adjustment?: PayrollAdjustment;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const personnelOptions = asPersonnelOptions(employees);
  const currentPeriod = taipeiMonth();
  const defaultEffective = adjustment?.effectivePeriodKey ?? currentPeriod;
  const [employmentId, setEmploymentId] = useState(adjustment?.employmentId ?? "");
  const [effectivePeriodKey, setEffectivePeriodKey] = useState(defaultEffective);
  const [reason, setReason] = useState(adjustment?.reason ?? "");
  const [items, setItems] = useState<AdjustmentItemDraft[]>(() => initialItems(adjustment));
  const [validationError, setValidationError] = useState<string | null>(null);
  const save = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);

  function updateItem(key: string, patch: Partial<AdjustmentItemDraft>) {
    setItems((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
  }
  function addItem() {
    setItems((current) => [...current, { key: crypto.randomUUID(), itemName: "", direction: "earning", amount: "" }]);
  }
  function removeItem(key: string) {
    setItems((current) => current.length > 1 ? current.filter((item) => item.key !== key) : current);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!employmentId) { setValidationError("請選擇人員。"); return; }
    if (!effectivePeriodKey) { setValidationError("請選擇生效薪資月份。"); return; }
    if (!reason.trim()) { setValidationError("請填寫加扣項原因。"); return; }
    const payloadItems: Array<{ itemName: string; amountMinor: number }> = [];
    for (const item of items) {
      const amount = Number(item.amount);
      if (!item.itemName.trim()) { setValidationError("每個薪資加扣項都要有名稱。"); return; }
      if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(amount * 100)) { setValidationError(`「${item.itemName || "未命名項目"}」的金額必須是正整數元。`); return; }
      payloadItems.push({ itemName: item.itemName.trim(), amountMinor: (item.direction === "deduction" ? -1 : 1) * amount * 100 });
    }
    setValidationError(null);
    save.mutate({
      path: adjustment ? `/payroll/adjustments/${encodeURIComponent(adjustment.id)}` : "/payroll/adjustments",
      method: adjustment ? "PATCH" : "POST",
      values: { employmentId, effectivePeriodKey, reason: reason.trim(), items: payloadItems, ...(adjustment ? { revision: adjustment.revision } : {}) },
    }, { onSuccess: () => { onSuccess(); (closeRequestRef.current ?? onClose)(); } });
  }

  return <Dialog
    className="hr-payroll-adjustment-dialog"
    title={adjustment ? "編輯薪資加扣項" : "新增薪資加扣項"}
    titleMeta={personnelOptions.find((person) => person.employmentId === employmentId)?.legalName ?? "選擇人員"}
    onClose={onClose}
    closeRequestRef={closeRequestRef}
    closeDisabled={save.isPending}
    formProps={{ onSubmit: submit }}
    actions={<><Button variant="secondary" onClick={onClose} disabled={save.isPending}>取消</Button><Button type="submit" icon="check" className={adjustment ? "hr-action-update" : "add-action"} loading={save.isPending} disabled={employeesPending || !personnelOptions.length}>{adjustment ? "保存加扣項" : "建立加扣項"}</Button></>}
  >
    <p className="form-hint hr-payroll-adjustment-dialog-note">這筆加扣項會在生效月份試算時自動帶入，可用於一次性獎金、補發或扣款。</p>
    <div className="form-grid two">
      <SelectField label="人員" value={employmentId} required searchable options={[{ value: "", label: employeesPending ? "正在載入人員…" : "請選擇人員" }, ...personnelOptions.map((person) => ({ value: person.employmentId, label: payrollAdjustmentPersonnelLabel(person) }))]} onChange={(event) => setEmploymentId(event.target.value)} />
      <TextField label="生效薪資月份" type="month" value={effectivePeriodKey} required onChange={(event) => setEffectivePeriodKey(event.target.value)} />
    </div>
    <div className="hr-payroll-adjustment-items">
      <div className="hr-payroll-adjustment-items-head"><div><strong>薪資加扣項</strong><small>正數為補發／加給，負數為扣款。</small></div><Button type="button" variant="chip-action" icon="plus" className="add-action" onClick={addItem}>新增項目</Button></div>
      <div className="hr-payroll-adjustment-item-list">
        {items.map((item) => <div className="hr-payroll-adjustment-item-row" key={item.key}>
          <SelectField label="類型" value={item.direction} options={[{ value: "earning", label: "補發／加給" }, { value: "deduction", label: "扣款" }]} onChange={(event) => updateItem(item.key, { direction: event.target.value as AdjustmentItemDraft["direction"] })} />
          <TextField label="項目名稱" value={item.itemName} required placeholder="例如：一次性獎金" onChange={(event) => updateItem(item.key, { itemName: event.target.value })} />
          <TextField label="金額（元）" type="number" min="1" step="1" value={item.amount} required onChange={(event) => updateItem(item.key, { amount: event.target.value })} />
          <Tooltip label="移除薪資加扣項" focusable={false}><Button type="button" variant="icon" icon="trash" aria-label="移除薪資加扣項" onClick={() => removeItem(item.key)} disabled={items.length === 1} /></Tooltip>
        </div>)}
      </div>
    </div>
    <TextField label="加扣項原因" value={reason} maxLength={1000} required placeholder="例如：一次性獎金" onChange={(event) => setReason(event.target.value)} />
    {employeesError ? <Alert tone="danger">人員名單載入失敗：{employeesError.message}</Alert> : null}
    {validationError || save.error ? <Alert tone="danger">{validationError ?? save.error?.message}</Alert> : null}
  </Dialog>;
}

export function HrPayrollAdjustments() {
  usePageTitle("薪資加扣項");
  const { permissions, user } = useSession();
  const canRead = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:read"));
  const canCalculate = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:calculate"));
  const [effectivePeriodKey, setEffectivePeriodKey] = useState("");
  const [editing, setEditing] = useState<PayrollAdjustment | null>(null);
  const [deleting, setDeleting] = useState<PayrollAdjustment | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const remove = useHrWrite();
  const adjustments = useHrQuery<PayrollAdjustmentsResponse>(`/payroll/adjustments${effectivePeriodKey ? `?effectivePeriodKey=${encodeURIComponent(effectivePeriodKey)}` : ""}`, canRead);
  const employees = useHrPersonnelRoster(canCalculate);

  if (!canRead) return <Alert tone="danger">薪資資料僅限全平台 HR 管理者查看。</Alert>;
  if (adjustments.isPending) return <HrPageSkeleton variant="table" />;

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(adjustment: PayrollAdjustment) {
    setEditing(adjustment);
    setDialogOpen(true);
  }
  function closeDialog() {
    setDialogOpen(false);
    setEditing(null);
  }
  function confirmRemove() {
    if (!deleting) return;
    remove.mutate({ path: `/payroll/adjustments/${encodeURIComponent(deleting.id)}`, method: "DELETE", values: { revision: deleting.revision } }, {
      onSuccess: () => { setDeleting(null); void adjustments.refetch(); },
    });
  }

  return <div className="page fills hr-payroll-page hr-payroll-adjustments-page">
    <PageHeader title="薪資加扣項" description="登記指定薪資月份的補發與扣款，於試算時自動帶入。" actions={canCalculate ? <Button icon="plus" className="add-action" onClick={openCreate}>新增薪資加扣項</Button> : null} />
    {!canCalculate ? <Alert tone="info">目前只有薪資檢視權限；新增、編輯與刪除需要「執行薪資試算」權限。</Alert> : null}
    <Panel className="grows hr-payroll-adjustments-panel">
      <FilterToolbar className="hr-payroll-adjustment-filter">
        <FilterInput label="生效薪資月份" type="month" value={effectivePeriodKey} onChange={(event) => setEffectivePeriodKey(event.target.value)} />
      </FilterToolbar>
      {adjustments.error ? <Alert tone="danger">薪資加扣項載入失敗：{adjustments.error.message}</Alert> : null}
      <div className="hr-payroll-adjustments-table-region">
        <DataTable className="hr-payroll-adjustment-table">
            <thead><tr><th>生效月份</th><th>人員</th><th>加扣項目</th><th className="numeric">加扣金額</th><th>原因</th><th>操作</th></tr></thead>
            <tbody>{(adjustments.data?.adjustments ?? []).map((adjustment) => <tr key={adjustment.id}>
              <td data-label="生效月份"><strong>{periodLabel(adjustment.effectivePeriodKey)}</strong></td>
              <td data-label="人員"><div className="hr-payroll-adjustment-person"><strong>{adjustment.employeeName}</strong><small className="cell-sub">{adjustment.employeeNumber ?? adjustment.employmentId}</small></div></td>
              <td data-label="加扣項目"><div className="hr-payroll-adjustment-item-summary">{adjustment.items.map((item) => <span key={item.id}><strong>{item.itemName}</strong><small>{item.amountMinor < 0 ? "扣款" : "補發／加給"}</small></span>)}</div></td>
              <td data-label="加扣金額" className="numeric"><strong>{signedMoney(totalMinor(adjustment))}</strong></td>
              <td data-label="原因" className="hr-payroll-adjustment-reason">{adjustment.reason}</td>
              <td data-label="操作"><div className="hr-payroll-adjustment-actions">{!canCalculate || !adjustment.canEdit ? <Tooltip label={canCalculate ? "已發放或月份結帳，不能編輯或刪除" : "需要薪資試算權限才能編輯或刪除"} className="muted"><span role="img" aria-label={canCalculate ? "不能編輯或刪除" : "需要薪資試算權限才能編輯或刪除"}><Icon name="block" /></span></Tooltip> : <><Button variant="secondary" icon="edit" className="hr-action-update" onClick={() => openEdit(adjustment)}>編輯</Button><Button variant="danger" icon="trash" onClick={() => { remove.reset(); setDeleting(adjustment); }}>刪除</Button></>}</div></td>
            </tr>)}</tbody>
        </DataTable>
      </div>
      {adjustments.data && !adjustments.data.adjustments.length ? <EmptyState>目前沒有符合條件的薪資加扣項。</EmptyState> : null}
    </Panel>
    {dialogOpen ? <PayrollAdjustmentDialog key={editing?.id ?? "new"} employees={employees.data?.employees ?? []} employeesPending={employees.isPending} employeesError={employees.error instanceof Error ? employees.error : null} adjustment={editing ?? undefined} onClose={closeDialog} onSuccess={() => { closeDialog(); void adjustments.refetch(); }} /> : null}
    {deleting ? <ConfirmDialog title="刪除這筆薪資加扣項？" confirmLabel="刪除加扣項" pending={remove.isPending} onCancel={() => { if (!remove.isPending) setDeleting(null); }} onConfirm={confirmRemove}>
      <p><strong>{deleting.employeeName}</strong>（{periodLabel(deleting.effectivePeriodKey)}）的加扣項及其項目會一併刪除。</p>
      <p>已建立的薪資試算會保留當時保存的明細快照，不會因刪除而改寫；已結帳月份不可刪除。</p>
      {remove.error ? <Alert tone="danger">刪除失敗：{remove.error.message}</Alert> : null}
    </ConfirmDialog> : null}
  </div>;
}
