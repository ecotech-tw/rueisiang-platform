import { useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { Icon } from "../../shell/icons.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, EmptyState, FormHint, Page, PageHeader, Panel, StatusBadge, TextField } from "../../ui/index.js";
import { downloadPayslipImage } from "./exportPayslip.js";
import { useHrQuery, useHrWrite, type PayrollLine, type PayrollRecordDetail, type PayrollScheduleAllocationDetail, type PayrollWorker } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

/*
 * 薪資單的明細表是給員工看、也會匯出成圖片的單據，不是管理用的資料表：
 * 沒有左右留白、列與列之間用下緣線、表頭小一級。最後一欄固定寬，金額才會對齊。
 * 表頭沿用外層的圓角，但不要玻璃：單據上的表頭是實心的紙。
 */
const PAYSLIP_TABLE = "table-fixed [&_th]:h-auto [&_td]:h-auto [&_th]:px-0 [&_td]:px-0 [&_th]:py-[9px] [&_td]:py-[9px] [&_th]:border-t-0 [&_td]:border-t-0 [&_th]:border-b [&_td]:border-b [&_th]:border-soft-line [&_td]:border-soft-line [&_th]:text-left [&_td]:text-left [&_th:first-child]:pl-0 [&_td:first-child]:pl-0 [&_th:last-child]:w-[180px] [&_td:last-child]:w-[180px] [&_th:last-child]:pr-0 [&_td:last-child]:pr-0 [&_th]:text-[12px] [&_th]:font-bold [&_.numeric]:text-right [[data-table-scroll]>&_thead_th]:bg-paper [[data-table-scroll]>&_thead_th]:shadow-none [[data-table-scroll]>&_thead_th]:[-webkit-backdrop-filter:none] [[data-table-scroll]>&_thead_th]:[backdrop-filter:none]";
const PAYSLIP_META_TERM = "text-[11px] font-bold text-muted";
const PAYSLIP_META_VALUE = "m-0 mt-[3px] wrap-anywhere";
const PAYSLIP_TOTAL = "flex items-baseline justify-between gap-3";
const ACTION_GROUP = "flex flex-wrap items-center gap-2 max-[760px]:w-full";

const PAY_BASIS_LABEL: Record<string, string> = { monthly: "月薪", daily: "日薪", hourly: "時薪", mixed: "混合" };
const PERSON_KIND_LABEL = { employee: "正式員工", worker: "支援人員" } as const;
const LINE_LABELS: Record<string, string> = {
  base_salary: "本薪",
  monthly_rest_adjustment: "月休差額",
  overtime: "核准付薪加班",
  unpaid_leave: "請假扣款",
  booth_bonus: "櫃點獎金",
  labor_insurance: "勞保員工負擔",
  health_insurance: "健保員工負擔",
  special_workday: "特殊上班日薪資加給",
  annual_leave_settlement: "未休特休折現",
  typhoon_stop_pay: "災防停班給薪",
  worker_pay: "本薪",
};

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
function explanationString(line: PayrollLine, key: string): string | null {
  const value = line.explanation[key];
  return typeof value === "string" && value.trim() ? value : null;
}
function leaveHoursOf(line: PayrollLine): Array<{ leaveType: string; hours: number }> {
  const values = line.explanation.leaveHours;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const leaveType = (value as { leaveType?: unknown }).leaveType;
    const hours = (value as { hours?: unknown }).hours;
    return typeof leaveType === "string" && leaveType.trim() && typeof hours === "number" && Number.isFinite(hours) && hours > 0
      ? [{ leaveType: leaveType.trim(), hours }]
      : [];
  });
}
function leaveDeductionLabel(line: PayrollLine): string {
  const summary = leaveHoursOf(line).map(({ leaveType, hours }) => `${leaveType} ${hours.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 小時`);
  return summary.length ? `請假扣款（${summary.join("、")}）` : "請假扣款";
}
function ruleNamesOf(line: PayrollLine): string[] {
  const names = Array.isArray(line.explanation.ruleNames) ? line.explanation.ruleNames.filter((name): name is string => typeof name === "string" && Boolean(name.trim())) : [];
  const singleName = explanationString(line, "ruleName");
  const legacyName = line.lineKey.startsWith("special_allowance_") ? explanationString(line, "rule") : null;
  return [...new Set([...names, ...(singleName ? [singleName] : []), ...(legacyName ? [legacyName] : [])])];
}
function explanationItemNamesOf(line: PayrollLine): string[] {
  const names = [explanationString(line, "itemName")].filter((name): name is string => Boolean(name));
  const quantities = line.explanation.quantities;
  if (Array.isArray(quantities)) {
    for (const value of quantities) {
      if (!value || typeof value !== "object") continue;
      const itemName = (value as { itemName?: unknown }).itemName;
      if (typeof itemName === "string" && itemName.trim()) names.push(itemName);
    }
  }
  return [...new Set(names)];
}
function specialAllowanceLabel(line: PayrollLine): string {
  const ruleName = explanationString(line, "ruleName") ?? explanationString(line, "rule");
  const itemNames = explanationItemNamesOf(line);
  if (ruleName && itemNames.length) return `${ruleName}：${itemNames.join("、")}`;
  if (itemNames.length) return itemNames.join("、");
  return ruleName ? `特殊上班日補貼（${ruleName}）` : "特殊上班日補貼";
}
export function specialWorkdayDifferenceLabel(line: PayrollLine): string {
  const names = ruleNamesOf(line);
  const directionLabel = line.direction === "deduction" ? "薪資扣回" : "薪資加給";
  if (names.length === 1) return `${names[0]}：${directionLabel}`;
  if (names.length > 1) return `特殊上班日（${names.join("、")}）${directionLabel}`;
  return `特殊上班日${directionLabel}`;
}
export function payrollLineLabel(line: PayrollLine): string {
  if (line.lineKey === "unpaid_leave") return leaveDeductionLabel(line);
  if (line.lineKey.startsWith("special_allowance_")) return specialAllowanceLabel(line);
  if (line.lineKey === "special_workday") return specialWorkdayDifferenceLabel(line);
  if (line.lineKey.startsWith("bonus_")) return explanationString(line, "policyName") ?? "業績獎金";
  const itemName = explanationString(line, "itemName");
  if (itemName) return itemName;
  if (line.lineKey.startsWith("salary_item_")) return "薪資項目";
  if (line.lineKey.startsWith("adjustment_")) return "薪資加扣項";
  return LINE_LABELS[line.lineKey] ?? line.lineKey;
}
function lineFormula(line: PayrollLine): string {
  const explanation = line.explanation;
  const detail = explanation.formulaDetail ?? explanation.formula;
  return typeof detail === "string" && detail ? detail : "依保存的薪資規則計算";
}
// Same allowances across dates are grouped only for display; keep each dated formula in the persisted snapshot details.
export function groupSpecialAllowanceLines(lines: PayrollLine[]): PayrollLine[] {
  const groupedLines: PayrollLine[] = [];
  const groupedIndexes = new Map<string, number>();
  for (const line of lines) {
    if (!line.lineKey.startsWith("special_allowance_")) {
      groupedLines.push(line);
      continue;
    }
    const ruleName = explanationString(line, "ruleName") ?? explanationString(line, "rule");
    const itemNames = explanationItemNamesOf(line);
    if (!ruleName && !itemNames.length) {
      groupedLines.push(line);
      continue;
    }
    const displayLabelKey = payrollLineLabel(line).normalize("NFC").replaceAll("／", "/").replace(/\s+/g, " ").trim();
    const key = JSON.stringify([line.direction, displayLabelKey]);
    const existingIndex = groupedIndexes.get(key);
    if (existingIndex === undefined) {
      groupedIndexes.set(key, groupedLines.length);
      groupedLines.push(line);
      continue;
    }
    const existing = groupedLines[existingIndex]!;
    const calculationParts = [...calculationPartsOf(existing), ...calculationPartsOf(line)];
    groupedLines[existingIndex] = {
      ...existing,
      amountMinor: existing.amountMinor + line.amountMinor,
      explanation: {
        ...existing.explanation,
        ...(calculationParts.length ? { calculationParts } : {}),
        formulaDetail: `${lineFormula(existing)}；${lineFormula(line)}`,
      },
    };
  }
  return groupedLines;
}
function calculationPartsOf(line: PayrollLine): Array<{ formula: string; amountMinor: number }> {
  const value = line.explanation.calculationParts;
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const formula = (part as { formula?: unknown }).formula;
    const amountMinor = (part as { amountMinor?: unknown }).amountMinor;
    return typeof formula === "string" && typeof amountMinor === "number" && Number.isFinite(amountMinor) ? [{ formula, amountMinor }] : [];
  });
}

function isScheduleAllocationDetail(value: unknown): value is PayrollScheduleAllocationDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const detail = value as Partial<PayrollScheduleAllocationDetail>;
  return typeof detail.date === "string" && typeof detail.scopeId === "string" && typeof detail.shiftVersionId === "string"
    && (detail.shiftGroupId === null || typeof detail.shiftGroupId === "string")
    && (detail.attendanceStatus === "scheduled" || detail.attendanceStatus === "present" || detail.attendanceStatus === "absent")
    && [detail.requiredHeadcount, detail.assignedCount, detail.effectiveCount, detail.allocatedUnits, detail.unitNumerator, detail.unitDenominator].every((item) => typeof item === "number" && Number.isFinite(item))
    && (detail.payBasis === undefined || detail.payBasis === null || detail.payBasis === "monthly" || detail.payBasis === "daily" || detail.payBasis === "hourly")
    && (detail.scheduledHours === undefined || (typeof detail.scheduledHours === "number" && Number.isFinite(detail.scheduledHours) && detail.scheduledHours >= 0))
    && (detail.payableHours === undefined || (typeof detail.payableHours === "number" && Number.isFinite(detail.payableHours) && detail.payableHours >= 0))
    && (detail.overlapDeductedHours === undefined || (typeof detail.overlapDeductedHours === "number" && Number.isFinite(detail.overlapDeductedHours) && detail.overlapDeductedHours >= 0));
}
function scheduleAllocationDetailsOf(value: PayrollLine | PayrollWorker | null | undefined): PayrollScheduleAllocationDetail[] {
  if (!value) return [];
  const raw = "explanation" in value ? value.explanation.scheduleAllocationDetails : value.scheduleAllocationDetails;
  return Array.isArray(raw) ? raw.filter(isScheduleAllocationDetail) : [];
}
const LINE_FOCUS = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-secondary";
const LINE_DETAIL_TERM = "text-[11px] text-muted";
const LINE_DETAIL_VALUE = "m-0 mt-0.5 text-[12px] text-ink wrap-anywhere";
const ATTENDANCE_STATUS_LABEL:Record<PayrollScheduleAllocationDetail["attendanceStatus"], string> = { scheduled: "待確認", present: "已出勤", absent: "未出勤" };
function allocationUnitLabel(detail: PayrollScheduleAllocationDetail): string {
  if (detail.unitNumerator <= 0) return "0 個本薪單位";
  return `${detail.unitNumerator}/${detail.unitDenominator} 個本薪單位`;
}
export function PayrollAllocationDetails({ details }: { details: PayrollScheduleAllocationDetail[] }) {
  if (!details.length) return null;
  const totalUnits = details.reduce((sum, detail) => sum + detail.allocatedUnits, 0);
  return <div className="hr-payroll-allocation-details">
    <dl className="m-0 mt-[10px] grid grid-cols-3 gap-x-[14px] gap-y-2 max-[760px]:grid-cols-2 max-[620px]:grid-cols-[1fr]">
      <div className="min-w-0"><dt className={LINE_DETAIL_TERM}>分配班別</dt><dd className={LINE_DETAIL_VALUE}>{details.length} 班</dd></div>
      <div className="min-w-0"><dt className={LINE_DETAIL_TERM}>單位規則</dt><dd className={LINE_DETAIL_VALUE}>需求人力為上限，超額排班時均分</dd></div>
      <div className="min-w-0"><dt className={LINE_DETAIL_TERM}>本次分得</dt><dd className={LINE_DETAIL_VALUE}>{totalUnits.toLocaleString("zh-TW", { maximumFractionDigits: 3 })} 單位</dd></div>
    </dl>
    <details className="mt-[9px] border-t border-t-soft-line pt-2">
      <summary className={`flex cursor-pointer list-none items-center justify-between gap-2 text-[12px] font-bold text-muted [&::-webkit-details-marker]:hidden ${ LINE_FOCUS }`}><span>查看每日分配</span><span>{details.length} 筆</span></summary>
      <ol className="m-0 mt-[7px] grid gap-[5px] pl-5 text-[12px] text-muted">{details.map((detail, index) => <li key={`${detail.date}:${detail.shiftGroupId ?? detail.shiftVersionId}:${index}`} className="flex justify-between gap-3"><span className="wrap-anywhere">{detail.date}・{ATTENDANCE_STATUS_LABEL[detail.attendanceStatus]}・需求 {detail.requiredHeadcount} 人・有效 {detail.effectiveCount}/{detail.assignedCount} 人</span><strong className="flex-none text-ink tabular-nums">{allocationUnitLabel(detail)}</strong></li>)}</ol>
    </details>
  </div>;
}

export interface PayrollWorkerWorkDay {
  date: string;
  allocatedUnits: number;
  payBasis: "monthly" | "daily" | "hourly" | null;
  scheduledHours: number | null;
  payableHours: number | null;
  overlapDeductedHours: number;
}

export function payrollWorkerWorkDays(details: PayrollScheduleAllocationDetail[]): PayrollWorkerWorkDay[] {
  const byDate = new Map<string, PayrollWorkerWorkDay>();
  for (const detail of details) {
    const current = byDate.get(detail.date);
    if (!current) {
      byDate.set(detail.date, {
        date: detail.date,
        allocatedUnits: detail.allocatedUnits,
        payBasis: detail.payBasis ?? null,
        scheduledHours: typeof detail.scheduledHours === "number" ? detail.scheduledHours : null,
        payableHours: typeof detail.payableHours === "number" ? detail.payableHours : null,
        overlapDeductedHours: detail.overlapDeductedHours ?? 0,
      });
      continue;
    }
    byDate.set(detail.date, {
      date: detail.date,
      allocatedUnits: current.allocatedUnits + detail.allocatedUnits,
      payBasis: current.payBasis === (detail.payBasis ?? null) ? current.payBasis : null,
      scheduledHours: current.scheduledHours === null || typeof detail.scheduledHours !== "number" ? null : current.scheduledHours + detail.scheduledHours,
      payableHours: current.payableHours === null || typeof detail.payableHours !== "number" ? null : current.payableHours + detail.payableHours,
      overlapDeductedHours: current.overlapDeductedHours + (detail.overlapDeductedHours ?? 0),
    });
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function payrollHours(hours: number): string {
  return `${hours.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 小時`;
}

function payrollWorkerWorkDayBasisLabel(day: PayrollWorkerWorkDay): string {
  if (day.payBasis === "daily") return day.allocatedUnits > 0
    ? day.allocatedUnits === 1 ? "納入日薪計算" : `日薪 × ${day.allocatedUnits.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 單位`
    : "日薪・未分配";
  if (day.payBasis === "hourly") return day.scheduledHours === null || day.payableHours === null
    ? "時薪・工時未保存"
    : `時薪・排班 ${payrollHours(day.scheduledHours)}${day.overlapDeductedHours > 0 ? `・重疊扣除 ${payrollHours(day.overlapDeductedHours)}` : ""}・計薪 ${payrollHours(day.payableHours)}`;
  return day.payBasis === "monthly" ? "月薪計算" : "當日敘薪方式未保存";
}

const WORKER_NOTE = "m-0 text-[12px] leading-[1.6] text-muted";
const WORK_SUMMARY = "grid gap-1.5 border-t border-t-soft-line pt-2";
const WORK_SUMMARY_HEAD = "flex items-center justify-between gap-[10px]";
const WORK_SUMMARY_LIST = "m-0 grid list-none gap-[5px] p-0";
const WORK_SUMMARY_NOTE = "m-0 text-[11px] leading-[1.6] text-muted";

function PayrollWorkerWorkDayList({ days, label }: { days: PayrollWorkerWorkDay[]; label: (day: PayrollWorkerWorkDay) => string }) {
  return <ul className={WORK_SUMMARY_LIST}>{days.map((day) => <li key={day.date} className="flex justify-between gap-3 text-[12px] text-muted"><span className="flex-none wrap-anywhere">{day.date}</span><strong className="min-w-0 flex-auto text-right text-ink tabular-nums wrap-anywhere">{label(day)}</strong></li>)}</ul>;
}

function PayrollWorkerWorkSummaryDisclosure({ title, count, countDetail, emptyMessage, children }: { title: string; count: number; countDetail?: string; emptyMessage: string; children: ReactNode }) {
  const countLabel = countDetail ? `${count} 天・${countDetail}` : `${count} 天`;
  const heading = <><strong className="text-[13px]">{title}</strong><span className="text-[12px] font-bold text-brand-dark tabular-nums">{countLabel}</span></>;
  if (!count) return <><div className={WORK_SUMMARY_HEAD}>{heading}</div><p className={WORK_SUMMARY_NOTE}>{emptyMessage}</p></>;
  return <details className="group grid gap-1.5">
    <summary className={`${ WORK_SUMMARY_HEAD } cursor-pointer list-none hover:bg-brand/4 [&::-webkit-details-marker]:hidden ${ LINE_FOCUS }`}>{heading}<span className="grid size-8 flex-none place-items-center rounded-[50%] text-muted [transition-property:background-color,color] duration-150 ease-out motion-reduce:transition-none" aria-hidden="true"><Icon name="chevronDown" className="size-5 [transition-property:transform] duration-220 ease-out group-open:[transform:rotate(180deg)] motion-reduce:transition-none" /></span></summary>
    {children}
  </details>;
}

export function PayrollWorkerWorkSummary({ worker, details }: { worker: PayrollWorker; details: PayrollScheduleAllocationDetail[] }) {
  const workDays = payrollWorkerWorkDays(details);
  if (worker.payBasis === "daily") {
    const payableDays = workDays.filter((day) => day.allocatedUnits > 0);
    const allocatedUnits = payableDays.reduce((sum, day) => sum + day.allocatedUnits, 0);
    return <section className={WORK_SUMMARY} aria-label="日薪計薪日期">
      <PayrollWorkerWorkSummaryDisclosure title="日薪計薪日期" count={payableDays.length} countDetail={`${allocatedUnits.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 單位`} emptyMessage={details.length ? "本期沒有可計薪日期。" : "此筆歷史快照未保存逐日排班資料。"}>
        <PayrollWorkerWorkDayList days={payableDays} label={payrollWorkerWorkDayBasisLabel} />
      </PayrollWorkerWorkSummaryDisclosure>
    </section>;
  }
  if (worker.payBasis === "mixed") {
    return <section className={WORK_SUMMARY} aria-label="逐日計薪方式">
      <PayrollWorkerWorkSummaryDisclosure title="逐日計薪方式" count={workDays.length} emptyMessage="此筆歷史快照未保存逐日計薪資料。">
        <PayrollWorkerWorkDayList days={workDays} label={payrollWorkerWorkDayBasisLabel} />
      </PayrollWorkerWorkSummaryDisclosure>
    </section>;
  }
  if (worker.payBasis !== "hourly") return null;
  const hasHours = workDays.length > 0 && workDays.every((day) => day.scheduledHours !== null && day.payableHours !== null);
  const scheduledHours = hasHours ? workDays.reduce((sum, day) => sum + day.scheduledHours!, 0) : 0;
  const payableHours = hasHours ? workDays.reduce((sum, day) => sum + day.payableHours!, 0) : 0;
  return <section className={WORK_SUMMARY} aria-label="時薪逐日工時">
    <PayrollWorkerWorkSummaryDisclosure title="時薪逐日工時" count={workDays.length} emptyMessage="此筆歷史快照未保存逐日工時明細。">
      <PayrollWorkerWorkDayList days={workDays} label={(day) => day.scheduledHours === null || day.payableHours === null ? "工時未保存" : `排班 ${payrollHours(day.scheduledHours)}${day.overlapDeductedHours > 0 ? `・重疊扣除 ${payrollHours(day.overlapDeductedHours)}` : ""}・計薪 ${payrollHours(day.payableHours)}`} />
      {hasHours ? <p className={WORK_SUMMARY_NOTE}>合計排班 {payrollHours(scheduledHours)}・重疊扣除 {payrollHours(workDays.reduce((sum, day) => sum + day.overlapDeductedHours, 0))}・計薪 {payrollHours(payableHours)}。依此次薪資試算保存的排班單位計算；歷史批次保留當時分配結果。</p> : <p className={WORK_SUMMARY_NOTE}>此筆歷史試算未保存逐日工時，無法回溯工時數。</p>}
    </PayrollWorkerWorkSummaryDisclosure>
  </section>;
}

function PayrollOverviewItem({ label, value, net = false }: { label: string; value: string; net?: boolean }) {
  return <div className={`grid min-w-0 gap-1 rounded-[12px] px-[13px] py-[11px] [box-shadow:inset_0_1px_0_color-mix(in_oklab,var(--color-paper)_64%,transparent),inset_0_0_0_1px_color-mix(in_oklab,var(--color-ink)_5%,transparent)] ${ net ? "bg-brand-soft" : "bg-paper/52" }`}><span className="text-[11px] font-bold text-muted">{label}</span><strong className={`truncate text-[16px] ${ net ? "text-brand-dark" : "text-ink" }`}>{value}</strong></div>;
}
function payBasisOf(detail: PayrollRecordDetail) {
  return detail.record.payBasis ? PAY_BASIS_LABEL[detail.record.payBasis] ?? detail.record.payBasis : "—";
}
function payrollLinesOf(detail: PayrollRecordDetail): PayrollLine[] {
  const workerLines = detail.worker?.lines?.length ? detail.worker.lines : detail.worker ? [
    { lineKey: "worker_pay", direction: "earning" as const, amountMinor: Math.max(0, detail.worker.amountMinor - (detail.worker.overtimeMinor ?? 0)), explanation: {} },
    ...((detail.worker.overtimeMinor ?? 0) > 0 ? [{ lineKey: "overtime", direction: "earning" as const, amountMinor: detail.worker.overtimeMinor ?? 0, explanation: detail.worker.overtimeExplanation ?? {} }] : []),
  ] : [];
  const baseLines = detail.employee?.lines ?? workerLines;
  const legacyLines = detail.items.map((item) => ({
    lineKey: `legacy_adjustment_${item.id}`,
    direction: item.direction,
    amountMinor: item.amountMinor,
    explanation: { itemName: item.itemName, reason: item.reason, formulaDetail: `歷史薪資加扣項（${item.itemName}）：${item.reason}` },
  }));
  return groupSpecialAllowanceLines([...baseLines, ...legacyLines]);
}
function PayrollLineList({ lines }: { lines: PayrollLine[] }) {
  return <div className="grid gap-[10px] pt-[14px]">{lines.map((line) => {
    const allocationDetails = scheduleAllocationDetailsOf(line);
    const deduction = line.direction === "deduction";
    return <details className="overflow-hidden rounded-[12px] border border-soft-line bg-canvas/74" key={line.lineKey}>
      <summary className={`grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-[14px] py-[13px] hover:bg-brand/4 motion-reduce:transition-none [&::-webkit-details-marker]:hidden ${ LINE_FOCUS }`}><span className="flex min-w-0 flex-wrap items-center gap-2"><strong className="wrap-anywhere">{payrollLineLabel(line)}</strong><span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ${ deduction ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok" }`}>{deduction ? "扣款" : "應發"}</span></span><strong className={`flex-none whitespace-nowrap text-[15px] tabular-nums ${ deduction ? "text-warn" : "text-ink" }`}>{deduction ? deductionMoney(line.amountMinor) : money(line.amountMinor)}</strong></summary>
      <div className="border-t border-t-soft-line px-[14px] pb-[13px] max-[620px]:px-3"><div className="mt-[10px] grid gap-[3px] rounded-[9px] bg-brand/6 px-[10px] py-[9px]"><span className="text-[11px] font-extrabold tracking-[.03em] text-muted">計算公式</span><p className="m-0 text-[13px] leading-[1.6] text-ink wrap-anywhere">{lineFormula(line)}</p></div><PayrollAllocationDetails details={allocationDetails} /></div>
    </details>;
  })}</div>;
}

function PayrollPayslipTable({ title, lines, direction }: { title: string; lines: PayrollLine[]; direction: PayrollLine["direction"] }) {
  const filteredLines = lines.filter((line) => line.direction === direction);
  return <section className="mt-5 break-inside-avoid" aria-labelledby={`payroll-payslip-${direction}`}>
    <h2 id={`payroll-payslip-${direction}`} className="m-0 mb-2 text-[15px]">{title}</h2>
    <DataTable className={PAYSLIP_TABLE}>
      <thead><tr><th>薪資項目</th><th className="numeric">金額</th></tr></thead>
      <tbody>{filteredLines.length ? filteredLines.map((line) => <tr key={line.lineKey}><td>{payrollLineLabel(line)}</td><td className="numeric">{direction === "deduction" ? deductionMoney(line.amountMinor) : money(line.amountMinor)}</td></tr>) : <tr><td colSpan={2}>—</td></tr>}</tbody>
    </DataTable>
  </section>;
}

function PayrollPayslip({ detail, elementRef }: { detail: PayrollRecordDetail; elementRef?: Ref<HTMLElement> }) {
  const lines = payrollLinesOf(detail);
  const titleId = "hr-payroll-payslip-preview-title";
  return <section ref={elementRef} className="mx-auto my-9 block w-[min(794px,100%)] bg-paper px-12 py-[42px] [box-shadow:0_0_0_1px_color-mix(in_oklab,var(--color-ink)_6%,transparent),0_14px_36px_rgba(53,28,29,.12)]" aria-labelledby={titleId}>
    <header className="flex items-start justify-between gap-5 border-b-2 border-b-ink pb-[18px]">
      <div><p className="m-0 mb-1 text-[13px] font-bold tracking-[.08em] text-muted">員工薪資條</p><h1 id={titleId} className="m-0 text-[26px]">{detail.record.personName}</h1></div>
      <strong className="whitespace-nowrap pt-5 text-[18px] tabular-nums">{periodLabel(detail.record.periodKey)}</strong>
    </header>
    <dl className="mx-0 mb-6 mt-[18px] grid grid-cols-4 gap-x-[18px] gap-y-3">
      <div className="min-w-0"><dt className={PAYSLIP_META_TERM}>員工編號</dt><dd className={PAYSLIP_META_VALUE}>{detail.record.personNumber ?? "—"}</dd></div>
      <div className="min-w-0"><dt className={PAYSLIP_META_TERM}>人員類型</dt><dd className={PAYSLIP_META_VALUE}>{PERSON_KIND_LABEL[detail.record.personKind]}</dd></div>
      <div className="min-w-0"><dt className={PAYSLIP_META_TERM}>計薪方式</dt><dd className={PAYSLIP_META_VALUE}>{payBasisOf(detail)}</dd></div>
      <div className="min-w-0"><dt className={PAYSLIP_META_TERM}>發薪日</dt><dd className={PAYSLIP_META_VALUE}>{detail.record.payDate ?? "—"}</dd></div>
    </dl>
    <PayrollPayslipTable title="應發項目" lines={lines} direction="earning" />
    <PayrollPayslipTable title="扣款項目" lines={lines} direction="deduction" />
    <dl className="mx-0 mb-0 mt-7 grid grid-cols-3 gap-3 border-t-2 border-t-ink pt-[14px]">
      <div className={PAYSLIP_TOTAL}><dt className="text-[12px] text-muted">應發合計</dt><dd className="m-0 text-[17px] tabular-nums">{money(detail.record.earningMinor)}</dd></div>
      <div className={PAYSLIP_TOTAL}><dt className="text-[12px] text-muted">扣款合計</dt><dd className="m-0 text-[17px] tabular-nums">{detail.record.deductionMinor ? deductionMoney(detail.record.deductionMinor) : "—"}</dd></div>
      <div className={PAYSLIP_TOTAL}><dt className="text-[12px] font-bold text-brand-dark">實領合計</dt><dd className="m-0 text-[17px] font-bold text-brand-dark tabular-nums">{money(detail.record.netMinor)}</dd></div>
    </dl>
  </section>;
}

export function HrPayrollRecordDetail() {
  usePageTitle("薪資發放明細");
  const navigate = useNavigate();
  const { runId = "", personKind = "", personId = "" } = useParams();
  const { permissions, user } = useSession();
  const canRead = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:read"));
  const canCalculate = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:calculate"));
  const [approveOpen, setApproveOpen] = useState(false);
  const [deleteItemId, setDeleteItemId] = useState<string | null>(null);
  const [deleteRunOpen, setDeleteRunOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [withdrawValidationError, setWithdrawValidationError] = useState<string | null>(null);
  const [payslipPreviewOpen, setPayslipPreviewOpen] = useState(false);
  const [payslipDownloading, setPayslipDownloading] = useState(false);
  const payslipPreviewRef = useRef<HTMLElement>(null);
  const toast = useToast();
  const result = useHrQuery<PayrollRecordDetail>(runId && (personKind === "employee" || personKind === "worker") && personId ? `/payroll/records/${encodeURIComponent(runId)}/${personKind}/${encodeURIComponent(personId)}` : "/payroll/records/__none__/employee/__none__", canRead && Boolean(runId && personId), { keepPreviousData: false });
  const approve = useHrWrite<{ approved: number }>();
  const deleteItem = useHrWrite();
  const deleteRun = useHrWrite<{ id: string; deleted: true }>();
  const withdraw = useHrWrite();
  const detail = result.data;
  const itemTotals = useMemo(() => (detail?.items ?? []).reduce((totals, item) => item.direction === "earning"
    ? { earningMinor: totals.earningMinor + item.amountMinor, deductionMinor: totals.deductionMinor }
    : { earningMinor: totals.earningMinor, deductionMinor: totals.deductionMinor + item.amountMinor }, { earningMinor: 0, deductionMinor: 0 }), [detail?.items]);

  if (!canRead) return <Alert tone="danger">薪資資料僅限全平台 HR 管理者查看。</Alert>;
  if (result.isPending) return <HrPageSkeleton variant="detail" />;
  if (result.error || !detail) return <Alert tone="danger">{result.error?.message ?? "找不到這筆薪資發放紀錄。"}</Alert>;
  const detailLines = payrollLinesOf(detail);
  const workerAllocationDetails = scheduleAllocationDetailsOf(detail.worker);
  const hasUnsettledActions = canCalculate && detail.record.status === "unsettled";

  function approveRecord() {
    approve.mutate({ path: "/payroll/records/approve", method: "POST", values: { records: [{ runId: detail!.record.runId, personKind: detail!.record.personKind, personId: detail!.record.personId }] } }, { onSuccess: () => { setApproveOpen(false); void result.refetch(); toast.show("已確定發放。", "success"); } });
  }
  function removeItem() {
    if (!deleteItemId) return;
    deleteItem.mutate({ path: `/payroll/records/items/${encodeURIComponent(deleteItemId)}`, method: "DELETE", values: {} }, { onSuccess: () => { setDeleteItemId(null); void result.refetch(); toast.show("薪資加扣項已刪除。", "success"); } });
  }
  function removeRecord() {
    deleteRun.mutate({ path: `/payroll/records/${encodeURIComponent(detail!.record.runId)}/${detail!.record.personKind}/${encodeURIComponent(detail!.record.personId)}`, method: "DELETE", values: {} }, { onSuccess: () => { setDeleteRunOpen(false); toast.show("這筆薪資試算已刪除。", "success"); navigate("/hr/payroll-settlement", { replace: true }); } });
  }
  function withdrawRecord() {
    const reason = withdrawReason.trim();
    if (!reason) { setWithdrawValidationError("請填寫撤回原因。"); return; }
    setWithdrawValidationError(null);
    withdraw.mutate({ path: `/payroll/records/${encodeURIComponent(detail!.record.runId)}/${detail!.record.personKind}/${encodeURIComponent(detail!.record.personId)}/withdraw`, method: "POST", values: { reason } }, { onSuccess: () => { setWithdrawOpen(false); void result.refetch(); toast.show("這筆薪資已撤回，可重新試算此人員。", "success"); } });
  }
  async function downloadPayslip() {
    const element = payslipPreviewRef.current;
    if (!element || payslipDownloading) return;
    setPayslipDownloading(true);
    try {
      await downloadPayslipImage(element, detail!.record.personName, detail!.record.periodKey);
      toast.show("薪資條 PNG 已下載。");
    } catch (failure) {
      toast.show(failure instanceof Error ? failure.message : "圖片產生失敗，請再試一次。", "danger");
    } finally {
      setPayslipDownloading(false);
    }
  }

  return <Page className="hr-payroll-page">
    <PageHeader title={detail.record.personName} description={`${periodLabel(detail.record.periodKey)}・${PERSON_KIND_LABEL[detail.record.personKind]}・${payBasisOf(detail)}`} actions={<div className="flex flex-wrap items-center justify-end gap-2 max-[760px]:justify-start"><Button variant="secondary" icon="chevronLeft" onClick={() => navigate("/hr/payroll-settlement")}>返回發放紀錄</Button></div>} />
    <Panel className="grid gap-4" title="發放明細" description={`${detail.record.payDate ? `發薪日 ${detail.record.payDate}` : "未設定發薪日"}・試算版本 v${detail.record.versionNumber}`}>
      <div className="flex items-center justify-between gap-[18px] border-b border-b-soft-line pb-[14px] max-[760px]:flex-col max-[760px]:items-start">
        <div className="grid min-w-0 grid-cols-[auto_auto] items-center gap-x-2 gap-y-[5px]"><span className="col-span-full text-[12px] font-bold text-muted">發放狀態</span><StatusBadge tone={detail.record.status === "closed" ? "success" : detail.record.status === "withdrawn" ? "danger" : "warning"}>{detail.record.status === "closed" ? "已確定發放" : detail.record.status === "withdrawn" ? "已撤回" : "尚未結算"}</StatusBadge><small className="col-span-full text-[12px] text-muted">{detail.record.personNumber ? `${detail.record.personNumber}・` : ""}{PERSON_KIND_LABEL[detail.record.personKind]}・建立於 {detail.record.createdAt}</small></div>
        <div className="flex flex-wrap items-center justify-end gap-2 max-[760px]:w-full max-[760px]:justify-start" role="group" aria-label="薪資發放操作">
          {hasUnsettledActions ? <div className={ACTION_GROUP} role="group" aria-label="未結算操作"><Button icon="check" loading={approve.isPending} disabled={deleteRun.isPending || withdraw.isPending} onClick={() => { approve.reset(); setApproveOpen(true); }}>確定發放此筆</Button></div> : null}
          {/* 兩組都在時用分隔線隔開；手機上兩組各佔一列，分隔線改成上緣。 */}
          <div className={`${ ACTION_GROUP } ${ hasUnsettledActions ? "ms-1 border-s border-s-soft-line ps-3 max-[760px]:ms-0 max-[760px]:border-s-0 max-[760px]:border-t max-[760px]:border-t-soft-line max-[760px]:ps-0 max-[760px]:pt-2" : "" }`} role="group" aria-label="其他操作"><Button variant="secondary" icon="eye" tone="info" onClick={() => setPayslipPreviewOpen(true)}>預覽薪資條</Button>{canCalculate && detail.record.status === "unsettled" && detail.run.canDelete ? <Button variant="danger" icon="trash" disabled={approve.isPending || withdraw.isPending} onClick={() => { deleteRun.reset(); setDeleteRunOpen(true); }}>刪除此筆試算</Button> : null}{canCalculate && detail.record.status === "closed" && !detail.record.withdrawal ? <Button variant="danger" icon="history" disabled={approve.isPending || deleteRun.isPending || withdraw.isPending} onClick={() => { withdraw.reset(); setWithdrawReason(""); setWithdrawValidationError(null); setWithdrawOpen(true); }}>撤回此筆發放</Button> : null}</div>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2 max-[760px]:grid-cols-2" aria-label="薪資合計">
        <PayrollOverviewItem label="應發" value={money(detail.record.earningMinor)} />
        <PayrollOverviewItem label="扣款" value={detail.record.deductionMinor ? deductionMoney(detail.record.deductionMinor) : "—"} />
        <PayrollOverviewItem label="實領" value={money(detail.record.netMinor)} net />
      </div>
      {detail.record.status === "withdrawn" ? <Alert tone="warning"><strong>此筆發放已撤回，歷史薪資快照保留供稽核。</strong><p>撤回原因：{detail.record.withdrawal?.reason}（{detail.record.withdrawal?.withdrawnAt}）</p><p>此人員可重新加入本月試算；其他人員的發放狀態不受影響。</p></Alert> : detail.record.status === "closed" ? <Alert tone="info">這筆紀錄已確定發放，以下明細是不可改寫的歷史快照。{detail.run.withdrawal ? <p>原試算批次曾撤回；批次撤回原因：{detail.run.withdrawal.reason}（{detail.run.withdrawal.withdrawnAt}）</p> : null}</Alert> : detail.run.withdrawal ? <Alert tone="warning"><strong>原始薪資批次曾整批撤回。</strong>此筆仍可重新確認發放或個別刪除。<p>撤回原因：{detail.run.withdrawal.reason}（{detail.run.withdrawal.withdrawnAt}）</p></Alert> : <Alert tone="warning">請確認試算公式與薪資加扣項後，再確定發放。薪資加扣項會以試算時保存的明細快照呈現；若資料有變更，請刪除此筆後重新試算。</Alert>}
      {detail.run.warnings.length ? <Alert tone="warning"><strong>試算提醒</strong><ul className="mt-[7px] mb-0 pl-5">{detail.run.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></Alert> : null}

      {detail.employee ? <PayrollLineList lines={detailLines} /> : <div className="grid gap-2 rounded-[12px] border border-line bg-paper/42 px-[14px] py-[13px]"><div className="flex items-start justify-between gap-3"><div className="grid gap-0.5"><strong>{detail.worker?.workerName}</strong><small className="text-[12px] text-muted">排班支援・{detail.worker ? PAY_BASIS_LABEL[detail.worker.payBasis] ?? detail.worker.payBasis : ""}</small></div><strong className="whitespace-nowrap text-brand-dark tabular-nums">{money(detail.worker?.amountMinor ?? 0)}</strong></div><p className={WORKER_NOTE}>依已發布排班、有效敘薪與核准付薪加班計算；原始試算結果保留在這筆發放紀錄中。</p>{detail.worker?.overtimeMinor ? <p className={WORKER_NOTE}>其中核准付薪加班：{money(detail.worker.overtimeMinor)}（{((detail.worker.overtimeSeconds ?? 0) / 3600).toFixed(1)} 小時）</p> : null}{detail.worker ? <PayrollWorkerWorkSummary worker={detail.worker} details={workerAllocationDetails} /> : null}<PayrollAllocationDetails details={workerAllocationDetails} /><PayrollLineList lines={detailLines} /></div>}

      <section className="grid gap-3" aria-labelledby="payroll-items-title">
        <div className="flex items-start justify-between gap-3 border-b border-b-soft-line pb-3"><div className="grid min-w-0 gap-1"><h3 className="m-0 text-[15px]" id="payroll-items-title">薪資加扣項</h3><p className="m-0 text-[13px] text-muted">附加在這筆紀錄的補發與扣款。{canCalculate && detail.record.status === "unsettled" ? <>新增與管理請至 <Link to="/hr/payroll-adjustments">薪資加扣項</Link>。</> : ""}</p></div></div>
        {detail.items.length ? <DataTable><thead><tr><th>項目</th><th>原因</th><th className="numeric">金額</th><th>操作</th></tr></thead><tbody>{detail.items.map((item) => <tr key={item.id}><td><strong>{item.itemName}</strong><small className="text-[12px] text-muted">{item.direction === "earning" ? "補發" : "扣款"}</small></td><td>{item.reason}</td><td className="numeric">{item.direction === "earning" ? money(item.amountMinor) : deductionMoney(item.amountMinor)}</td><td>{canCalculate && detail.record.status === "unsettled" ? <Button variant="danger" onClick={() => setDeleteItemId(item.id)}>刪除</Button> : null}</td></tr>)}</tbody></DataTable> : <EmptyState className="mt-[18px]">尚未加入薪資加扣項。</EmptyState>}
        {detail.items.length ? <FormHint>加扣項合計：補發 {money(itemTotals.earningMinor)}・扣款 {itemTotals.deductionMinor ? deductionMoney(itemTotals.deductionMinor) : "—"}</FormHint> : null}
      </section>
    </Panel>
    {approveOpen ? <ConfirmDialog title="確定發放這筆薪資？" confirmLabel="確定發放" pending={approve.isPending} onCancel={() => { if (!approve.isPending) setApproveOpen(false); }} onConfirm={approveRecord}>
      <p><strong>{detail.record.personName}</strong>（{periodLabel(detail.record.periodKey)}）的這筆薪資紀錄會標記為「已確定發放」，之後明細將以歷史快照保存。</p>
      {approve.error ? <Alert tone="danger">{approve.error.message}</Alert> : null}
    </ConfirmDialog> : null}
    {deleteItemId ? <ConfirmDialog title="刪除這筆薪資加扣項？" confirmLabel="刪除" pending={deleteItem.isPending} onCancel={() => { if (!deleteItem.isPending) setDeleteItemId(null); }} onConfirm={removeItem}>
      <p>刪除後會立即從這筆尚未結算的發放紀錄移除。</p>
      {deleteItem.error ? <Alert tone="danger">{deleteItem.error.message}</Alert> : null}
    </ConfirmDialog> : null}
    {payslipPreviewOpen ? <Dialog
      width={900}
      // 畫布底色貼齊 footer：-mb-2 抵掉 footer 上方的 mt-2。
      bodyLayout="grid max-h-[calc(100vh-180px)] content-start gap-4 bg-canvas -mb-2"
      title="薪資條預覽"
      titleMeta={`${detail.record.personName}・${periodLabel(detail.record.periodKey)}`}
      onClose={() => setPayslipPreviewOpen(false)}
      actions={<><Button variant="secondary" onClick={() => setPayslipPreviewOpen(false)}>關閉</Button><Button icon="download" loading={payslipDownloading} loadingLabel="產生圖片…" onClick={() => { void downloadPayslip(); }}>下載薪資條</Button></>}
    ><PayrollPayslip detail={detail} elementRef={payslipPreviewRef} /></Dialog> : null}
    {withdrawOpen ? <ConfirmDialog title="撤回這筆薪資發放？" confirmLabel="撤回此筆" pending={withdraw.isPending} onCancel={() => { if (!withdraw.isPending) setWithdrawOpen(false); }} onConfirm={withdrawRecord}>
      <p><strong>{detail.record.personName}</strong>（{periodLabel(detail.record.periodKey)}）的已確定發放結果會標記為撤回，原始薪資快照與撤回原因會保留。</p>
      <p>撤回不影響同批次其他人員；此人員可重新加入本月試算。若此筆含未休特休折現，系統會一併恢復額度。</p>
      <TextField label="撤回原因" value={withdrawReason} maxLength={1000} required placeholder="請說明撤回原因" onChange={(event) => setWithdrawReason(event.target.value)} />
      {withdrawValidationError || withdraw.error ? <Alert tone="danger">{withdrawValidationError ?? withdraw.error?.message}</Alert> : null}
    </ConfirmDialog> : null}
    {deleteRunOpen ? <ConfirmDialog title="刪除此筆薪資試算？" confirmLabel="刪除此筆" pending={deleteRun.isPending} onCancel={() => { if (!deleteRun.isPending) setDeleteRunOpen(false); }} onConfirm={removeRecord}>
      <p><strong>{detail.record.personName}</strong>（{periodLabel(detail.record.periodKey)}）的未發放薪資試算、明細與加扣項會一併刪除。</p>
      <p>同批次其他人員的試算與發放狀態不受影響；刪除後可重新加入此人員試算。</p>
      {deleteRun.error ? <Alert tone="danger">{deleteRun.error.message}</Alert> : null}
    </ConfirmDialog> : null}
  </Page>;
}
