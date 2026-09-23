import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { useSession } from "../../auth/session.js";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
import { HR_ROSTER_PATH, useHrQuery, useHrWrite, type Employee, type PayrollEmployee, type PayrollLine, type PayrollLineCalculationPart, type PayrollRun, type PayrollRunSummary, type Profile } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

interface PayrollRunsResponse { runs: PayrollRunSummary[] }
interface EmployeeListResponse { employees: Employee[] }
interface PayrollLineDetail { label: string; value: string }
interface PayrollDisclosureProps { className: string; summaryClassName?: string; summary: ReactNode; children: ReactNode; defaultOpen?: boolean }
type PayrollDisclosureState = "closed" | "opening" | "open" | "closing";

const PAYROLL_DISCLOSURE_DURATION_MS = 220;
const PAYROLL_RUN_NAME_MAX_LENGTH = 20;
const PAYROLL_RUN_NAME_ELLIPSIS = "...";
const RUN_STATUS: Record<string, string> = { calculating: "計算中", ready: "待覆核", approved: "已核准", closed: "已結帳", failed: "失敗" };
const PERIOD_STATUS: Record<string, string> = { open: "開放中", closed: "已關閉" };
const PAY_BASIS_LABEL: Record<string, string> = { monthly: "月薪", daily: "日薪", hourly: "時薪" };
const ITEM_BASIS_LABEL: Record<string, string> = { monthly: "月給", daily: "每日", hourly: "每小時" };
const LINE_LABELS: Record<string, string> = {
  base_salary: "本薪", overtime: "核准付薪加班", unpaid_leave: "無薪假扣款", booth_bonus: "櫃點獎金", attendance_summary: "出勤摘要",
  labor_insurance: "勞保員工負擔", health_insurance: "健保員工負擔", special_workday: "特殊上班日薪資", annual_leave_settlement: "未休特休折現",
};

function money(minor: number): string {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}
function formulaMoney(minor: number): string {
  const absoluteMinor = Math.abs(minor);
  const whole = Math.floor(absoluteMinor / 100).toLocaleString("zh-TW");
  const cents = absoluteMinor % 100;
  return `NT$ ${minor < 0 ? "−" : ""}${whole}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
}
function deductionMoney(minor: number): string {
  return `-NT$ ${Math.abs(Math.round(minor / 100)).toLocaleString("zh-TW")}`;
}
function adjustmentMoney(minor: number): string {
  return minor >= 0 ? money(minor) : deductionMoney(minor);
}
function percentage(ppm: number): string {
  return `${(ppm / 10_000).toFixed(4).replace(/\.?0+$/, "")}%`;
}
function hours(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}
function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
function taipeiMonth() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${parts.find((item) => item.type === "year")?.value ?? ""}-${parts.find((item) => item.type === "month")?.value ?? ""}`;
}
function nextMonth(value: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return "";
  const [year, month] = value.split("-").map(Number);
  const next = new Date(Date.UTC(year!, month!, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}
function readableLine(line: PayrollLine): string {
  if (line.lineKey.startsWith("bonus_")) return `業績獎金${stringValue(line.explanation.policyName) ? `｜${line.explanation.policyName}` : ""}`;
  if (line.lineKey.startsWith("salary_item_")) return stringValue(line.explanation.itemName) ?? "薪資項目";
  if (line.lineKey.startsWith("special_allowance_")) return `特殊上班日補貼${stringValue(line.explanation.rule) ? `｜${line.explanation.rule}` : ""}`;
  return LINE_LABELS[line.lineKey] ?? line.lineKey;
}

function payBasis(employee: PayrollEmployee): string {
  const basis = employee.lines.find((line) => line.lineKey === "base_salary")?.explanation.payBasis;
  return typeof basis === "string" ? PAY_BASIS_LABEL[basis] ?? basis : "—";
}

function fallbackFormula(line: PayrollLine): string {
  const explanation = line.explanation;
  const savedDetail = stringValue(explanation.formulaDetail);
  if (savedDetail) return savedDetail;
  const savedFormula = stringValue(explanation.formula);
  if (savedFormula) return savedFormula;
  if (line.lineKey === "health_insurance" || line.lineKey === "labor_insurance") {
    const insured = numberValue(explanation.insuredAmountMinor);
    const employeeRate = numberValue(explanation.employeeRatePpm);
    if (insured !== null && employeeRate !== null) {
      const baseMinor = Math.floor(insured * employeeRate / 1_000_000);
      const baseYuan = Math.round(baseMinor / 100);
      if (line.lineKey === "health_insurance") {
        const dependentCount = numberValue(explanation.dependentCount) ?? 0;
        const dependentRate = numberValue(explanation.dependentRatePpm) ?? 1_000_000;
        return `本人保費 ${formulaMoney(baseYuan * 100)} × (1 + ${dependentCount} 位親屬 × ${percentage(dependentRate)}) = ${deductionMoney(line.amountMinor)}`;
      }
      return `本人保費 ${formulaMoney(baseYuan * 100)} = ${deductionMoney(line.amountMinor)}`;
    }
  }
  if (line.lineKey.startsWith("bonus_")) {
    const revenue = numberValue(explanation.revenueMinor);
    const guarantee = numberValue(explanation.guaranteeMinor);
    const rate = numberValue(explanation.ratePpm);
    if (revenue !== null && guarantee !== null && rate !== null) {
      const base = `max(0, ${formulaMoney(revenue)} − ${formulaMoney(guarantee)}) × ${percentage(rate)}`;
      return explanation.bonusKind === "team_performance"
        ? `${base} → 獎金池，再按本人權重分配 = ${money(line.amountMinor)}`
        : `${base} = ${money(line.amountMinor)}`;
    }
  }
  if (line.lineKey === "base_salary") {
    return stringValue(explanation.rule) ?? "依敘薪與出勤資料計算";
  }
  if (line.lineKey.startsWith("salary_item_")) {
    return stringValue(explanation.rule) ?? "依薪資項目設定與出勤資料計算";
  }
  return "此批次未保存詳細公式；請重新試算以取得完整計算依據。";
}

function displayFormula(line: PayrollLine): string {
  const formula = fallbackFormula(line);
  return line.direction === "deduction" ? `扣款：${formula}` : formula;
}

function calculationParts(line: PayrollLine): PayrollLineCalculationPart[] {
  const value = line.explanation.calculationParts;
  if (!Array.isArray(value)) return [];
  return value.filter((part): part is PayrollLineCalculationPart => Boolean(part) && typeof part === "object" && typeof (part as Record<string, unknown>).formula === "string" && typeof (part as Record<string, unknown>).amountMinor === "number");
}

function PayrollDisclosure({ className, summaryClassName, summary, children, defaultOpen = false }: PayrollDisclosureProps) {
  const initialState: PayrollDisclosureState = defaultOpen ? "open" : "closed";
  const [state, setState] = useState<PayrollDisclosureState>(initialState);
  const stateRef = useRef(state);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setDisclosureState = (next: PayrollDisclosureState) => {
    stateRef.current = next;
    setState(next);
  };
  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  useEffect(() => () => clearTimer(), []);
  function finishTransition(next: "open" | "closed") {
    const expected: PayrollDisclosureState = next === "open" ? "opening" : "closing";
    if (stateRef.current !== expected) return;
    clearTimer();
    setDisclosureState(next);
  }
  function toggle(event: MouseEvent<HTMLElement>) {
    // 原生 details 收合會立刻把內容拿出 layout；先攔住預設行為，等 0fr 動畫完成才關閉 open。
    event.preventDefault();
    clearTimer();
    const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const opening = stateRef.current === "closed" || stateRef.current === "closing";
    if (reduceMotion) {
      setDisclosureState(opening ? "open" : "closed");
      return;
    }
    const next = opening ? "opening" : "closing";
    setDisclosureState(next);
    timerRef.current = setTimeout(() => finishTransition(opening ? "open" : "closed"), PAYROLL_DISCLOSURE_DURATION_MS + 50);
  }
  const contentHidden = state === "closed" || state === "closing";
  return <details className={`hr-payroll-disclosure ${className}`} data-disclosure-state={state} open={state !== "closed"}>
    <summary className={summaryClassName} onClick={toggle}>{summary}</summary>
    <div className="hr-payroll-disclosure-content" aria-hidden={contentHidden} inert={contentHidden}>
      <div className="hr-payroll-disclosure-content-inner">{children}</div>
    </div>
  </details>;
}

function PayrollDisclosureMarker({ className }: { className: string }) {
  return <span className={`hr-payroll-disclosure-marker ${className}`} aria-hidden="true"><Icon name="chevronDown" /></span>;
}

function lineDetails(line: PayrollLine): PayrollLineDetail[] {
  const explanation = line.explanation;
  const details: PayrollLineDetail[] = [];
  if (line.lineKey === "base_salary") {
    const basis = stringValue(explanation.payBasis);
    if (basis) details.push({ label: "計薪方式", value: PAY_BASIS_LABEL[basis] ?? basis });
    if (stringValue(explanation.period)) details.push({ label: "計算月份", value: explanation.period as string });
  }
  if (line.lineKey.startsWith("salary_item_")) {
    const basis = stringValue(explanation.amountBasis);
    if (basis) details.push({ label: "給付單位", value: ITEM_BASIS_LABEL[basis] ?? basis });
    if (stringValue(explanation.itemKind)) details.push({ label: "項目類型", value: explanation.itemKind === "variable" ? "變動" : "固定" });
    details.push({ label: "計入加班基礎", value: explanation.includeOvertime ? "是" : "否" });
    details.push({ label: "計入投保基數", value: explanation.includeInsurance ? "是" : "否" });
    details.push({ label: "計入扣繳", value: explanation.includeTax ? "是" : "否" });
  }
  if (line.lineKey.startsWith("bonus_")) {
    if (stringValue(explanation.policyName)) details.push({ label: "適用政策", value: explanation.policyName as string });
    if (explanation.bonusKind) details.push({ label: "績效歸屬", value: explanation.bonusKind === "team_performance" ? "團體績效" : "個人績效" });
    if (explanation.performancePeriod) details.push({ label: "業績期間", value: explanation.performancePeriod === "previous_month" ? "前月" : "當月" });
    const revenue = numberValue(explanation.revenueMinor);
    const guarantee = numberValue(explanation.guaranteeMinor);
    const rate = numberValue(explanation.ratePpm);
    if (revenue !== null) details.push({ label: "業績", value: money(revenue) });
    if (guarantee !== null) details.push({ label: "保底", value: money(guarantee) });
    if (rate !== null) details.push({ label: "獎金比例", value: percentage(rate) });
    const weight = numberValue(explanation.weightUnits);
    const weightedTotal = numberValue(explanation.weightedTotal);
    if (weight !== null && weightedTotal !== null && explanation.bonusKind === "team_performance") details.push({ label: "分配權重", value: `${weight} ÷ ${weightedTotal}` });
    const scheduledDays = numberValue(explanation.scheduledDays);
    if (scheduledDays !== null) details.push({ label: "本人排班日", value: `${scheduledDays} 天` });
  }
  if (line.lineKey === "labor_insurance" || line.lineKey === "health_insurance") {
    const insured = numberValue(explanation.insuredAmountMinor);
    const dependentCount = numberValue(explanation.dependentCount);
    const employeeRate = numberValue(explanation.employeeRatePpm);
    const dependentRate = numberValue(explanation.dependentRatePpm);
    if (insured !== null) details.push({ label: "投保金額", value: money(insured) });
    if (employeeRate !== null) details.push({ label: "本人負擔比例", value: percentage(employeeRate) });
    if (line.lineKey === "health_insurance" && dependentCount !== null) details.push({ label: "親屬人數", value: `${dependentCount} 人` });
    if (line.lineKey === "health_insurance" && dependentRate !== null) details.push({ label: "親屬負擔比例", value: percentage(dependentRate) });
    if (stringValue(explanation.sourceKind)) details.push({ label: "規則來源", value: explanation.sourceKind === "official" ? "官方" : "人工覆核" });
  }
  if (line.lineKey === "overtime") {
    const approvedRequests = numberValue(explanation.approvedRequests);
    const standardDailyHours = numberValue(explanation.standardDailyHours);
    if (approvedRequests !== null) details.push({ label: "核准筆數", value: `${approvedRequests} 筆` });
    if (line.quantitySeconds !== undefined) details.push({ label: "加班時數", value: `${hours(line.quantitySeconds / 3600)} 小時` });
    if (standardDailyHours !== null) details.push({ label: "每日標準工時", value: `${hours(standardDailyHours)} 小時` });
  }
  if (line.lineKey === "unpaid_leave") {
    if (stringValue(explanation.period)) details.push({ label: "計算月份", value: explanation.period as string });
    const entryCount = numberValue(explanation.entryCount);
    if (entryCount !== null) details.push({ label: "登記／申請筆數", value: `${entryCount} 筆` });
  }
  if (line.lineKey === "annual_leave_settlement") {
    details.push({ label: "折現基準", value: "結算日適用月薪 ÷ 30" });
    const settlementItems = Array.isArray(explanation.settlementItems) ? explanation.settlementItems : [];
    details.push({ label: "結算筆數", value: `${settlementItems.length} 筆` });
  }
  if (line.lineKey === "special_workday" || line.lineKey.startsWith("special_allowance_")) {
    if (stringValue(explanation.rule)) details.push({ label: "套用規則", value: explanation.rule as string });
    const quantity = numberValue(explanation.quantity);
    if (quantity !== null) details.push({ label: "套用次數", value: `${quantity} 次` });
  }
  if (line.lineKey.startsWith("adjustment_")) {
    if (stringValue(explanation.sourcePeriodKey)) details.push({ label: "來源月份", value: explanation.sourcePeriodKey as string });
    if (stringValue(explanation.reason)) details.push({ label: "調整原因", value: explanation.reason as string });
  }
  return details;
}

function PayrollLineDetail({ line }: { line: PayrollLine }) {
  const parts = calculationParts(line);
  const details = lineDetails(line);
  return <PayrollDisclosure
    className={`hr-payroll-line hr-payroll-line-${line.direction}`}
    summaryClassName="hr-payroll-line-summary"
    summary={<>
      <span className="hr-payroll-line-head">
        <span className="hr-payroll-line-title"><strong>{readableLine(line)}</strong><span className="hr-payroll-line-direction">{line.direction === "earning" ? "應發" : "扣款"}</span></span>
        <strong className="hr-payroll-line-amount">{line.direction === "deduction" ? deductionMoney(line.amountMinor) : money(line.amountMinor)}</strong>
      </span>
      <PayrollDisclosureMarker className="hr-payroll-line-marker" />
    </>}
  >
    <div className="hr-payroll-line-content">
      <div className="hr-payroll-line-formula">
        <span>計算公式</span>
        <p>{displayFormula(line)}</p>
      </div>
      {details.length ? <dl className="hr-payroll-line-details">{details.map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}</dl> : null}
      {parts.length > 1 ? <PayrollDisclosure
        className="hr-payroll-line-steps"
        summaryClassName="hr-payroll-line-steps-summary"
        summary={<><span>查看 {parts.length} 段計算</span><PayrollDisclosureMarker className="hr-payroll-line-steps-marker" /></>}
      >
        <ol>{parts.map((part, index) => <li key={`${part.formula}-${index}`}><span>{part.formula}</span><strong>{money(part.amountMinor)}</strong></li>)}</ol>
      </PayrollDisclosure> : null}
    </div>
  </PayrollDisclosure>;
}

function workerFormula(worker: PayrollRun["workers"][number]): string {
  const basis = worker.payBasis === "monthly" ? "月薪 ÷ 30 天" : worker.payBasis === "hourly" ? "時薪 ×（排班時數 − 休息時間）" : worker.payBasis === "mixed" ? "各敘薪版本分段計算" : "日薪 × 排班日期";
  return `${basis}，依已發布排班 ${worker.scheduledDays} 天與有效敘薪計算 = ${money(worker.amountMinor)}`;
}

type PayrollEmployeeSelectionMode = "all" | "selected";

function shortenPayrollRunName(value: string): string {
  const characters = Array.from(value);
  return characters.length > PAYROLL_RUN_NAME_MAX_LENGTH
    ? `${characters.slice(0, PAYROLL_RUN_NAME_MAX_LENGTH - PAYROLL_RUN_NAME_ELLIPSIS.length).join("")}${PAYROLL_RUN_NAME_ELLIPSIS}`
    : value;
}

function suggestedPayrollRunName(selectionMode: PayrollEmployeeSelectionMode, employees: Employee[], selectedEmployeeIds: string[]): string {
  if (selectionMode === "all") return "全體員工";
  const names = employees.filter((employee) => selectedEmployeeIds.includes(employee.userId)).map((employee) => employee.displayName).join("、");
  return shortenPayrollRunName(names || "選擇員工");
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
  const [runName, setRunName] = useState("全體員工");
  const [nameCustomized, setNameCustomized] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const calculatePayroll = useHrWrite<{ run: PayrollRun }>();
  const suggestedName = useMemo(() => suggestedPayrollRunName(selectionMode, employees, selectedEmployeeIds), [employees, selectedEmployeeIds, selectionMode]);
  const selectedCount = selectionMode === "all" ? employees.length : selectedEmployeeIds.length;
  const unselectedCount = Math.max(0, employees.length - selectedCount);

  useEffect(() => {
    if (!nameCustomized) setRunName(suggestedName);
  }, [nameCustomized, suggestedName]);

  function setAllEmployees(checked: boolean) {
    setSelectionMode(checked ? "all" : "selected");
    setSelectedEmployeeIds(checked ? employees.map((employee) => employee.userId) : []);
  }

  function toggleEmployee(userId: string, checked: boolean) {
    const currentIds = selectionMode === "all" ? employees.map((employee) => employee.userId) : selectedEmployeeIds;
    const nextIds = checked
      ? [...new Set([...currentIds, userId])]
      : currentIds.filter((id) => id !== userId);
    setSelectedEmployeeIds(nextIds);
    setSelectionMode(nextIds.length === employees.length && employees.length > 0 ? "all" : "selected");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = runName.trim();
    const nameLength = Array.from(trimmedName).length;
    if (!periodKey) { setValidationError("請選擇計算月份。"); return; }
    if (selectionMode === "selected" && selectedCount === 0) { setValidationError("請至少選擇一位員工，或改選全體員工。"); return; }
    if (!trimmedName || nameLength > PAYROLL_RUN_NAME_MAX_LENGTH) { setValidationError(`結算名稱請填 1～${PAYROLL_RUN_NAME_MAX_LENGTH} 個字。`); return; }
    setValidationError(null);
    calculatePayroll.mutate({
      path: "/payroll/calculate",
      method: "POST",
      values: {
        periodKey,
        payDate: payDate || undefined,
        runName: trimmedName,
        attendanceMode: "all",
        employeeUserIds: selectionMode === "all" ? undefined : selectedEmployeeIds,
        requestId: `portal-${crypto.randomUUID()}`,
      },
    }, { onSuccess: (result) => { onSuccess(result.run); onClose(); } });
  }

  return <Dialog
    className="hr-payroll-create-dialog"
    title="新增薪資試算"
    titleMeta={`${periodKey || "尚未選擇月份"}・已選 ${selectedCount} 位員工`}
    onClose={onClose}
    closeDisabled={calculatePayroll.isPending}
    formProps={{ onSubmit: submit }}
    actions={<><Button variant="secondary" onClick={onClose} disabled={calculatePayroll.isPending}>取消</Button><Button type="submit" icon="payments" loading={calculatePayroll.isPending}>開始試算</Button></>}
  >
    <div className="form-grid two">
      <TextField type="month" label="計算月份" value={periodKey} required onChange={(event) => setPeriodKey(event.target.value)} />
      <TextField type="date" label="發薪日（選填）" value={payDate} onChange={(event) => setPayDate(event.target.value)} />
    </div>
    <TextField label="這次結算名稱" value={runName} maxLength={PAYROLL_RUN_NAME_MAX_LENGTH} required hint={`${Array.from(runName).length}/${PAYROLL_RUN_NAME_MAX_LENGTH}`} onChange={(event) => { setNameCustomized(true); setRunName(Array.from(event.target.value).slice(0, PAYROLL_RUN_NAME_MAX_LENGTH).join("")); }} />
    <div className="hr-payroll-employee-picker-section">
      <div className="hr-payroll-picker-heading"><div><strong>計算範圍</strong><small>可選全體，或複選本次要試算的員工。</small></div><span className="hr-payroll-picker-count">已選 {selectedCount} 人</span></div>
      <div className="hr-payroll-scope-summary" aria-live="polite"><span>符合資格 <strong>{employees.length}</strong> 人</span><span>已選 <strong>{selectedCount}</strong> 人</span><span>未選 <strong>{unselectedCount}</strong> 人</span></div>
      <label className={`hr-payroll-employee-option hr-payroll-employee-option-all${selectionMode === "all" ? " selected" : ""}`}>
        <input type="checkbox" checked={selectionMode === "all"} onChange={(event) => setAllEmployees(event.target.checked)} />
        <span><strong>全體員工</strong><small>納入全部符合資格的員工</small></span>
      </label>
      {employeesPending ? <p className="muted hr-payroll-picker-empty">正在載入符合資格的員工…</p> : employees.length ? <div className="hr-payroll-employee-picker" role="group" aria-label="選擇員工">
        {employees.map((employee) => {
          const checked = selectionMode === "all" || selectedEmployeeIds.includes(employee.userId);
          return <label className={`hr-payroll-employee-option${checked ? " selected" : ""}`} key={employee.userId}>
            <input type="checkbox" checked={checked} onChange={(event) => toggleEmployee(employee.userId, event.target.checked)} />
            <span><strong>{employee.displayName}</strong><small>{employee.employeeNumber}・{employee.position || "未設定職位"}</small></span>
          </label>;
        })}
      </div> : <p className="muted hr-payroll-picker-empty">目前沒有符合資格的員工；若有支援人員排班，仍可試算支援人員薪資。</p>}
      {selectionMode === "selected" && unselectedCount > 0 ? <Alert tone="warning">這是部分結算；未選的 {unselectedCount} 位符合資格員工不會納入這次試算。</Alert> : null}
    </div>
    {employeesError ? <Alert tone="danger">員工名單載入失敗：{employeesError.message}</Alert> : null}
    {validationError || calculatePayroll.error ? <Alert tone="danger">{validationError ?? calculatePayroll.error?.message}</Alert> : null}
  </Dialog>;
}

export function HrPayrollSettlement() {
  usePageTitle("薪資結算");
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.isHrAdministrator ?? false;
  const canRead = isHrAdministrator && permissions.has("hr:payroll:read");
  const canCalculate = isHrAdministrator && permissions.has("hr:payroll:calculate");
  const [periodKey, setPeriodKey] = useState(taipeiMonth);
  const [payDate, setPayDate] = useState("");
  const [showCalculationDialog, setShowCalculationDialog] = useState(false);
  const [payrollResult, setPayrollResult] = useState<PayrollRun | null>(null);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [adjustmentUserId, setAdjustmentUserId] = useState("");
  const [adjustmentDirection, setAdjustmentDirection] = useState<"earning" | "deduction">("deduction");
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [adjustmentEffectivePeriodKey, setAdjustmentEffectivePeriodKey] = useState(() => nextMonth(taipeiMonth()));
  const [adjustmentReason, setAdjustmentReason] = useState("勞健保員工負擔人工覆核");
  const runs = useHrQuery<PayrollRunsResponse>("/payroll/runs", canRead);
  const selectedRun = useHrQuery<{ run: PayrollRun }>(selectedRunId ? `/payroll/runs/${selectedRunId}` : "/payroll/runs/__none__", canRead && Boolean(selectedRunId), { keepPreviousData: false });
  const adjustmentProfile = useHrQuery<Profile>(adjustmentUserId ? `/employees/${encodeURIComponent(adjustmentUserId)}` : "/employees/__none__", canRead && Boolean(adjustmentUserId), { keepPreviousData: false });
  const adjustments = useHrQuery<{ adjustments: Array<{ id: string; employeeName: string; effectivePeriodKey: string; reason: string; items: Array<{ itemName: string; amountMinor: number }> }> }>(`/payroll/adjustments?effectivePeriodKey=${encodeURIComponent(adjustmentEffectivePeriodKey)}`, canRead && Boolean(adjustmentEffectivePeriodKey));
  const employees = useHrQuery<EmployeeListResponse>(HR_ROSTER_PATH, canRead && permissions.has("hr:employee:read"));
  const closePayroll = useHrWrite<{ run: PayrollRun }>();
  const createAdjustment = useHrWrite();
  useEffect(() => {
    if (!selectedRun.data?.run) return;
    setPayrollResult(selectedRun.data.run);
    setPayDate(selectedRun.data.run.payDate ?? "");
    // 載入歷史批次時同步月份，避免調整表單仍指向另一個月份。
    setPeriodKey(selectedRun.data.run.periodKey);
    setAdjustmentEffectivePeriodKey(nextMonth(selectedRun.data.run.periodKey));
  }, [selectedRun.data]);
  useEffect(() => { setAdjustmentEffectivePeriodKey(nextMonth(periodKey)); }, [periodKey]);
  const adjustmentEmployeeOptions = useMemo(() => [{ label: "請選擇員工", value: "" }, ...(employees.data?.employees ?? []).map((employee) => ({ label: `${employee.displayName}（${employee.employeeNumber}）`, value: employee.userId }))], [employees.data]);
  const payrollTotals = useMemo(() => payrollResult?.employees.reduce((totals, employee) => ({ earningMinor: totals.earningMinor + employee.earningMinor, deductionMinor: totals.deductionMinor + employee.deductionMinor, netMinor: totals.netMinor + employee.netMinor }), { earningMinor: 0, deductionMinor: 0, netMinor: 0 }) ?? { earningMinor: 0, deductionMinor: 0, netMinor: 0 }, [payrollResult]);
  if (!canRead) return <Alert tone="danger">薪資資料僅限全平台 HR 管理者查看。</Alert>;
  if (runs.isPending) return <HrPageSkeleton variant="table" />;
  const adjustmentEmployment = adjustmentProfile.data?.employments.find((employment) => !employment.archivedAt);

  return <div className="page hr-payroll-page">
    <PageHeader title="薪資結算" description="建立試算版本，選擇員工範圍與結算名稱，再逐位確認薪資明細。" actions={canCalculate ? <Button icon="plus" onClick={() => setShowCalculationDialog(true)}>新增試算</Button> : null} />
    <Alert tone="info">先選月份試算；展開員工即可查看每一筆應發、扣款與公式。週期終結或離職的未休特休會在該薪資期間列為折現，只有結帳後才會寫入額度台帳。敘薪、月度資料與獎金政策請在各自的管理頁維護。</Alert>
    {closePayroll.error ? <Alert tone="danger">{closePayroll.error.message}</Alert> : null}
    {selectedRun.error ? <Alert tone="danger">{selectedRun.error.message}</Alert> : null}
    {runs.error ? <Alert tone="danger">{runs.error.message}</Alert> : null}

    <Panel className="hr-payroll-main-panel" title="試算結果" description="每次新增試算會建立新的版本；完成後可在下方逐筆覆核。">
      {payrollResult ? <div className="hr-payroll-result">
        <div className="hr-payroll-result-toolbar">
          <div><strong>{payrollResult.runName}</strong><span>{payrollResult.periodKey}・{payrollResult.status === "closed" ? "已結帳" : "待覆核"}{payrollResult.payDate ? `・發薪日 ${payrollResult.payDate}` : ""}</span></div>
          {canCalculate && payrollResult.status === "ready" ? <Button icon="check" loading={closePayroll.isPending} onClick={() => closePayroll.mutate({ path: `/payroll/runs/${payrollResult.runId}/close`, method: "POST", values: {} }, { onSuccess: (result) => setPayrollResult(result.run) })}>結帳此批次</Button> : null}
        </div>
        <div className="hr-payroll-overview" aria-label="薪資合計">
          <div><span>員工薪資單</span><strong>{payrollResult.employees.length} 人</strong></div>
          <div><span>應發合計</span><strong>{money(payrollTotals.earningMinor)}</strong></div>
          <div><span>扣款合計</span><strong>{deductionMoney(payrollTotals.deductionMinor)}</strong></div>
          <div className="hr-payroll-overview-net"><span>實領合計</span><strong>{money(payrollTotals.netMinor)}</strong></div>
        </div>
        {payrollResult.warnings.length ? <Alert tone="warning"><strong>試算提醒</strong><ul className="hr-payroll-warning-list">{payrollResult.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></Alert> : null}
        {payrollResult.employees.length ? <div className="hr-payroll-details">{payrollResult.employees.map((employee, index) => <PayrollDisclosure
          className="hr-payroll-employee"
          summaryClassName="hr-payroll-employee-summary"
          defaultOpen={index === 0}
          key={employee.employmentId}
          summary={<>
            <span className="hr-payroll-employee-summary-main"><strong>{employee.employeeName}</strong><small>{employee.employeeNumber}・{payBasis(employee)}・出勤 {employee.attendanceDays} 天・缺卡 {employee.missingPunchDays} 天</small></span>
            <span className="hr-payroll-employee-summary-total"><strong>{money(employee.netMinor)}</strong><span>實領</span></span>
            <PayrollDisclosureMarker className="hr-payroll-summary-marker" />
          </>}
        >
          <div className="hr-payroll-result-body">
            <div className="hr-payroll-line-list">{employee.lines.map((line) => <PayrollLineDetail key={line.lineKey} line={line} />)}</div>
            <div className="hr-payroll-employee-totals"><span>應發 <strong>{money(employee.earningMinor)}</strong></span><span>扣款 <strong>{deductionMoney(employee.deductionMinor)}</strong></span><span>實領 <strong>{money(employee.netMinor)}</strong></span></div>
          </div>
        </PayrollDisclosure>)}</div> : <p className="empty-state">本批次沒有員工薪資單。</p>}
        {payrollResult.workers.length ? <div className="hr-payroll-worker-results"><h3>排班支援人員</h3>{payrollResult.workers.map((worker) => <article className="hr-payroll-worker-result" key={`worker-${worker.workerId}`}><div className="hr-payroll-worker-result-head"><div><strong>{worker.workerName}</strong><small>排班支援・{PAY_BASIS_LABEL[worker.payBasis] ?? "混合薪資方式"}</small></div><strong>{money(worker.amountMinor)}</strong></div><p>{workerFormula(worker)}</p></article>)}</div> : null}
      </div> : <p className="empty-state">尚未執行本月份試算。</p>}
    </Panel>

    <PayrollDisclosure
      className="panel hr-payroll-secondary"
      summaryClassName="hr-payroll-secondary-summary"
      summary={<><span><strong>結帳後薪資調整</strong><small>只有補發、扣回或特殊身分覆核時才需要使用</small></span><PayrollDisclosureMarker className="hr-payroll-secondary-marker" /></>}
    >
      <div className="hr-payroll-secondary-content">
        <p className="muted">來源月份必須已有結帳結果；調整會在生效月份試算成為獨立明細，生效月份結帳後不可修改。</p>
        <div className="admin-form toolbar hr-payroll-adjustment-form"><SelectField label="員工" value={adjustmentUserId} options={adjustmentEmployeeOptions} onChange={(event) => setAdjustmentUserId(event.target.value)} /><TextField label="來源薪資月份" type="month" value={periodKey} onChange={(event) => setPeriodKey(event.target.value)} /><TextField label="生效薪資月份" type="month" value={adjustmentEffectivePeriodKey} onChange={(event) => setAdjustmentEffectivePeriodKey(event.target.value)} /><SelectField label="調整類型" value={adjustmentDirection} options={[{ label: "扣回", value: "deduction" }, { label: "補發", value: "earning" }]} onChange={(event) => setAdjustmentDirection(event.target.value as "earning" | "deduction")} /><TextField label="調整金額（元）" type="number" min="0" step="1" value={adjustmentAmount} onChange={(event) => setAdjustmentAmount(event.target.value)} /><TextField label="調整原因" value={adjustmentReason} maxLength={1000} onChange={(event) => setAdjustmentReason(event.target.value)} />{canCalculate ? <Button icon="plus" loading={createAdjustment.isPending} disabled={!adjustmentEmployment || adjustmentEffectivePeriodKey === periodKey || !Number.isSafeInteger(Number(adjustmentAmount)) || Number(adjustmentAmount) <= 0 || !adjustmentReason.trim()} onClick={() => createAdjustment.mutate({ path: "/payroll/adjustments", method: "POST", values: { employmentId: adjustmentEmployment?.id, sourcePeriodKey: periodKey, effectivePeriodKey: adjustmentEffectivePeriodKey, reason: adjustmentReason, items: [{ itemName: adjustmentDirection === "earning" ? "薪資補發" : "勞健保員工負擔", amountMinor: (adjustmentDirection === "earning" ? 1 : -1) * Math.round(Number(adjustmentAmount) * 100) }] } }, { onSuccess: () => { setAdjustmentAmount(""); void adjustments.refetch(); } })}>保存{adjustmentDirection === "earning" ? "補發" : "扣回"}</Button> : null}</div>
        {createAdjustment.error ? <Alert tone="danger">{createAdjustment.error.message}</Alert> : null}
        {adjustments.error ? <Alert tone="danger">{adjustments.error.message}</Alert> : null}
        {adjustments.data?.adjustments.length ? <div className={`table-scroll${adjustments.isPlaceholderData ? " is-refreshing" : ""}`}><table className="data-table compact"><thead><tr><th>員工</th><th>原因</th><th className="numeric">調整</th></tr></thead><tbody>{adjustments.data.adjustments.map((item) => <tr key={item.id}><td>{item.employeeName}</td><td>{item.reason}</td><td className="numeric">{item.items.map((line) => adjustmentMoney(line.amountMinor)).join("、")}</td></tr>)}</tbody></table></div> : <p className="form-hint">本月尚無人工薪資調整。</p>}
      </div>
    </PayrollDisclosure>

    <PayrollDisclosure
      className="panel hr-payroll-secondary"
      summaryClassName="hr-payroll-secondary-summary"
      summary={<><span><strong>歷史試算批次</strong><small>{runs.data?.runs.length ? `${runs.data.runs.length} 個版本可供載入` : "查看過往月份與版本"}</small></span><PayrollDisclosureMarker className="hr-payroll-secondary-marker" /></>}
    >
      <div className="hr-payroll-secondary-content"><div className="table-scroll"><table className="data-table"><thead><tr><th>結算名稱</th><th>月份</th><th>批次版本</th><th>狀態</th><th>期間</th><th>完成</th><th>引擎</th><th>建立時間</th><th>操作</th></tr></thead><tbody>{(runs.data?.runs ?? []).map((item) => <tr key={item.run.id}><td><strong>{item.run.runName}</strong></td><td><strong>{item.periodKey}</strong></td><td>v{item.run.versionNumber}</td><td>{RUN_STATUS[item.run.status] ?? item.run.status}</td><td>{PERIOD_STATUS[item.periodStatus] ?? item.periodStatus}</td><td>{item.run.completedCount} / {item.run.expectedCount}</td><td>{item.run.engineVersion}</td><td>{item.run.createdAt}</td><td><Button variant="secondary" onClick={() => setSelectedRunId(item.run.id)}>載入結果</Button></td></tr>)}</tbody></table></div>{!runs.data?.runs.length ? <p className="empty-state">尚未產生薪資計算批次。</p> : null}</div>
    </PayrollDisclosure>
    <p className="form-hint">公式、結算名稱與輸入會隨試算批次保存；勞健保優先使用系統標準規則，特殊身分類別則以已覆核的公司版本為準。</p>
    {showCalculationDialog ? <PayrollCalculationDialog
      employees={employees.data?.employees ?? []}
      employeesPending={employees.isPending}
      employeesError={employees.error instanceof Error ? employees.error : null}
      initialPeriodKey={periodKey}
      initialPayDate={payDate}
      onClose={() => setShowCalculationDialog(false)}
      onSuccess={(run) => { setPayrollResult(run); setPeriodKey(run.periodKey); setPayDate(run.payDate ?? ""); setAdjustmentEffectivePeriodKey(nextMonth(run.periodKey)); }}
    /> : null}
  </div>;
}
