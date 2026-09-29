import { useRef, useState, type FormEvent } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, FilterInput, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
import { HR_ROSTER_PATH, useHrQuery, useHrWrite, type Employee, type PayrollAdjustment } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

interface PayrollAdjustmentsResponse { adjustments: PayrollAdjustment[] }
interface AdjustmentItemDraft { key: string; itemName: string; direction: "earning" | "deduction"; amount: string }

type EmployeeWithEmployment = Employee & { employmentId: string };

function taipeiMonth() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${parts.find((item) => item.type === "year")?.value ?? ""}-${parts.find((item) => item.type === "month")?.value ?? ""}`;
}
function shiftMonth(value: string, offset: number) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return "";
  const [year, month] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
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
function asEmployeeOptions(employees: Employee[]): EmployeeWithEmployment[] {
  return employees.filter((employee): employee is EmployeeWithEmployment => Boolean(employee.employmentId));
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
  const employeeOptions = asEmployeeOptions(employees);
  const currentPeriod = taipeiMonth();
  const defaultEffective = adjustment?.effectivePeriodKey ?? shiftMonth(currentPeriod, 1);
  const [employmentId, setEmploymentId] = useState(adjustment?.employmentId ?? "");
  const [sourcePeriodKey, setSourcePeriodKey] = useState(adjustment?.sourcePeriodKey ?? shiftMonth(currentPeriod, -1));
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
    if (!employmentId) { setValidationError("請選擇員工。"); return; }
    if (!sourcePeriodKey || !effectivePeriodKey || sourcePeriodKey === effectivePeriodKey) { setValidationError("原薪資月份與生效薪資月份必須填寫且不能相同。"); return; }
    if (!reason.trim()) { setValidationError("請填寫調整原因。"); return; }
    const payloadItems: Array<{ itemName: string; amountMinor: number }> = [];
    for (const item of items) {
      const amount = Number(item.amount);
      if (!item.itemName.trim()) { setValidationError("每個調整項目都要有名稱。"); return; }
      if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(amount * 100)) { setValidationError(`「${item.itemName || "未命名項目"}」的金額必須是正整數元。`); return; }
      payloadItems.push({ itemName: item.itemName.trim(), amountMinor: (item.direction === "deduction" ? -1 : 1) * amount * 100 });
    }
    setValidationError(null);
    save.mutate({
      path: adjustment ? `/payroll/adjustments/${encodeURIComponent(adjustment.id)}` : "/payroll/adjustments",
      method: adjustment ? "PATCH" : "POST",
      values: { employmentId, sourcePeriodKey, effectivePeriodKey, reason: reason.trim(), items: payloadItems, ...(adjustment ? { revision: adjustment.revision } : {}) },
    }, { onSuccess: () => { onSuccess(); (closeRequestRef.current ?? onClose)(); } });
  }

  return <Dialog
    className="hr-payroll-adjustment-dialog"
    title={adjustment ? "編輯薪資調整" : "新增薪資調整"}
    titleMeta={employeeOptions.find((employee) => employee.employmentId === employmentId)?.legalName ?? "選擇員工"}
    onClose={onClose}
    closeRequestRef={closeRequestRef}
    closeDisabled={save.isPending}
    formProps={{ onSubmit: submit }}
    actions={<><Button variant="secondary" onClick={onClose} disabled={save.isPending}>取消</Button><Button type="submit" icon="check" loading={save.isPending} disabled={employeesPending || !employeeOptions.length}>{adjustment ? "保存調整" : "建立調整"}</Button></>}
  >
    <p className="form-hint hr-payroll-adjustment-dialog-note">原薪資月份必須已結帳；調整會在生效月份開始試算時自動帶入。</p>
    <div className="form-grid two">
      <SelectField label="員工" value={employmentId} required options={[{ value: "", label: employeesPending ? "正在載入員工…" : "請選擇員工" }, ...employeeOptions.map((employee) => ({ value: employee.employmentId, label: `${employee.legalName}／${employee.employeeNumber}` }))]} onChange={(event) => setEmploymentId(event.target.value)} />
      <TextField label="生效薪資月份" type="month" value={effectivePeriodKey} required onChange={(event) => setEffectivePeriodKey(event.target.value)} />
    </div>
    <TextField label="原薪資月份" type="month" value={sourcePeriodKey} required hint="用來對應已結帳的原始薪資。" onChange={(event) => setSourcePeriodKey(event.target.value)} />
    <div className="hr-payroll-adjustment-items">
      <div className="hr-payroll-adjustment-items-head"><div><strong>調整項目</strong><small>正數為補發／加給，負數為扣款。</small></div><Button type="button" variant="chip-action" icon="plus" onClick={addItem}>新增項目</Button></div>
      <div className="hr-payroll-adjustment-item-list">
        {items.map((item) => <div className="hr-payroll-adjustment-item-row" key={item.key}>
          <SelectField label="類型" value={item.direction} options={[{ value: "earning", label: "補發／加給" }, { value: "deduction", label: "扣款" }]} onChange={(event) => updateItem(item.key, { direction: event.target.value as AdjustmentItemDraft["direction"] })} />
          <TextField label="項目名稱" value={item.itemName} required placeholder="例如：前月差額" onChange={(event) => updateItem(item.key, { itemName: event.target.value })} />
          <TextField label="金額（元）" type="number" min="1" step="1" value={item.amount} required onChange={(event) => updateItem(item.key, { amount: event.target.value })} />
          <Button type="button" variant="icon" icon="trash" aria-label="移除調整項目" title="移除調整項目" onClick={() => removeItem(item.key)} disabled={items.length === 1} />
        </div>)}
      </div>
    </div>
    <TextField label="調整原因" value={reason} maxLength={1000} required placeholder="說明這筆差額的來源與依據" onChange={(event) => setReason(event.target.value)} />
    {employeesError ? <Alert tone="danger">員工名單載入失敗：{employeesError.message}</Alert> : null}
    {validationError || save.error ? <Alert tone="danger">{validationError ?? save.error?.message}</Alert> : null}
  </Dialog>;
}

export function HrPayrollAdjustments() {
  usePageTitle("薪資調整");
  const { permissions, user } = useSession();
  const canRead = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:read"));
  const canCalculate = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:calculate"));
  const [effectivePeriodKey, setEffectivePeriodKey] = useState("");
  const [editing, setEditing] = useState<PayrollAdjustment | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const adjustments = useHrQuery<PayrollAdjustmentsResponse>(`/payroll/adjustments${effectivePeriodKey ? `?effectivePeriodKey=${encodeURIComponent(effectivePeriodKey)}` : ""}`, canRead);
  const employees = useHrQuery<{ employees: Employee[] }>(HR_ROSTER_PATH, canCalculate);

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

  return <div className="page fills hr-payroll-page hr-payroll-adjustments-page">
    <PageHeader title="薪資調整" description="預先登記已結帳差額，於指定生效月份試算時自動帶入。" actions={canCalculate ? <Button icon="plus" onClick={openCreate}>新增薪資調整</Button> : null} />
    <Panel className="grows hr-payroll-adjustments-panel">
      <form className="admin-form toolbar hr-payroll-adjustment-filter" onSubmit={(event) => event.preventDefault()}>
        <FilterInput label="生效薪資月份" type="month" value={effectivePeriodKey} onChange={(event) => setEffectivePeriodKey(event.target.value)} />
      </form>
      {adjustments.error ? <Alert tone="danger">薪資調整載入失敗：{adjustments.error.message}</Alert> : null}
      <div className="hr-payroll-adjustments-table-region">
        <div className="table-scroll">
          <table className="data-table hr-payroll-adjustment-table">
            <thead><tr><th>生效月份</th><th>員工</th><th>調整項目</th><th className="numeric">調整金額</th><th>原薪資月份</th><th>原因</th><th>操作</th></tr></thead>
            <tbody>{(adjustments.data?.adjustments ?? []).map((adjustment) => <tr key={adjustment.id}>
              <td data-label="生效月份"><strong>{periodLabel(adjustment.effectivePeriodKey)}</strong></td>
              <td data-label="員工"><strong>{adjustment.employeeName}</strong><small className="cell-sub">{adjustment.employeeNumber ?? adjustment.employmentId}</small></td>
              <td data-label="調整項目"><div className="hr-payroll-adjustment-item-summary">{adjustment.items.map((item) => <span key={item.id}><strong>{item.itemName}</strong><small>{item.amountMinor < 0 ? "扣款" : "補發／加給"}</small></span>)}</div></td>
              <td data-label="調整金額" className="numeric"><strong>{signedMoney(totalMinor(adjustment))}</strong></td>
              <td data-label="原薪資月份">{periodLabel(adjustment.sourcePeriodKey)}</td>
              <td data-label="原因" className="hr-payroll-adjustment-reason">{adjustment.reason}</td>
              <td data-label="操作">{canCalculate ? <Button variant="secondary" icon="edit" onClick={() => openEdit(adjustment)}>編輯</Button> : null}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>
      {adjustments.data && !adjustments.data.adjustments.length ? <p className="empty-state">目前沒有符合條件的薪資調整。</p> : null}
    </Panel>
    {dialogOpen ? <PayrollAdjustmentDialog key={editing?.id ?? "new"} employees={employees.data?.employees ?? []} employeesPending={employees.isPending} employeesError={employees.error instanceof Error ? employees.error : null} adjustment={editing ?? undefined} onClose={closeDialog} onSuccess={() => { closeDialog(); void adjustments.refetch(); }} /> : null}
  </div>;
}
