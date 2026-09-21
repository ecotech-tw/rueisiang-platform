import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, Field, PageHeader, Panel, SelectField, StatusBadge, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type Employee, type FormRequest, type HrLeaveRequest, type HrOvertimeRequest, type HrRequestCenterResponse } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

type RequestKind = "leave" | "overtime" | "clock_correction";
type RequestStatus = "draft" | "pending" | "approved" | "rejected" | "cancelled";
type HistoryKind = "all" | RequestKind;

interface EmployeePageResponse { employees: Employee[] }
interface LeaveType { id: string; name: string; defaultPayRatePpm: number }

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

function statusLabel(status: RequestStatus) {
  return status === "pending" ? "待審核" : status === "approved" ? "已核准" : status === "rejected" ? "已駁回" : status === "cancelled" ? "已取消" : "草稿";
}

function statusTone(status: RequestStatus): "success" | "warning" | "danger" | "neutral" {
  return status === "approved" ? "success" : status === "pending" ? "warning" : status === "rejected" ? "danger" : "neutral";
}

function taipeiToday() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function previousDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? value : new Date(parsed.getTime() - 86_400_000).toISOString().slice(0, 10);
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

function toRequestRows(data: HrRequestCenterResponse | undefined): RequestRow[] {
  const leaves = (data?.leaves ?? []).map(({ request, employeeName, employeeNumber }: HrLeaveRequest) => ({
    id: request.id,
    kind: "leave" as const,
    employeeName: employeeName ?? "未命名員工",
    employeeNumber: employeeNumber ?? "—",
    period: `${request.startsOn}～${previousDate(request.endsOn)}`,
    detail: `${request.leaveType}・${(request.durationMinutes / 60).toFixed(1)} 小時・給薪 ${(request.payRatePpm / 10_000).toFixed(2)}%`,
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
    detail: request.settlementKind === "pay" ? "付薪" : "補休",
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
  const canCancel = row.kind !== "clock_correction";
  function decide(decision: "approved" | "rejected" | "cancelled") {
    if (decision === "rejected" && !comment.trim()) return;
    const path = row.kind === "leave" ? `/requests/leave/${row.id}/review` : row.kind === "overtime" ? `/overtime/${row.id}/review` : `/me/form-requests/${row.id}/review`;
    const values: Record<string, unknown> = { decision, comment };
    if (row.kind === "overtime" && decision === "approved") { values.actualStart = actualStart; values.actualEnd = actualEnd; }
    review.mutate({ path, method: "POST", values }, { onSuccess: () => { onDone(); onClose(); } });
  }
  return <Dialog
    title={`審核${REQUEST_KIND_LABEL[row.kind]}申請`}
    titleMeta={`${row.employeeName}・${row.employeeNumber}`}
    onClose={onClose}
    closeDisabled={review.isPending}
    actions={<>
      <Button variant="secondary" onClick={onClose}>取消</Button>
      {canCancel ? <Button variant="secondary" loading={review.isPending} onClick={() => decide("cancelled")}>取消申請</Button> : null}
      <Button variant="danger" loading={review.isPending} onClick={() => decide("rejected")} disabled={!comment.trim()}>駁回</Button>
      <Button loading={review.isPending} onClick={() => decide("approved")}>核准</Button>
    </>}
  >
    <dl><dt>申請期間</dt><dd>{row.period}</dd><dt>申請內容</dt><dd>{row.detail}</dd><dt>原因</dt><dd>{row.reason}</dd></dl>
    {row.kind === "overtime" ? <div className="form-grid two"><Field label="實際開始（台北）" hint="可縮短，不能超出申請時段"><input type="datetime-local" step="60" value={actualStart} onChange={(event) => setActualStart(event.target.value)} /></Field><Field label="實際結束（台北）"><input type="datetime-local" step="60" value={actualEnd} onChange={(event) => setActualEnd(event.target.value)} /></Field></div> : null}
    <Field label="審核意見" hint="駁回時必填"><textarea rows={4} maxLength={1000} value={comment} onChange={(event) => setComment(event.target.value)} /></Field>
    {review.error ? <Alert tone="danger">{review.error.message}</Alert> : null}
  </Dialog>;
}

function LeaveForm({ employees, leaveTypes, onDone }: { employees: Employee[]; leaveTypes: LeaveType[]; onDone: () => void }) {
  const [employeeUserId, setEmployeeUserId] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [startDate, setStartDate] = useState(taipeiToday);
  const [endDate, setEndDate] = useState(taipeiToday);
  const [hours, setHours] = useState("8");
  const [payRate, setPayRate] = useState("100");
  const [reason, setReason] = useState("");
  const write = useHrWrite();
  const employeeOptions = [{ value: "", label: "請選擇員工" }, ...employees.map((employee) => ({ value: employee.userId, label: `${employee.displayName}（${employee.employeeNumber}）` }))];
  const leaveTypeOptions = [{ value: "", label: leaveTypes.length ? "請選擇假別" : "尚未建立假別" }, ...leaveTypes.map((type) => ({ value: type.id, label: type.name }))];
  function submit(event: React.FormEvent) {
    event.preventDefault();
    const durationMinutes = Math.round(Number(hours) * 60);
    if (!employeeUserId || !leaveTypeId || !Number.isFinite(durationMinutes) || durationMinutes < 30 || durationMinutes % 30 !== 0 || endDate < startDate) return;
    write.mutate({ path: "/requests/leave", method: "POST", values: { employeeUserId, leaveTypeId, startDate, endDate, durationMinutes, payRatePpm: Math.round(Number(payRate) * 10_000), reason } }, { onSuccess: () => { setReason(""); onDone(); } });
  }
  return <form className="hr-request-form" onSubmit={submit}>
    <SelectField label="申請員工" required value={employeeUserId} options={employeeOptions} onChange={(event) => setEmployeeUserId(event.target.value)} />
    <SelectField label="假別" required value={leaveTypeId} options={leaveTypeOptions} disabled={!leaveTypes.length} onChange={(event) => { const value = event.target.value; setLeaveTypeId(value); const type = leaveTypes.find((item) => item.id === value); if (type) setPayRate(String(type.defaultPayRatePpm / 10_000)); }} />
    <div className="form-grid two"><TextField label="開始日期" type="date" required value={startDate} onChange={(event) => { setStartDate(event.target.value); if (endDate < event.target.value) setEndDate(event.target.value); }} /><TextField label="結束日期" type="date" required value={endDate} min={startDate} onChange={(event) => setEndDate(event.target.value)} /></div>
    <div className="form-grid two"><TextField label="請假時數" hint="以 0.5 小時為單位" type="number" min="0.5" step="0.5" required value={hours} onChange={(event) => setHours(event.target.value)} /><TextField label="給薪比例（%）" type="number" min="0" max="100" step="0.01" required value={payRate} onChange={(event) => setPayRate(event.target.value)} /></div>
    <Field label="請假原因"><textarea rows={4} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
    <div className="button-row"><Button type="submit" icon="plus" loading={write.isPending} disabled={!employees.length || !leaveTypes.length}>建立請假申請</Button></div>
    {write.error ? <Alert tone="danger">{write.error.message}</Alert> : null}
  </form>;
}

function OvertimeForm({ employees, onDone }: { employees: Employee[]; onDone: () => void }) {
  const [employeeUserId, setEmployeeUserId] = useState("");
  const [requestedStart, setRequestedStart] = useState("");
  const [requestedEnd, setRequestedEnd] = useState("");
  const [settlementKind, setSettlementKind] = useState<"pay" | "compensatory">("pay");
  const [reason, setReason] = useState("");
  const write = useHrWrite();
  const employeeOptions = [{ value: "", label: "請選擇員工" }, ...employees.map((employee) => ({ value: employee.userId, label: `${employee.displayName}（${employee.employeeNumber}）` }))];
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!employeeUserId || !requestedStart || !requestedEnd || !reason.trim()) return;
    write.mutate({ path: "/requests/overtime", method: "POST", values: { employeeUserId, requestedStart, requestedEnd, settlementKind, reason } }, { onSuccess: () => { setReason(""); onDone(); } });
  }
  return <form className="hr-request-form" onSubmit={submit}>
    <SelectField label="申請員工" required value={employeeUserId} options={employeeOptions} onChange={(event) => setEmployeeUserId(event.target.value)} />
    <div className="form-grid two"><TextField label="加班開始" type="datetime-local" required value={requestedStart} onChange={(event) => setRequestedStart(event.target.value)} /><TextField label="加班結束" type="datetime-local" required min={requestedStart} value={requestedEnd} onChange={(event) => setRequestedEnd(event.target.value)} /></div>
    <SelectField label="結算方式" required value={settlementKind} options={[{ value: "pay", label: "付薪" }, { value: "compensatory", label: "補休" }]} onChange={(event) => setSettlementKind(event.target.value as "pay" | "compensatory")} />
    <Field label="加班原因" required><textarea rows={4} maxLength={1000} required value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
    <div className="button-row"><Button type="submit" icon="plus" loading={write.isPending} disabled={!employees.length}>建立加班申請</Button></div>
    {write.error ? <Alert tone="danger">{write.error.message}</Alert> : null}
  </form>;
}

export function HrRequestCenter() {
  usePageTitle("申請與審核");
  const { permissions } = useSession();
  const canAccess = permissions.has("hr:request:review");
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<"new" | "history">("new");
  const [kind, setKind] = useState<"leave" | "overtime">(searchParams.get("type") === "overtime" ? "overtime" : "leave");
  const [historyKind, setHistoryKind] = useState<HistoryKind>("all");
  const [reviewing, setReviewing] = useState<RequestRow | null>(null);
  const employees = useHrQuery<EmployeePageResponse>("/requests/employees", canAccess, { keepPreviousData: false });
  const leaveTypes = useHrQuery<{ leaveTypes: LeaveType[] }>("/requests/leave-types", canAccess, { keepPreviousData: false });
  const requests = useHrQuery<HrRequestCenterResponse>("/requests", canAccess, { keepPreviousData: false });
  const rows = useMemo(() => toRequestRows(requests.data), [requests.data]);
  const filteredRows = historyKind === "all" ? rows : rows.filter((row) => row.kind === historyKind);

  if (!canAccess) return <Alert tone="danger">你沒有檢視 HR 申請的權限。</Alert>;
  if (employees.isPending || leaveTypes.isPending || requests.isPending) return <HrPageSkeleton variant="table" />;

  return <div className="page fills hr-request-page">
    <PageHeader title="申請與審核" description="申請中心獨立於儀表板、員工與出勤資料頁；目前 HR 代登送出後直接核准，未來員工前台可沿用同一套待審核流程。" />
    <Alert tone="info">核准後才會成為出勤與薪資計算的正式來源。後台代登目前會保存「已核准」狀態；員工前台上線後則由主管或 HR 進行審核。</Alert>
    <div className="segmented-control hr-request-view-tabs" role="group" aria-label="申請中心工作區">
      <button type="button" className={view === "new" ? "selected" : ""} aria-pressed={view === "new"} onClick={() => setView("new")}>新增申請</button>
      <button type="button" className={view === "history" ? "selected" : ""} aria-pressed={view === "history"} onClick={() => setView("history")}>申請紀錄</button>
    </div>
    {view === "new" ? <div className="hr-request-layout">
      <Panel title="建立申請" description="先選擇申請類型，再指定員工與實際期間。">
        <div className="segmented-control hr-request-kind-tabs" role="group" aria-label="申請類型">
          <button type="button" className={kind === "leave" ? "selected" : ""} aria-pressed={kind === "leave"} onClick={() => setKind("leave")}>請假</button>
          <button type="button" className={kind === "overtime" ? "selected" : ""} aria-pressed={kind === "overtime"} onClick={() => setKind("overtime")}>加班</button>
        </div>
        {employees.error || leaveTypes.error ? <Alert tone="danger">{employees.error?.message ?? leaveTypes.error?.message}</Alert> : null}
        {kind === "leave" ? <LeaveForm employees={employees.data?.employees ?? []} leaveTypes={leaveTypes.data?.leaveTypes ?? []} onDone={() => { setView("history"); void requests.refetch(); }} /> : <OvertimeForm employees={employees.data?.employees ?? []} onDone={() => { setView("history"); void requests.refetch(); }} />}
      </Panel>
      <Panel title="流程說明" className="hr-request-process-panel">
        <ol className="hr-request-process"><li><strong>選擇員工</strong><span>申請資料以員工任職紀錄為主體保存。</span></li><li><strong>建立申請</strong><span>HR 後台目前直接建立為已核准，保留建立者與核准資訊。</span></li><li><strong>影響出勤</strong><span>請假與核准加班會被後續出勤、薪資查詢讀取。</span></li><li><strong>未來前台</strong><span>本人入口改為待審核，審核後才進入同一個正式結果。</span></li></ol>
      </Panel>
    </div> : <Panel className="grows hr-request-history-panel" title="申請紀錄" description="包含 HR 後台代登與未來員工前台產生的申請；待審核資料可在此處理。" actions={<div className="hr-request-history-filter" role="group" aria-label="申請類型篩選">{(["all", "leave", "overtime", "clock_correction"] as const).map((value) => <button type="button" key={value} className={historyKind === value ? "selected" : ""} aria-pressed={historyKind === value} onClick={() => setHistoryKind(value)}>{value === "all" ? "全部" : REQUEST_KIND_LABEL[value]}</button>)}</div>}>
      {requests.error ? <Alert tone="danger">{requests.error.message}</Alert> : null}
      <div className="table-scroll"><table className="data-table"><thead><tr><th>類型</th><th>員工</th><th>期間</th><th>內容</th><th>原因</th><th>狀態</th><th>操作</th></tr></thead><tbody>{filteredRows.map((row) => <tr key={`${row.kind}-${row.id}`}><td data-label="類型">{REQUEST_KIND_LABEL[row.kind]}</td><td data-label="員工">{row.employeeName}<small className="muted">{row.employeeNumber}</small></td><td data-label="期間">{row.period}</td><td data-label="內容">{row.detail}</td><td data-label="原因">{row.reason}</td><td data-label="狀態"><StatusBadge tone={statusTone(row.status)}>{statusLabel(row.status)}</StatusBadge></td><td data-label="操作">{row.status === "pending" ? <Button variant="secondary" onClick={() => setReviewing(row)}>審核</Button> : "—"}</td></tr>)}</tbody></table></div>
      {!filteredRows.length ? <p className="empty-state">目前沒有符合條件的申請紀錄。</p> : null}
    </Panel>}
    {reviewing ? <ReviewDialog row={reviewing} onClose={() => setReviewing(null)} onDone={() => void requests.refetch()} /> : null}
  </div>;
}
