import { useEffect, useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
import { HR_ROSTER_PATH, useHrQuery, useHrWrite, type Employee, type PayrollRun, type PayrollEmployee, type PayrollLine, type PayrollRunSummary, type Profile } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

interface PayrollRunsResponse { runs: PayrollRunSummary[] }
interface EmployeeListResponse { employees: Employee[] }

const RUN_STATUS: Record<string, string> = { calculating: "計算中", ready: "待覆核", approved: "已核准", closed: "已結帳", failed: "失敗" };
const PERIOD_STATUS: Record<string, string> = { open: "開放中", closed: "已關閉" };
const PAY_BASIS_LABEL: Record<string, string> = { monthly: "月薪", daily: "日薪", hourly: "時薪" };
const LINE_LABELS: Record<string, string> = {
  base_salary: "本薪", overtime: "核准付薪加班", unpaid_leave: "無薪假扣款", booth_bonus: "櫃點獎金", attendance_summary: "出勤摘要",
  labor_insurance: "勞保員工負擔", health_insurance: "健保員工負擔", special_workday: "特殊上班日薪資",
};

function money(minor: number): string {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
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
function monthRange(value: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return { start: "", end: "" };
  const [year, month] = value.split("-").map(Number);
  const start = new Date(Date.UTC(year!, month! - 1, 1));
  const end = new Date(Date.UTC(year!, month!, 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function readableLine(line: PayrollLine): string {
  if (line.lineKey.startsWith("bonus_")) return `業績獎金${typeof line.explanation.policyName === "string" ? `｜${line.explanation.policyName}` : ""}`;
  if (line.lineKey.startsWith("salary_item_")) return typeof line.explanation.itemName === "string" && line.explanation.itemName ? line.explanation.itemName : "薪資項目";
  if (line.lineKey.startsWith("special_allowance_")) return `特殊上班日補貼${typeof line.explanation.rule === "string" ? `｜${line.explanation.rule}` : ""}`;
  return LINE_LABELS[line.lineKey] ?? line.lineKey;
}

function payBasis(employee: PayrollEmployee): string {
  const basis = employee.lines.find((line) => line.lineKey === "base_salary")?.explanation.payBasis;
  return typeof basis === "string" ? PAY_BASIS_LABEL[basis] ?? basis : "—";
}

export function HrPayrollSettlement() {
  usePageTitle("薪資結算");
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.isHrAdministrator ?? false;
  const canRead = isHrAdministrator && permissions.has("hr:payroll:read");
  const canCalculate = isHrAdministrator && permissions.has("hr:payroll:calculate");
  const [periodKey, setPeriodKey] = useState(taipeiMonth);
  const [employeeUserId, setEmployeeUserId] = useState("__all__");
  const [payDate, setPayDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [payrollResult, setPayrollResult] = useState<PayrollRun | null>(null);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [adjustmentUserId, setAdjustmentUserId] = useState("");
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [adjustmentEffectivePeriodKey, setAdjustmentEffectivePeriodKey] = useState(() => nextMonth(taipeiMonth()));
  const [adjustmentReason, setAdjustmentReason] = useState("勞健保員工負擔人工覆核");
  const runs = useHrQuery<PayrollRunsResponse>("/payroll/runs", canRead);
  const selectedRun = useHrQuery<{ run: PayrollRun }>(selectedRunId ? `/payroll/runs/${selectedRunId}` : "/payroll/runs/__none__", canRead && Boolean(selectedRunId));
  const adjustmentProfile = useHrQuery<Profile>(adjustmentUserId ? `/employees/${encodeURIComponent(adjustmentUserId)}` : "/employees/__none__", canRead && Boolean(adjustmentUserId));
  const adjustments = useHrQuery<{ adjustments: Array<{ id: string; employeeName: string; effectivePeriodKey: string; reason: string; items: Array<{ itemName: string; amountMinor: number }> }> }>(`/payroll/adjustments?effectivePeriodKey=${encodeURIComponent(adjustmentEffectivePeriodKey)}`, canRead && Boolean(adjustmentEffectivePeriodKey));
  const employees = useHrQuery<EmployeeListResponse>(HR_ROSTER_PATH, canRead && permissions.has("hr:employee:read"));
  const calculatePayroll = useHrWrite<{ run: PayrollRun }>();
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
  const employeeOptions = useMemo(() => [{ label: "全部啟用員工", value: "__all__" }, ...(employees.data?.employees ?? []).map((employee) => ({ label: `${employee.displayName}（${employee.employeeNumber}）`, value: employee.userId }))], [employees.data]);
  if (!canRead) return <Alert tone="danger">薪資資料僅限全平台 HR 管理者查看。</Alert>;
  if (runs.isPending) return <HrPageSkeleton variant="table" />;
  const sourceRange = monthRange(periodKey);
  const adjustmentEmployment = adjustmentProfile.data?.employments.find((employment) => employment.hiredOn < sourceRange.end && (!employment.endedOn || employment.endedOn > sourceRange.start));

  function calculate() {
    setError(null);
    calculatePayroll.mutate({ path: "/payroll/calculate", method: "POST", values: { periodKey, payDate: payDate || undefined, attendanceMode: "all", employeeUserIds: employeeUserId === "__all__" ? undefined : [employeeUserId], requestId: `portal-${crypto.randomUUID()}` } }, {
      onSuccess: (result) => setPayrollResult(result.run),
      onError: (cause) => setError(cause.message),
    });
  }

  return <div className="page">
    <PageHeader title="薪資結算" description="從敘薪管理、假勤資料與員工已套用的獎金 policy 建立指定月份薪資試算批次；計算完成後再進行覆核與結帳。" />
    <Alert tone="info">流程：先在「敘薪管理」設定員工薪資，再到「獎金管理」套用 policy 與保存業績快照，最後在此按下計算薪資。業績不需在這裡重複輸入。</Alert>
    {error ? <Alert tone="danger">{error}</Alert> : null}
    {closePayroll.error ? <Alert tone="danger">{closePayroll.error.message}</Alert> : null}
    {selectedRun.error ? <Alert tone="danger">{selectedRun.error.message}</Alert> : null}

    <Panel>
      <div className="panel-head"><div><h2>結帳後薪資調整</h2><p>系統標準規則會自動計算；特殊身分或法定資料缺漏時，可保存具名調整。來源月份必須已有結帳結果，調整會在生效月份試算成為獨立明細，且生效月份結帳後不可修改。</p></div></div>
      <div className="admin-form toolbar"><SelectField label="員工" value={adjustmentUserId} options={[{ label: "請選擇員工", value: "" }, ...employeeOptions.slice(1)]} onChange={(event) => setAdjustmentUserId(event.target.value)} /><TextField label="來源薪資月份" type="month" value={periodKey} onChange={(event) => setPeriodKey(event.target.value)} /><TextField label="生效薪資月份" type="month" value={adjustmentEffectivePeriodKey} onChange={(event) => setAdjustmentEffectivePeriodKey(event.target.value)} /><TextField label="扣款金額（元）" type="number" min="0" step="1" value={adjustmentAmount} onChange={(event) => setAdjustmentAmount(event.target.value)} /><TextField label="調整原因" value={adjustmentReason} maxLength={1000} onChange={(event) => setAdjustmentReason(event.target.value)} />{canCalculate ? <Button icon="plus" loading={createAdjustment.isPending} disabled={!adjustmentEmployment || adjustmentEffectivePeriodKey === periodKey || !Number.isSafeInteger(Number(adjustmentAmount)) || Number(adjustmentAmount) <= 0 || !adjustmentReason.trim()} onClick={() => createAdjustment.mutate({ path: "/payroll/adjustments", method: "POST", values: { employmentId: adjustmentEmployment?.id, sourcePeriodKey: periodKey, effectivePeriodKey: adjustmentEffectivePeriodKey, reason: adjustmentReason, items: [{ itemName: "勞健保員工負擔", amountMinor: -Math.round(Number(adjustmentAmount) * 100) }] } }, { onSuccess: () => { setAdjustmentAmount(""); void adjustments.refetch(); } })}>保存扣款</Button> : null}</div>
      {adjustments.error ? <Alert tone="danger">{adjustments.error.message}</Alert> : null}
      {adjustments.data?.adjustments.length ? <div className="table-scroll"><table className="data-table compact"><thead><tr><th>員工</th><th>原因</th><th className="numeric">調整</th></tr></thead><tbody>{adjustments.data.adjustments.map((item) => <tr key={item.id}><td>{item.employeeName}</td><td>{item.reason}</td><td className="numeric">{item.items.map((line) => money(line.amountMinor)).join("、")}</td></tr>)}</tbody></table></div> : <p className="form-hint">本月尚無人工薪資調整。</p>}
    </Panel>

    <Panel>
      <div className="panel-head"><div><h2>計算薪資</h2><p>每次計算會建立新的版本化批次；同月份可保留多次試算，適合覆核前比對。</p></div></div>
      <div className="admin-form">
        <TextField type="month" label="計算月份" value={periodKey} required onChange={(event) => setPeriodKey(event.target.value)} />
        <TextField type="date" label="發薪日（選填）" value={payDate} onChange={(event) => setPayDate(event.target.value)} />
        <SelectField label="員工" value={employeeUserId} options={employeeOptions} onChange={(event) => setEmployeeUserId(event.target.value)} />
        {canCalculate ? <Button icon="payments" loading={calculatePayroll.isPending} disabled={!periodKey} onClick={calculate}>計算薪資</Button> : <p className="form-hint">目前帳號沒有執行薪資試算的權限。</p>}
      </div>
      {payrollResult ? <>
        <div className="hr-payroll-result-toolbar"><strong>{payrollResult.periodKey}・{payrollResult.status === "closed" ? "已結帳" : "待覆核"}{payrollResult.payDate ? `・發薪日 ${payrollResult.payDate}` : ""}</strong>{canCalculate && payrollResult.status === "ready" ? <Button icon="check" loading={closePayroll.isPending} onClick={() => closePayroll.mutate({ path: `/payroll/runs/${payrollResult.runId}/close`, method: "POST", values: {} }, { onSuccess: (result) => setPayrollResult(result.run) })}>結帳此批次</Button> : null}</div>
        {payrollResult.warnings.length ? <Alert tone="warning"><strong>試算提醒</strong><ul className="hr-payroll-warning-list">{payrollResult.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></Alert> : null}
        {payrollResult.employees.length ? <div className="table-scroll hr-payroll-summary"><table className="data-table compact"><thead><tr><th>員工</th><th>方式</th><th className="numeric">應發</th><th className="numeric">扣款</th><th className="numeric">淨額</th><th className="numeric">出勤／缺卡</th></tr></thead><tbody>{payrollResult.employees.map((employee) => <tr key={employee.employmentId}><td><strong>{employee.employeeName}</strong><br /><span className="muted">{employee.employeeNumber}</span></td><td>{payBasis(employee)}</td><td className="numeric">{money(employee.earningMinor)}</td><td className="numeric">{money(employee.deductionMinor)}</td><td className="numeric"><strong>{money(employee.netMinor)}</strong></td><td className="numeric">{employee.attendanceDays}／{employee.missingPunchDays}</td></tr>)}</tbody></table></div> : null}
        <div className="hr-payroll-details">{payrollResult.employees.map((employee, index) => <details className="hr-payroll-employee" key={employee.employmentId} open={index === 0}>
          <summary className="hr-payroll-result-head"><span className="hr-payroll-result-person"><strong>{employee.employeeName}（{employee.employeeNumber}）</strong><span className="form-hint">{payBasis(employee)}・出勤 {employee.attendanceDays} 天・缺卡 {employee.missingPunchDays} 天</span></span><b>{money(employee.netMinor)}</b></summary>
          <div className="hr-payroll-result-body"><div className="table-scroll"><table className="data-table compact"><thead><tr><th>項目</th><th>方向</th><th className="numeric">金額</th></tr></thead><tbody>{employee.lines.map((line) => <tr key={line.lineKey}><td>{readableLine(line)}</td><td>{line.direction === "earning" ? "應發" : "扣款"}</td><td className="numeric">{money(line.amountMinor)}</td></tr>)}</tbody></table></div><p className="form-hint">應發 {money(employee.earningMinor)}・扣款 {money(employee.deductionMinor)}・淨額 {money(employee.netMinor)}</p></div>
        </details>)}</div>
        {payrollResult.workers.length ? <div className="hr-payroll-worker-results"><h3>排班支援人員</h3>{payrollResult.workers.map((worker) => <div className="hr-payroll-result" key={`worker-${worker.workerId}`}><div className="hr-payroll-result-head"><strong>{worker.workerName}（排班支援）</strong><b>{money(worker.amountMinor)}</b></div><p className="form-hint">{worker.payBasis === "daily" ? "日薪" : worker.payBasis === "monthly" ? "月薪" : worker.payBasis === "mixed" ? "混合薪資方式" : "時薪"}・已發布排班 {worker.scheduledDays} 天{worker.compensationVersionId ? "" : worker.payBasis === "mixed" ? "・套用多個敘薪版本" : "・尚未設定敘薪"}</p></div>)}</div> : null}
      </> : <p className="empty-state">尚未執行本月份試算。</p>}
    </Panel>

    <Panel>
      {runs.error ? <Alert tone="danger">{runs.error.message}</Alert> : null}
      <div className="panel-head"><div><h2>薪資計算批次</h2><p>查看每一版批次與結算狀態；核准、關帳與付款按鈕將在制度確認後接續開放。</p></div></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>月份</th><th>批次版本</th><th>狀態</th><th>期間</th><th>完成</th><th>引擎</th><th>建立時間</th><th>操作</th></tr></thead><tbody>{(runs.data?.runs ?? []).map((item) => <tr key={item.run.id}><td><strong>{item.periodKey}</strong></td><td>v{item.run.versionNumber}</td><td>{RUN_STATUS[item.run.status] ?? item.run.status}</td><td>{PERIOD_STATUS[item.periodStatus] ?? item.periodStatus}</td><td>{item.run.completedCount} / {item.run.expectedCount}</td><td>{item.run.engineVersion}</td><td>{item.run.createdAt}</td><td><Button variant="secondary" onClick={() => setSelectedRunId(item.run.id)}>載入結果</Button></td></tr>)}</tbody></table></div>
      {!runs.data?.runs.length ? <p className="empty-state">尚未產生薪資計算批次。</p> : null}
    </Panel>
    <p className="form-hint">試算引擎版本固定記錄在批次中；勞健保會優先使用系統提供的一般受僱者標準規則，若公司有特殊身分類別則以已覆核的公司版本為準。</p>
  </div>;
}
