import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Icon } from "../../shell/icons.js";
import { Alert, Button, PageHeader, Panel } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type PayrollLine, type PayrollRun } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

function money(minor: number): string {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}
function deductionMoney(minor: number): string {
  return `-NT$ ${Math.abs(Math.round(minor / 100)).toLocaleString("zh-TW")}`;
}
function periodLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return match ? `${match[1]} 年 ${Number(match[2])} 月` : value;
}
function lineLabel(line: PayrollLine): string {
  const labels: Record<string, string> = {
    base_salary: "本薪",
    overtime: "核准付薪加班",
    unpaid_leave: "無薪假扣款",
    booth_bonus: "櫃點獎金",
    labor_insurance: "勞保員工負擔",
    health_insurance: "健保員工負擔",
    special_workday: "特殊上班日薪資",
    annual_leave_settlement: "未休特休折現",
  };
  return line.lineKey.startsWith("bonus_") ? "業績獎金" : line.lineKey.startsWith("salary_item_") ? "薪資項目" : labels[line.lineKey] ?? line.lineKey;
}
function lineFormula(line: PayrollLine): string {
  const detail = line.explanation.formulaDetail ?? line.explanation.formula;
  return typeof detail === "string" && detail ? detail : "依保存的薪資規則計算";
}
function payBasisLabel(value: string): string {
  return ({ monthly: "月薪", daily: "日薪", hourly: "時薪", mixed: "混合" } as Record<string, string>)[value] ?? value;
}

export function HrPayrollRunDetail() {
  const navigate = useNavigate();
  const { runId = "" } = useParams();
  const { permissions, user } = useSession();
  const canRead = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:read"));
  const canCalculate = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:calculate"));
  const [deleteOpen, setDeleteOpen] = useState(false);
  const result = useHrQuery<{ run: PayrollRun }>(runId ? `/payroll/runs/${encodeURIComponent(runId)}` : "/payroll/runs/__none__", canRead && Boolean(runId), { keepPreviousData: false });
  const closePayroll = useHrWrite<{ run: PayrollRun }>();
  const deletePayrollRun = useHrWrite<{ id: string; deleted: true }>();
  const payrollResult = result.data?.run;
  const totals = useMemo(() => {
    const employees = payrollResult?.employees ?? [];
    const workers = payrollResult?.workers ?? [];
    const employeeTotals = employees.reduce((total, employee) => ({ earningMinor: total.earningMinor + employee.earningMinor, deductionMinor: total.deductionMinor + employee.deductionMinor, netMinor: total.netMinor + employee.netMinor }), { earningMinor: 0, deductionMinor: 0, netMinor: 0 });
    const workerTotal = workers.reduce((total, worker) => total + worker.amountMinor, 0);
    return { earningMinor: employeeTotals.earningMinor + workerTotal, deductionMinor: employeeTotals.deductionMinor, netMinor: employeeTotals.netMinor + workerTotal, peopleCount: employees.length + workers.length };
  }, [payrollResult]);

  if (!canRead) return <Alert tone="danger">薪資資料僅限全平台 HR 管理者查看。</Alert>;
  if (result.isPending) return <HrPageSkeleton variant="detail" />;
  if (result.error || !payrollResult) return <Alert tone="danger">{result.error?.message ?? "找不到這個薪資試算批次。"}</Alert>;

  function confirmDelete() {
    deletePayrollRun.mutate({ path: `/payroll/runs/${payrollResult!.runId}`, method: "DELETE", values: {} }, {
      onSuccess: () => {
        setDeleteOpen(false);
        navigate("/hr/payroll-settlement");
      },
    });
  }

  return <div className="page hr-payroll-page hr-payroll-detail-page">
    <PageHeader title="試算明細" description="查看這個批次保存的薪資單與計算公式；調整必須在結帳前回到薪資結算頁完成。" actions={<Button variant="secondary" onClick={() => navigate("/hr/payroll-settlement")}>返回薪資結算</Button>} />
    <Alert tone={payrollResult.status === "closed" ? "info" : "warning"}>{payrollResult.status === "closed" ? "這個批次已結帳，以下是不可改寫的歷史快照。" : "這個批次尚未結算；如需補發或扣回，請先返回薪資結算頁建立結帳前調整，再執行結帳。"}</Alert>
    <Panel title={payrollResult.runName} description={`${periodLabel(payrollResult.periodKey)}・${payrollResult.status === "closed" ? "已結帳" : "尚未結算"}${payrollResult.payDate ? `・發薪日 ${payrollResult.payDate}` : ""}`}>
      <div className="hr-payroll-overview" aria-label="薪資合計">
        <div><span>薪資人數</span><strong>{totals.peopleCount} 人</strong></div>
        <div><span>應發合計</span><strong>{money(totals.earningMinor)}</strong></div>
        <div><span>扣款合計</span><strong>{deductionMoney(totals.deductionMinor)}</strong></div>
        <div className="hr-payroll-overview-net"><span>實領合計</span><strong>{money(totals.netMinor)}</strong></div>
      </div>
      {payrollResult.warnings.length ? <Alert tone="warning"><strong>試算提醒</strong><ul className="hr-payroll-warning-list">{payrollResult.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></Alert> : null}
      {payrollResult.employees.length ? <div className="hr-payroll-details">{payrollResult.employees.map((employee, index) => <details className="hr-payroll-employee" open={index === 0} key={employee.employmentId}>
        <summary><span className="hr-payroll-employee-summary-main"><strong>{employee.employeeName}</strong><small>{employee.employeeNumber}・出勤 {employee.attendanceDays} 天・缺卡 {employee.missingPunchDays} 天</small></span><span className="hr-payroll-employee-summary-total"><strong>{money(employee.netMinor)}</strong><span>實領</span></span><span className="hr-payroll-disclosure-marker" aria-hidden="true"><Icon name="chevronDown" /></span></summary>
        <div className="hr-payroll-result-body">
          <div className="hr-payroll-line-list">{employee.lines.map((line) => <details className={`hr-payroll-line hr-payroll-line-${line.direction}`} key={line.lineKey}>
            <summary className="hr-payroll-line-summary"><span className="hr-payroll-line-title"><strong>{lineLabel(line)}</strong><span className="hr-payroll-line-direction">{line.direction === "earning" ? "應發" : "扣款"}</span></span><strong className="hr-payroll-line-amount">{line.direction === "deduction" ? deductionMoney(line.amountMinor) : money(line.amountMinor)}</strong></summary>
            <div className="hr-payroll-line-content"><div className="hr-payroll-line-formula"><span>計算公式</span><p>{lineFormula(line)}</p></div></div>
          </details>)}</div>
          <div className="hr-payroll-employee-totals"><span>應發 <strong>{money(employee.earningMinor)}</strong></span><span>扣款 <strong>{deductionMoney(employee.deductionMinor)}</strong></span><span>實領 <strong>{money(employee.netMinor)}</strong></span></div>
        </div>
      </details>)}</div> : <p className="empty-state">本批次沒有員工薪資單。</p>}
      {payrollResult.workers.length ? <div className="hr-payroll-worker-results"><h3>排班支援人員</h3>{payrollResult.workers.map((worker) => <article className="hr-payroll-worker-result" key={worker.workerId}><div className="hr-payroll-worker-result-head"><div><strong>{worker.workerName}</strong><small>排班支援・{payBasisLabel(worker.payBasis)}</small></div><strong>{money(worker.amountMinor)}</strong></div></article>)}</div> : null}
      {canCalculate && payrollResult.status !== "closed" ? <div className="hr-payroll-result-actions hr-payroll-result-footer-actions">{payrollResult.status === "ready" ? <Button icon="check" loading={closePayroll.isPending} onClick={() => closePayroll.mutate({ path: `/payroll/runs/${payrollResult.runId}/close`, method: "POST", values: {} })}>結帳此批次</Button> : null}<Button variant="danger" icon="trash" disabled={closePayroll.isPending} onClick={() => { deletePayrollRun.reset(); setDeleteOpen(true); }}>刪除尚未結算試算</Button></div> : null}
      {closePayroll.error ? <Alert tone="danger">{closePayroll.error.message}</Alert> : null}
    </Panel>
    {deleteOpen ? <ConfirmDialog title="刪除尚未結算試算？" confirmLabel="刪除試算" pending={deletePayrollRun.isPending} onCancel={() => { if (!deletePayrollRun.isPending) setDeleteOpen(false); }} onConfirm={confirmDelete}>
      <p><strong>{payrollResult.runName}</strong>（{periodLabel(payrollResult.periodKey)}）會連同本批次的試算薪資單與明細一併刪除。</p>
      <p>這不會影響已結帳的薪資歷史；刪除後可以重新建立同月份試算。</p>
      {deletePayrollRun.error ? <Alert tone="danger">{deletePayrollRun.error.message}</Alert> : null}
    </ConfirmDialog> : null}
  </div>;
}
