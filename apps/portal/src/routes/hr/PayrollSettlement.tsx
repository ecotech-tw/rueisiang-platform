import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Pager } from "../../shell/Pager.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, FilterInput, FilterSelect, PageHeader, Panel, SearchFilterInput, StatusBadge, TextField } from "../../ui/index.js";
import { HR_ROSTER_PATH, useHrQuery, useHrWrite, type Employee, type PayrollRecord, type PayrollRun, type PayrollWorkerCandidate } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

interface PayrollRecordsResponse {
  records: PayrollRecord[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  counts: { total: number; unsettled: number; closed: number };
}
interface EmployeeListResponse { employees: Employee[] }
interface PayrollRecordFilters {
  page: number;
  pageSize: number;
  search: string;
  periodKey: string;
  status: "all" | "unsettled" | "closed";
  personKind: "all" | "employee" | "worker";
  payBasis: "all" | "monthly" | "daily" | "hourly" | "mixed";
}
type PayrollEmployeeSelectionMode = "all" | "selected";

const PAYROLL_RECORD_PAGE_SIZES = [10, 25, 50, 100] as const;
const PAYROLL_RECORD_STATUS_LABEL = { unsettled: "尚未結算", closed: "已確定發放" } as const;
const PAYROLL_PERSON_KIND_LABEL = { employee: "正式員工", worker: "支援人員" } as const;
const PAY_BASIS_LABEL: Record<string, string> = { monthly: "月薪", daily: "日薪", hourly: "時薪", mixed: "混合" };

function taipeiMonth() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${parts.find((item) => item.type === "year")?.value ?? ""}-${parts.find((item) => item.type === "month")?.value ?? ""}`;
}
function money(minor: number): string {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}
function deductionMoney(minor: number): string {
  return `-NT$ ${Math.abs(Math.round(minor / 100)).toLocaleString("zh-TW")}`;
}
function payrollPeriodLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return match ? `${match[1]} 年 ${Number(match[2])} 月` : value;
}
function recordStatusTone(status: PayrollRecord["status"]): "success" | "warning" {
  return status === "closed" ? "success" : "warning";
}
function referenceKey(record: Pick<PayrollRecord, "runId" | "personKind" | "personId">) {
  return `${record.runId}:${record.personKind}:${record.personId}`;
}

interface PayrollCalculationDialogProps {
  employees: Employee[];
  employeesPending: boolean;
  employeesError: Error | null;
  initialPeriodKey: string;
  initialPayDate: string;
  onClose: () => void;
  onSuccess: (run: PayrollRun) => void;
}

function PayrollCalculationDialog({ employees, employeesPending, employeesError, initialPeriodKey, initialPayDate, onClose, onSuccess }: PayrollCalculationDialogProps) {
  const [periodKey, setPeriodKey] = useState(initialPeriodKey);
  const [payDate, setPayDate] = useState(initialPayDate);
  const [selectionMode, setSelectionMode] = useState<PayrollEmployeeSelectionMode>("all");
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);
  const [selectedWorkerIds, setSelectedWorkerIds] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const calculatePayroll = useHrWrite<{ run: PayrollRun }>();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const supportWorkers = useHrQuery<{ workers: PayrollWorkerCandidate[] }>(periodKey ? `/payroll/workers?periodKey=${encodeURIComponent(periodKey)}` : "/payroll/workers?periodKey=", Boolean(periodKey), { keepPreviousData: false });
  const workerOptions = supportWorkers.data?.workers ?? [];
  const peopleCount = employees.length + workerOptions.length;
  const selectedCount = selectionMode === "all" ? peopleCount : selectedEmployeeIds.length + selectedWorkerIds.length;
  const unselectedCount = Math.max(0, peopleCount - selectedCount);

  useEffect(() => {
    setSelectionMode("all");
    setSelectedEmployeeIds([]);
    setSelectedWorkerIds([]);
  }, [periodKey]);
  useEffect(() => {
    const availableWorkerIds = new Set(workerOptions.map((worker) => worker.id));
    setSelectedWorkerIds((current) => current.filter((workerId) => availableWorkerIds.has(workerId)));
  }, [workerOptions]);

  function setAllPeople(checked: boolean) {
    setSelectionMode(checked ? "all" : "selected");
    setSelectedEmployeeIds(checked ? employees.map((employee) => employee.userId) : []);
    setSelectedWorkerIds(checked ? workerOptions.map((worker) => worker.id) : []);
  }
  function updateSelection(nextEmployeeIds: string[], nextWorkerIds: string[]) {
    setSelectedEmployeeIds(nextEmployeeIds);
    setSelectedWorkerIds(nextWorkerIds);
    setSelectionMode(nextEmployeeIds.length + nextWorkerIds.length === peopleCount && peopleCount > 0 ? "all" : "selected");
  }
  function toggleEmployee(userId: string, checked: boolean) {
    const currentEmployeeIds = selectionMode === "all" ? employees.map((employee) => employee.userId) : selectedEmployeeIds;
    const currentWorkerIds = selectionMode === "all" ? workerOptions.map((worker) => worker.id) : selectedWorkerIds;
    updateSelection(checked ? [...new Set([...currentEmployeeIds, userId])] : currentEmployeeIds.filter((id) => id !== userId), currentWorkerIds);
  }
  function toggleWorker(workerId: string, checked: boolean) {
    const currentEmployeeIds = selectionMode === "all" ? employees.map((employee) => employee.userId) : selectedEmployeeIds;
    const currentWorkerIds = selectionMode === "all" ? workerOptions.map((worker) => worker.id) : selectedWorkerIds;
    updateSelection(currentEmployeeIds, checked ? [...new Set([...currentWorkerIds, workerId])] : currentWorkerIds.filter((id) => id !== workerId));
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!periodKey) { setValidationError("請選擇計算月份。"); return; }
    if (selectionMode === "selected" && selectedCount === 0) { setValidationError("請至少選擇一位員工或支援人員。"); return; }
    setValidationError(null);
    calculatePayroll.mutate({
      path: "/payroll/calculate",
      method: "POST",
      values: {
        periodKey,
        payDate: payDate || undefined,
        runName: `${periodKey}薪資`,
        attendanceMode: "all",
        employeeUserIds: selectionMode === "all" ? undefined : selectedEmployeeIds,
        workerIds: selectionMode === "all" ? undefined : selectedWorkerIds,
        requestId: `portal-${crypto.randomUUID()}`,
      },
    }, { onSuccess: (result) => { onSuccess(result.run); (closeRequestRef.current ?? onClose)(); } });
  }

  return <Dialog
    className="hr-payroll-create-dialog"
    title="新增薪資試算"
    titleMeta={`${periodKey || "尚未選擇月份"}・已選 ${selectedCount} 位人員`}
    onClose={onClose}
    closeRequestRef={closeRequestRef}
    closeDisabled={calculatePayroll.isPending}
    formProps={{ onSubmit: submit }}
    actions={<><Button variant="secondary" onClick={onClose} disabled={calculatePayroll.isPending}>取消</Button><Button type="submit" icon="payments" loading={calculatePayroll.isPending} disabled={supportWorkers.isPending || Boolean(supportWorkers.error)}>開始試算</Button></>}
  >
    <div className="form-grid two">
      <TextField type="month" label="計算月份" value={periodKey} required onChange={(event) => setPeriodKey(event.target.value)} />
      <TextField type="date" label="發薪日（選填）" value={payDate} onChange={(event) => setPayDate(event.target.value)} />
    </div>
    <div className="hr-payroll-employee-picker-section">
      <div className="hr-payroll-picker-heading"><div><strong>試算人員</strong><small>每位人員會在發放紀錄建立一筆資料，可選全體或指定人員。</small></div><span className="hr-payroll-picker-count">已選 {selectedCount} 人</span></div>
      <label className={`hr-payroll-employee-option hr-payroll-employee-option-all${selectionMode === "all" ? " selected" : ""}`}>
        <input type="checkbox" checked={selectionMode === "all"} onChange={(event) => setAllPeople(event.target.checked)} />
        <span><strong>全體人員</strong><small>納入全部符合資格的員工與本月有排班的支援人員</small></span>
      </label>
      <div className="hr-payroll-employee-picker" role="group" aria-label="選擇員工與支援人員">
        <div className="hr-payroll-picker-group">
          <strong className="hr-payroll-picker-group-title">正式員工</strong>
          {employeesPending ? <p className="muted hr-payroll-picker-empty">正在載入符合資格的員工…</p> : employees.length ? employees.map((employee) => {
            const checked = selectionMode === "all" || selectedEmployeeIds.includes(employee.userId);
            return <label className={`hr-payroll-employee-option${checked ? " selected" : ""}`} key={`employee-${employee.userId}`}>
              <input type="checkbox" checked={checked} onChange={(event) => toggleEmployee(employee.userId, event.target.checked)} />
              <span><strong>{employee.legalName}</strong><small>{employee.employeeNumber}・{employee.position || "未設定職位"}</small></span>
            </label>;
          }) : <p className="muted hr-payroll-picker-empty">目前沒有符合資格的正式員工。</p>}
        </div>
        <div className="hr-payroll-picker-group">
          <strong className="hr-payroll-picker-group-title">支援人員</strong>
          {supportWorkers.isPending ? <p className="muted hr-payroll-picker-empty">正在載入本月已發布排班…</p> : workerOptions.length ? workerOptions.map((worker) => {
            const checked = selectionMode === "all" || selectedWorkerIds.includes(worker.id);
            return <label className={`hr-payroll-employee-option${checked ? " selected" : ""}`} key={`worker-${worker.id}`}>
              <input type="checkbox" checked={checked} onChange={(event) => toggleWorker(worker.id, event.target.checked)} />
              <span><strong>{worker.displayName}</strong><small>本月已發布排班</small></span>
            </label>;
          }) : <p className="muted hr-payroll-picker-empty">本月份沒有已發布排班的支援人員。</p>}
        </div>
      </div>
      {selectionMode === "selected" && unselectedCount > 0 ? <Alert tone="warning">未選的 {unselectedCount} 位人員不會納入這次試算。</Alert> : null}
    </div>
    {employeesError ? <Alert tone="danger">員工名單載入失敗：{employeesError.message}</Alert> : null}
    {supportWorkers.error instanceof Error ? <Alert tone="danger">支援人員名單載入失敗：{supportWorkers.error.message}</Alert> : null}
    {validationError || calculatePayroll.error ? <Alert tone="danger">{validationError ?? calculatePayroll.error?.message}</Alert> : null}
  </Dialog>;
}

export function HrPayrollSettlement() {
  usePageTitle("薪資結算");
  const { permissions, user } = useSession();
  const navigate = useNavigate();
  const canRead = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:read"));
  const canCalculate = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:calculate"));
  const currentMonth = taipeiMonth();
  const [recordFilters, setRecordFilters] = useState<PayrollRecordFilters>({ page: 1, pageSize: 25, search: "", periodKey: currentMonth, status: "all", personKind: "all", payBasis: "all" });
  const [showCalculationDialog, setShowCalculationDialog] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [approveOpen, setApproveOpen] = useState(false);
  const employees = useHrQuery<EmployeeListResponse>(HR_ROSTER_PATH, canRead && permissions.has("hr:employee:read"));
  const records = useHrQuery<PayrollRecordsResponse>(`/payroll/records?page=${recordFilters.page}&pageSize=${recordFilters.pageSize}&search=${encodeURIComponent(recordFilters.search)}&periodKey=${encodeURIComponent(recordFilters.periodKey || "all")}&status=${recordFilters.status}&personKind=${recordFilters.personKind}&payBasis=${recordFilters.payBasis}`, canRead);
  const approvePayroll = useHrWrite<{ approved: number }>();

  const visibleUnsettledKeys = useMemo(() => (records.data?.records ?? []).filter((record) => record.status === "unsettled").map(referenceKey), [records.data?.records]);
  const selectedRecords = useMemo(() => (records.data?.records ?? []).filter((record) => selectedKeys.includes(referenceKey(record)) && record.status === "unsettled"), [records.data?.records, selectedKeys]);
  const allVisibleSelected = visibleUnsettledKeys.length > 0 && visibleUnsettledKeys.every((key) => selectedKeys.includes(key));

  useEffect(() => {
    const validKeys = new Set((records.data?.records ?? []).filter((record) => record.status === "unsettled").map(referenceKey));
    setSelectedKeys((current) => current.filter((key) => validKeys.has(key)));
  }, [records.data?.records]);

  if (!canRead) return <Alert tone="danger">薪資資料僅限全平台 HR 管理者查看。</Alert>;
  if (records.isPending) return <HrPageSkeleton variant="table" />;

  function updateRecordFilters(patch: Partial<PayrollRecordFilters>) {
    setRecordFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
    setSelectedKeys([]);
  }
  function toggleRecord(record: PayrollRecord, checked: boolean) {
    const key = referenceKey(record);
    setSelectedKeys((current) => checked ? [...new Set([...current, key])] : current.filter((item) => item !== key));
  }
  function toggleVisibleRecords(checked: boolean) {
    setSelectedKeys((current) => checked ? [...new Set([...current, ...visibleUnsettledKeys])] : current.filter((key) => !visibleUnsettledKeys.includes(key)));
  }
  function openRecord(record: PayrollRecord) {
    navigate(`/hr/payroll-settlement/${encodeURIComponent(record.runId)}/${record.personKind}/${encodeURIComponent(record.personId)}`);
  }
  function approveSelected() {
    if (!selectedRecords.length) return;
    approvePayroll.mutate({ path: "/payroll/records/approve", method: "POST", values: { records: selectedRecords.map(({ runId, personKind, personId }) => ({ runId, personKind, personId })) } }, {
      onSuccess: () => { setSelectedKeys([]); setApproveOpen(false); void records.refetch(); },
    });
  }

  return <div className="page hr-payroll-page">
    <PageHeader title="薪資發放紀錄" description="每位員工與支援人員各一筆發放紀錄；從明細確認試算結果，選取多筆後一次確定發放。" actions={canCalculate ? <Button icon="plus" onClick={() => setShowCalculationDialog(true)}>新增試算</Button> : null} />
    <Alert tone="info">試算只會建立尚未結算的紀錄。薪資加扣項在單筆明細的 modal 管理；確定發放後，該筆紀錄與明細會保留為不可改寫的歷史快照。</Alert>
    {approvePayroll.error ? <Alert tone="danger">{approvePayroll.error.message}</Alert> : null}

    <Panel className="grows hr-payroll-records-panel" title="發放紀錄" description="預設顯示本月；清除月份即可跨期間查詢。">
      <div className="hr-payroll-record-summary" aria-label="薪資紀錄統計">
        <div><span>符合條件</span><strong>{records.data?.counts.total.toLocaleString("zh-TW") ?? "—"}</strong><small>筆紀錄</small></div>
        <div><span>尚未結算</span><strong>{records.data?.counts.unsettled.toLocaleString("zh-TW") ?? "—"}</strong><small>可覆核與確定發放</small></div>
        <div className="is-closed"><span>已確定發放</span><strong>{records.data?.counts.closed.toLocaleString("zh-TW") ?? "—"}</strong><small>歷史快照</small></div>
      </div>
      <form className="admin-form toolbar hr-payroll-record-filter" onSubmit={(event) => event.preventDefault()}>
        <SearchFilterInput label="搜尋人員" placeholder="姓名或員工編號" value={recordFilters.search} onSearch={(search) => updateRecordFilters({ search })} />
        <FilterInput label="薪資月份" type="month" value={recordFilters.periodKey} onChange={(event) => updateRecordFilters({ periodKey: event.target.value })} />
        <FilterSelect label="狀態" value={recordFilters.status} options={[{ value: "all", label: "全部狀態" }, { value: "unsettled", label: "尚未結算" }, { value: "closed", label: "已確定發放" }]} onChange={(event) => updateRecordFilters({ status: event.target.value as PayrollRecordFilters["status"] })} />
        <FilterSelect label="人員類型" value={recordFilters.personKind} options={[{ value: "all", label: "全部人員" }, { value: "employee", label: "正式員工" }, { value: "worker", label: "支援人員" }]} onChange={(event) => updateRecordFilters({ personKind: event.target.value as PayrollRecordFilters["personKind"] })} />
        <FilterSelect label="計薪方式" value={recordFilters.payBasis} options={[{ value: "all", label: "全部計薪方式" }, { value: "monthly", label: "月薪" }, { value: "daily", label: "日薪" }, { value: "hourly", label: "時薪" }, { value: "mixed", label: "混合" }]} onChange={(event) => updateRecordFilters({ payBasis: event.target.value as PayrollRecordFilters["payBasis"] })} />
      </form>
      {records.error ? <Alert tone="danger">薪資紀錄載入失敗：{records.error.message}</Alert> : null}
      {selectedRecords.length ? <div className="hr-payroll-bulk-bar" role="status"><strong>已選 {selectedRecords.length} 筆</strong><span>只會核准目前尚未結算的紀錄</span>{canCalculate ? <Button icon="check" loading={approvePayroll.isPending} onClick={() => setApproveOpen(true)}>確定發放</Button> : null}<Button variant="secondary" onClick={() => setSelectedKeys([])}>取消選取</Button></div> : null}
      <div className={`table-scroll${records.isPlaceholderData ? " is-refreshing" : ""}`}>
        <table className="data-table hr-payroll-record-table">
          <thead><tr><th className="hr-payroll-select-cell"><input type="checkbox" checked={allVisibleSelected} disabled={!visibleUnsettledKeys.length} onChange={(event) => toggleVisibleRecords(event.target.checked)} aria-label="選取本頁尚未結算紀錄" /></th><th>薪資月份</th><th>人員</th><th>計薪方式</th><th className="numeric">應發</th><th className="numeric">扣款</th><th className="numeric">實領</th><th>狀態</th><th>操作</th></tr></thead>
          <tbody>{(records.data?.records ?? []).map((record) => <tr key={referenceKey(record)}>
            <td data-label="選取" className="hr-payroll-select-cell">{record.status === "unsettled" ? <input type="checkbox" checked={selectedKeys.includes(referenceKey(record))} onChange={(event) => toggleRecord(record, event.target.checked)} aria-label={`選取${record.personName}`} /> : null}</td>
            <td data-label="薪資月份"><strong>{payrollPeriodLabel(record.periodKey)}</strong><small className="cell-sub">{record.payDate ? `發薪日 ${record.payDate}` : "未設定發薪日"}</small></td>
            <td data-label="人員"><div className="hr-payroll-record-person"><strong>{record.personName}</strong><small className="cell-sub">{record.personNumber ? `${record.personNumber}・` : ""}{PAYROLL_PERSON_KIND_LABEL[record.personKind]}</small></div></td>
            <td data-label="計薪方式">{record.payBasis ? PAY_BASIS_LABEL[record.payBasis] ?? record.payBasis : "—"}</td>
            <td data-label="應發" className="numeric">{money(record.earningMinor)}</td>
            <td data-label="扣款" className="numeric">{record.deductionMinor ? deductionMoney(record.deductionMinor) : "—"}</td>
            <td data-label="實領" className="numeric"><strong>{money(record.netMinor)}</strong></td>
            <td data-label="狀態"><StatusBadge tone={recordStatusTone(record.status)}>{PAYROLL_RECORD_STATUS_LABEL[record.status]}</StatusBadge></td>
            <td data-label="操作"><Button variant="secondary" icon="eye" onClick={() => openRecord(record)}>查看明細</Button></td>
          </tr>)}</tbody>
        </table>
      </div>
      {records.data && !records.data.records.length ? <p className="empty-state">目前沒有符合條件的薪資發放紀錄。</p> : null}
      {records.data && records.data.total > 0 ? <Pager page={records.data.page} pageSize={records.data.pageSize} pageSizes={PAYROLL_RECORD_PAGE_SIZES} totalPages={Math.max(1, Math.ceil(records.data.total / records.data.pageSize))} totalLabel={`共 ${records.data.total.toLocaleString("zh-TW")} 筆`} onPage={(page) => updateRecordFilters({ page })} onPageSize={(pageSize) => updateRecordFilters({ pageSize })} /> : null}
    </Panel>

    {showCalculationDialog ? <PayrollCalculationDialog
      employees={employees.data?.employees ?? []}
      employeesPending={employees.isPending}
      employeesError={employees.error instanceof Error ? employees.error : null}
      initialPeriodKey={recordFilters.periodKey || currentMonth}
      initialPayDate=""
      onClose={() => setShowCalculationDialog(false)}
      onSuccess={(run) => { setRecordFilters((current) => ({ ...current, periodKey: run.periodKey, page: 1 })); setSelectedKeys([]); }}
    /> : null}
    {approveOpen ? <ConfirmDialog title="確定發放選取紀錄？" confirmLabel="確定發放" pending={approvePayroll.isPending} onCancel={() => { if (!approvePayroll.isPending) setApproveOpen(false); }} onConfirm={approveSelected}>
      <p>即將將 <strong>{selectedRecords.length} 筆</strong>薪資紀錄標記為「已確定發放」。</p>
      <p>確定後薪資明細會保留為歷史快照，不能再修改或刪除。</p>
      {approvePayroll.error ? <Alert tone="danger">{approvePayroll.error.message}</Alert> : null}
    </ConfirmDialog> : null}
  </div>;
}
