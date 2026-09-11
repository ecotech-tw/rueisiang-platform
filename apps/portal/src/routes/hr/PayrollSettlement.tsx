import { useMemo, useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type Employee, type PayrollRun, type PayrollLine, type PayrollRunSummary } from "./api.js";

interface PayrollRunsResponse { runs: PayrollRunSummary[] }
interface EmployeeListResponse { employees: Employee[] }

const RUN_STATUS: Record<string, string> = { calculating: "計算中", ready: "待覆核", approved: "已核准", closed: "已結帳", failed: "失敗" };
const PERIOD_STATUS: Record<string, string> = { open: "開放中", closed: "已關閉" };
const LINE_LABELS: Record<string, string> = { base_salary: "本薪", overtime: "核准付薪加班", unpaid_leave: "無薪假扣款", booth_bonus: "櫃點獎金" };

function money(minor: number): string {
  return new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 }).format(Math.round(minor / 100));
}

function readableLine(line: PayrollLine): string {
  if (line.lineKey.startsWith("bonus_")) return `業績獎金${typeof line.explanation.policyName === "string" ? `｜${line.explanation.policyName}` : ""}`;
  return LINE_LABELS[line.lineKey] ?? line.lineKey;
}

export function HrPayrollSettlement() {
  usePageTitle("薪資結算");
  const [periodKey, setPeriodKey] = useState("2026-08");
  const [employeeUserId, setEmployeeUserId] = useState("__all__");
  const [error, setError] = useState<string | null>(null);
  const [payrollResult, setPayrollResult] = useState<PayrollRun | null>(null);
  const runs = useHrQuery<PayrollRunsResponse>("/payroll/runs");
  const employees = useHrQuery<EmployeeListResponse>("/employees?page=1&pageSize=100&status=active&sortField=name&sortDirection=asc");
  const calculatePayroll = useHrWrite<{ run: PayrollRun }>();
  const employeeOptions = useMemo(() => [{ label: "全部啟用員工", value: "__all__" }, ...(employees.data?.employees ?? []).map((employee) => ({ label: `${employee.displayName}（${employee.employeeNumber}）`, value: employee.userId }))], [employees.data]);

  function calculate() {
    setError(null);
    calculatePayroll.mutate({ path: "/payroll/calculate", method: "POST", values: { periodKey, attendanceMode: "all", employeeUserIds: employeeUserId === "__all__" ? undefined : [employeeUserId], requestId: `portal-${crypto.randomUUID()}` } }, {
      onSuccess: (result) => setPayrollResult(result.run),
      onError: (cause) => setError(cause.message),
    });
  }

  return <div className="page">
    <PageHeader title="薪資結算" description="從敘薪管理、假勤資料與員工已套用的獎金 policy 建立指定月份薪資試算批次；計算完成後再進行覆核與結帳。" />
    <Alert tone="info">流程：先在「敘薪管理」設定員工薪資，再到「獎金管理」套用 policy 與保存業績快照，最後在此按下計算薪資。業績不需在這裡重複輸入。</Alert>
    {error ? <Alert tone="danger">{error}</Alert> : null}

    <Panel>
      <div className="panel-head"><div><h2>計算薪資</h2><p>每次計算會建立新的版本化批次；同月份可保留多次試算，適合覆核前比對。</p></div></div>
      <div className="admin-form">
        <TextField type="month" label="計算月份" value={periodKey} required onChange={(event) => setPeriodKey(event.target.value)} />
        <SelectField label="員工" value={employeeUserId} options={employeeOptions} onChange={(event) => setEmployeeUserId(event.target.value)} />
        <Button icon="payments" loading={calculatePayroll.isPending} disabled={!periodKey} onClick={calculate}>計算薪資</Button>
      </div>
      {payrollResult ? payrollResult.employees.map((employee) => <div className="hr-payroll-result" key={employee.employmentId}>
        <div className="hr-payroll-result-head"><strong>{employee.employeeName}（{employee.employeeNumber}）</strong><b>{money(employee.netMinor)}</b></div>
        <p className="form-hint">出勤 {employee.attendanceDays} 天・缺卡 {employee.missingPunchDays} 天</p>
        <div className="table-scroll"><table className="data-table compact"><thead><tr><th>項目</th><th>方向</th><th className="numeric">金額</th></tr></thead><tbody>{employee.lines.map((line) => <tr key={line.lineKey}><td>{readableLine(line)}</td><td>{line.direction === "earning" ? "應發" : "扣款"}</td><td className="numeric">{money(line.amountMinor)}</td></tr>)}</tbody></table></div>
        <p className="form-hint">應發 {money(employee.earningMinor)}・扣款 {money(employee.deductionMinor)}・淨額 {money(employee.netMinor)}</p>
      </div>) : <p className="empty-state">尚未執行本月份試算。</p>}
      {payrollResult?.warnings.map((warning) => <p className="form-hint" key={warning}>{warning}</p>)}
    </Panel>

    <Panel>
      <div className="panel-head"><div><h2>薪資計算批次</h2><p>查看每一版批次與結算狀態；核准、關帳與付款按鈕將在制度確認後接續開放。</p></div></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>月份</th><th>批次版本</th><th>狀態</th><th>期間</th><th>完成</th><th>引擎</th><th>建立時間</th></tr></thead><tbody>{(runs.data?.runs ?? []).map((item) => <tr key={item.run.id}><td><strong>{item.periodKey}</strong></td><td>v{item.run.versionNumber}</td><td>{RUN_STATUS[item.run.status] ?? item.run.status}</td><td>{PERIOD_STATUS[item.periodStatus] ?? item.periodStatus}</td><td>{item.run.completedCount} / {item.run.expectedCount}</td><td>{item.run.engineVersion}</td><td>{item.run.createdAt}</td></tr>)}</tbody></table></div>
      {!runs.data?.runs.length ? <p className="empty-state">尚未產生薪資計算批次。</p> : null}
    </Panel>
    <p className="form-hint">試算引擎版本固定記錄在批次中；目前刻意不猜測勞健保扣款，正式費率與公司負擔規則確認後再接入結帳。</p>
  </div>;
}
