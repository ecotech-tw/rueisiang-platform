import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, Field, PageHeader, Panel, SelectField, SegmentedControl, StatusBadge, TextField, Tooltip } from "../../ui/index.js";
import { useHrLeaveDuration, useHrQuery, useHrWrite, type FormApproversResponse, type FormRequest, type FormRequestStatus, type LeaveRequest, type LeaveTypeOption, type LeaveTypesResponse, type OvertimeRequest } from "./api.js";

const statusCopy: Record<FormRequestStatus, { label: string; tone: "neutral" | "info" | "success" | "danger" }> = {
  draft: { label: "草稿", tone: "neutral" },
  pending: { label: "申請中", tone: "info" },
  approved: { label: "已核准", tone: "success" },
  rejected: { label: "已駁回", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" },
};

function formatTaipei(value: string | null) {
  if (!value) return "—";
  const date = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "medium", timeStyle: "short" }).format(date);
}

function taipeiInputNow() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour").replace("24", "00")}:${part("minute")}` };
}

function taipeiInputFromUtc(value: string) {
  const date = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return taipeiInputNow();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour").replace("24", "00")}:${part("minute")}` };
}

type FormTab = "leave" | "overtime" | "clock_correction";
type RequestStatusFilter = "all" | "draft" | "pending" | "approved" | "rejected" | "cancelled";

const FORM_TAB_OPTIONS: readonly { value: FormTab; label: string }[] = [
  { value: "leave", label: "請假" },
  { value: "overtime", label: "加班" },
  { value: "clock_correction", label: "補打卡" },
];

const REQUEST_STATUS_OPTIONS: readonly { value: RequestStatusFilter; label: string }[] = [
  { value: "all", label: "全部狀態" },
  { value: "pending", label: "申請中" },
  { value: "approved", label: "已核准" },
  { value: "rejected", label: "已駁回" },
  { value: "cancelled", label: "已取消" },
  { value: "draft", label: "草稿" },
];

function formTab(value: string | null): FormTab {
  return value === "overtime" || value === "clock_correction" ? value : "leave";
}

function requestStatusLabel(status: RequestStatusFilter) {
  return status === "pending" ? "審核中" : status === "approved" ? "已核准" : status === "rejected" ? "已駁回" : status === "cancelled" ? "已取消" : status === "draft" ? "草稿" : "全部狀態";
}

function requestBadgeCount(statuses: readonly string[] | undefined) {
  return statuses?.filter((status) => status !== "approved" && status !== "cancelled").length ?? 0;
}

function requestBadgeLabel(count: number) {
  return count > 99 ? "99+" : String(count);
}

function matchesRequest(searchText: string, status: string, search: string, statusFilter: RequestStatusFilter) {
  const normalizedSearch = search.trim().toLocaleLowerCase("zh-TW");
  return (statusFilter === "all" || status === statusFilter)
    && (!normalizedSearch || searchText.toLocaleLowerCase("zh-TW").includes(normalizedSearch));
}

function FormPageHeader({ title, description, returnTo = "/forms" }: { title: string; description: string; returnTo?: string }) {
  const navigate = useNavigate();
  return <>
    <div className="hr-form-back-bar">
      <Button variant="link" icon="chevronLeft" className="hr-form-back-button" onClick={() => navigate(returnTo, { state: { transition: "back" } })}>返回表單</Button>
    </div>
    <PageHeader title={title} description={description} />
  </>;
}

function formLabel(request: FormRequest) {
  return `${request.correctionDate} ${request.requestedEventKind === "clock_in" ? "上班" : "下班"}補打卡`;
}

function formatHours(minutes: number) {
  return `${(minutes / 60).toFixed(1)} 小時`;
}

function dateBefore(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function leavePeriod(item: LeaveRequest) {
  const start = item.request.startsAt ? formatTaipei(item.request.startsAt) : item.request.startsOn;
  const end = item.request.endsAt ? formatTaipei(item.request.endsAt) : dateBefore(item.request.endsOn);
  return `${start}～${end}`;
}

function leaveStatus(status: LeaveRequest["request"]["status"]) {
  return status === "pending" ? { label: "審核中", tone: "info" as const }
    : status === "approved" ? { label: "已核准", tone: "success" as const }
      : status === "rejected" ? { label: "已駁回", tone: "danger" as const }
        : status === "cancelled" ? { label: "已取消", tone: "neutral" as const }
          : { label: "草稿", tone: "neutral" as const };
}

function RequestSummary({ request, reviewer = false }: { request: FormRequest; reviewer?: boolean }) {
  const status = statusCopy[request.status];
  return <div className="hr-form-request-summary">
    <div className="hr-form-request-title"><strong>{formLabel(request)}</strong><StatusBadge tone={status.tone}>{status.label}</StatusBadge></div>
    <dl>
      {reviewer ? <><dt>申請人</dt><dd>{request.requesterName ?? request.employeeUserId}</dd></> : null}
      <dt>補登時間</dt><dd>{formatTaipei(request.requestedAt)}</dd>
      <dt>審核者</dt><dd>{request.approverName ?? "尚未指定"}</dd>
      <dt>申請原因</dt><dd>{request.reason}</dd>
      {request.reviewComment ? <><dt>審核意見</dt><dd>{request.reviewComment}</dd></> : null}
    </dl>
    {request.submittedAt ? <small className="muted">送出時間：{formatTaipei(request.submittedAt)}</small> : null}
  </div>;
}

function OvertimeCancelDialog({ item, onClose }: { item: OvertimeRequest; onClose: () => void }) {
  const cancel = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);
  function submit() {
    cancel.mutate({ path: `/me/overtime/${item.request.id}/cancel`, method: "POST", values: {} }, { onSuccess: () => (closeRequestRef.current ?? onClose)() });
  }
  return <Dialog title="取消加班申請" titleMeta={formatTaipei(item.request.requestedStart)} role="alertdialog" onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={cancel.isPending} actions={<>
    <Button variant="secondary" onClick={onClose} disabled={cancel.isPending}>保留申請</Button>
    <Button variant="danger" loading={cancel.isPending} onClick={submit}>確認取消</Button>
  </>}>
    <p>取消後這筆加班申請不會再納入薪資試算；已取消的申請仍會保留在申請紀錄。</p>
    {cancel.error ? <Alert tone="danger">{cancel.error.message}</Alert> : null}
  </Dialog>;
}

function OvertimeRequestCard({ item, onEdit, onCancel }: { item: OvertimeRequest; onEdit: (item: OvertimeRequest) => void; onCancel: (item: OvertimeRequest) => void }) {
  const status = item.request.status;
  const canEdit = status === "pending";
  const canCancel = status === "pending" || status === "approved";
  const tone = status === "approved" ? "success" : status === "rejected" ? "danger" : status === "cancelled" ? "neutral" : "info";
  const label = status === "pending" ? "申請中" : status === "approved" ? "已核准" : status === "rejected" ? "已駁回" : status === "cancelled" ? "已取消" : "草稿";
  return <article className="hr-form-request-card">
    <div className="hr-form-request-title"><strong>{formatTaipei(item.request.requestedStart)}～{formatTaipei(item.request.requestedEnd)}</strong><StatusBadge tone={tone}>{label}</StatusBadge></div>
    <p>{item.request.settlementKind === "pay" ? "付薪" : "補休"}・倍率 {(item.request.ratePpm / 10_000).toFixed(2)}%・{item.request.reason || "—"}</p>
    {item.request.decisionReason ? <small>審核意見：{item.request.decisionReason}</small> : null}
    {canEdit || canCancel ? <div className="hr-form-request-actions">{canEdit ? <Button variant="secondary" className="hr-action-update" onClick={() => onEdit(item)}>編輯</Button> : null}{canCancel ? <Button variant="secondary" onClick={() => onCancel(item)}>取消申請</Button> : null}</div> : null}
  </article>;
}

function LeaveCancelDialog({ item, onClose }: { item: LeaveRequest; onClose: () => void }) {
  const cancel = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);
  function submit() {
    cancel.mutate({ path: `/me/leave-requests/${item.request.id}/cancel`, method: "POST", values: {} }, { onSuccess: () => (closeRequestRef.current ?? onClose)() });
  }
  return <Dialog title="取消請假申請" titleMeta={leavePeriod(item)} role="alertdialog" onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={cancel.isPending} actions={<>
    <Button variant="secondary" onClick={onClose} disabled={cancel.isPending}>保留申請</Button>
    <Button variant="danger" loading={cancel.isPending} onClick={submit}>確認取消</Button>
  </>}>
    <p>取消後這筆請假不會再納入出勤與薪資計算；已取消的申請仍會保留在申請紀錄。</p>
    {cancel.error ? <Alert tone="danger">{cancel.error.message}</Alert> : null}
  </Dialog>;
}

function LeaveRequestCard({ item, onCancel }: { item: LeaveRequest; onCancel: (item: LeaveRequest) => void }) {
  const status = leaveStatus(item.request.status);
  const canCancel = item.request.status === "pending" || item.request.status === "approved";
  return <article className="hr-form-request-card">
    <div className="hr-form-request-title"><strong>{item.request.leaveType}・{leavePeriod(item)}</strong><StatusBadge tone={status.tone}>{status.label}</StatusBadge></div>
    <p>{formatHours(item.request.durationMinutes)}・{item.request.reason || "未填寫原因"}</p>
    {item.request.reviewComment ? <small>審核意見：{item.request.reviewComment}</small> : null}
    {canCancel ? <div className="hr-form-request-actions"><Button variant="secondary" onClick={() => onCancel(item)}>取消申請</Button></div> : null}
  </article>;
}

type CorrectionAction = { request: FormRequest; mode: "cancel" | "delete" };

function CorrectionActionDialog({ action, onClose }: { action: CorrectionAction; onClose: () => void }) {
  const write = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const isDelete = action.mode === "delete";
  function submit() {
    const path = `/me/form-requests/${action.request.id}`;
    write.mutate(isDelete ? { path, method: "DELETE", values: {} } : { path: `${path}/cancel`, method: "POST", values: {} }, { onSuccess: () => (closeRequestRef.current ?? onClose)() });
  }
  return <Dialog title={isDelete ? "刪除補打卡草稿" : "取消補打卡申請"} titleMeta={formLabel(action.request)} role="alertdialog" onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={write.isPending} actions={<>
    <Button variant="secondary" onClick={onClose} disabled={write.isPending}>{isDelete ? "保留草稿" : "保留申請"}</Button>
    <Button variant="danger" loading={write.isPending} onClick={submit}>{isDelete ? "確認刪除" : "確認取消"}</Button>
  </>}>
    <p>{isDelete ? "草稿還沒送出，刪除後不會留下紀錄，也無法復原。" : "取消後審核者不會再看到這張申請；已取消的申請仍會保留在申請紀錄，需要時請重新申請。"}</p>
    {write.error ? <Alert tone="danger">{write.error.message}</Alert> : null}
  </Dialog>;
}

function ReviewDialog({ request, onClose }: { request: FormRequest; onClose: () => void }) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const review = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);

  async function submit(decision: "approved" | "rejected"): Promise<boolean> {
    if (decision === "rejected" && !comment.trim()) {
      setError("駁回時請填寫審核意見。");
      return false;
    }
    setError("");
    try {
      await review.mutateAsync({ path: `/me/form-requests/${request.id}/review`, method: "POST", values: { decision, comment: comment.trim() } });
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "審核失敗，請稍後再試。");
      return false;
    }
  }

  async function submitAndClose(decision: "approved" | "rejected") {
    if (await submit(decision)) (closeRequestRef.current ?? onClose)();
  }

  return <Dialog title="審核補打卡申請" titleMeta={request.requesterName ?? request.employeeUserId} onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={review.isPending} actions={<>
    <Button variant="secondary" disabled={review.isPending} onClick={onClose}>取消</Button>
    <Button variant="danger" disabled={review.isPending} onClick={() => { void submitAndClose("rejected"); }}>駁回</Button>
    <Button className="hr-action-update" loading={review.isPending} loadingLabel="核准中…" onClick={() => { void submitAndClose("approved"); }}>核准</Button>
  </>}>
    <RequestSummary request={request} reviewer />
    <Field label="審核意見" hint="駁回時必填；核准時可留空。">
      <textarea maxLength={1000} rows={4} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="請填寫審核意見（選填）" />
    </Field>
    {error ? <Alert tone="danger">{error}</Alert> : null}
  </Dialog>;
}

export function HrForms() {
  usePageTitle("表單申請");
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  // 從草稿表單回來時網址會帶 status=draft；預設的「申請中」看不到草稿，使用者會以為它不見了。
  const [statusFilter, setStatusFilter] = useState<RequestStatusFilter>(() => REQUEST_STATUS_OPTIONS.find((option) => option.value === params.get("status"))?.value ?? "pending");
  const [visibleCount, setVisibleCount] = useState(8);
  const [reviewing, setReviewing] = useState<FormRequest | null>(null);
  const [cancelling, setCancelling] = useState<OvertimeRequest | null>(null);
  const [cancellingLeave, setCancellingLeave] = useState<LeaveRequest | null>(null);
  const [correctionAction, setCorrectionAction] = useState<CorrectionAction | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const hasMountedTabs = useRef(false);
  const activeTab = formTab(params.get("tab"));
  const isBackNavigation = typeof location.state === "object" && location.state !== null && (location.state as { transition?: string }).transition === "back";
  const query = useHrQuery<{ requests: FormRequest[]; reviewRequests: FormRequest[] }>("/me/form-requests");
  const overtime = useHrQuery<{ requests: OvertimeRequest[] }>("/me/overtime");
  const leave = useHrQuery<{ requests: LeaveRequest[] }>("/me/leave-requests");
  const data = query.data;

  const filteredLeaves = useMemo(() => (leave.data?.requests ?? []).filter((item) => matchesRequest(
    `${item.request.leaveType} ${leavePeriod(item)} ${item.request.reason} ${requestStatusLabel(item.request.status)}`,
    item.request.status,
    search,
    statusFilter,
  )), [leave.data?.requests, search, statusFilter]);
  const filteredOvertime = useMemo(() => (overtime.data?.requests ?? []).filter((item) => matchesRequest(
    `${formatTaipei(item.request.requestedStart)} ${formatTaipei(item.request.requestedEnd)} ${item.request.settlementKind === "pay" ? "付薪" : "補休"} ${item.request.reason} ${requestStatusLabel(item.request.status)}`,
    item.request.status,
    search,
    statusFilter,
  )), [overtime.data?.requests, search, statusFilter]);
  const filteredCorrections = useMemo(() => (data?.requests ?? []).filter((request) => matchesRequest(
    `${formLabel(request)} ${request.approverName ?? ""} ${request.reason} ${requestStatusLabel(request.status)}`,
    request.status,
    search,
    statusFilter,
  )), [data?.requests, search, statusFilter]);
  const activeCount = activeTab === "leave" ? filteredLeaves.length : activeTab === "overtime" ? filteredOvertime.length : filteredCorrections.length;
  const activeError = activeTab === "leave" ? leave.error : activeTab === "overtime" ? overtime.error : query.error;
  const isLoading = query.isPending || overtime.isPending || leave.isPending;
  const hasMore = visibleCount < activeCount;

  useEffect(() => {
    hasMountedTabs.current = true;
  }, []);

  useEffect(() => {
    setVisibleCount(8);
  }, [activeTab, search, statusFilter]);

  useEffect(() => {
    if (!hasMore || !sentinelRef.current) return;
    const target = sentinelRef.current;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) setVisibleCount((current) => Math.min(current + 8, activeCount));
    }, { rootMargin: "240px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [activeCount, hasMore]);

  function selectTab(tab: FormTab) {
    const next = new URLSearchParams(params);
    next.set("tab", tab);
    setParams(next, { replace: true });
  }

  function openNewForm() {
    navigate(activeTab === "leave" ? "/forms/leave" : activeTab === "overtime" ? "/forms/overtime" : "/forms/new");
  }

  const tabOptions = FORM_TAB_OPTIONS.map((option) => {
    const count = option.value === "leave"
      ? requestBadgeCount(leave.data?.requests.map((item) => item.request.status))
      : option.value === "overtime"
        ? requestBadgeCount(overtime.data?.requests.map((item) => item.request.status))
        : requestBadgeCount(data?.requests.map((item) => item.status));
    return {
      ...option,
      label: <><span>{option.label}</span><small>{requestBadgeLabel(count)}</small></>,
    };
  });

  return <div className={`page hr-forms-page hr-forms-index-page${isBackNavigation ? " hr-page-transition-back" : ""}`}>
    <PageHeader className="hr-forms-index-head" title="表單申請" actions={<Tooltip label="新增申請" focusable={false}><Button variant="icon" icon="plus" className="hr-form-add-button" aria-label="新增申請" onClick={openNewForm} /></Tooltip>} />
    {isLoading ? <p className="muted">載入申請紀錄…</p> : null}
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    {overtime.error ? <Alert tone="danger">{overtime.error.message}</Alert> : null}
    {leave.error ? <Alert tone="danger">{leave.error.message}</Alert> : null}
    <div className="hr-form-sticky-controls">
      <div className="hr-form-tabs-shell">
        <SegmentedControl className="hr-form-tabs" aria-label="申請表單類型" options={tabOptions} value={activeTab} onChange={(value) => selectTab(formTab(value))} />
      </div>
      <div className="hr-form-filters" aria-label="申請列表篩選">
        <TextField aria-label="搜尋申請" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜尋假別、日期或原因" inputClassName="hr-form-search-input" />
        <SelectField aria-label="狀態" value={statusFilter} options={REQUEST_STATUS_OPTIONS} onChange={(event) => setStatusFilter(event.target.value as RequestStatusFilter)} />
      </div>
    </div>
    {activeTab === "clock_correction" && data?.reviewRequests.length ? <Panel className="hr-form-section hr-form-review-panel">
      <div className="panel-head"><div><h2>待我審核</h2><p className="muted">只顯示指定你為審核者、且尚未完成處理的申請。</p></div></div>
      <div className="hr-form-request-list">{data.reviewRequests.map((request) => <article className="hr-form-request-card review" key={request.id}>
        <RequestSummary request={request} reviewer />
        <div className="hr-form-review-actions"><Button className="hr-action-info" onClick={() => setReviewing(request)}>審核</Button></div>
      </article>)}</div>
    </Panel> : null}
    <Panel key={activeTab} className={`hr-form-section hr-form-request-panel hr-form-request-panel-${activeTab}${hasMountedTabs.current ? " hr-form-tab-transition" : ""}`}>
      {activeError ? null : activeTab === "leave" ? <div className="hr-form-request-list">{filteredLeaves.slice(0, visibleCount).map((item) => <LeaveRequestCard key={item.request.id} item={item} onCancel={setCancellingLeave} />)}</div> : activeTab === "overtime" ? <div className="hr-form-request-list">{filteredOvertime.slice(0, visibleCount).map((item) => <OvertimeRequestCard key={item.request.id} item={item} onEdit={(request) => navigate(`/forms/overtime?request=${encodeURIComponent(request.request.id)}`)} onCancel={setCancelling} />)}</div> : <div className="hr-form-request-list">{filteredCorrections.slice(0, visibleCount).map((request) => <article className="hr-form-request-card" key={request.id}>
        <RequestSummary request={request} />
        {request.status === "draft" ? <div className="hr-form-request-actions">
          <Button variant="secondary" className="hr-action-update" onClick={() => navigate(`/forms/new?request=${encodeURIComponent(request.id)}`)}>繼續編輯</Button>
          <Button variant="secondary" onClick={() => setCorrectionAction({ request, mode: "delete" })}>刪除草稿</Button>
        </div> : request.status === "pending" ? <div className="hr-form-request-actions">
          <Button variant="secondary" onClick={() => setCorrectionAction({ request, mode: "cancel" })}>取消申請</Button>
        </div> : null}
      </article>)}</div>}
      {!isLoading && !activeError && activeCount === 0 ? <div className="hr-form-empty-state"><strong>{search || statusFilter !== "all" ? "找不到符合條件的申請" : "目前沒有申請紀錄"}</strong><p className="muted">{search || statusFilter !== "all" ? "請調整搜尋文字或狀態篩選。" : "點右上角的＋開始新增申請。"}</p></div> : null}
      {hasMore ? <div ref={sentinelRef} className="hr-form-load-sentinel" aria-live="polite">載入更多申請…</div> : activeCount > 0 ? <div className="hr-form-list-end">已顯示全部申請</div> : null}
    </Panel>
    {reviewing ? <ReviewDialog request={reviewing} onClose={() => setReviewing(null)} /> : null}
    {cancelling ? <OvertimeCancelDialog item={cancelling} onClose={() => setCancelling(null)} /> : null}
    {cancellingLeave ? <LeaveCancelDialog item={cancellingLeave} onClose={() => setCancellingLeave(null)} /> : null}
    {correctionAction ? <CorrectionActionDialog action={correctionAction} onClose={() => setCorrectionAction(null)} /> : null}
  </div>;
}

export function HrOvertimeForm() {
  const [params] = useSearchParams();
  const requestId = params.get("request");
  const editing = Boolean(requestId);
  usePageTitle(editing ? "編輯加班申請" : "加班申請");
  const navigate = useNavigate();
  const initial = taipeiInputNow();
  const [start, setStart] = useState(`${initial.date}T18:00`);
  const [end, setEnd] = useState(`${initial.date}T20:00`);
  const [settlementKind, setSettlementKind] = useState<"pay" | "compensatory">("pay");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const save = useHrWrite();
  const existing = useHrQuery<{ requests: OvertimeRequest[] }>("/me/overtime", editing);
  const existingRequest = existing.data?.requests.find((item) => item.request.id === requestId);

  useEffect(() => {
    if (!existingRequest) return;
    const startInput = taipeiInputFromUtc(existingRequest.request.requestedStart);
    const endInput = taipeiInputFromUtc(existingRequest.request.requestedEnd);
    setStart(`${startInput.date}T${startInput.time}`);
    setEnd(`${endInput.date}T${endInput.time}`);
    setSettlementKind(existingRequest.request.settlementKind);
    setReason(existingRequest.request.reason);
  }, [existingRequest?.request.id]);

  if (editing && existing.isPending) return <div className="page hr-form-page"><FormPageHeader title="編輯加班申請" description="正在載入申請內容…" returnTo="/forms?tab=overtime" /><p className="muted">載入加班申請…</p></div>;
  if (editing && existing.error) return <div className="page hr-form-page"><FormPageHeader title="編輯加班申請" description="無法載入這筆申請。" returnTo="/forms?tab=overtime" /><Alert tone="danger">{existing.error.message}</Alert></div>;
  if (editing && !existingRequest) return <div className="page hr-form-page"><FormPageHeader title="編輯加班申請" description="找不到這筆申請。" returnTo="/forms?tab=overtime" /><Alert tone="danger">找不到這筆加班申請。</Alert></div>;
  if (existingRequest && existingRequest.request.status !== "pending") return <div className="page hr-form-page"><FormPageHeader title="編輯加班申請" description="這筆申請已完成處理。" returnTo="/forms?tab=overtime" /><Alert tone="info">這筆加班申請已完成處理，無法再修改；如需變更請先取消後重新申請。</Alert></div>;

  const disabled = save.isPending || (editing && existing.isPending);
  function submit() {
    setError("");
    if (!start || !end) {
      setError("請填寫完整的加班開始與結束時間。");
      return;
    }
    save.mutate({ path: editing ? `/me/overtime/${requestId}` : "/me/overtime", method: editing ? "PATCH" : "POST", values: { requestedStart: start, requestedEnd: end, settlementKind, reason, ...(editing ? { revision: existingRequest?.request.revision } : {}) } }, { onSuccess: () => navigate("/forms?tab=overtime", { replace: true, state: { transition: "back" } }), onError: (cause) => setError(cause.message) });
  }

  return <div className="page hr-form-page"><FormPageHeader title={editing ? "編輯加班申請" : "加班申請"} description={editing ? "只能修改待審核的加班申請；已核准的申請請先取消後重新申請。" : "填寫台北時間的申請時段；倍率由公司已確認的加班制度決定，申請人不能自行修改。核准前不會進入薪資結算。"} returnTo="/forms?tab=overtime" /><Panel><div className="hr-form-fields"><div className="hr-form-field-row"><TextField label="開始（台北時間）" type="datetime-local" required value={start} disabled={disabled} onChange={(event) => setStart(event.target.value)} /><TextField label="結束（台北時間）" type="datetime-local" required value={end} disabled={disabled} onChange={(event) => setEnd(event.target.value)} /></div><div className="hr-form-field-row"><SelectField label="結算方式" value={settlementKind} options={[{ value: "pay", label: "付薪" }, { value: "compensatory", label: "補休" }]} disabled={disabled} onChange={(event) => setSettlementKind(event.target.value as "pay" | "compensatory")} /><p className="form-hint">目前制度倍率：133.33%（由伺服器套用）</p></div><Field label="加班原因（選填）"><textarea maxLength={1000} rows={5} value={reason} disabled={disabled} onChange={(event) => setReason(event.target.value)} /></Field></div>{error ? <Alert tone="danger">{error}</Alert> : null}<div className="hr-form-actions"><Button variant="secondary" onClick={() => navigate("/forms?tab=overtime", { state: { transition: "back" } })} disabled={disabled}>取消</Button><Button className={editing ? "hr-action-update" : "add-action"} loading={save.isPending} onClick={submit}>{editing ? "更新加班申請" : "送出加班申請"}</Button></div></Panel></div>;
}

function leaveTypeLabel(leaveType: LeaveTypeOption) {
  if (leaveType.leaveKind !== "annual") return leaveType.name;
  const available = leaveType.credits.reduce((total, credit) => total + Math.max(0, credit.balanceHalfHours), 0);
  return available > 0 ? `${leaveType.name}・可用 ${formatHours(available * 30)}` : `${leaveType.name}・目前無可用額度`;
}

function matchingLeaveCredit(leaveType: LeaveTypeOption | undefined, duration: { startsOn: string; endsOn: string; durationMinutes: number } | undefined) {
  if (!leaveType || leaveType.leaveKind !== "annual" || !duration) return null;
  return leaveType.credits.find((credit) => credit.periodStart <= duration.startsOn && credit.periodEnd >= duration.endsOn) ?? null;
}

const NO_LEAVE_TYPE = "__none__";

export function HrLeaveForm() {
  usePageTitle("請假申請");
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialDate = params.get("date") ?? taipeiInputNow().date;
  const [start, setStart] = useState(`${initialDate}T09:00`);
  const [end, setEnd] = useState(`${initialDate}T18:00`);
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const leaveTypesAsOfDate = end.length >= 10 ? end.slice(0, 10) : "";
  const leaveTypesPath = leaveTypesAsOfDate ? `/me/leave-types?asOfDate=${encodeURIComponent(leaveTypesAsOfDate)}` : "/me/leave-types";
  const leaveTypes = useHrQuery<LeaveTypesResponse>(leaveTypesPath);
  const duration = useHrLeaveDuration(start && end ? { startsAt: start, endsAt: end } : null);
  const save = useHrWrite();
  const options = leaveTypes.data?.leaveTypes ?? [];
  const selectedType = options.find((leaveType) => leaveType.id === leaveTypeId);
  const calculated = duration.data;
  const durationValid = Boolean(calculated && calculated.durationMinutes >= 30 && calculated.durationMinutes % 30 === 0);
  const credit = matchingLeaveCredit(selectedType, calculated);
  const hasEnoughCredit = selectedType?.leaveKind !== "annual" || Boolean(credit && credit.balanceHalfHours * 30 >= (calculated?.durationMinutes ?? Number.MAX_SAFE_INTEGER));
  const canSubmit = Boolean(selectedType && durationValid && hasEnoughCredit && !save.isPending && !leaveTypes.isPending && !duration.isPending);

  function submit() {
    setError("");
    if (!selectedType) {
      setError("請先選擇假別。");
      return;
    }
    if (!calculated || !durationValid) {
      setError("請先填寫有效的請假時間。");
      return;
    }
    if (!hasEnoughCredit) {
      setError("所選時段沒有足夠的可用特休額度，請調整日期或時數。");
      return;
    }
    save.mutate({ path: "/me/leave-requests", method: "POST", values: { leaveTypeId: selectedType.id, startsAt: start, endsAt: end, reason } }, { onSuccess: () => navigate("/forms?tab=leave", { replace: true, state: { transition: "back" } }), onError: (cause) => setError(cause.message) });
  }

  const leaveTypeOptions = [
    { value: NO_LEAVE_TYPE, label: options.length ? "請選擇假別" : "目前沒有可申請的假別" },
    ...options.map((leaveType) => ({ value: leaveType.id, label: leaveTypeLabel(leaveType) })),
  ];
  return <div className="page hr-form-page">
    <FormPageHeader title="請假申請" description="系統依工作日、班表與休息時間計算請假時數；特休可用額度由伺服器依目前週期自動判定。" returnTo="/forms?tab=leave" />
    <Panel>
      <div className="hr-form-fields">
        <SelectField label="假別" required value={leaveTypeId || NO_LEAVE_TYPE} options={leaveTypeOptions} disabled={leaveTypes.isPending || save.isPending} onChange={(event) => setLeaveTypeId(event.target.value === NO_LEAVE_TYPE ? "" : event.target.value)} hint={selectedType?.leaveKind === "annual" ? "特休額度以 0.5 小時為單位，且每個週期獨立計算。" : "此假別的給薪與額度依公司制度及審核結果處理。"} />
        <div className="hr-form-field-row">
          <TextField label="開始（台北時間）" type="datetime-local" step="1800" required value={start} disabled={save.isPending} onChange={(event) => { const value = event.target.value; setStart(value); if (end && end <= value) setEnd(""); }} />
          <TextField label="結束（台北時間）" type="datetime-local" step="1800" required min={start} value={end} disabled={save.isPending} onChange={(event) => setEnd(event.target.value)} />
        </div>
        <div className="hr-leave-duration-card" aria-live="polite">
          <div><span>系統計算時數</span><strong>{duration.isPending ? "計算中…" : calculated && durationValid ? formatHours(calculated.durationMinutes) : "尚未完成計算"}</strong></div>
          {calculated ? <small>{calculated.startsOn}～{dateBefore(calculated.endsOn)}，依實際工作日與休息時間計算</small> : null}
        </div>
        {selectedType?.leaveKind === "annual" ? <div className="hr-leave-credit-card" aria-live="polite">
          <div><span>可用特休額度</span><strong>{credit && credit.balanceHalfHours > 0 ? formatHours(credit.balanceHalfHours * 30) : "此時段沒有可用額度"}</strong></div>
          {credit && credit.balanceHalfHours > 0 ? <small>額度週期：{credit.periodStart}～{dateBefore(credit.periodEnd)}；送出後核准才會扣除。</small> : <small>請調整日期至可用額度週期內，或聯絡管理者確認額度。</small>}
        </div> : null}
        <Field label="請假原因（選填）"><textarea maxLength={1000} rows={5} value={reason} disabled={save.isPending} onChange={(event) => setReason(event.target.value)} placeholder="請說明請假原因（選填）" /></Field>
      </div>
      {leaveTypes.error ? <Alert tone="danger">{leaveTypes.error.message}</Alert> : null}
      {duration.error ? <Alert tone="danger">{duration.error.message}</Alert> : null}
      {selectedType?.leaveKind === "annual" && calculated && !hasEnoughCredit ? <Alert tone="warning">所選時段超過可用特休額度，請縮短時數或調整到其他額度週期。</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="hr-form-actions"><Button variant="secondary" onClick={() => navigate("/forms?tab=leave", { state: { transition: "back" } })} disabled={save.isPending}>取消</Button><Button loading={save.isPending} onClick={submit} disabled={!canSubmit}>送出請假申請</Button></div>
    </Panel>
  </div>;
}

export function HrClockCorrectionForm() {
  usePageTitle("補打卡申請單");
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const requestId = params.get("request");
  const initial = taipeiInputNow();
  const [correctionDate, setCorrectionDate] = useState(params.get("date") ?? initial.date);
  const [requestedTime, setRequestedTime] = useState(initial.time);
  const [requestedEventKind, setRequestedEventKind] = useState<"clock_in" | "clock_out">(params.get("kind") === "clock_out" ? "clock_out" : "clock_in");
  const [reason, setReason] = useState("");
  const [approverUserId, setApproverUserId] = useState("");
  const [localError, setLocalError] = useState("");
  const [saving, setSaving] = useState(false);
  const approvers = useHrQuery<FormApproversResponse>("/me/form-approvers");
  const existing = useHrQuery<{ request: FormRequest }>(`/me/form-requests/${encodeURIComponent(requestId ?? "")}`, Boolean(requestId));
  const save = useHrWrite();

  useEffect(() => {
    const request = existing.data?.request;
    if (!request) return;
    const input = taipeiInputFromUtc(request.requestedAt);
    setCorrectionDate(request.correctionDate);
    setRequestedTime(input.time);
    setRequestedEventKind(request.requestedEventKind);
    setReason(request.reason);
    setApproverUserId(request.approverUserId ?? "");
  }, [existing.data?.request]);

  useEffect(() => {
    if (!requestId && !approverUserId && approvers.data?.defaultApproverUserId) setApproverUserId(approvers.data.defaultApproverUserId);
  }, [approverUserId, approvers.data?.defaultApproverUserId, requestId]);

  async function submit() {
    setLocalError("");
    if (!correctionDate || !requestedTime) {
      setLocalError("請填寫補打卡日期與時間。");
      return;
    }
    const now = taipeiInputNow();
    if (`${correctionDate}T${requestedTime}` > `${now.date}T${now.time}`) {
      setLocalError("補打卡時間不可晚於現在。");
      return;
    }
    if (!reason.trim()) {
      setLocalError("請填寫申請原因。");
      return;
    }
    const values = { correctionDate, requestedTime, requestedEventKind, reason, approverUserId: approverUserId || null };
    setSaving(true);
    let savedId: string | null = null;
    try {
      // API 仍是「先存成草稿、再送出」兩步；畫面只給一顆送出鈕，草稿只會在第二步失敗時留下來。
      const saved = await save.mutateAsync({ path: requestId ? `/me/form-requests/${requestId}` : "/me/form-requests", method: requestId ? "PATCH" : "POST", values });
      savedId = saved.id;
      await save.mutateAsync({ path: `/me/form-requests/${saved.id}/submit`, method: "POST", values: {} });
      navigate("/forms?tab=clock_correction", { replace: true, state: { from: location.pathname, transition: "back" } });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "申請單儲存失敗，請稍後再試。");
      // 草稿已經存進去但送出失敗時，把網址換成那張草稿；不然再按一次會多建一張。
      if (savedId && !requestId) navigate(`/forms/new?request=${encodeURIComponent(savedId)}`, { replace: true });
    } finally {
      setSaving(false);
    }
  }

  // 沒帶 request 時這個 query 是停用的，停用的 query 會一直停在 pending；只有編輯草稿才需要等它。
  if (requestId && existing.isPending) return <div className="page hr-form-page"><FormPageHeader title="補打卡申請單" description="正在載入申請內容…" returnTo="/forms?tab=clock_correction" /><p className="muted">載入申請單…</p></div>;
  if (existing.error) return <div className="page hr-form-page"><FormPageHeader title="補打卡申請單" description="無法載入這份申請。" returnTo="/forms?tab=clock_correction" /><Alert tone="danger">{existing.error.message}</Alert></div>;
  if (existing.data?.request.status !== undefined && existing.data.request.status !== "draft") {
    const closed = existing.data.request.status === "cancelled" ? "已取消" : "已送出";
    return <div className="page hr-form-page"><FormPageHeader title="補打卡申請單" description={`這份申請${closed}。`} returnTo="/forms?tab=clock_correction" /><Alert tone="info">這份申請單{closed}，無法再修改。</Alert></div>;
  }
  // 正在編輯草稿時回列表要直接看得到那張草稿。
  const returnTo = requestId ? "/forms?tab=clock_correction&status=draft" : "/forms?tab=clock_correction";

  const approverOptions = [
    { label: "請選擇審核者", value: "" },
    ...(approvers.data?.approvers ?? []).map((approver) => ({ label: approver.employeeNumber ? `${approver.employeeNumber}・${approver.name}` : approver.name, value: approver.id })),
  ];
  return <div className="page hr-form-page">
    <FormPageHeader title="補打卡申請單" description="補登實際應出勤時間，送出後由指定審核者確認。" returnTo={returnTo} />
    <Panel>
      <div className="hr-form-fields">
        <div className="hr-form-field-row">
          <TextField label="補打卡日期" required type="date" max={initial.date} value={correctionDate} disabled={saving} onChange={(event) => setCorrectionDate(event.target.value)} />
          <TextField label="補打卡時間（台北時間）" required type="time" value={requestedTime} disabled={saving} onChange={(event) => setRequestedTime(event.target.value)} />
        </div>
        <SelectField label="補登類型" required value={requestedEventKind} disabled={saving} onChange={(event) => setRequestedEventKind(event.target.value as "clock_in" | "clock_out")} options={[{ label: "上班打卡", value: "clock_in" }, { label: "下班打卡", value: "clock_out" }]} />
        <SelectField label="審核者" required value={approverUserId} searchable disabled={saving || approvers.isPending} onChange={(event) => setApproverUserId(event.target.value)} options={approverOptions} hint={approvers.data?.defaultApproverUserId ? "預設帶入後台設定的員工主管，可依需要改選其他審核者。" : "尚未設定員工主管，請先選擇一位啟用中的員工審核。"} />
        <Field label="申請原因" required hint="最多 1000 字，請說明未能正常打卡的原因。">
          <textarea required maxLength={1000} rows={5} value={reason} disabled={saving} onChange={(event) => setReason(event.target.value)} placeholder="例如：手機當日故障，抵達辦公位置後無法完成打卡。" />
        </Field>
      </div>
      {approvers.error ? <Alert tone="danger">{approvers.error.message}</Alert> : null}
      {localError ? <Alert tone="danger">{localError}</Alert> : null}
      <div className="hr-form-actions">
        <Button variant="secondary" disabled={saving} onClick={() => navigate(returnTo, { state: { transition: "back" } })}>取消</Button>
        <Button className="add-action" loading={saving} loadingLabel="送出中…" disabled={!approverUserId} onClick={() => { void submit(); }}>送出補打卡申請</Button>
      </div>
    </Panel>
  </div>;
}
