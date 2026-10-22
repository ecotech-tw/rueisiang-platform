import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { useSession } from "../../auth/session.js";
import { Icon } from "../../shell/icons.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Pager } from "../../shell/Pager.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, DropdownSelect, EmptyState, FilterInput, FilterSelect, FilterToolbar, PageHeader, Panel, SearchFilterInput, SelectionActionBar, StatusBadge, TextField } from "../../ui/index.js";
import { hrEmployeeLabel, isHrFormalEmployee, useHrEmployeeRoster, useHrQuery, useHrWrite, type HrFormalEmployee, type PayrollCandidateExclusions, type PayrollJob, type PayrollJobsResponse, type PayrollRecord, type PayrollRun, type PayrollWorkerCandidate } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

interface PayrollRecordsResponse {
  records: PayrollRecord[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  counts: { total: number; unsettled: number; closed: number };
}
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
const MAX_PAYROLL_SELECTED_EMPLOYEES = 80;
const MAX_PAYROLL_SELECTED_WORKERS = 100;
// 載入中的空名單要是同一個參考：每次 render 都給新的 [] 會讓依賴它的 effect 每輪都重跑、再 setState，變成無限重繪。
const NO_PAYROLL_WORKERS: PayrollWorkerCandidate[] = [];
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
function isPayrollJobActive(job: PayrollJob) {
  return job.status === "queued" || job.status === "calculating";
}
// /payroll/jobs 固定回最近幾筆、不分狀態，照單全收的話面板會常駐。
// 面板只列還需要人等或處理的工作：算完的紀錄已經在表格裡，留著只是重整後還賴在畫面上。
export function visiblePayrollJobs(jobs: PayrollJob[]): PayrollJob[] {
  return jobs.filter((job) => {
    if (isPayrollJobActive(job)) return true;
    if (job.status === "ready") return false;
    const finishedAt = job.completedAt ?? job.updatedAt;
    // 失敗的要留到有人處理：同一個月份之後有試算成功，就不必再提醒。
    return !jobs.some((other) => other.status === "ready" && other.periodKey === job.periodKey && (other.completedAt ?? other.updatedAt) > finishedAt);
  });
}
const PAYROLL_JOB_STATUS_LABEL: Record<PayrollJob["status"], string> = { queued: "等待背景執行", calculating: "背景計算中", ready: "試算完成", failed: "試算失敗" };
const PAYROLL_JOB_PHASE_LABEL: Record<PayrollJob["phase"], string> = { queued: "等待佇列派送", preparing: "準備來源資料", calculating_workers: "計算支援人員", calculating_employees: "計算正式員工", persisting: "保存薪資明細", completed: "可以開始覆核", failed: "需要重新試算" };
// 記在模組而不是元件上：試算途中常點進明細頁再回來，記在元件上的話回來時不知道它原本在跑，
// 完成或失敗的 toast 就不會發——而算完的工作已經不列在面板裡，那是唯一的通知。
const observedPayrollJobStatuses = new Map<string, PayrollJob["status"]>();
function payrollJobTone(status: PayrollJob["status"]): "warning" | "danger" {
  return status === "failed" ? "danger" : "warning";
}
function referenceKey(record: Pick<PayrollRecord, "runId" | "personKind" | "personId">) {
  return `${record.runId}:${record.personKind}:${record.personId}`;
}

export function availablePayrollEmployees<T extends Pick<HrFormalEmployee, "userId">>(employees: readonly T[], exclusions: PayrollCandidateExclusions | undefined): T[] {
  if (!exclusions || exclusions.allEmployees) return [];
  const excludedIds = new Set(exclusions.employeeUserIds);
  return employees.filter((employee) => !excludedIds.has(employee.userId));
}

export function availablePayrollWorkers<T extends Pick<PayrollWorkerCandidate, "id">>(workers: readonly T[], exclusions: PayrollCandidateExclusions | undefined): T[] {
  if (!exclusions || exclusions.allWorkers) return [];
  const excludedIds = new Set(exclusions.workerIds);
  return workers.filter((worker) => !excludedIds.has(worker.id));
}

interface PayrollCalculationDialogProps {
  employees: HrFormalEmployee[];
  employeesPending: boolean;
  employeesError: Error | null;
  initialPeriodKey: string;
  initialPayDate: string;
  onClose: () => void;
  onSuccess: (result: { job?: PayrollJob; run?: PayrollRun }) => void;
}

function PayrollCalculationDialog({ employees, employeesPending, employeesError, initialPeriodKey, initialPayDate, onClose, onSuccess }: PayrollCalculationDialogProps) {
  const [periodKey, setPeriodKey] = useState(initialPeriodKey);
  const [payDate, setPayDate] = useState(initialPayDate);
  const [selectionMode, setSelectionMode] = useState<PayrollEmployeeSelectionMode>("all");
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);
  const [selectedWorkerIds, setSelectedWorkerIds] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const calculatePayroll = useHrWrite<{ job?: PayrollJob; run?: PayrollRun }>();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const supportWorkers = useHrQuery<{ workers: PayrollWorkerCandidate[] }>(periodKey ? `/payroll/workers?periodKey=${encodeURIComponent(periodKey)}` : "/payroll/workers?periodKey=", Boolean(periodKey), { keepPreviousData: false });
  const candidateExclusions = useHrQuery<PayrollCandidateExclusions>(periodKey ? `/payroll/candidate-exclusions?periodKey=${encodeURIComponent(periodKey)}` : "/payroll/candidate-exclusions?periodKey=", Boolean(periodKey), { keepPreviousData: false });
  const rawWorkerOptions = supportWorkers.data?.workers ?? NO_PAYROLL_WORKERS;
  const availableEmployees = useMemo(() => availablePayrollEmployees(employees, candidateExclusions.data), [candidateExclusions.data, employees]);
  const workerOptions = useMemo(() => {
    if (!candidateExclusions.data || candidateExclusions.data.allWorkers) return NO_PAYROLL_WORKERS;
    return availablePayrollWorkers(rawWorkerOptions, candidateExclusions.data);
  }, [candidateExclusions.data, rawWorkerOptions]);
  const peopleCount = availableEmployees.length + workerOptions.length;
  const selectedCount = selectionMode === "all" ? peopleCount : selectedEmployeeIds.length + selectedWorkerIds.length;
  const unselectedCount = Math.max(0, peopleCount - selectedCount);
  const selectionLimitError = selectionMode === "selected" && (selectedEmployeeIds.length > MAX_PAYROLL_SELECTED_EMPLOYEES || selectedWorkerIds.length > MAX_PAYROLL_SELECTED_WORKERS)
    ? `正式員工最多選擇 ${MAX_PAYROLL_SELECTED_EMPLOYEES} 位、支援人員最多選擇 ${MAX_PAYROLL_SELECTED_WORKERS} 位；若要納入全體，請按「全選」。`
    : null;
  /*
   * 兩份名單的 options 與 value 都先記起來：人多的公司一份就是上千筆，
   * 每次重繪都重新 map 一遍，下拉還得逐筆比對內容有沒有變。
   */
  const employeeOptions = useMemo(() => {
    const selected = new Set(selectedEmployeeIds);
    const atLimit = selectionMode !== "all" && selected.size >= MAX_PAYROLL_SELECTED_EMPLOYEES;
    return availableEmployees.map((employee) => ({ value: employee.userId, label: `${hrEmployeeLabel(employee)}・${employee.position || "未設定職位"}`, chipLabel: employee.legalName, disabled: atLimit && !selected.has(employee.userId) }));
  }, [availableEmployees, selectionMode, selectedEmployeeIds]);
  const employeeValue = useMemo(() => selectionMode === "all" ? availableEmployees.map((employee) => employee.userId) : selectedEmployeeIds, [availableEmployees, selectionMode, selectedEmployeeIds]);
  const workerSelectOptions = useMemo(() => {
    const selected = new Set(selectedWorkerIds);
    const atLimit = selectionMode !== "all" && selected.size >= MAX_PAYROLL_SELECTED_WORKERS;
    return workerOptions.map((worker) => ({ value: worker.id, label: worker.displayName, disabled: atLimit && !selected.has(worker.id) }));
  }, [workerOptions, selectionMode, selectedWorkerIds]);
  const workerValue = useMemo(() => selectionMode === "all" ? workerOptions.map((worker) => worker.id) : selectedWorkerIds, [workerOptions, selectionMode, selectedWorkerIds]);

  useEffect(() => {
    setSelectionMode("all");
    setSelectedEmployeeIds([]);
    setSelectedWorkerIds([]);
  }, [periodKey]);
  useEffect(() => {
    const availableEmployeeIds = new Set(availableEmployees.map((employee) => employee.userId));
    setSelectedEmployeeIds((current) => current.filter((userId) => availableEmployeeIds.has(userId)));
  }, [availableEmployees]);
  useEffect(() => {
    const availableWorkerIds = new Set(workerOptions.map((worker) => worker.id));
    setSelectedWorkerIds((current) => current.filter((workerId) => availableWorkerIds.has(workerId)));
  }, [workerOptions]);

  /*
   * 「全選」不能只靠把人一個一個加回去：指定名單有人數上限，超過上限的公司少選一個人之後，
   * 剩下那位在清單裡會是停用的，加不回來。全體模式不送名單、也不受上限限制，所以要留一個入口回得去。
   */
  function selectAllPeople() {
    setSelectionMode("all");
    setSelectedEmployeeIds(availableEmployees.map((employee) => employee.userId));
    setSelectedWorkerIds(workerOptions.map((worker) => worker.id));
  }
  function updateSelection(nextEmployeeIds: string[], nextWorkerIds: string[]) {
    setSelectedEmployeeIds(nextEmployeeIds);
    setSelectedWorkerIds(nextWorkerIds);
    setSelectionMode(nextEmployeeIds.length + nextWorkerIds.length === peopleCount && peopleCount > 0 ? "all" : "selected");
  }
  function updateEmployeeSelection(nextEmployeeIds: string[]) {
    const currentWorkerIds = selectionMode === "all" ? workerOptions.map((worker) => worker.id) : selectedWorkerIds;
    updateSelection(nextEmployeeIds, currentWorkerIds);
  }
  function updateWorkerSelection(nextWorkerIds: string[]) {
    const currentEmployeeIds = selectionMode === "all" ? availableEmployees.map((employee) => employee.userId) : selectedEmployeeIds;
    updateSelection(currentEmployeeIds, nextWorkerIds);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!periodKey) { setValidationError("請選擇計算月份。"); return; }
    if (selectionMode === "selected" && selectedCount === 0) { setValidationError("請至少選擇一位員工或支援人員。"); return; }
    if (selectionLimitError) { setValidationError(selectionLimitError); return; }
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
        expectedCount: selectedCount,
      },
    }, { onSuccess: (result) => { onSuccess(result); (closeRequestRef.current ?? onClose)(); } });
  }

  return <Dialog
    width={720}
    bodyLayout="grid gap-[18px] px-6 pb-2"
    title="新增薪資試算"
    titleMeta={`${periodKey || "尚未選擇月份"}・已選 ${selectedCount} 位人員`}
    onClose={onClose}
    closeRequestRef={closeRequestRef}
    closeDisabled={calculatePayroll.isPending}
    formProps={{ onSubmit: submit }}
    actions={<><Button variant="secondary" onClick={onClose} disabled={calculatePayroll.isPending}>取消</Button><Button type="submit" icon="payments" tone="success" loading={calculatePayroll.isPending} disabled={calculatePayroll.isPending || employeesPending || Boolean(employeesError) || supportWorkers.isPending || Boolean(supportWorkers.error) || candidateExclusions.isPending || Boolean(candidateExclusions.error) || Boolean(selectionLimitError) || peopleCount === 0}>開始試算</Button></>}
  >
    <div className="form-grid two">
      <TextField type="month" label="計算月份" value={periodKey} required onChange={(event) => setPeriodKey(event.target.value)} />
      <TextField type="date" label="發薪日（選填）" value={payDate} onChange={(event) => setPayDate(event.target.value)} />
    </div>
    <div className="hr-payroll-employee-picker-section">
      <div className="hr-payroll-picker-heading"><div><strong>試算人員</strong><small>每位人員會在發放紀錄建立一筆資料；預設納入全部符合資格的人員。當月已有試算結果或正在試算的人員（不論是否已發放）會自動排除。</small></div><span className="flex flex-none items-center gap-2"><Button variant="link" onClick={selectAllPeople} disabled={selectionMode === "all" || peopleCount === 0 || calculatePayroll.isPending}>全選</Button><span className="hr-payroll-picker-count">{selectionMode === "all" ? `全體 ${selectedCount} 人` : `已選 ${selectedCount} 人`}</span></span></div>
      <div className="hr-payroll-employee-picker" role="group" aria-label="選擇員工與支援人員">
        <div className="hr-payroll-picker-group">
          <strong className="hr-payroll-picker-group-title">正式員工</strong>
          {!periodKey ? <p className="muted hr-payroll-picker-empty">選擇計算月份後會列出尚未試算的正式員工。</p> : employeesPending || candidateExclusions.isPending ? <p className="muted hr-payroll-picker-empty">正在載入符合資格的員工…</p> : employeesError || candidateExclusions.error ? <p className="muted hr-payroll-picker-empty">本月薪資試算名單載入失敗。</p> : availableEmployees.length ? <DropdownSelect
            multiple
            searchable
            // 全體模式只收合視覺上的 chip，清單仍保留所有人，才能搜尋並取消單一人員。
            compactSelected={selectionMode === "all"}
            value={employeeValue}
            options={employeeOptions}
            placeholder="搜尋姓名或員工編號"
            aria-label="選擇正式員工"
            // 另一份名單還沒載完時不能動：這時從「全體」移除一個人，會把還沒出現的那一邊記成「一個都沒選」。
            // 用 isLoading 不用 isPending：月份清空時查詢是停用的，isPending 會一直是 true，下拉就再也解不開。
            // 載入失敗也算沒載完：重試成功之前名單一樣是空的。
            disabled={calculatePayroll.isPending || supportWorkers.isLoading || Boolean(supportWorkers.error) || candidateExclusions.isLoading || Boolean(candidateExclusions.error)}
            onValueChange={updateEmployeeSelection}
          /> : <p className="muted hr-payroll-picker-empty">{employees.length ? "本月份正式員工皆已有試算結果或正在試算。" : "目前沒有符合資格的正式員工。"}</p>}
        </div>
        <div className="hr-payroll-picker-group">
          <strong className="hr-payroll-picker-group-title">支援人員</strong>
          {!periodKey ? <p className="muted hr-payroll-picker-empty">選擇計算月份後會列出該月可試算的支援人員。</p> : supportWorkers.isPending || candidateExclusions.isPending ? <p className="muted hr-payroll-picker-empty">正在載入本月已發布排班…</p> : supportWorkers.error || candidateExclusions.error ? <p className="muted hr-payroll-picker-empty">本月支援人員試算名單載入失敗。</p> : workerOptions.length ? <DropdownSelect
            multiple
            searchable
            compactSelected={selectionMode === "all"}
            value={workerValue}
            options={workerSelectOptions}
            placeholder="搜尋支援人員"
            aria-label="選擇支援人員"
            disabled={calculatePayroll.isPending || employeesPending || Boolean(employeesError) || candidateExclusions.isLoading || Boolean(candidateExclusions.error)}
            onValueChange={updateWorkerSelection}
          /> : <p className="muted hr-payroll-picker-empty">{rawWorkerOptions.length ? "本月份支援人員皆已有試算結果或正在試算。" : "本月份沒有已發布排班的支援人員。"}</p>}
        </div>
      </div>
      {selectionLimitError ? <Alert tone="warning">{selectionLimitError}</Alert> : null}
      {selectionMode === "selected" && unselectedCount > 0 ? <Alert tone="warning">未選的 {unselectedCount} 位人員不會納入這次試算。</Alert> : null}
    </div>
    {employeesError ? <Alert tone="danger">員工名單載入失敗：{employeesError.message}</Alert> : null}
    {supportWorkers.error instanceof Error ? <Alert tone="danger">支援人員名單載入失敗：{supportWorkers.error.message}</Alert> : null}
    {candidateExclusions.error instanceof Error ? <Alert tone="danger">本月已有薪資試算名單載入失敗：{candidateExclusions.error.message}</Alert> : null}
    {validationError || calculatePayroll.error ? <Alert tone="danger">{validationError ?? calculatePayroll.error?.message}</Alert> : null}
  </Dialog>;
}

function PayrollJobProgress({ jobs, onRetry, canRetry }: { jobs: PayrollJob[]; onRetry: (job: PayrollJob) => void; canRetry: boolean }) {
  // 預設收合：展開的面板會蓋住表格右下角的選取列，進度有 toast 通知，想看細節的人再點開。
  const [expanded, setExpanded] = useState(false);
  // 沒有工作時元件還掛著、只是不畫：不重設的話，下一筆試算一出現面板就是展開的。
  useEffect(() => { if (!jobs.length) setExpanded(false); }, [jobs.length]);
  // 掛到 HRIS 最外層：頁面轉場會在自己的容器上留著 filter，那會變成 fixed 的定位基準，頁籤就不再貼著視窗右緣。
  // 不掛 body，因為卡片裡的按鈕配色是靠 `.hr-system` 的選擇器套上的。
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => { setHost(document.querySelector(".hr-system")); }, []);
  if (!jobs.length || !host) return null;
  const failedCount = jobs.filter((job) => job.status === "failed").length;
  return createPortal(<section className={`hr-payroll-job-progress${expanded ? "" : " is-collapsed"}${failedCount ? " has-failed" : ""}`} aria-label="薪資試算進度">
    <button
      type="button"
      className="hr-payroll-job-progress-toggle text-brand transition-[background-color,border-color,color,box-shadow] duration-120 ease-out motion-reduce:transition-none"
      aria-expanded={expanded}
      aria-controls="hr-payroll-job-list"
      aria-label={`${expanded ? "收合" : "展開"}薪資試算，${jobs.length} 筆${failedCount ? `，其中 ${failedCount} 筆失敗` : ""}`}
      onClick={() => setExpanded((current) => !current)}
    >
      <span className={`hr-payroll-job-progress-chevron${expanded ? " is-expanded" : ""}`} aria-hidden="true">
        <Icon name="chevronLeft" className="hr-payroll-job-progress-chevron-open" />
        <Icon name="chevronRight" className="hr-payroll-job-progress-chevron-close" />
      </span>
      {/* 收合時錯誤原因與「重新試算」都看不到，頁籤自己要說得出有失敗待處理，不能只靠顏色。 */}
      <strong>{failedCount ? "試算失敗" : "薪資試算"}</strong>
      <span className="hr-payroll-job-progress-count">{jobs.length}</span>
    </button>
    <div className="hr-payroll-job-list" id="hr-payroll-job-list" aria-hidden={!expanded} inert={!expanded}>
      {jobs.map((job) => {
        const hasProgress = job.progressPercent !== null;
        // 準備或派送階段就失敗的工作沒有人數可算，畫 indeterminate 進度條會像還在跑。
        const failedBeforeProgress = job.status === "failed" && !hasProgress;
        return <article className={`hr-payroll-job-card hr-payroll-job-${job.status}`} key={job.jobId}>
          <div className="hr-payroll-job-card-head">
            <div><strong>{job.runName}</strong><small>{payrollPeriodLabel(job.periodKey)}・{PAYROLL_JOB_PHASE_LABEL[job.phase]}</small></div>
            <StatusBadge tone={payrollJobTone(job.status)}>{PAYROLL_JOB_STATUS_LABEL[job.status]}</StatusBadge>
          </div>
          {failedBeforeProgress ? null : <div className={`hr-payroll-job-bar${hasProgress ? "" : " is-indeterminate"}`} role="progressbar" aria-label={`${job.runName}試算進度`} aria-valuemin={0} aria-valuemax={100} {...(hasProgress ? { "aria-valuenow": job.progressPercent! } : {})}>
            <span style={hasProgress ? { width: `${job.progressPercent}%` } : undefined} />
          </div>}
          <div className="hr-payroll-job-card-foot">
            {job.status === "failed"
              ? <span className="hr-payroll-job-error">{job.error ?? "試算沒有完成，請重新試算。"}</span>
              : <span>{job.expectedCount > 0 ? `${job.completedCount.toLocaleString("zh-TW")} / ${job.expectedCount.toLocaleString("zh-TW")} 人` : "正在準備試算資料…"}</span>}
            {job.status === "failed" ? (canRetry ? <Button className="max-[760px]:self-stretch max-[760px]:justify-center" variant="secondary" icon="sync" tone="info" onClick={() => onRetry(job)}>重新試算</Button> : null) : job.dispatchPending && job.error ? <span className="hr-payroll-job-error">Queue 派送暫時失敗，系統會重試：{job.error}</span> : job.dispatchPending ? <span>等待 Queue 派送</span> : null}
          </div>
        </article>;
      })}
    </div>
  </section>, host);
}

export function HrPayrollSettlement() {
  usePageTitle("薪資結算");
  const { permissions, user } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const canRead = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:read"));
  const canCalculate = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:calculate"));
  const currentMonth = taipeiMonth();
  const [recordFilters, setRecordFilters] = useState<PayrollRecordFilters>({ page: 1, pageSize: 25, search: "", periodKey: "", status: "all", personKind: "all", payBasis: "all" });
  const [showCalculationDialog, setShowCalculationDialog] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [approveOpen, setApproveOpen] = useState(false);
  const employees = useHrEmployeeRoster(canRead && permissions.has("hr:employee:read"));
  const formalEmployees = (employees.data?.employees ?? []).filter(isHrFormalEmployee);
  const records = useHrQuery<PayrollRecordsResponse>(`/payroll/records?page=${recordFilters.page}&pageSize=${recordFilters.pageSize}&search=${encodeURIComponent(recordFilters.search)}&periodKey=${encodeURIComponent(recordFilters.periodKey || "all")}&status=${recordFilters.status}&personKind=${recordFilters.personKind}&payBasis=${recordFilters.payBasis}`, canRead);
  const [pollPayrollJobs, setPollPayrollJobs] = useState(true);
  const payrollJobs = useHrQuery<PayrollJobsResponse>("/payroll/jobs", canRead, { keepPreviousData: false, refetchInterval: pollPayrollJobs ? 3000 : false });
  const approvePayroll = useHrWrite<{ approved: number }>();
  const retryPayroll = useHrWrite<{ job: PayrollJob }>();

  const visibleUnsettledKeys = useMemo(() => (records.data?.records ?? []).filter((record) => record.status === "unsettled").map(referenceKey), [records.data?.records]);
  const selectedRecords = useMemo(() => (records.data?.records ?? []).filter((record) => selectedKeys.includes(referenceKey(record)) && record.status === "unsettled"), [records.data?.records, selectedKeys]);
  const selectedVisibleCount = visibleUnsettledKeys.filter((key) => selectedKeys.includes(key)).length;
  const allVisibleSelected = visibleUnsettledKeys.length > 0 && selectedVisibleCount === visibleUnsettledKeys.length;
  const selectAllRef = useRef<HTMLInputElement>(null);
  const mobileSelectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const validKeys = new Set((records.data?.records ?? []).filter((record) => record.status === "unsettled").map(referenceKey));
    setSelectedKeys((current) => current.filter((key) => validKeys.has(key)));
  }, [records.data?.records]);
  useEffect(() => {
    const jobs = payrollJobs.data?.jobs ?? [];
    setPollPayrollJobs(jobs.some(isPayrollJobActive));
    for (const job of jobs) {
      const previous = observedPayrollJobStatuses.get(job.jobId);
      if (previous && previous !== job.status && (job.status === "ready" || job.status === "failed")) {
        if (job.status === "ready") {
          toast.show(`${job.runName}試算完成，可以開始覆核。`, "success");
          void records.refetch();
        } else {
          toast.show(`${job.runName}試算失敗。`, "danger", canCalculate ? { label: "重新試算", onClick: () => retryJob(job) } : undefined);
        }
      }
      observedPayrollJobStatuses.set(job.jobId, job.status);
    }
  }, [canCalculate, payrollJobs.data?.jobs, records, toast]);
  useEffect(() => {
    const indeterminate = selectedVisibleCount > 0 && !allVisibleSelected;
    if (selectAllRef.current) selectAllRef.current.indeterminate = indeterminate;
    if (mobileSelectAllRef.current) mobileSelectAllRef.current.indeterminate = indeterminate;
  }, [allVisibleSelected, selectedVisibleCount]);

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
  function retryJob(job: PayrollJob) {
    if (retryPayroll.isPending) return;
    retryPayroll.mutate({ path: `/payroll/jobs/${encodeURIComponent(job.jobId)}/retry`, method: "POST", values: {} }, { onSuccess: ({ job: retriedJob }) => { observedPayrollJobStatuses.set(retriedJob.jobId, retriedJob.status); toast.show(`${retriedJob.runName}已重新加入薪資試算。`, "info"); setPollPayrollJobs(true); void payrollJobs.refetch(); } });
  }

  const payrollJobList = visiblePayrollJobs(payrollJobs.data?.jobs ?? []);

  return <div className="page fills hr-payroll-page">
    <PageHeader title="薪資發放紀錄" description="每位員工與支援人員各一筆發放紀錄；從明細確認試算結果，未結算試算可刪除整批，選取多筆後一次確定發放。" actions={canCalculate ? <Button tone="success" mobileIconOnly icon="plus" onClick={() => setShowCalculationDialog(true)}>新增試算</Button> : null} />
    {approvePayroll.error ? <Alert tone="danger">{approvePayroll.error.message}</Alert> : null}
    {payrollJobs.error ? <Alert tone="danger">薪資試算進度載入失敗：{payrollJobs.error.message}</Alert> : null}
    <PayrollJobProgress jobs={payrollJobList} onRetry={retryJob} canRetry={canCalculate} />

    <Panel className="grows hr-payroll-records-panel">
      <FilterToolbar className="hr-payroll-record-filter">
        <SearchFilterInput label="搜尋人員" placeholder="姓名或員工編號" value={recordFilters.search} onSearch={(search) => updateRecordFilters({ search })} />
        <FilterInput label="薪資月份" type="month" value={recordFilters.periodKey} onChange={(event) => updateRecordFilters({ periodKey: event.target.value })} />
        <FilterSelect label="狀態" value={recordFilters.status} options={[{ value: "all", label: "全部狀態" }, { value: "unsettled", label: "尚未結算" }, { value: "closed", label: "已確定發放" }]} onChange={(event) => updateRecordFilters({ status: event.target.value as PayrollRecordFilters["status"] })} />
        <FilterSelect label="人員類型" value={recordFilters.personKind} options={[{ value: "all", label: "全部人員" }, { value: "employee", label: "正式員工" }, { value: "worker", label: "支援人員" }]} onChange={(event) => updateRecordFilters({ personKind: event.target.value as PayrollRecordFilters["personKind"] })} />
        <FilterSelect label="計薪方式" value={recordFilters.payBasis} options={[{ value: "all", label: "全部計薪方式" }, { value: "monthly", label: "月薪" }, { value: "daily", label: "日薪" }, { value: "hourly", label: "時薪" }, { value: "mixed", label: "混合" }]} onChange={(event) => updateRecordFilters({ payBasis: event.target.value as PayrollRecordFilters["payBasis"] })} />
      </FilterToolbar>
      {records.error ? <Alert tone="danger">薪資紀錄載入失敗：{records.error.message}</Alert> : null}
      <div className="hr-payroll-table-region">
        <div className="hr-payroll-mobile-select-all">
          <label className="table-select-all">
            <input ref={mobileSelectAllRef} className="table-checkbox" type="checkbox" checked={allVisibleSelected} disabled={!canCalculate || !visibleUnsettledKeys.length || approvePayroll.isPending} onChange={(event) => toggleVisibleRecords(event.target.checked)} aria-label={allVisibleSelected ? "取消全選本頁尚未結算紀錄" : "全選本頁尚未結算紀錄"} />
            <span>{allVisibleSelected ? "取消全選本頁" : "全選本頁"}</span>
          </label>
        </div>
        <DataTable className="hr-payroll-record-table" containerClassName={records.isPlaceholderData ? "is-refreshing" : ""}>
            <thead><tr><th className="hr-payroll-select-cell"><input ref={selectAllRef} className="table-checkbox" type="checkbox" checked={allVisibleSelected} disabled={!canCalculate || !visibleUnsettledKeys.length || approvePayroll.isPending} onChange={(event) => toggleVisibleRecords(event.target.checked)} aria-label={allVisibleSelected ? "取消全選本頁尚未結算紀錄" : "全選本頁尚未結算紀錄"} /></th><th>薪資月份</th><th>人員</th><th>計薪方式</th><th className="numeric">應發</th><th className="numeric">扣款</th><th className="numeric">實領</th><th>狀態</th><th>操作</th></tr></thead>
            <tbody>{(records.data?.records ?? []).map((record) => <tr key={referenceKey(record)} className={selectedKeys.includes(referenceKey(record)) ? "selected" : undefined}>
              <td data-label="選取" className="hr-payroll-select-cell">{record.status === "unsettled" ? <input className="table-checkbox" type="checkbox" checked={selectedKeys.includes(referenceKey(record))} disabled={!canCalculate || approvePayroll.isPending} onChange={(event) => toggleRecord(record, event.target.checked)} aria-label={`選取${record.personName}`} /> : null}</td>
              <td data-label="薪資月份"><strong>{payrollPeriodLabel(record.periodKey)}</strong><small className="cell-sub">{record.payDate ? `發薪日 ${record.payDate}` : "未設定發薪日"}</small></td>
              <td data-label="人員"><div className="hr-payroll-record-person"><strong>{record.personName}</strong><small className="cell-sub">{record.personNumber ? `${record.personNumber}・` : ""}{PAYROLL_PERSON_KIND_LABEL[record.personKind]}</small></div></td>
              <td data-label="計薪方式">{record.payBasis ? PAY_BASIS_LABEL[record.payBasis] ?? record.payBasis : "—"}</td>
              <td data-label="應發" className="numeric">{money(record.earningMinor)}</td>
              <td data-label="扣款" className="numeric">{record.deductionMinor ? deductionMoney(record.deductionMinor) : "—"}</td>
              <td data-label="實領" className="numeric"><strong>{money(record.netMinor)}</strong></td>
              <td data-label="狀態"><StatusBadge tone={recordStatusTone(record.status)}>{PAYROLL_RECORD_STATUS_LABEL[record.status]}</StatusBadge></td>
              <td data-label="操作"><Button variant="secondary" icon="eye" tone="info" onClick={() => openRecord(record)}>查看明細</Button></td>
            </tr>)}</tbody>
        </DataTable>
        {selectedRecords.length ? <SelectionActionBar count={selectedRecords.length} countLabel="筆">{canCalculate ? <Button icon="check" loading={approvePayroll.isPending} onClick={() => setApproveOpen(true)}>確定發放</Button> : null}</SelectionActionBar> : null}
      </div>
      {records.data && !records.data.records.length ? <EmptyState className="mt-[18px]">目前沒有符合條件的薪資發放紀錄。</EmptyState> : null}
      {records.data && records.data.total > 0 ? <Pager className="mt-4 shrink-0" page={records.data.page} pageSize={records.data.pageSize} pageSizes={PAYROLL_RECORD_PAGE_SIZES} totalPages={Math.max(1, Math.ceil(records.data.total / records.data.pageSize))} totalLabel={`共 ${records.data.total.toLocaleString("zh-TW")} 筆`} onPage={(page) => updateRecordFilters({ page })} onPageSize={(pageSize) => updateRecordFilters({ pageSize })} /> : null}
    </Panel>

    {showCalculationDialog ? <PayrollCalculationDialog
      employees={formalEmployees}
      employeesPending={employees.isPending}
      employeesError={employees.error instanceof Error ? employees.error : null}
      initialPeriodKey={recordFilters.periodKey || currentMonth}
      initialPayDate=""
      onClose={() => setShowCalculationDialog(false)}
      onSuccess={({ job, run }) => { if (job) { observedPayrollJobStatuses.set(job.jobId, job.status); toast.show(job.status === "failed" ? `${job.runName}薪資試算啟動失敗，請重新試算。` : `${job.runName}已加入薪資試算，完成後會通知你。`, job.status === "failed" ? "danger" : "info"); } else if (run) toast.show("薪資試算完成，可以開始覆核。", "success"); setRecordFilters((current) => ({ ...current, periodKey: job?.periodKey ?? run?.periodKey ?? current.periodKey, page: 1 })); setSelectedKeys([]); setPollPayrollJobs(true); void payrollJobs.refetch(); }}
    /> : null}
    {approveOpen ? <ConfirmDialog title="確定發放選取紀錄？" confirmLabel="確定發放" pending={approvePayroll.isPending} onCancel={() => { if (!approvePayroll.isPending) setApproveOpen(false); }} onConfirm={approveSelected}>
      <p>即將將 <strong>{selectedRecords.length} 筆</strong>薪資紀錄標記為「已確定發放」。</p>
      <p>確定後薪資明細會保留為歷史快照，不能再修改或刪除。</p>
      {approvePayroll.error ? <Alert tone="danger">{approvePayroll.error.message}</Alert> : null}
    </ConfirmDialog> : null}
  </div>;
}
