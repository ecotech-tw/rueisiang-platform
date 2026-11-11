import { useNavigate, useParams } from "react-router";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Page, PageHeader, Panel, StatusBadge } from "../../ui/index.js";
import { useHrQuery, type HrPayrollHistoryRecord, type HrPayslipDetailResponse, type PayrollLine } from "./api.js";
import { dateLabel } from "./format.js";
import { HrBackBar } from "./HrBackBar.js";
import { SummaryTotals } from "./SummaryTotals.js";

function money(minor: number) {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}

function periodLabel(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return match ? `${match[1]} 年 ${Number(match[2])} 月` : value;
}

const NO_PAY_DATE = "尚未提供發薪日";
const PAYROLL_PAGE = "w-full max-w-[760px] mx-auto max-[760px]:max-w-none";

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
  return <Page className={PAYROLL_PAGE}>
    <PageHeader title="薪資袋" description="查看已確定發放的薪資紀錄與實領金額。" />
    <div className="grid min-h-0 gap-3">
      {query.isPending ? <p className="muted">載入薪資紀錄…</p> : null}
      {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
      {query.data?.records.length ? <div className="grid gap-2.5">{query.data.records.map((record) => <button className="grid w-full cursor-pointer gap-3.5 rounded-[14px] border border-line bg-paper p-4 text-left text-ink transition-[border-color,background-color] duration-150 ease-[ease] hover:border-brand hover:bg-brand/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary" key={`${record.runId}:${record.employmentId}`} type="button" onClick={() => navigate(historyPath(record))}>
        <div className="flex items-start justify-between gap-2.5"><div className="grid gap-[3px]"><strong className="text-[16px]">{periodLabel(record.periodKey)}</strong><span className="text-[12px] text-muted">發薪日 {dateLabel(record.payDate, NO_PAY_DATE)}</span></div><StatusBadge tone="success">已發放</StatusBadge></div>
        <div className="grid gap-1 rounded-[11px] bg-canvas p-3"><span className="text-[12px] font-bold text-muted">實領金額</span><strong className="text-[23px] tabular-nums">{money(record.netMinor)}</strong></div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted"><span>收入 {money(record.earningMinor)}</span><span>扣除 {money(record.deductionMinor)}</span><span>薪資版本 {record.versionNumber}</span></div>
      </button>)}</div> : !query.isPending && !query.error ? <div className="hr-form-empty-state"><strong>目前沒有已發放的薪資單</strong><p className="muted">完成薪資結帳後，紀錄會出現在這裡。</p></div> : null}
    </div>
  </Page>;
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
  return <Page className={`${PAYROLL_PAGE} [&>[data-page-head]]:mt-2`}>
    <HrBackBar label="返回薪資袋" onBack={() => navigate("/payroll")} />
    <PageHeader title="薪資明細" description={record ? `${periodLabel(record.periodKey)}・${dateLabel(record.payDate, NO_PAY_DATE)}` : "查看已發放薪資項目。"} className="[&>div]:flex [&>div]:min-w-0 [&>div]:items-baseline [&>div]:justify-between [&>div]:gap-3 [&_h1]:flex-none [&_h1]:whitespace-nowrap [&_p]:min-w-0 [&_p]:overflow-hidden [&_p]:text-right [&_p]:text-ellipsis [&_p]:whitespace-nowrap" />
    {query.isPending ? <p className="muted">載入薪資明細…</p> : null}
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    {record ? <Panel className="grid gap-[18px]">
      <div className="flex items-center justify-between gap-2.5 font-bold"><span>{record.employeeName}・{record.employeeNumber}</span><StatusBadge tone="success">已發放</StatusBadge></div>
      <SummaryTotals items={[{ label: "收入", value: money(record.earningMinor) }, { label: "扣除", value: money(record.deductionMinor) }, { label: "實領", value: money(record.netMinor), emphasis: true }]} />
      <div className="grid gap-4">{(["earning", "deduction"] as const).map((direction) => {
        const selected = lines.filter((line) => line.direction === direction);
        return <section key={direction} className="grid gap-2"><h2 className="m-0 text-[15px]">{direction === "earning" ? "收入項目" : "扣除項目"}</h2>{selected.length ? <ul className="m-0 grid list-none gap-0 p-0">{selected.map((line) => <li key={line.lineKey} className="flex justify-between gap-3 border-b border-b-soft-line py-2.5 text-[13px]"><span>{lineLabel(line)}</span><strong className="flex-none tabular-nums">{direction === "deduction" ? `−${money(line.amountMinor)}` : money(line.amountMinor)}</strong></li>)}</ul> : <p className="muted">無項目</p>}</section>;
      })}</div>
    </Panel> : null}
  </Page>;
}
