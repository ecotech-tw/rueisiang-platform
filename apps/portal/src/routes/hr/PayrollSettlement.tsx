import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { useSession } from "../../auth/session.js";
import { Icon } from "../../shell/icons.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Pager } from "../../shell/Pager.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, DropdownSelect, EmptyState, FilterInput, FilterSelect, FilterToolbar, Page, PageHeader, Panel, SearchFilterInput, SelectionActionBar, StatusBadge, TABLE_SELECT_COLUMN, TableBulkActionMenu, TableMobileSelectAll, TextField, useTableBulkSelection, type TableBulkAction } from "../../ui/index.js";
import { hrEmployeeLabel, isHrFormalEmployee, useHrEmployeeRoster, useHrQuery, useHrWrite, type HrFormalEmployee, type PayrollCandidateExclusions, type PayrollJob, type PayrollJobsResponse, type PayrollRecord, type PayrollRun, type PayrollWorkerCandidate } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";
import { PeoplePickerEmpty, PeoplePickerHeading } from "./PickerList.js";

interface PayrollRecordsResponse {
  records: PayrollRecord[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  counts: { total: number; unsettled: number; closed: number; withdrawn: number };
}
interface PayrollRecordFilters {
  page: number;
  pageSize: number;
  search: string;
  periodKey: string;
  status: "all" | "unsettled" | "closed" | "withdrawn";
  personKind: "all" | "employee" | "worker";
  payBasis: "all" | "monthly" | "daily" | "hourly" | "mixed";
}
type PayrollEmployeeSelectionMode = "all" | "selected";

const PAYROLL_RECORD_PAGE_SIZES = [10, 25, 50, 100] as const;
const MAX_PAYROLL_SELECTED_EMPLOYEES = 80;
const MAX_PAYROLL_SELECTED_WORKERS = 100;
// 載入中的空名單要是同一個參考：每次 render 都給新的 [] 會讓依賴它的 effect 每輪都重跑、再 setState，變成無限重繪。
const NO_PAYROLL_WORKERS: PayrollWorkerCandidate[] = [];
const PAYROLL_RECORD_STATUS_LABEL = { unsettled: "尚未結算", closed: "已確定發放", withdrawn: "已撤回" } as const;
const PAYROLL_PERSON_KIND_LABEL = { employee: "正式員工", worker: "支援人員" } as const;
const PAY_BASIS_LABEL: Record<string, string> = { monthly: "月薪", daily: "日薪", hourly: "時薪", mixed: "混合" };
const PAYROLL_RECORD_TABLE = "min-w-[960px] max-[760px]:min-w-0 [&_.numeric]:whitespace-nowrap [&_.cell-sub]:block [&_.cell-sub]:mt-0.5 [&_tr.selected_td]:bg-brand/8";

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
function recordStatusTone(status: PayrollRecord["status"]): "success" | "warning" | "danger" {
  return status === "closed" ? "success" : status === "withdrawn" ? "danger" : "warning";
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
// 頁籤與面板是同一塊玻璃：外框、底色與陰影共用一份，右緣貼著視窗所以不畫右框。
// 底色多疊一層 state layer，頁籤的 hover/active 只換那個變數，不必把整串漸層再寫一次。
const PAYROLL_JOB_SURFACE = "border border-r-0 border-brand-dark/22 [background:linear-gradient(var(--hr-payroll-job-state-layer,transparent),var(--hr-payroll-job-state-layer,transparent)),linear-gradient(135deg,--alpha(var(--color-brand)/14%),--alpha(var(--color-paper)/96%)_72%)] [box-shadow:0_1px_0_--alpha(var(--color-paper)/72%)_inset,0_14px_36px_--alpha(var(--color-ink)/16%)] [-webkit-backdrop-filter:blur(16px)_saturate(150%)] [backdrop-filter:blur(16px)_saturate(150%)] pointer-events-auto";
const PAYROLL_JOB_EASE = "duration-220 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";
const PAYROLL_JOB_CHEVRON_SHOWN = "opacity-100 [scale:1] [filter:blur(0)]";
const PAYROLL_JOB_CHEVRON_HIDDEN = "opacity-0 [scale:.25] [filter:blur(4px)]";
// 錯誤是後端例外的原文，最長兩千字；不截的話一張卡就把整個面板撐滿。
const PAYROLL_JOB_ERROR = "line-clamp-3 [line-clamp:3] min-w-0 text-brand-dark [overflow-wrap:anywhere]";
const PICKER_GROUP_TITLE = "px-2.5 pt-1.5 pb-[3px] text-[12px] font-bold text-muted";
function referenceKey(record: Pick<PayrollRecord, "runId" | "personKind" | "personId">) {
  return `${record.runId}:${record.personKind}:${record.personId}`;
}

const PAYROLL_BULK_ACTIONS: TableBulkAction<PayrollRecord>[] = [
  { id: "approve", label: "確定發放", isEligible: (record) => record.status === "unsettled" },
  { id: "withdraw", label: "撤回已發放", isEligible: (record) => record.status === "closed" && !record.withdrawal },
  { id: "delete", label: "刪除試算", isEligible: (record) => record.status === "unsettled" || record.status === "withdrawn" && Boolean(record.withdrawal) },
];

export function payrollEmployeesInPeriod<T extends Pick<HrFormalEmployee, "serviceStartOn">>(employees: readonly T[], periodKey: string): T[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)) return [];
  const periodEnd = `${periodKey}-${new Date(Date.UTC(Number(periodKey.slice(0, 4)), Number(periodKey.slice(5, 7)), 0)).getUTCDate().toString().padStart(2, "0")}`;
  return employees.filter((employee) => Boolean(employee.serviceStartOn && employee.serviceStartOn <= periodEnd));
}

export function availablePayrollEmployees<T extends Pick<HrFormalEmployee, "userId" | "serviceStartOn">>(employees: readonly T[], exclusions: PayrollCandidateExclusions | undefined, periodKey: string): T[] {
  if (!exclusions || exclusions.allEmployees) return [];
  const excludedIds = new Set(exclusions.employeeUserIds);
  return payrollEmployeesInPeriod(employees, periodKey).filter((employee) => !excludedIds.has(employee.userId));
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
  const employeesInPeriod = useMemo(() => payrollEmployeesInPeriod(employees, periodKey), [employees, periodKey]);
  const availableEmployees = useMemo(() => availablePayrollEmployees(employees, candidateExclusions.data, periodKey), [candidateExclusions.data, employees, periodKey]);
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
    <div className="grid gap-[10px]">
      <PeoplePickerHeading title="試算人員" description="每位人員會在發放紀錄建立一筆資料；預設納入全部符合資格的人員。當月已有試算結果或正在試算的人員（不論是否已發放）會自動排除。" count={selectionMode === "all" ? `全體 ${selectedCount} 人` : `已選 ${selectedCount} 人`}><Button variant="link" onClick={selectAllPeople} disabled={selectionMode === "all" || peopleCount === 0 || calculatePayroll.isPending}>全選</Button></PeoplePickerHeading>
      <div className="grid max-h-[min(38vh,360px)] gap-0.5 overflow-y-auto rounded-card border border-line bg-canvas p-[5px]" role="group" aria-label="選擇員工與支援人員">
        <div className="grid gap-0.5">
          <strong className={PICKER_GROUP_TITLE}>正式員工</strong>
          {!periodKey ? <PeoplePickerEmpty>選擇計算月份後會列出尚未試算的正式員工。</PeoplePickerEmpty> : employeesPending || candidateExclusions.isPending ? <PeoplePickerEmpty>正在載入符合資格的員工…</PeoplePickerEmpty> : employeesError || candidateExclusions.error ? <PeoplePickerEmpty>本月薪資試算名單載入失敗。</PeoplePickerEmpty> : availableEmployees.length ? <DropdownSelect
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
          /> : <PeoplePickerEmpty>{employeesInPeriod.length ? "符合本月份日期條件的正式員工皆已有試算結果或正在試算。" : employees.length ? "本月份沒有符合在職日期條件的正式員工。" : "目前沒有符合資格的正式員工。"}</PeoplePickerEmpty>}
        </div>
        <div className="mt-1.5 grid gap-0.5 border-t border-t-soft-line pt-1.5">
          <strong className={PICKER_GROUP_TITLE}>支援人員</strong>
          {!periodKey ? <PeoplePickerEmpty>選擇計算月份後會列出該月可試算的支援人員。</PeoplePickerEmpty> : supportWorkers.isPending || candidateExclusions.isPending ? <PeoplePickerEmpty>正在載入本月已發布排班…</PeoplePickerEmpty> : supportWorkers.error || candidateExclusions.error ? <PeoplePickerEmpty>本月支援人員試算名單載入失敗。</PeoplePickerEmpty> : workerOptions.length ? <DropdownSelect
            multiple
            searchable
            compactSelected={selectionMode === "all"}
            value={workerValue}
            options={workerSelectOptions}
            placeholder="搜尋支援人員"
            aria-label="選擇支援人員"
            disabled={calculatePayroll.isPending || employeesPending || Boolean(employeesError) || candidateExclusions.isLoading || Boolean(candidateExclusions.error)}
            onValueChange={updateWorkerSelection}
          /> : <PeoplePickerEmpty>{rawWorkerOptions.length ? "本月份支援人員皆已有試算結果或正在試算。" : "本月份沒有已發布排班的支援人員。"}</PeoplePickerEmpty>}
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
  // 收合時只剩貼在視窗右緣的直式頁籤：它待在頁面右側的留白裡，不會蓋住表格右下角的「確定發放」。
  // 外框涵蓋頁籤上下的空白，那一塊不該攔截點擊，所以整塊 pointer-events-none，只有頁籤與面板自己收得到。
  // 用位移把面板推出視窗而不是收寬度：卡片內容不會在過場中重新排版，陰影也不必靠 overflow 裁。
  return createPortal(<section className={`fixed top-[60%] right-0 z-24 flex items-center pointer-events-none [--hr-payroll-job-panel-width:min(420px,calc(100vw_-_72px))] transition-[translate] ${PAYROLL_JOB_EASE} ${expanded ? "[translate:0_-50%]" : "[translate:calc(var(--hr-payroll-job-panel-width)_-_1px)_-50%]"}`} aria-label="薪資試算進度">
    {/* 頁籤疊在面板上面，並把自己右側的陰影裁掉：否則不是面板的陰影壓暗頁籤的字，就是頁籤的陰影畫到面板上。
        900px 以下頁面右側的留白只剩 24px，頁籤跟著縮才不會壓到表格的捲軸。
        頁籤貼齊視窗右緣，焦點外框往內畫才不會有一邊跑到畫面外。
        hover 另外包一層 (hover: hover)：觸控裝置點過之後 :hover 會黏住，頁籤會一直停在染色狀態。 */}
    <button
      type="button"
      className={`${PAYROLL_JOB_SURFACE} relative z-1 [clip-path:inset(-48px_0_-64px_-48px)] flex flex-none flex-col items-center gap-2 box-border w-8 min-w-0 min-h-0 pt-[10px] pb-3 rounded-l-[12px] appearance-none [@media(hover:hover)]:hover:[--hr-payroll-job-state-layer:--alpha(var(--color-brand)/4%)] active:[--hr-payroll-job-state-layer:--alpha(var(--color-brand)/7%)] focus-visible:outline-2 focus-visible:outline-secondary focus-visible:-outline-offset-4 max-[900px]:w-6 text-brand transition-[background-color,border-color,color,box-shadow] duration-120 ease-out motion-reduce:transition-none`}
      aria-expanded={expanded}
      aria-controls="hr-payroll-job-list"
      aria-label={`${expanded ? "收合" : "展開"}薪資試算，${jobs.length} 筆${failedCount ? `，其中 ${failedCount} 筆失敗` : ""}`}
      onClick={() => setExpanded((current) => !current)}
    >
      <span className="relative grid flex-none size-5 place-items-center text-muted" aria-hidden="true">
        <Icon name="chevronLeft" className={`absolute inset-0 size-5 transition-[opacity,scale,filter] ${PAYROLL_JOB_EASE} ${expanded ? PAYROLL_JOB_CHEVRON_HIDDEN : PAYROLL_JOB_CHEVRON_SHOWN}`} />
        <Icon name="chevronRight" className={`absolute inset-0 size-5 transition-[opacity,scale,filter] ${PAYROLL_JOB_EASE} ${expanded ? PAYROLL_JOB_CHEVRON_SHOWN : PAYROLL_JOB_CHEVRON_HIDDEN}`} />
      </span>
      {/* 收合時錯誤原因與「重新試算」都看不到，頁籤自己要說得出有失敗待處理，不能只靠顏色。 */}
      <strong className="text-ink text-[13px] font-normal tracking-[.08em] [writing-mode:vertical-rl]">{failedCount ? "試算失敗" : "薪資試算"}</strong>
      <span className={`grid min-w-5 h-5 box-border px-1 place-items-center rounded-full text-[12px] tabular-nums font-medium ${failedCount ? "bg-brand-dark text-paper" : "bg-brand-soft text-brand-dark"}`}>{jobs.length}</span>
    </button>
    {/* 面板以 60% 為中心，往下只剩 40% 的視窗高：上限照這一半算，底部才不會跑出畫面。
        往左退一格疊住頁籤的右緣，兩塊才會連成一片而不是中間夾一條線。
        收合只是把面板移到視窗外，36px 的陰影還是會滲回右緣；等它滑出去再整個藏掉。 */}
    <div className={`${PAYROLL_JOB_SURFACE} text-ink grid flex-none content-start gap-2 box-border w-(--hr-payroll-job-panel-width) max-h-[min(560px,calc(80vh_-_48px))] -ml-px overflow-x-hidden overflow-y-auto overscroll-contain p-4 rounded-l-card [transition-property:visibility] duration-0 motion-reduce:transition-none ${expanded ? "" : "invisible delay-220"}`} id="hr-payroll-job-list" aria-hidden={!expanded} inert={!expanded}>
      {jobs.map((job) => {
        const hasProgress = job.progressPercent !== null;
        // 準備或派送階段就失敗的工作沒有人數可算，畫 indeterminate 進度條會像還在跑。
        const failedBeforeProgress = job.status === "failed" && !hasProgress;
        return <article className="grid gap-[10px] p-3 border border-soft-line rounded-[12px] bg-canvas" key={job.jobId}>
          <div className="flex items-center justify-between gap-3 min-w-0 max-[760px]:items-start max-[760px]:flex-col">
            <div className="grid gap-0.5 min-w-0"><strong className="truncate">{job.runName}</strong><small className="text-muted text-[12px]">{payrollPeriodLabel(job.periodKey)}・{PAYROLL_JOB_PHASE_LABEL[job.phase]}</small></div>
            <StatusBadge tone={payrollJobTone(job.status)}>{PAYROLL_JOB_STATUS_LABEL[job.status]}</StatusBadge>
          </div>
          {failedBeforeProgress ? null : <div className="h-[7px] overflow-hidden rounded-full bg-ink/10" role="progressbar" aria-label={`${job.runName}試算進度`} aria-valuemin={0} aria-valuemax={100} {...(hasProgress ? { "aria-valuenow": job.progressPercent! } : {})}>
            <span className={`block h-full min-w-0 rounded-[inherit] transition-[width,background-color] ${PAYROLL_JOB_EASE} ${job.status === "failed" ? "bg-brand-dark" : "bg-brand"} ${hasProgress ? "" : "w-[32%] opacity-70"}`} style={hasProgress ? { width: `${job.progressPercent}%` } : undefined} />
          </div>}
          <div className="flex items-start justify-between gap-3 min-w-0 max-[760px]:flex-col text-muted text-[12px]">
            {job.status === "failed"
              ? <span className={PAYROLL_JOB_ERROR}>{job.error ?? "試算沒有完成，請重新試算。"}</span>
              : <span>{job.expectedCount > 0 ? `${job.completedCount.toLocaleString("zh-TW")} / ${job.expectedCount.toLocaleString("zh-TW")} 人` : "正在準備試算資料…"}</span>}
            {job.status === "failed" ? (canRetry ? <Button className="max-[760px]:self-stretch max-[760px]:justify-center" variant="secondary" icon="sync" tone="info" onClick={() => onRetry(job)}>重新試算</Button> : null) : job.dispatchPending && job.error ? <span className={PAYROLL_JOB_ERROR}>Queue 派送暫時失敗，系統會重試：{job.error}</span> : job.dispatchPending ? <span>等待 Queue 派送</span> : null}
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
  const [approveOpen, setApproveOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<PayrollRecord[]>([]);
  const [withdrawTargets, setWithdrawTargets] = useState<PayrollRecord[]>([]);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [withdrawValidationError, setWithdrawValidationError] = useState<string | null>(null);
  const employees = useHrEmployeeRoster(canRead && permissions.has("hr:employee:read"));
  const formalEmployees = (employees.data?.employees ?? []).filter(isHrFormalEmployee);
  const records = useHrQuery<PayrollRecordsResponse>(`/payroll/records?page=${recordFilters.page}&pageSize=${recordFilters.pageSize}&search=${encodeURIComponent(recordFilters.search)}&periodKey=${encodeURIComponent(recordFilters.periodKey || "all")}&status=${recordFilters.status}&personKind=${recordFilters.personKind}&payBasis=${recordFilters.payBasis}`, canRead);
  const [pollPayrollJobs, setPollPayrollJobs] = useState(true);
  const payrollJobs = useHrQuery<PayrollJobsResponse>("/payroll/jobs", canRead, { keepPreviousData: false, refetchInterval: pollPayrollJobs ? 3000 : false });
  const approvePayroll = useHrWrite<{ approved: number }>();
  const deletePayrollRecord = useHrWrite<{ deleted: true }>({ invalidate: false });
  const withdrawPayrollRecord = useHrWrite<{ withdrawn: true }>({ invalidate: false });
  const retryPayroll = useHrWrite<{ job: PayrollJob }>();
  const payrollRows = records.data?.records ?? [];
  const bulk = useTableBulkSelection(payrollRows, referenceKey, PAYROLL_BULK_ACTIONS);
  const selectedRecords = bulk.actionId === "approve" ? bulk.selectedRows : [];
  const selectedWithdrawableRecords = bulk.actionId === "withdraw" ? bulk.selectedRows : [];
  const selectedDeletableRecords = bulk.actionId === "delete" ? bulk.selectedRows : [];
  const payrollBulkActionOptions = PAYROLL_BULK_ACTIONS.map((action) => ({ id: action.id, label: action.label, eligibleCount: payrollRows.filter(action.isEligible).length }));
  const allVisibleSelected = bulk.allEligibleSelected;
  const selectAllRef = useRef<HTMLInputElement>(null);
  const mobileSelectAllRef = useRef<HTMLInputElement>(null);

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
    const indeterminate = bulk.someEligibleSelected && !allVisibleSelected;
    if (selectAllRef.current) selectAllRef.current.indeterminate = indeterminate;
    if (mobileSelectAllRef.current) mobileSelectAllRef.current.indeterminate = indeterminate;
  }, [allVisibleSelected, bulk.someEligibleSelected]);

  if (!canRead) return <Alert tone="danger">薪資資料僅限全平台 HR 管理者查看。</Alert>;
  if (records.isPending) return <HrPageSkeleton variant="table" />;

  function updateRecordFilters(patch: Partial<PayrollRecordFilters>) {
    setRecordFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
    bulk.cancel();
  }
  async function deleteSelectedRecords() {
    await Promise.all(deleteTargets.map((record) => deletePayrollRecord.mutateAsync({ path: `/payroll/records/${encodeURIComponent(record.runId)}/${record.personKind}/${encodeURIComponent(record.personId)}`, method: "DELETE", values: {} })));
    bulk.cancel();
    setDeleteTargets([]);
    void records.refetch();
    toast.show(`已刪除 ${deleteTargets.length} 筆薪資紀錄。`, "success");
  }
  async function withdrawSelectedRecords() {
    const reason = withdrawReason.trim();
    if (!reason) { setWithdrawValidationError("請填寫撤回原因。"); return; }
    setWithdrawValidationError(null);
    await Promise.all(withdrawTargets.map((record) => withdrawPayrollRecord.mutateAsync({ path: `/payroll/records/${encodeURIComponent(record.runId)}/${record.personKind}/${encodeURIComponent(record.personId)}/withdraw`, method: "POST", values: { reason } })));
    bulk.cancel();
    setWithdrawTargets([]);
    setWithdrawReason("");
    void records.refetch();
    toast.show(`已撤回 ${withdrawTargets.length} 筆薪資發放。`, "success");
  }
  function openRecord(record: PayrollRecord) {
    navigate(`/hr/payroll-settlement/${encodeURIComponent(record.runId)}/${record.personKind}/${encodeURIComponent(record.personId)}`);
  }
  function approveSelected() {
    if (!selectedRecords.length) return;
    approvePayroll.mutate({ path: "/payroll/records/approve", method: "POST", values: { records: selectedRecords.map(({ runId, personKind, personId }) => ({ runId, personKind, personId })) } }, {
      onSuccess: () => { bulk.cancel(); setApproveOpen(false); void records.refetch(); },
    });
  }
  function retryJob(job: PayrollJob) {
    if (retryPayroll.isPending) return;
    retryPayroll.mutate({ path: `/payroll/jobs/${encodeURIComponent(job.jobId)}/retry`, method: "POST", values: {} }, { onSuccess: ({ job: retriedJob }) => { observedPayrollJobStatuses.set(retriedJob.jobId, retriedJob.status); toast.show(`${retriedJob.runName}已重新加入薪資試算。`, "info"); setPollPayrollJobs(true); void payrollJobs.refetch(); } });
  }

  const payrollJobList = visiblePayrollJobs(payrollJobs.data?.jobs ?? []);

  return <Page layout="fills" className="hr-payroll-page">
    <PageHeader title="薪資發放紀錄" description="每位員工與支援人員各自管理試算版本與發放狀態；可刪除未發放的單筆結果、撤回個人發放，並選取多筆一次處理。" actions={canCalculate ? <Button tone="success" mobileIconOnly icon="plus" onClick={() => setShowCalculationDialog(true)}>新增試算</Button> : null} />
    {approvePayroll.error ? <Alert tone="danger">{approvePayroll.error.message}</Alert> : null}
    {payrollJobs.error ? <Alert tone="danger">薪資試算進度載入失敗：{payrollJobs.error.message}</Alert> : null}
    <PayrollJobProgress jobs={payrollJobList} onRetry={retryJob} canRetry={canCalculate} />

    <Panel grows className="grid gap-3.5">
      <FilterToolbar>
        <SearchFilterInput label="搜尋人員" placeholder="姓名或員工編號" value={recordFilters.search} onSearch={(search) => updateRecordFilters({ search })} className="min-w-[130px] flex-[1_1_220px] max-[760px]:min-w-0 max-[760px]:basis-full" />
        <FilterInput label="薪資月份" type="month" className="min-w-[130px] flex-[1_1_150px] max-[760px]:basis-full" value={recordFilters.periodKey} onChange={(event) => updateRecordFilters({ periodKey: event.target.value })} />
        <FilterSelect label="狀態" className="min-w-[130px] flex-[1_1_150px] max-[760px]:basis-full" value={recordFilters.status} options={[{ value: "all", label: "全部狀態" }, { value: "unsettled", label: "尚未結算" }, { value: "closed", label: "已確定發放" }, { value: "withdrawn", label: "已撤回" }]} onChange={(event) => updateRecordFilters({ status: event.target.value as PayrollRecordFilters["status"] })} />
        <FilterSelect label="人員類型" className="min-w-[130px] flex-[1_1_150px] max-[760px]:basis-full" value={recordFilters.personKind} options={[{ value: "all", label: "全部人員" }, { value: "employee", label: "正式員工" }, { value: "worker", label: "支援人員" }]} onChange={(event) => updateRecordFilters({ personKind: event.target.value as PayrollRecordFilters["personKind"] })} />
        <FilterSelect label="計薪方式" className="min-w-[130px] flex-[1_1_150px] max-[760px]:basis-full" value={recordFilters.payBasis} options={[{ value: "all", label: "全部計薪方式" }, { value: "monthly", label: "月薪" }, { value: "daily", label: "日薪" }, { value: "hourly", label: "時薪" }, { value: "mixed", label: "混合" }]} onChange={(event) => updateRecordFilters({ payBasis: event.target.value as PayrollRecordFilters["payBasis"] })} />
      </FilterToolbar>
      {records.error ? <Alert tone="danger">薪資紀錄載入失敗：{records.error.message}</Alert> : null}
      <div className="relative flex min-h-0 min-w-0 flex-auto flex-col overflow-hidden">
        {canCalculate ? <div className="mb-2 flex justify-end min-[761px]:hidden"><TableBulkActionMenu actionId={bulk.actionId} actions={payrollBulkActionOptions} disabled={approvePayroll.isPending || deletePayrollRecord.isPending || withdrawPayrollRecord.isPending} onChange={(actionId) => actionId ? bulk.chooseAction(actionId) : bulk.cancel()} /></div> : null}
        {bulk.actionId && bulk.eligibleKeys.length ? <TableMobileSelectAll variant="divided" inputRef={mobileSelectAllRef} checked={allVisibleSelected} disabled={approvePayroll.isPending || deletePayrollRecord.isPending || withdrawPayrollRecord.isPending} onChange={(checked) => bulk.toggleAll(checked)} aria-label={allVisibleSelected ? "取消全選本頁符合條件紀錄" : "全選本頁符合條件紀錄"}>{allVisibleSelected ? "取消全選本頁" : "全選本頁符合條件"}</TableMobileSelectAll> : null}
        <DataTable className={`${PAYROLL_RECORD_TABLE} ${bulk.actionId ? TABLE_SELECT_COLUMN.inline : ""}`} containerClassName={`min-h-0 flex-auto overflow-y-auto ${records.isPlaceholderData ? "is-refreshing opacity-62 [transition:opacity_160ms_ease-out]" : ""}`}>
            <thead><tr>{bulk.actionId ? <th>{bulk.eligibleKeys.length ? <input ref={selectAllRef} className="table-checkbox" type="checkbox" checked={allVisibleSelected} disabled={approvePayroll.isPending || deletePayrollRecord.isPending || withdrawPayrollRecord.isPending} onChange={(event) => bulk.toggleAll(event.target.checked)} aria-label={allVisibleSelected ? "取消全選本頁符合條件紀錄" : "全選本頁符合條件紀錄"} /> : null}</th> : null}<th>薪資月份</th><th>人員</th><th>計薪方式</th><th className="numeric">應發</th><th className="numeric">扣款</th><th className="numeric">實領</th><th>狀態</th><th><div className="flex min-w-[220px] items-center justify-between gap-2"><span>操作</span>{canCalculate ? <TableBulkActionMenu actionId={bulk.actionId} actions={payrollBulkActionOptions} disabled={approvePayroll.isPending || deletePayrollRecord.isPending || withdrawPayrollRecord.isPending} onChange={(actionId) => actionId ? bulk.chooseAction(actionId) : bulk.cancel()} /> : null}</div></th></tr></thead>
            <tbody>{payrollRows.map((record) => <tr key={referenceKey(record)} className={bulk.selectedKeys.includes(referenceKey(record)) ? "selected" : undefined}>
              {bulk.actionId ? <td data-label="選取">{bulk.isRowEligible(record) ? <input className="table-checkbox" type="checkbox" checked={bulk.selectedKeys.includes(referenceKey(record))} disabled={approvePayroll.isPending || deletePayrollRecord.isPending || withdrawPayrollRecord.isPending} onChange={(event) => bulk.toggleRow(record, event.target.checked)} aria-label={`選取${record.personName}`} /> : null}</td> : null}
              <td data-label="薪資月份"><strong>{payrollPeriodLabel(record.periodKey)}</strong><small className="cell-sub">{record.payDate ? `發薪日 ${record.payDate}` : "未設定發薪日"}</small></td>
              <td data-label="人員"><div className="grid min-w-0 gap-0.5"><strong className="truncate">{record.personName}</strong><small className="cell-sub">{record.personNumber ? `${record.personNumber}・` : ""}{PAYROLL_PERSON_KIND_LABEL[record.personKind]}</small></div></td>
              <td data-label="計薪方式">{record.payBasis ? PAY_BASIS_LABEL[record.payBasis] ?? record.payBasis : "—"}</td>
              <td data-label="應發" className="numeric">{money(record.earningMinor)}</td>
              <td data-label="扣款" className="numeric">{record.deductionMinor ? deductionMoney(record.deductionMinor) : "—"}</td>
              <td data-label="實領" className="numeric"><strong>{money(record.netMinor)}</strong></td>
              <td data-label="狀態"><StatusBadge tone={recordStatusTone(record.status)}>{PAYROLL_RECORD_STATUS_LABEL[record.status]}</StatusBadge></td>
              <td data-label="操作"><div className="flex flex-wrap items-center gap-2"><Button variant="secondary" icon="eye" tone="info" onClick={() => openRecord(record)}>查看明細</Button>{canCalculate && (record.status === "unsettled" || record.status === "withdrawn" && record.withdrawal) ? <Button variant="danger" icon="trash" disabled={deletePayrollRecord.isPending} onClick={() => setDeleteTargets([record])}>刪除試算</Button> : null}{canCalculate && record.status === "closed" && !record.withdrawal ? <Button variant="danger" icon="history" disabled={withdrawPayrollRecord.isPending} onClick={() => { setWithdrawReason(""); setWithdrawValidationError(null); setWithdrawTargets([record]); }}>撤回</Button> : null}</div></td>
            </tr>)}</tbody>
        </DataTable>
        {bulk.selectedRows.length ? <SelectionActionBar count={bulk.selectedRows.length} countLabel={bulk.actionId === "approve" ? "筆待發放紀錄" : bulk.actionId === "withdraw" ? "筆已發放紀錄" : "筆薪資紀錄"} className="!pl-5 !pr-5 max-[760px]:!pl-4 max-[760px]:!pr-4">
          {bulk.actionId === "approve" ? <Button icon="check" loading={approvePayroll.isPending} onClick={() => setApproveOpen(true)}>確定發放</Button> : null}
          {bulk.actionId === "delete" ? <Button variant="danger" icon="trash" onClick={() => setDeleteTargets(selectedDeletableRecords)}>刪除試算</Button> : null}
          {bulk.actionId === "withdraw" ? <Button variant="danger" icon="history" onClick={() => { setWithdrawReason(""); setWithdrawValidationError(null); setWithdrawTargets(selectedWithdrawableRecords); }}>撤回已發放</Button> : null}
        </SelectionActionBar> : null}
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
      onSuccess={({ job, run }) => { if (job) { observedPayrollJobStatuses.set(job.jobId, job.status); toast.show(job.status === "failed" ? `${job.runName}薪資試算啟動失敗，請重新試算。` : `${job.runName}已加入薪資試算，完成後會通知你。`, job.status === "failed" ? "danger" : "info"); } else if (run) toast.show("薪資試算完成，可以開始覆核。", "success"); setRecordFilters((current) => ({ ...current, periodKey: job?.periodKey ?? run?.periodKey ?? current.periodKey, page: 1 })); bulk.cancel(); setPollPayrollJobs(true); void payrollJobs.refetch(); }}
    /> : null}
    {deleteTargets.length ? <ConfirmDialog title={`刪除 ${deleteTargets.length} 筆薪資試算？`} confirmLabel="刪除試算" pending={deletePayrollRecord.isPending} onCancel={() => { if (!deletePayrollRecord.isPending) setDeleteTargets([]); }} onConfirm={() => { void deleteSelectedRecords().catch(() => { void records.refetch(); }); }}>
      <p>選取的薪資紀錄（包含未結算試算或已撤回紀錄）、明細與加扣項會一併刪除，之後可以重新加入試算；撤回稽核紀錄會保留。</p>
      {deletePayrollRecord.error ? <Alert tone="danger">{deletePayrollRecord.error.message}</Alert> : null}
    </ConfirmDialog> : null}
    {withdrawTargets.length ? <ConfirmDialog title={`撤回 ${withdrawTargets.length} 筆薪資發放？`} confirmLabel="撤回發放" pending={withdrawPayrollRecord.isPending} onCancel={() => { if (!withdrawPayrollRecord.isPending) setWithdrawTargets([]); }} onConfirm={() => { void withdrawSelectedRecords().catch(() => { void records.refetch(); }); }}>
      <p>原薪資快照會保留供稽核，撤回後可重新試算；若包含未休特休折現，系統會一併恢復額度。</p>
      <TextField label="撤回原因" value={withdrawReason} maxLength={1000} required placeholder="請說明撤回原因" onChange={(event) => setWithdrawReason(event.target.value)} />
      {withdrawValidationError ? <Alert tone="danger">{withdrawValidationError}</Alert> : null}
      {withdrawPayrollRecord.error ? <Alert tone="danger">{withdrawPayrollRecord.error.message}</Alert> : null}
    </ConfirmDialog> : null}
    {approveOpen ? <ConfirmDialog title="確定發放選取紀錄？" confirmLabel="確定發放" pending={approvePayroll.isPending} onCancel={() => { if (!approvePayroll.isPending) setApproveOpen(false); }} onConfirm={approveSelected}>
      <p>即將將 <strong>{selectedRecords.length} 筆</strong>薪資紀錄標記為「已確定發放」。</p>
      <p>確定後薪資明細會保留為歷史快照，不能再修改或刪除。</p>
      {approvePayroll.error ? <Alert tone="danger">{approvePayroll.error.message}</Alert> : null}
    </ConfirmDialog> : null}
  </Page>;
}
