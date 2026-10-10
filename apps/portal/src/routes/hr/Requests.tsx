import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { Pager } from "../../shell/Pager.js";
import { useToast } from "../../shell/Toast.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, Field, FilterSelect, FilterToolbar, PageHeader, Panel, SearchFilterInput, SegmentedControl, SelectField, StatusBadge, TextField, Tooltip } from "../../ui/index.js";
import { hrEmployeeLabel, isHrFormalEmployee, sortHrEmployees, useHrLeaveDuration, useHrQuery, useHrWrite, type Employee, type FormRequest, type HrLeaveRequest, type HrOvertimeDay, type HrOvertimeRequest, type HrRequestCenterResponse, type HrRequestCenterRow } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";
import { OVERTIME_HOUR_PRESETS, OvertimeDayPicker, addMinutes, buildOvertimeEntries, hoursText, isValidOvertimeMinutes, minutesUntil, monthRange, nextDate, parseHours, selectedUnscheduledDates, summarizeAssignments } from "@rueisiang/ui";
import { buildOvertimeSubmission } from "./overtime-entry.js";

type RequestKind = "leave" | "overtime" | "clock_correction";
type RequestStatus = "draft" | "pending" | "approved" | "rejected" | "cancelled";
type HistoryKind = "all" | RequestKind;

interface EmployeePageResponse { employees: Employee[] }
interface WorkerCandidate { id: string; displayName: string }
interface LeaveType { id: string; name: string; leaveKind: "annual" | "other" }

interface RequestRow {
  id: string;
  kind: RequestKind;
  employeeName: string;
  employeeNumber: string;
  period: string;
  detail: string;
  reason: string;
  status: RequestStatus;
  createdAt: string;
  requestedStart?: string;
  requestedEnd?: string;
}

const REQUEST_KIND_LABEL: Record<RequestKind, string> = {
  leave: "請假",
  overtime: "加班",
  clock_correction: "補打卡",
};
const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  draft: "草稿",
  pending: "待審核",
  approved: "已核准",
  rejected: "已駁回",
  cancelled: "已取消",
};
const REQUEST_PAGE_SIZES = [10, 25, 50, 100] as const;

type RequestStatusFilter = "all" | RequestStatus;
interface RequestFilters {
  page: number;
  pageSize: number;
  search: string;
  kind: HistoryKind;
  status: RequestStatusFilter;
}

const DEFAULT_REQUEST_FILTERS: RequestFilters = {
  page: 1,
  pageSize: 25,
  search: "",
  kind: "all",
  status: "all",
};

function statusLabel(status: RequestStatus) {
  return REQUEST_STATUS_LABEL[status];
}

function statusTone(status: RequestStatus): "success" | "warning" | "danger" | "neutral" {
  return status === "approved" ? "success" : status === "pending" ? "warning" : status === "rejected" ? "danger" : "neutral";
}

function taipeiToday() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function taipeiDisplayValue(value: string) {
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  const parts = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(parsed);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

function taipeiInputValue(value: string) {
  const display = taipeiDisplayValue(value);
  return display.includes(" ") ? display.replace(" ", "T") : "";
}

function leaveDisplayValue(value: string, fallbackDate: string) {
  return value ? taipeiDisplayValue(value) : `${fallbackDate} 00:00`;
}

function overtimeDetail(settlementKind: string | null | undefined, requestedStart: string | null | undefined, requestedEnd: string | null | undefined) {
  const settlement = settlementKind === "pay" ? "付薪" : "補休";
  const minutes = (Date.parse(`${(requestedEnd ?? "").replace(" ", "T")}Z`) - Date.parse(`${(requestedStart ?? "").replace(" ", "T")}Z`)) / 60_000;
  return Number.isFinite(minutes) && minutes > 0 ? `${settlement}・${(minutes / 60).toFixed(1)} 小時` : settlement;
}

const LEAVE_UNIT_MINUTES = 30;
const MAX_LEAVE_MINUTES = 31 * 24 * 60;

function toRequestRow(row: HrRequestCenterRow): RequestRow {
  if (row.kind === "leave") {
    return {
      id: row.id,
      kind: row.kind,
      employeeName: row.employeeName ?? "未命名員工",
      employeeNumber: row.employeeNumber ?? "—",
      period: `${leaveDisplayValue(row.startsAt ?? "", row.startsOn ?? "—")}～${leaveDisplayValue(row.endsAt ?? "", row.endsOn ?? "—")}`,
      detail: `${row.leaveType ?? "請假"}・${((row.durationMinutes ?? 0) / 60).toFixed(1)} 小時`,
      reason: row.reason || "—",
      status: row.status,
      createdAt: row.createdAt,
    };
  }
  if (row.kind === "overtime") {
    return {
      id: row.id,
      kind: row.kind,
      employeeName: row.employeeName ?? "未命名員工",
      employeeNumber: row.employeeNumber ?? "—",
      period: `${taipeiDisplayValue(row.requestedStart ?? "")}～${taipeiDisplayValue(row.requestedEnd ?? "")}`,
      detail: overtimeDetail(row.settlementKind, row.requestedStart, row.requestedEnd),
      reason: row.reason || "—",
      status: row.status,
      createdAt: row.createdAt,
      requestedStart: row.requestedStart ?? undefined,
      requestedEnd: row.requestedEnd ?? undefined,
    };
  }
  return {
    id: row.id,
    kind: row.kind,
    employeeName: row.employeeName ?? "未命名員工",
    employeeNumber: row.employeeNumber ?? "—",
    period: row.correctionDate ?? "—",
    detail: row.requestedEventKind === "clock_in" ? `補上班 ${taipeiDisplayValue(row.requestedAt ?? "")}` : `補下班 ${taipeiDisplayValue(row.requestedAt ?? "")}`,
    reason: row.reason || "—",
    status: row.status,
    createdAt: row.createdAt,
  };
}

function toRequestRows(data: HrRequestCenterResponse | undefined): RequestRow[] {
  if (data?.rows) return data.rows.map(toRequestRow);
  const leaves = (data?.leaves ?? []).map(({ request, employeeName, employeeNumber }: HrLeaveRequest) => ({
    id: request.id,
    kind: "leave" as const,
    employeeName: employeeName ?? "未命名員工",
    employeeNumber: employeeNumber ?? "—",
    period: `${leaveDisplayValue(request.startsAt, request.startsOn)}～${leaveDisplayValue(request.endsAt, request.endsOn)}`,
    detail: `${request.leaveType}・${(request.durationMinutes / 60).toFixed(1)} 小時`,
    reason: request.reason || "—",
    status: request.status,
    createdAt: request.createdAt,
  }));
  const overtime = (data?.overtime ?? []).map(({ request, employeeName, employeeNumber }: HrOvertimeRequest) => ({
    id: request.id,
    kind: "overtime" as const,
    employeeName: employeeName ?? "未命名員工",
    employeeNumber: employeeNumber ?? "—",
    period: `${taipeiDisplayValue(request.requestedStart)}～${taipeiDisplayValue(request.requestedEnd)}`,
    detail: overtimeDetail(request.settlementKind, request.requestedStart, request.requestedEnd),
    reason: request.reason || "—",
    status: request.status,
    createdAt: request.createdAt,
    requestedStart: request.requestedStart,
    requestedEnd: request.requestedEnd,
  }));
  const clockCorrections = (data?.clockCorrections ?? []).map((request: FormRequest) => ({
    id: request.id,
    kind: "clock_correction" as const,
    employeeName: request.requesterName ?? "未命名員工",
    employeeNumber: "—",
    period: request.correctionDate,
    detail: request.requestedEventKind === "clock_in" ? `補上班 ${taipeiDisplayValue(request.requestedAt)}` : `補下班 ${taipeiDisplayValue(request.requestedAt)}`,
    reason: request.reason || "—",
    status: request.status,
    createdAt: request.createdAt,
  }));
  return [...leaves, ...overtime, ...clockCorrections].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function ReviewDialog({ row, onClose, onDone }: { row: RequestRow; onClose: () => void; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const [actualStart, setActualStart] = useState(() => row.kind === "overtime" ? taipeiInputValue(row.requestedStart ?? "") : "");
  const [actualEnd, setActualEnd] = useState(() => row.kind === "overtime" ? taipeiInputValue(row.requestedEnd ?? "") : "");
  const review = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const isApprovedCancellable = (row.kind === "leave" || row.kind === "overtime") && row.status === "approved";
  const canCancel = row.kind !== "clock_correction" && (row.status === "pending" || isApprovedCancellable);
  function decide(decision: "approved" | "rejected" | "cancelled") {
    if (decision === "rejected" && !comment.trim()) return;
    const isCancellation = decision === "cancelled";
    const path = isCancellation
      ? row.kind === "leave" ? `/requests/leave/${row.id}/cancel` : `/requests/overtime/${row.id}/cancel`
      : row.kind === "leave" ? `/requests/leave/${row.id}/review` : row.kind === "overtime" ? `/requests/overtime/${row.id}/review` : `/me/form-requests/${row.id}/review`;
    const values: Record<string, unknown> = isCancellation ? {} : { decision, comment };
    if (row.kind === "overtime" && decision === "approved") { values.actualStart = actualStart; values.actualEnd = actualEnd; }
    review.mutate({ path, method: "POST", values }, { onSuccess: () => { onDone(); (closeRequestRef.current ?? onClose)(); } });
  }
  return <Dialog
    title={isApprovedCancellable ? `取消已核准${REQUEST_KIND_LABEL[row.kind]}` : `審核${REQUEST_KIND_LABEL[row.kind]}申請`}
    titleMeta={`${row.employeeName}・${row.employeeNumber}`}
    onClose={onClose}
    closeRequestRef={closeRequestRef}
    closeDisabled={review.isPending}
    actions={<>
      <Button variant="secondary" onClick={onClose}>關閉</Button>
      {canCancel ? <Button variant="secondary" loading={review.isPending} onClick={() => decide("cancelled")}>{isApprovedCancellable ? `取消已核准${REQUEST_KIND_LABEL[row.kind]}` : "取消申請"}</Button> : null}
      {row.status === "pending" ? <><Button variant="danger" loading={review.isPending} onClick={() => decide("rejected")} disabled={!comment.trim()}>駁回</Button><Button loading={review.isPending} onClick={() => decide("approved")}>核准</Button></> : null}
    </>}
  >
    <dl><dt>申請期間</dt><dd>{row.period}</dd><dt>申請內容</dt><dd>{row.detail}</dd><dt>原因</dt><dd>{row.reason}</dd></dl>
    {row.kind === "overtime" && !isApprovedCancellable ? <div className="form-grid two"><Field label="實際開始（台北）" hint="可縮短，不能超出申請時段"><input type="datetime-local" step="1800" value={actualStart} onChange={(event) => setActualStart(event.target.value)} /></Field><Field label="實際結束（台北）"><input type="datetime-local" step="1800" value={actualEnd} onChange={(event) => setActualEnd(event.target.value)} /></Field></div> : null}
    {isApprovedCancellable ? <p className="muted field-note">{row.kind === "overtime" ? "取消後這筆加班會直接刪除，不會留在申請紀錄，也不再納入薪資計算。" : `取消後這筆${REQUEST_KIND_LABEL[row.kind]}不會再納入出勤或薪資計算。`}</p> : <Field label="審核意見" hint="駁回時必填"><textarea rows={4} maxLength={1000} value={comment} onChange={(event) => setComment(event.target.value)} /></Field>}
    {row.kind === "overtime" && row.status === "pending" ? <p className="muted field-note">按「取消申請」會直接刪除這筆加班，不會留在申請紀錄。</p> : null}
    {review.error ? <Alert tone="danger">{review.error.message}</Alert> : null}
  </Dialog>;
}

const REQUEST_FORM_ID = "hr-request-create-form";

interface RequestFormProps {
  /**
   * Dialog 的 footer。按鈕的 loading／disabled 由各表單自己的狀態決定，但表單在會捲動的
   * body 裡；把按鈕 portal 到 footer，長表單（多日月曆）捲動時操作才不會跟著捲走。
   */
  actionsSlot: HTMLElement | null;
  onClose: () => void;
  onDone: () => void;
  onPendingChange: (pending: boolean) => void;
}

function LeaveForm({ employees, leaveTypes, actionsSlot, onClose, onDone, onPendingChange }: { employees: Employee[]; leaveTypes: LeaveType[] } & RequestFormProps) {
  const [employeeUserId, setEmployeeUserId] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [startsAt, setStartsAt] = useState(() => `${taipeiToday()}T09:00`);
  const [endsAt, setEndsAt] = useState(() => `${taipeiToday()}T18:00`);
  const [reason, setReason] = useState("");
  const toast = useToast();
  const write = useHrWrite();
  const employeeOptions = [{ value: "", label: "請選擇員工" }, ...sortHrEmployees(employees.filter(isHrFormalEmployee)).map((employee) => ({ value: employee.userId, label: hrEmployeeLabel(employee) }))];
  const leaveTypeOptions = [{ value: "", label: leaveTypes.length ? "請選擇假別" : "尚未建立假別" }, ...leaveTypes.map((type) => ({ value: type.id, label: `${type.name}${type.leaveKind === "annual" ? "（週年制特休）" : ""}` }))];
  const leaveDuration = useHrLeaveDuration(employeeUserId && startsAt && endsAt ? { employeeUserId, startsAt, endsAt } : null);
  const durationMinutes = leaveDuration.data?.durationMinutes ?? null;
  const durationValid = durationMinutes !== null && durationMinutes >= LEAVE_UNIT_MINUTES && durationMinutes % LEAVE_UNIT_MINUTES === 0 && durationMinutes <= MAX_LEAVE_MINUTES;
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!employeeUserId || !leaveTypeId || leaveDuration.isPending || !durationValid) return;
    onPendingChange(true);
    write.mutate({ path: "/requests/leave", method: "POST", values: { employeeUserId, leaveTypeId, startsAt, endsAt, reason } }, {
      onSuccess: () => {
        onPendingChange(false);
        toast.show("請假申請成功，已回到申請紀錄。", "success");
        onDone();
      },
      onError: () => onPendingChange(false),
    });
  }
  return <form id={REQUEST_FORM_ID} className="hr-request-form" onSubmit={submit}>
    <SelectField label="申請員工" required value={employeeUserId} options={employeeOptions} searchable disabled={write.isPending} onChange={(event) => setEmployeeUserId(event.target.value)} />
    <SelectField label="假別" required value={leaveTypeId} options={leaveTypeOptions} disabled={!leaveTypes.length || write.isPending} onChange={(event) => setLeaveTypeId(event.target.value)} />
    <div className="form-grid two"><TextField label="開始日期與時間（台北）" type="datetime-local" step="1800" required value={startsAt} disabled={write.isPending} onChange={(event) => { const value = event.target.value; setStartsAt(value); if (endsAt && endsAt <= value) setEndsAt(""); }} /><TextField label="結束日期與時間（台北）" type="datetime-local" step="1800" required value={endsAt} min={startsAt} disabled={write.isPending} onChange={(event) => setEndsAt(event.target.value)} /></div>
    <p className="muted field-note">系統依工作日、班表與休息時間計算請假時數：{leaveDuration.isPending ? "計算中…" : leaveDuration.error ? leaveDuration.error.message : durationMinutes !== null && durationValid ? `${(durationMinutes / 60).toFixed(1)} 小時` : durationMinutes !== null && durationMinutes > MAX_LEAVE_MINUTES ? "請假期間不可超過 31 天。" : "請先選擇有效的工作時間。"}</p>
    <Field label="請假原因"><textarea rows={4} maxLength={1000} value={reason} disabled={write.isPending} onChange={(event) => setReason(event.target.value)} /></Field>
    {write.error ? <Alert tone="danger">{write.error.message}</Alert> : null}
    {actionsSlot ? createPortal(<><Button variant="secondary" type="button" onClick={onClose} disabled={write.isPending}>取消</Button><Button type="submit" form={REQUEST_FORM_ID} icon="plus" className="add-action" loading={write.isPending} disabled={!employees.length || !leaveTypes.length || leaveDuration.isPending || !durationValid}>建立請假申請</Button></>, actionsSlot) : null}
  </form>;
}

type OvertimeMode = "single" | "multiple";

const OVERTIME_MODE_OPTIONS = [{ value: "single", label: "單日" }, { value: "multiple", label: "多日" }] as const;
const OVERTIME_PRESET_OPTIONS = OVERTIME_HOUR_PRESETS.map((hours) => ({ value: String(hours), label: `${hours} 小時` }));
const OVERTIME_UNIT_ERROR = "時數要以 0.5 小時為單位，最多 24 小時。";

export function OvertimeForm({ employees, workers, actionsSlot, onClose, onDone, onPendingChange }: { employees: Employee[]; workers: WorkerCandidate[] } & RequestFormProps) {
  const [mode, setMode] = useState<OvertimeMode>("single");
  const [targetKind, setTargetKind] = useState<"employee" | "worker">("employee");
  const [employeeUserId, setEmployeeUserId] = useState("");
  const [workerId, setWorkerId] = useState("");
  const [date, setDate] = useState(taipeiToday);
  const [month, setMonth] = useState(() => taipeiToday().slice(0, 7));
  /** null 代表還沒手動改過，開始時間跟著班表的下班時間走。 */
  const [manualStart, setManualStart] = useState<string | null>(null);
  const [unscheduledStartTime, setUnscheduledStartTime] = useState("");
  const [showUnscheduledConfirmation, setShowUnscheduledConfirmation] = useState(false);
  const [hours, setHours] = useState("1");
  const [assigned, setAssigned] = useState<Record<string, number>>({});
  const [settlementKind, setSettlementKind] = useState<"pay" | "compensatory">("pay");
  const [reason, setReason] = useState("");
  const toast = useToast();
  const write = useHrWrite();
  const employeeOptions = [{ value: "", label: "請選擇員工" }, ...sortHrEmployees(employees.filter(isHrFormalEmployee)).map((employee) => ({ value: employee.userId, label: hrEmployeeLabel(employee) }))];
  const workerOptions = [{ value: "", label: "請選擇支援人員" }, ...workers.map((worker) => ({ value: worker.id, label: worker.displayName }))];
  const targetId = targetKind === "employee" ? employeeUserId : workerId;

  const range = mode === "single" ? (date ? { startsOn: date, endsOn: nextDate(date) } : null) : monthRange(month);
  const daysPath = targetId && range ? `/requests/overtime-days?${new URLSearchParams(targetKind === "employee" ? { employeeUserId, ...range } : { workerId, ...range }).toString()}` : "";
  const dayQuery = useHrQuery<{ days: HrOvertimeDay[] }>(daysPath, Boolean(daysPath), { keepPreviousData: false });
  const days = useMemo(() => (daysPath ? dayQuery.data?.days ?? [] : []).map((day) => ({ date: day.date, startAt: day.shiftEnd ? taipeiInputValue(day.shiftEnd) : null, existing: day.existing })), [dayQuery.data, daysPath]);
  const daysLoading = Boolean(daysPath) && dayQuery.isPending;

  const minutes = parseHours(hours);
  const minutesValid = isValidOvertimeMinutes(minutes);

  // 跨日班的下班時間落在隔天，套進「當天日期＋時間」會早一天，所以只帶入同一天的。
  const singleDay = mode === "single" ? days.find((day) => day.date === date) : undefined;
  const suggestedStart = singleDay?.startAt?.startsWith(date) ? singleDay.startAt.slice(11) : "";
  // 直接衍生，不用 effect 同步：查詢命中快取時下班時間字串可能跟上一天一樣，effect 不會重跑。
  const startEdited = manualStart !== null;
  const startTime = manualStart ?? suggestedStart;
  const start = date && startTime ? `${date}T${startTime}` : "";
  const end = start && minutes !== null ? addMinutes(start, minutes) : "";
  const startHint = !targetId ? "選了申請對象會自動帶入下班時間" : daysLoading ? "查詢班表中…" : suggestedStart ? (startEdited ? `班表下班時間是 ${suggestedStart}` : "已帶入班表的下班時間") : singleDay ? "這天沒有可帶入的下班時間，請自行填寫" : undefined;

  const pickerDays = useMemo(() => days.map((day) => ({ date: day.date, startAt: day.startAt, hasExisting: day.existing.length > 0 })), [days]);
  const entries = mode === "multiple" ? buildOvertimeEntries(days, assigned, unscheduledStartTime) : [];
  const summary = summarizeAssignments(assigned);
  const unscheduledDates = mode === "single"
    ? singleDay?.startAt === null ? [date] : []
    : selectedUnscheduledDates(days, assigned);
  const scheduleLoaded = Boolean(targetId && !daysLoading && dayQuery.data);
  const canSubmit = Boolean(targetId && scheduleLoaded && !dayQuery.error) && (mode === "single" ? Boolean(start) && minutesValid : entries.length > 0 && entries.length === summary.days);

  // 換員工或換日期後，原本帶入的下班時間與選好的日子都屬於上一個班表，留著會送出錯的時段。
  function resetDayDefaults() {
    setManualStart(null);
    setUnscheduledStartTime("");
    setAssigned({});
  }
  function toggleDay(day: string) {
    if (!isValidOvertimeMinutes(minutes)) return;
    setAssigned((current) => {
      const next = { ...current };
      if (next[day] === minutes) delete next[day];
      else next[day] = minutes;
      return next;
    });
  }
  function createRequests() {
    onPendingChange(true);
    write.mutate(buildOvertimeSubmission({ targetKind, employeeUserId, workerId, mode, requestedStart: start, requestedEnd: end, settlementKind, reason, entries }), {
      onSuccess: () => {
        onPendingChange(false);
        toast.show(mode === "single" ? "加班申請成功，已回到申請紀錄。" : `已建立 ${entries.length} 筆加班申請，已回到申請紀錄。`, "success");
        onDone();
      },
      onError: () => onPendingChange(false),
    });
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    if (unscheduledDates.length) {
      setShowUnscheduledConfirmation(true);
      return;
    }
    createRequests();
  }

  const hoursField = <TextField label={mode === "single" ? "加班時數（小時）" : "每天加班時數（小時）"} type="number" inputMode="decimal" min={0.5} max={24} step={0.5} required value={hours} disabled={write.isPending} error={hours.trim() && !minutesValid ? OVERTIME_UNIT_ERROR : undefined} onChange={(event) => setHours(event.target.value)} />;
  const presets = <SegmentedControl className="hr-overtime-presets" aria-label="快速選擇加班時數" value={minutes !== null ? hoursText(minutes) : ""} options={OVERTIME_PRESET_OPTIONS} disabled={write.isPending} onChange={setHours} />;

  return <form id={REQUEST_FORM_ID} className="hr-request-form" onSubmit={submit}>
    <SegmentedControl className="hr-request-kind-tabs" aria-label="申請對象" value={targetKind} options={[{ value: "employee", label: "正式員工" }, { value: "worker", label: "支援人員" }]} disabled={write.isPending} onChange={(value) => { const next = value === "worker" ? "worker" : "employee"; setTargetKind(next); setEmployeeUserId(""); setWorkerId(""); resetDayDefaults(); }} />
    <SelectField label={targetKind === "employee" ? "申請員工" : "申請支援人員"} required value={targetId} options={targetKind === "employee" ? employeeOptions : workerOptions} searchable disabled={write.isPending} onChange={(event) => { if (targetKind === "employee") setEmployeeUserId(event.target.value); else setWorkerId(event.target.value); resetDayDefaults(); }} />
    <SegmentedControl className="hr-request-kind-tabs" aria-label="一次申請幾天" value={mode} options={OVERTIME_MODE_OPTIONS} disabled={write.isPending} onChange={(value) => setMode(value === "multiple" ? "multiple" : "single")} />
    {mode === "single" ? <>
      <div className="form-grid two">
        <TextField label="加班日期" type="date" required value={date} disabled={write.isPending} onChange={(event) => { setDate(event.target.value); resetDayDefaults(); }} />
        <TextField label="開始時間" type="time" step={1800} required value={startTime} disabled={write.isPending} hint={startHint} onChange={(event) => setManualStart(event.target.value)} />
      </div>
      {presets}
      <div className="form-grid two">
        {hoursField}
        <TextField label="結束時間" type="time" step={1800} value={end.slice(11)} disabled={write.isPending || !start} hint={end && end.slice(0, 10) !== date ? "隔天結束" : "改時數或結束時間，另一個會跟著變"} onChange={(event) => { const next = minutesUntil(start, event.target.value); if (next !== null) setHours(hoursText(next)); }} />
      </div>
      {singleDay?.existing.length ? <p className="muted field-note">這天已有加班：{singleDay.existing.map((row) => `${taipeiInputValue(row.requestedStart).slice(11)}～${taipeiInputValue(row.requestedEnd).slice(11)}`).join("、")}，時段不能重疊。</p> : null}
      {dayQuery.error ? <Alert tone="danger">無法確認這天的班表：{dayQuery.error.message}</Alert> : null}
      <p className="hr-overtime-summary" aria-live="polite">{start && minutesValid ? <>共 <strong>{hoursText(minutes)} 小時</strong>・{start.slice(11)}～{end.slice(11)}{end.slice(0, 10) !== date ? "（隔天）" : ""}</> : "填好開始時間與時數後會顯示加班時段。"}</p>
    </> : <>
      <div className="form-grid two">
        <TextField label="月份" type="month" required value={month} disabled={write.isPending} onChange={(event) => { setMonth(event.target.value); resetDayDefaults(); }} />
        {hoursField}
      </div>
      {presets}
      <p className="muted field-note">先選時數，再點日期；再點一次同樣時數就取消。有排班的日期從班表下班時間開始；未排班日期需指定開始時間，送出前會再次確認。</p>
      {!targetId ? <p className="muted table-note">先選申請對象，才看得到這個月的班表。</p>
        : dayQuery.error ? <Alert tone="danger">{dayQuery.error.message}</Alert>
        : daysLoading ? <p className="muted table-note">載入班表…</p>
        : <OvertimeDayPicker days={pickerDays} assigned={assigned} disabled={write.isPending || !minutesValid} onToggle={toggleDay} />}
      {unscheduledDates.length ? <TextField label="未排班日開始時間（台北）" type="time" step={1800} required value={unscheduledStartTime} disabled={write.isPending} hint="所有已選未排班日期都從這個時間開始；有排班日期仍沿用班表下班時間。" onChange={(event) => setUnscheduledStartTime(event.target.value)} /> : null}
      <p className="hr-overtime-summary" aria-live="polite">{summary.days ? <>已選 <strong>{summary.days} 天、共 {hoursText(summary.totalMinutes)} 小時</strong>（{summary.breakdown}）</> : "還沒選任何一天。"}</p>
    </>}
    <SelectField label="結算方式" required value={settlementKind} options={[{ value: "pay", label: "付薪" }, { value: "compensatory", label: "補休" }]} disabled={write.isPending} onChange={(event) => setSettlementKind(event.target.value as "pay" | "compensatory")} />
    <Field label="加班原因（選填）"><textarea rows={3} maxLength={1000} value={reason} disabled={write.isPending} onChange={(event) => setReason(event.target.value)} /></Field>
    {write.error && !showUnscheduledConfirmation ? <Alert tone="danger">{write.error.message}</Alert> : null}
    {actionsSlot ? createPortal(<><Button variant="secondary" type="button" onClick={onClose} disabled={write.isPending}>取消</Button><Button type="submit" form={REQUEST_FORM_ID} icon="plus" className="add-action" loading={write.isPending} disabled={!canSubmit}>{mode === "multiple" && entries.length ? `建立 ${entries.length} 筆加班申請` : "建立加班申請"}</Button></>, actionsSlot) : null}
    {showUnscheduledConfirmation ? <ConfirmDialog
      title="確認未排班日加班"
      confirmLabel="確認建立申請"
      cancelLabel="返回修改"
      tone="primary"
      pending={write.isPending}
      onConfirm={createRequests}
      onCancel={() => setShowUnscheduledConfirmation(false)}
    >
      <p>以下日期未排班，請確認仍有加班安排。未排班日期會從 {mode === "single" ? startTime : unscheduledStartTime} 開始計算；有排班日期仍使用班表下班時間。</p>
      <ul className="hr-overtime-unscheduled-dates">{unscheduledDates.map((day) => <li key={day}>{day}</li>)}</ul>
      {write.error ? <Alert tone="danger">{write.error.message}</Alert> : null}
    </ConfirmDialog> : null}
  </form>;
}

function CreateRequestDialog({ initialKind, employees, workers, leaveTypes, onClose, onDone }: { initialKind: "leave" | "overtime"; employees: Employee[]; workers: WorkerCandidate[]; leaveTypes: LeaveType[]; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<"leave" | "overtime">(initialKind);
  const [pending, setPending] = useState(false);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  return <Dialog title="新增申請" titleMeta="建立後會出現在申請紀錄" className="hr-request-dialog" bodyClassName="hr-request-dialog-body" onClose={onClose} closeDisabled={pending} actions={<div ref={setActionsSlot} className="hr-request-dialog-actions" />}>
    <div className="hr-request-kind-picker">
      <span className="muted">申請類型</span>
      <SegmentedControl
        className="hr-request-kind-tabs"
        aria-label="申請類型"
        value={kind}
        options={[{ value: "leave", label: "請假" }, { value: "overtime", label: "加班" }]}
        disabled={pending}
        onChange={(value) => { if (value === "leave" || value === "overtime") setKind(value); }}
      />
    </div>
    {kind === "leave" ? <LeaveForm employees={employees} leaveTypes={leaveTypes} actionsSlot={actionsSlot} onClose={onClose} onDone={onDone} onPendingChange={setPending} /> : <OvertimeForm employees={employees} workers={workers} actionsSlot={actionsSlot} onClose={onClose} onDone={onDone} onPendingChange={setPending} />}
  </Dialog>;
}

export function HrRequestCenter() {
  usePageTitle("申請與審核");
  const { permissions } = useSession();
  const toast = useToast();
  const canAccess = permissions.has("hr:request:review");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [initialKind] = useState<"leave" | "overtime">(searchParams.get("type") === "overtime" ? "overtime" : "leave");
  const [filters, setFilters] = useState<RequestFilters>(DEFAULT_REQUEST_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [reviewing, setReviewing] = useState<RequestRow | null>(null);
  const [selectedOvertimeIds, setSelectedOvertimeIds] = useState<string[]>([]);
  const [cancelSelectedOpen, setCancelSelectedOpen] = useState(false);
  const employees = useHrQuery<EmployeePageResponse>("/requests/employees", canAccess, { keepPreviousData: false });
  const leaveTypes = useHrQuery<{ leaveTypes: LeaveType[] }>("/requests/leave-types", canAccess, { keepPreviousData: false });
  const workers = useHrQuery<{ workers: WorkerCandidate[] }>("/requests/workers", canAccess, { keepPreviousData: false });
  const requestPath = useMemo(() => {
    const params = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize) });
    const search = filters.search.trim();
    if (search) params.set("search", search);
    if (filters.kind !== "all") params.set("kind", filters.kind);
    if (filters.status !== "all") params.set("status", filters.status);
    return `/requests?${params.toString()}`;
  }, [filters.kind, filters.page, filters.pageSize, filters.search, filters.status]);
  const requests = useHrQuery<HrRequestCenterResponse>(requestPath, canAccess);
  const cancelOvertime = useHrWrite<{ ids: string[]; count: number }>();
  const rows = useMemo(() => toRequestRows(requests.data), [requests.data]);
  const filteredRows = useMemo(() => {
    if (requests.data?.pagination) return rows;
    const term = filters.search.trim().toLocaleLowerCase("zh-TW");
    return rows.filter((row) => {
      if (filters.kind !== "all" && row.kind !== filters.kind) return false;
      if (filters.status !== "all" && row.status !== filters.status) return false;
      if (!term) return true;
      return [
        REQUEST_KIND_LABEL[row.kind],
        row.employeeName,
        row.employeeNumber,
        row.period,
        row.detail,
        row.reason,
        statusLabel(row.status),
      ].some((value) => value.toLocaleLowerCase("zh-TW").includes(term));
    });
  }, [filters.kind, filters.search, filters.status, requests.data?.pagination, rows]);
  const isServerPaged = Boolean(requests.data?.pagination);
  const total = isServerPaged ? requests.data?.pagination?.total ?? 0 : filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  const page = requests.data?.pagination?.page ?? Math.min(filters.page, totalPages);
  const visibleRows = isServerPaged ? rows : filteredRows.slice((page - 1) * filters.pageSize, page * filters.pageSize);
  const loadedPage = requests.data?.pagination?.page;
  const activeFilterCount = [filters.kind, filters.status].filter((value) => value !== "all").length;
  const cancellableOvertimeRows = useMemo(() => visibleRows.filter((row) => row.kind === "overtime" && row.status === "approved"), [visibleRows]);
  const cancellableOvertimeIds = useMemo(() => cancellableOvertimeRows.map((row) => row.id), [cancellableOvertimeRows]);
  const selectedOvertimeRows = cancellableOvertimeRows.filter((row) => selectedOvertimeIds.includes(row.id));
  const selectedVisibleCount = cancellableOvertimeIds.filter((id) => selectedOvertimeIds.includes(id)).length;
  const allVisibleOvertimeSelected = cancellableOvertimeIds.length > 0 && selectedVisibleCount === cancellableOvertimeIds.length;
  const selectAllOvertimeRef = useRef<HTMLInputElement>(null);
  const mobileSelectAllOvertimeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loadedPage) return;
    setFilters((current) => current.page === loadedPage ? current : { ...current, page: loadedPage });
  }, [loadedPage]);

  useEffect(() => {
    const validIds = new Set(cancellableOvertimeIds);
    setSelectedOvertimeIds((current) => current.filter((id) => validIds.has(id)));
  }, [cancellableOvertimeIds]);

  useEffect(() => {
    const indeterminate = selectedVisibleCount > 0 && !allVisibleOvertimeSelected;
    if (selectAllOvertimeRef.current) selectAllOvertimeRef.current.indeterminate = indeterminate;
    if (mobileSelectAllOvertimeRef.current) mobileSelectAllOvertimeRef.current.indeterminate = indeterminate;
  }, [allVisibleOvertimeSelected, selectedVisibleCount]);

  if (!canAccess) return <Alert tone="danger">你沒有檢視 HR 申請的權限。</Alert>;
  if (employees.isPending || leaveTypes.isPending || workers.isPending || requests.isPending) return <HrPageSkeleton variant="table" />;

  function updateFilters(patch: Partial<RequestFilters>) {
    setSelectedOvertimeIds([]);
    setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  function toggleVisibleOvertime(checked: boolean) {
    setSelectedOvertimeIds((current) => checked
      ? [...new Set([...current, ...cancellableOvertimeIds])]
      : current.filter((id) => !cancellableOvertimeIds.includes(id)));
  }

  function cancelSelectedOvertime() {
    if (!selectedOvertimeRows.length || cancelOvertime.isPending) return;
    const ids = selectedOvertimeRows.map((row) => row.id);
    cancelOvertime.mutate({ path: "/requests/overtime/cancel-batch", method: "POST", values: { ids } }, {
      onSuccess: ({ count }) => {
        setSelectedOvertimeIds([]);
        setCancelSelectedOpen(false);
        toast.show(`已取消並刪除 ${count} 筆加班申請，稽核快照已保留。`, "success");
        void requests.refetch();
      },
    });
  }

  function finishCreate() {
    setCreateOpen(false);
    setSelectedOvertimeIds([]);
    setFilters({ ...DEFAULT_REQUEST_FILTERS });
    void navigate("/hr/requests", { replace: true });
    void requests.refetch();
  }

  return <div className="page fills hr-request-page">
    <PageHeader title="申請與審核" description="申請紀錄與待審核項目集中在同一張表格；新增申請請使用右上角按鈕。" actions={<Button icon="plus" className="add-action" onClick={() => setCreateOpen(true)}>新增申請</Button>} />
    <Alert tone="info">核准後才會成為出勤與薪資計算的正式來源。後台代登（含沒有平台帳號的支援人員）會保存「已核准」狀態；正式員工前台申請則由主管或 HR 進行審核。</Alert>
    {employees.error || leaveTypes.error || workers.error ? <Alert tone="danger">{employees.error?.message ?? leaveTypes.error?.message ?? workers.error?.message}</Alert> : null}
    <Panel className="grows hr-request-history-panel" title="申請紀錄" description="包含 HR 後台代登（正式員工與支援人員）及正式員工前台產生的申請；待審核資料可直接在此處理。">
      {requests.error ? <Alert tone="danger">{requests.error.message}</Alert> : null}
      <FilterToolbar className="hr-request-toolbar">
        <SearchFilterInput label="搜尋申請" placeholder="搜尋員工、員工編號、內容或原因" value={filters.search} onSearch={(search) => updateFilters({ search })} />
        <Button variant="secondary" icon="filter" className={`filter-toggle${showFilters ? " active" : ""}`} aria-expanded={showFilters} onClick={() => setShowFilters((open) => !open)}>篩選{activeFilterCount ? <span className="filter-count">{activeFilterCount}</span> : null}</Button>
        {activeFilterCount ? <Button variant="link" onClick={() => updateFilters({ kind: "all", status: "all" })}>清除篩選</Button> : null}
        <div className={`filter-fields${showFilters ? " open" : ""}`}>
          <FilterSelect label="申請類型" value={filters.kind} options={[{ value: "all", label: "全部類型" }, ...Object.entries(REQUEST_KIND_LABEL).map(([value, label]) => ({ value, label }))]} onChange={(event) => updateFilters({ kind: event.target.value as HistoryKind })} />
          <FilterSelect label="狀態" value={filters.status} options={[{ value: "all", label: "全部狀態" }, ...Object.entries(REQUEST_STATUS_LABEL).map(([value, label]) => ({ value, label }))]} onChange={(event) => updateFilters({ status: event.target.value as RequestStatusFilter })} />
        </div>
      </FilterToolbar>
      {requests.isFetching ? <p className="muted table-note">更新中…</p> : null}
      {cancellableOvertimeIds.length ? <div className="hr-request-mobile-select-all"><label className="table-select-all"><input ref={mobileSelectAllOvertimeRef} className="table-checkbox" type="checkbox" checked={allVisibleOvertimeSelected} disabled={requests.isFetching || cancelOvertime.isPending} onChange={(event) => toggleVisibleOvertime(event.target.checked)} aria-label={allVisibleOvertimeSelected ? "取消全選本頁已核准加班" : "全選本頁已核准加班"} /><span>{allVisibleOvertimeSelected ? "取消全選本頁" : "全選本頁已核准加班"}</span></label></div> : null}
      <DataTable className="hr-request-table" containerClassName={requests.isFetching ? "is-refreshing" : ""}>
        <thead><tr>
          <th className="hr-request-select-cell"><input ref={selectAllOvertimeRef} className="table-checkbox" type="checkbox" checked={allVisibleOvertimeSelected} disabled={!cancellableOvertimeIds.length || requests.isFetching || cancelOvertime.isPending} onChange={(event) => toggleVisibleOvertime(event.target.checked)} aria-label={allVisibleOvertimeSelected ? "取消全選本頁已核准加班" : "全選本頁已核准加班"} /></th>
          <th>類型</th><th>員工</th><th>期間</th><th>內容</th><th>原因</th><th>狀態</th><th>操作</th>
        </tr></thead>
        <tbody>{visibleRows.map((row) => {
          const canBulkCancel = row.kind === "overtime" && row.status === "approved";
          return <tr key={`${row.kind}-${row.id}`} className={selectedOvertimeIds.includes(row.id) ? "selected" : undefined}>
            <td data-label="選取" className="hr-request-select-cell">{canBulkCancel ? <label className="hr-request-row-select"><input className="table-checkbox" type="checkbox" checked={selectedOvertimeIds.includes(row.id)} disabled={requests.isFetching || cancelOvertime.isPending} onChange={(event) => setSelectedOvertimeIds((current) => event.target.checked ? [...new Set([...current, row.id])] : current.filter((id) => id !== row.id))} aria-label={`選取 ${row.employeeName} ${row.period} 的已核准加班申請`} /></label> : null}</td>
            <td data-label="類型">{REQUEST_KIND_LABEL[row.kind]}</td>
            <td data-label="員工"><span className="cell-strong">{row.employeeName}</span> <span className="cell-sub">{row.employeeNumber}</span></td>
            <td data-label="期間">{row.period}</td>
            <td data-label="內容"><Tooltip label={row.detail} focusable={false}><span className="hr-request-cell-truncate">{row.detail}</span></Tooltip></td>
            <td data-label="原因"><Tooltip label={row.reason} focusable={false}><span className="hr-request-cell-truncate">{row.reason}</span></Tooltip></td>
            <td data-label="狀態"><StatusBadge tone={statusTone(row.status)}>{statusLabel(row.status)}</StatusBadge></td>
            <td data-label="操作">{row.status === "pending" ? <Button variant="secondary" className="hr-action-info" onClick={() => setReviewing(row)}>審核</Button> : row.kind === "leave" && row.status === "approved" ? <Button variant="secondary" onClick={() => setReviewing(row)}>取消請假</Button> : canBulkCancel ? <Tooltip label="取消並刪除已核准加班申請" focusable={false}><Button variant="icon" icon="trash" className="danger" aria-label={`取消 ${row.employeeName} 的已核准加班申請`} onClick={() => setReviewing(row)} /></Tooltip> : "—"}</td>
          </tr>;
        })}</tbody>
      </DataTable>
      {selectedOvertimeRows.length ? <div className="hr-request-selection-actions" role="status"><span className="hr-request-selection-count" aria-live="polite">已選取 {selectedOvertimeRows.length} 筆加班申請</span><Button variant="danger" icon="trash" disabled={requests.isFetching || cancelOvertime.isPending} onClick={() => { cancelOvertime.reset(); setCancelSelectedOpen(true); }}>取消並刪除所選加班</Button></div> : null}
      {requests.data && !visibleRows.length ? <p className="muted table-note">{total ? "沒有符合條件的申請紀錄，請調整搜尋或篩選。" : "目前沒有申請紀錄。"}</p> : null}
      {total ? <Pager page={page} pageSize={filters.pageSize} pageSizes={REQUEST_PAGE_SIZES} totalPages={totalPages} totalLabel={`共 ${total.toLocaleString("zh-TW")} 筆`} onPage={(nextPage) => { setSelectedOvertimeIds([]); setFilters((current) => ({ ...current, page: nextPage })); }} onPageSize={(pageSize) => updateFilters({ pageSize })} /> : null}
    </Panel>
    {createOpen ? <CreateRequestDialog initialKind={initialKind} employees={employees.data?.employees ?? []} workers={workers.data?.workers ?? []} leaveTypes={leaveTypes.data?.leaveTypes ?? []} onClose={() => setCreateOpen(false)} onDone={finishCreate} /> : null}
    {reviewing ? <ReviewDialog row={reviewing} onClose={() => setReviewing(null)} onDone={() => void requests.refetch()} /> : null}
    {cancelSelectedOpen && selectedOvertimeRows.length ? <ConfirmDialog title={`取消並刪除 ${selectedOvertimeRows.length} 筆加班申請？`} confirmLabel={`取消並刪除 ${selectedOvertimeRows.length} 筆`} pending={cancelOvertime.isPending} onCancel={() => { if (!cancelOvertime.isPending) setCancelSelectedOpen(false); }} onConfirm={cancelSelectedOvertime}>
      <p>選取的都是已核准加班。取消後會從申請紀錄刪除，不再納入薪資計算；HR 稽核紀錄會保留每筆申請的完整快照。</p>
      {cancelOvertime.error ? <Alert tone="danger">{cancelOvertime.error.message}</Alert> : null}
    </ConfirmDialog> : null}
  </div>;
}
