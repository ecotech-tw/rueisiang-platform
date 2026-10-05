import { useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { Pager } from "../../shell/Pager.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, Field, FilterSelect, PageHeader, Panel, SearchFilterInput, SelectField, StatusBadge, TextField } from "../../ui/index.js";
import { hrEmployeeLabel, sortHrEmployees, useHrLeaveDuration, useHrQuery, useHrWrite, type Employee, type FormRequest, type HrLeaveRequest, type HrOvertimeRequest, type HrRequestCenterResponse } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

type RequestKind = "leave" | "overtime" | "clock_correction";
type RequestStatus = "draft" | "pending" | "approved" | "rejected" | "cancelled";
type HistoryKind = "all" | RequestKind;

interface EmployeePageResponse { employees: Employee[] }
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

const LEAVE_UNIT_MINUTES = 30;
const MAX_LEAVE_MINUTES = 31 * 24 * 60;

function toRequestRows(data: HrRequestCenterResponse | undefined): RequestRow[] {
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
  const closeRequestRef = useRef<(() => void) | null>(null);
  const isApprovedCancellable = (row.kind === "leave" || row.kind === "overtime") && row.status === "approved";
  const canCancel = row.kind !== "clock_correction" && (row.status === "pending" || isApprovedCancellable);
  function decide(decision: "approved" | "rejected" | "cancelled") {
    if (decision === "rejected" && !comment.trim()) return;
    const isCancellation = decision === "cancelled";
    const path = isCancellation
      ? row.kind === "leave" ? `/requests/leave/${row.id}/cancel` : `/requests/overtime/${row.id}/cancel`
      : row.kind === "leave" ? `/requests/leave/${row.id}/review` : row.kind === "overtime" ? `/overtime/${row.id}/review` : `/me/form-requests/${row.id}/review`;
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
    {row.kind === "overtime" && !isApprovedCancellable ? <div className="form-grid two"><Field label="實際開始（台北）" hint="可縮短，不能超出申請時段"><input type="datetime-local" step="60" value={actualStart} onChange={(event) => setActualStart(event.target.value)} /></Field><Field label="實際結束（台北）"><input type="datetime-local" step="60" value={actualEnd} onChange={(event) => setActualEnd(event.target.value)} /></Field></div> : null}
    {isApprovedCancellable ? <p className="muted field-note">取消後這筆{REQUEST_KIND_LABEL[row.kind]}不會再納入出勤或薪資計算。</p> : <Field label="審核意見" hint="駁回時必填"><textarea rows={4} maxLength={1000} value={comment} onChange={(event) => setComment(event.target.value)} /></Field>}
    {review.error ? <Alert tone="danger">{review.error.message}</Alert> : null}
  </Dialog>;
}

interface RequestFormProps {
  onClose: () => void;
  onDone: () => void;
  onPendingChange: (pending: boolean) => void;
}

function LeaveForm({ employees, leaveTypes, onClose, onDone, onPendingChange }: { employees: Employee[]; leaveTypes: LeaveType[] } & RequestFormProps) {
  const [employeeUserId, setEmployeeUserId] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [startsAt, setStartsAt] = useState(() => `${taipeiToday()}T09:00`);
  const [endsAt, setEndsAt] = useState(() => `${taipeiToday()}T18:00`);
  const [reason, setReason] = useState("");
  const toast = useToast();
  const write = useHrWrite();
  const employeeOptions = [{ value: "", label: "請選擇員工" }, ...sortHrEmployees(employees).map((employee) => ({ value: employee.userId, label: hrEmployeeLabel(employee) }))];
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
  return <form className="hr-request-form" onSubmit={submit}>
    <SelectField label="申請員工" required value={employeeUserId} options={employeeOptions} searchable disabled={write.isPending} onChange={(event) => setEmployeeUserId(event.target.value)} />
    <SelectField label="假別" required value={leaveTypeId} options={leaveTypeOptions} disabled={!leaveTypes.length || write.isPending} onChange={(event) => setLeaveTypeId(event.target.value)} />
    <div className="form-grid two"><TextField label="開始日期與時間（台北）" type="datetime-local" step="1800" required value={startsAt} disabled={write.isPending} onChange={(event) => { const value = event.target.value; setStartsAt(value); if (endsAt && endsAt <= value) setEndsAt(""); }} /><TextField label="結束日期與時間（台北）" type="datetime-local" step="1800" required value={endsAt} min={startsAt} disabled={write.isPending} onChange={(event) => setEndsAt(event.target.value)} /></div>
    <p className="muted field-note">系統依工作日、班表與休息時間計算請假時數：{leaveDuration.isPending ? "計算中…" : leaveDuration.error ? leaveDuration.error.message : durationMinutes !== null && durationValid ? `${(durationMinutes / 60).toFixed(1)} 小時` : durationMinutes !== null && durationMinutes > MAX_LEAVE_MINUTES ? "請假期間不可超過 31 天。" : "請先選擇有效的工作時間。"}</p>
    <Field label="請假原因"><textarea rows={4} maxLength={1000} value={reason} disabled={write.isPending} onChange={(event) => setReason(event.target.value)} /></Field>
    <div className="button-row"><Button variant="secondary" type="button" onClick={onClose} disabled={write.isPending}>取消</Button><Button type="submit" icon="plus" loading={write.isPending} disabled={!employees.length || !leaveTypes.length || leaveDuration.isPending || !durationValid}>建立請假申請</Button></div>
    {write.error ? <Alert tone="danger">{write.error.message}</Alert> : null}
  </form>;
}

function OvertimeForm({ employees, onClose, onDone, onPendingChange }: { employees: Employee[] } & RequestFormProps) {
  const [employeeUserId, setEmployeeUserId] = useState("");
  const [requestedStart, setRequestedStart] = useState("");
  const [requestedEnd, setRequestedEnd] = useState("");
  const [settlementKind, setSettlementKind] = useState<"pay" | "compensatory">("pay");
  const [reason, setReason] = useState("");
  const toast = useToast();
  const write = useHrWrite();
  const employeeOptions = [{ value: "", label: "請選擇員工" }, ...sortHrEmployees(employees).map((employee) => ({ value: employee.userId, label: hrEmployeeLabel(employee) }))];
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!employeeUserId || !requestedStart || !requestedEnd) return;
    onPendingChange(true);
    write.mutate({ path: "/requests/overtime", method: "POST", values: { employeeUserId, requestedStart, requestedEnd, settlementKind, reason } }, {
      onSuccess: () => {
        onPendingChange(false);
        toast.show("加班申請成功，已回到申請紀錄。", "success");
        onDone();
      },
      onError: () => onPendingChange(false),
    });
  }
  return <form className="hr-request-form" onSubmit={submit}>
    <SelectField label="申請員工" required value={employeeUserId} options={employeeOptions} searchable disabled={write.isPending} onChange={(event) => setEmployeeUserId(event.target.value)} />
    <div className="form-grid two"><TextField label="加班開始" type="datetime-local" required value={requestedStart} disabled={write.isPending} onChange={(event) => setRequestedStart(event.target.value)} /><TextField label="加班結束" type="datetime-local" required min={requestedStart} value={requestedEnd} disabled={write.isPending} onChange={(event) => setRequestedEnd(event.target.value)} /></div>
    <SelectField label="結算方式" required value={settlementKind} options={[{ value: "pay", label: "付薪" }, { value: "compensatory", label: "補休" }]} disabled={write.isPending} onChange={(event) => setSettlementKind(event.target.value as "pay" | "compensatory")} />
    <Field label="加班原因（選填）"><textarea rows={4} maxLength={1000} value={reason} disabled={write.isPending} onChange={(event) => setReason(event.target.value)} /></Field>
    <div className="button-row"><Button variant="secondary" type="button" onClick={onClose} disabled={write.isPending}>取消</Button><Button type="submit" icon="plus" loading={write.isPending} disabled={!employees.length}>建立加班申請</Button></div>
    {write.error ? <Alert tone="danger">{write.error.message}</Alert> : null}
  </form>;
}

function CreateRequestDialog({ initialKind, employees, leaveTypes, onClose, onDone }: { initialKind: "leave" | "overtime"; employees: Employee[]; leaveTypes: LeaveType[]; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<"leave" | "overtime">(initialKind);
  const [pending, setPending] = useState(false);
  return <Dialog title="新增申請" titleMeta="建立後會出現在申請紀錄" className="hr-request-dialog" bodyClassName="hr-request-dialog-body" onClose={onClose} closeDisabled={pending}>
    <div className="hr-request-kind-picker">
      <span className="muted">申請類型</span>
      <div className="segmented-control hr-request-kind-tabs" role="group" aria-label="申請類型">
        <button type="button" className={kind === "leave" ? "selected" : ""} aria-pressed={kind === "leave"} disabled={pending} onClick={() => setKind("leave")}>請假</button>
        <button type="button" className={kind === "overtime" ? "selected" : ""} aria-pressed={kind === "overtime"} disabled={pending} onClick={() => setKind("overtime")}>加班</button>
      </div>
    </div>
    {kind === "leave" ? <LeaveForm employees={employees} leaveTypes={leaveTypes} onClose={onClose} onDone={onDone} onPendingChange={setPending} /> : <OvertimeForm employees={employees} onClose={onClose} onDone={onDone} onPendingChange={setPending} />}
  </Dialog>;
}

export function HrRequestCenter() {
  usePageTitle("申請與審核");
  const { permissions } = useSession();
  const canAccess = permissions.has("hr:request:review");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [initialKind] = useState<"leave" | "overtime">(searchParams.get("type") === "overtime" ? "overtime" : "leave");
  const [filters, setFilters] = useState<RequestFilters>(DEFAULT_REQUEST_FILTERS);
  const [reviewing, setReviewing] = useState<RequestRow | null>(null);
  const employees = useHrQuery<EmployeePageResponse>("/requests/employees", canAccess, { keepPreviousData: false });
  const leaveTypes = useHrQuery<{ leaveTypes: LeaveType[] }>("/requests/leave-types", canAccess, { keepPreviousData: false });
  const requests = useHrQuery<HrRequestCenterResponse>("/requests", canAccess, { keepPreviousData: false });
  const rows = useMemo(() => toRequestRows(requests.data), [requests.data]);
  const filteredRows = useMemo(() => {
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
  }, [filters.kind, filters.search, filters.status, rows]);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / filters.pageSize));
  const page = Math.min(filters.page, totalPages);
  const visibleRows = filteredRows.slice((page - 1) * filters.pageSize, page * filters.pageSize);
  const activeFilterCount = [filters.kind, filters.status].filter((value) => value !== "all").length;

  if (!canAccess) return <Alert tone="danger">你沒有檢視 HR 申請的權限。</Alert>;
  if (employees.isPending || leaveTypes.isPending || requests.isPending) return <HrPageSkeleton variant="table" />;

  function updateFilters(patch: Partial<RequestFilters>) {
    setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  function finishCreate() {
    setCreateOpen(false);
    setFilters({ ...DEFAULT_REQUEST_FILTERS });
    void navigate("/hr/requests", { replace: true });
    void requests.refetch();
  }

  return <div className="page fills hr-request-page">
    <PageHeader title="申請與審核" description="申請紀錄與待審核項目集中在同一張表格；新增申請請使用右上角按鈕。" actions={<Button icon="plus" className="add-action" onClick={() => setCreateOpen(true)}>新增申請</Button>} />
    <Alert tone="info">核准後才會成為出勤與薪資計算的正式來源。後台代登目前會保存「已核准」狀態；員工前台上線後則由主管或 HR 進行審核。</Alert>
    {employees.error || leaveTypes.error ? <Alert tone="danger">{employees.error?.message ?? leaveTypes.error?.message}</Alert> : null}
    <Panel className="grows hr-request-history-panel" title="申請紀錄" description="包含 HR 後台代登與未來員工前台產生的申請；待審核資料可直接在此處理。">
      {requests.error ? <Alert tone="danger">{requests.error.message}</Alert> : null}
      <form className="admin-form toolbar hr-request-toolbar" onSubmit={(event) => event.preventDefault()}>
        <SearchFilterInput label="搜尋申請" placeholder="搜尋員工、員工編號、內容或原因" value={filters.search} onSearch={(search) => updateFilters({ search })} />
        <FilterSelect label="申請類型" value={filters.kind} options={[{ value: "all", label: "全部類型" }, ...Object.entries(REQUEST_KIND_LABEL).map(([value, label]) => ({ value, label }))]} onChange={(event) => updateFilters({ kind: event.target.value as HistoryKind })} />
        <FilterSelect label="狀態" value={filters.status} options={[{ value: "all", label: "全部狀態" }, ...Object.entries(REQUEST_STATUS_LABEL).map(([value, label]) => ({ value, label }))]} onChange={(event) => updateFilters({ status: event.target.value as RequestStatusFilter })} />
        {activeFilterCount ? <Button variant="link" onClick={() => updateFilters({ kind: "all", status: "all" })}>清除篩選</Button> : null}
      </form>
      {requests.isFetching ? <p className="muted table-note">更新中…</p> : null}
      <div className={`table-scroll${requests.isFetching ? " is-refreshing" : ""}`}><table className="data-table hr-request-table"><thead><tr><th>類型</th><th>員工</th><th>期間</th><th>內容</th><th>原因</th><th>狀態</th><th>操作</th></tr></thead><tbody>{visibleRows.map((row) => <tr key={`${row.kind}-${row.id}`}><td data-label="類型">{REQUEST_KIND_LABEL[row.kind]}</td><td data-label="員工"><span className="cell-strong">{row.employeeName}</span> <span className="cell-sub">{row.employeeNumber}</span></td><td data-label="期間">{row.period}</td><td data-label="內容">{row.detail}</td><td data-label="原因">{row.reason}</td><td data-label="狀態"><StatusBadge tone={statusTone(row.status)}>{statusLabel(row.status)}</StatusBadge></td><td data-label="操作">{row.status === "pending" ? <Button variant="secondary" onClick={() => setReviewing(row)}>審核</Button> : (row.kind === "leave" || row.kind === "overtime") && row.status === "approved" ? <Button variant="secondary" onClick={() => setReviewing(row)}>取消{REQUEST_KIND_LABEL[row.kind]}</Button> : "—"}</td></tr>)}</tbody></table></div>
      {requests.data && !filteredRows.length ? <p className="muted table-note">{rows.length ? "沒有符合條件的申請紀錄，請調整搜尋或篩選。" : "目前沒有申請紀錄。"}</p> : null}
      {filteredRows.length ? <Pager page={page} pageSize={filters.pageSize} pageSizes={REQUEST_PAGE_SIZES} totalPages={totalPages} totalLabel={`共 ${filteredRows.length.toLocaleString("zh-TW")} 筆`} onPage={(nextPage) => setFilters((current) => ({ ...current, page: nextPage }))} onPageSize={(pageSize) => updateFilters({ pageSize })} /> : null}
    </Panel>
    {createOpen ? <CreateRequestDialog initialKind={initialKind} employees={employees.data?.employees ?? []} leaveTypes={leaveTypes.data?.leaveTypes ?? []} onClose={() => setCreateOpen(false)} onDone={finishCreate} /> : null}
    {reviewing ? <ReviewDialog row={reviewing} onClose={() => setReviewing(null)} onDone={() => void requests.refetch()} /> : null}
  </div>;
}
