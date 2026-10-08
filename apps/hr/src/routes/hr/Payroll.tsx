import { useNavigate, useParams } from "react-router";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel, StatusBadge } from "../../ui/index.js";
import { useHrQuery, type HrPayrollHistoryRecord, type HrPayslipDetailResponse, type PayrollLine } from "./api.js";

function money(minor: number) {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}

function periodLabel(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return match ? `${match[1]} 年 ${Number(match[2])} 月` : value;
}

function dateLabel(value: string | null) {
  if (!value) return "尚未提供發薪日";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[1]}/${Number(match[2])}/${Number(match[3])}` : value;
}

function lineLabel(line: PayrollLine) {
  const explanation = line.explanation;
  const itemName = typeof explanation.itemName === "string" ? explanation.itemName : null;
  const policyName = typeof explanation.policyName === "string" ? explanation.policyName : null;
  if (itemName) return itemName;
  if (line.lineKey === "base_salary") return "本薪";
  if (line.lineKey === "monthly_rest_adjustment") return "月休差額";
  if (line.lineKey === "overtime") return "核准付薪加班";
  if (line.lineKey === "unpaid_leave") return "請假扣款";
  if (line.lineKey === "labor_insurance") return "勞保員工負擔";
  if (line.lineKey === "health_insurance") return "健保員工負擔";
  if (line.lineKey === "annual_leave_settlement") return "未休特休折現";
  if (line.lineKey === "typhoon_stop_pay") return "災防停班給薪";
  if (line.lineKey === "special_workday") return line.direction === "deduction" ? "特殊上班日薪資扣回" : "特殊上班日薪資加給";
  if (line.lineKey.startsWith("bonus_")) return policyName ?? "業績獎金";
  if (line.lineKey.startsWith("special_allowance_")) return typeof explanation.ruleName === "string" ? explanation.ruleName : "特殊上班日補貼";
  if (line.lineKey.startsWith("salary_item_")) return "薪資項目";
  if (line.lineKey.startsWith("adjustment_")) return "薪資加扣項";
  return line.lineKey;
}

function historyPath(record: HrPayrollHistoryRecord) {
  return `/payroll/${encodeURIComponent(record.runId)}/${encodeURIComponent(record.employmentId)}`;
}

export function HrPayrollHistory() {
  usePageTitle("薪資袋");
  const navigate = useNavigate();
  const query = useHrQuery<{ records: HrPayrollHistoryRecord[] }>("/me/payroll-history");
  return <div className="page hr-payroll-history-page">
    <PageHeader title="薪資袋" description="查看已確定發放的薪資紀錄與實領金額。" />
    <Panel className="hr-payroll-history-panel">
      {query.isPending ? <p className="muted">載入薪資紀錄…</p> : null}
      {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
      {query.data?.records.length ? <div className="hr-payroll-history-list">{query.data.records.map((record) => <button className="hr-payroll-history-card" key={`${record.runId}:${record.employmentId}`} type="button" onClick={() => navigate(historyPath(record))}>
        <div className="hr-payroll-history-card-head"><div><strong>{periodLabel(record.periodKey)}</strong><span>發薪日 {dateLabel(record.payDate)}</span></div><StatusBadge tone="success">已發放</StatusBadge></div>
        <div className="hr-payroll-history-card-total"><span>實領金額</span><strong>{money(record.netMinor)}</strong></div>
        <div className="hr-payroll-history-card-foot"><span>收入 {money(record.earningMinor)}</span><span>扣除 {money(record.deductionMinor)}</span><span>薪資版本 {record.versionNumber}</span></div>
      </button>)}</div> : !query.isPending && !query.error ? <div className="hr-form-empty-state"><strong>目前沒有已發放的薪資單</strong><p className="muted">完成薪資結帳後，紀錄會出現在這裡。</p></div> : null}
    </Panel>
  </div>;
}

export function HrPayslipDetail() {
  const { runId, employmentId } = useParams();
  const navigate = useNavigate();
  usePageTitle("薪資明細");
  const path = runId && employmentId
    ? `/me/payroll-history/${encodeURIComponent(runId)}/${encodeURIComponent(employmentId)}`
    : "";
  const query = useHrQuery<HrPayslipDetailResponse>(path, Boolean(path));
  const record = query.data?.detail.record;
  const lines = query.data?.detail.lines ?? [];
  return <div className="page hr-payroll-history-page hr-payslip-page">
    <Button variant="secondary" icon="chevronLeft" onClick={() => navigate("/payroll")}>返回薪資袋</Button>
    <PageHeader title="薪資明細" description={record ? `${periodLabel(record.periodKey)}・${dateLabel(record.payDate)}` : "查看已發放薪資項目。"} />
    {query.isPending ? <p className="muted">載入薪資明細…</p> : null}
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    {record ? <Panel className="hr-payslip-panel">
      <div className="hr-payslip-employee"><span>{record.employeeName}・{record.employeeNumber}</span><StatusBadge tone="success">已發放</StatusBadge></div>
      <div className="hr-payslip-totals"><div><span>收入</span><strong>{money(record.earningMinor)}</strong></div><div><span>扣除</span><strong>{money(record.deductionMinor)}</strong></div><div className="net"><span>實領</span><strong>{money(record.netMinor)}</strong></div></div>
      <div className="hr-payslip-lines">{(["earning", "deduction"] as const).map((direction) => {
        const selected = lines.filter((line) => line.direction === direction);
        return <section key={direction}><h2>{direction === "earning" ? "收入項目" : "扣除項目"}</h2>{selected.length ? <ul>{selected.map((line) => <li key={line.lineKey}><span>{lineLabel(line)}</span><strong>{direction === "deduction" ? `−${money(line.amountMinor)}` : money(line.amountMinor)}</strong></li>)}</ul> : <p className="muted">無項目</p>}</section>;
      })}</div>
    </Panel> : null}
  </div>;
}
