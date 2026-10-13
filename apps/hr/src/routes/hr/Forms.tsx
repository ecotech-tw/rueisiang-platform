import { useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { OVERTIME_HOUR_PRESETS, OvertimeDayPicker, REVIEW_SNAPSHOT_NOTICE, addMinutes, hoursText, isValidOvertimeMinutes, monthRange, parseHours, reviewSnapshotState, useOvertimeBatchSelection } from "@rueisiang/ui";
import { Alert, Button, ConfirmDialog, Dialog, Field, PageHeader, Panel, SelectField, SegmentedControl, StatusBadge, TextField, Tooltip } from "../../ui/index.js";
import { useHrLeaveDuration, useHrLeaveEnd, useHrQuery, useHrWrite, type FormApproversResponse, type FormRequest, type FormRequestStatus, type HrOvertimeDay, type LeaveRequest, type LeaveTypeOption, type LeaveTypesResponse, type OvertimeRequest } from "./api.js";
import { dateBefore, formatHours, taipeiDay, taipeiTimeRange, utcStampDate } from "./format.js";
import { hoursToMinutes } from "./hours-entry.js";
import { emptyRecordsMessage } from "./notification-link.js";
import { batchDialogItems, reviewableOvertimeBatches } from "./overtime-batch.js";
import { swipeTarget, type SlideDirection } from "./page-direction.js";

const statusCopy: Record<FormRequestStatus, { label: string; tone: "neutral" | "info" | "success" | "danger" }> = {
  draft: { label: "草稿", tone: "neutral" },
  pending: { label: "申請中", tone: "info" },
  approved: { label: "已核准", tone: "success" },
  rejected: { label: "已駁回", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" },
};

function formatTaipei(value: string | null) {
  if (!value) return "—";
  const date = utcStampDate(value);
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
const FORM_TABS = FORM_TAB_OPTIONS.map((option) => option.value);
const SWIPE_MIN_DISTANCE = 56;
const SWIPE_EDGE_GUARD = 24;

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
      <Button variant="text" icon="chevronLeft" className="w-max" onClick={() => navigate(returnTo)}>返回表單</Button>
    </div>
    <PageHeader title={title} description={description} />
  </>;
}

function formLabel(request: FormRequest) {
  return `${request.correctionDate} ${request.requestedEventKind === "clock_in" ? "上班" : "下班"}補打卡`;
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
    <p>取消後這筆加班申請會直接刪除，不會留在申請紀錄，也不再納入薪資試算。</p>
    {cancel.error ? <Alert tone="danger">{cancel.error.message}</Alert> : null}
  </Dialog>;
}

function OvertimeRequestCard({ item, onEdit, onReapply, onCancel }: { item: OvertimeRequest; onEdit: (item: OvertimeRequest) => void; onReapply: (item: OvertimeRequest) => void; onCancel: (item: OvertimeRequest) => void }) {
  const status = item.request.status;
  const canEdit = status === "pending";
  const canReapply = status === "rejected";
  const canCancel = status === "pending" || status === "approved";
  const tone = status === "approved" ? "success" : status === "rejected" ? "danger" : status === "cancelled" ? "neutral" : "info";
  const label = status === "pending" ? "申請中" : status === "approved" ? "已核准" : status === "rejected" ? "已駁回" : status === "cancelled" ? "已取消" : "草稿";
  return <article className="hr-form-request-card">
    <div className="hr-form-request-title"><strong>{formatTaipei(item.request.requestedStart)}～{formatTaipei(item.request.requestedEnd)}</strong><StatusBadge tone={tone}>{label}</StatusBadge></div>
    <p>{item.request.settlementKind === "pay" ? "付薪" : "補休"}・{item.request.reason || "—"}</p>
    {item.request.decisionReason ? <small>審核意見：{item.request.decisionReason}</small> : null}
    {canEdit || canReapply || canCancel ? <div className="hr-form-request-actions">{canEdit ? <Button size="lg" variant="secondary" tone="info" onClick={() => onEdit(item)}>編輯</Button> : null}{canReapply ? <Button size="lg" variant="secondary" tone="info" onClick={() => onReapply(item)}>修改後重新申請</Button> : null}{canCancel ? <Button size="lg" variant="secondary" onClick={() => onCancel(item)}>取消申請</Button> : null}</div> : null}
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

function LeaveRequestCard({ item, onEdit, onReapply, onCancel }: { item: LeaveRequest; onEdit: (item: LeaveRequest) => void; onReapply: (item: LeaveRequest) => void; onCancel: (item: LeaveRequest) => void }) {
  const status = leaveStatus(item.request.status);
  const canEdit = item.request.status === "pending";
  const canReapply = item.request.status === "rejected";
  const canCancel = item.request.status === "pending" || item.request.status === "approved";
  return <article className="hr-form-request-card">
    <div className="hr-form-request-title"><strong>{item.request.leaveType}・{leavePeriod(item)}</strong><StatusBadge tone={status.tone}>{status.label}</StatusBadge></div>
    <p>{formatHours(item.request.durationMinutes)}・{item.request.reason || "未填寫原因"}</p>
    {item.request.reviewComment ? <small>審核意見：{item.request.reviewComment}</small> : null}
    {canEdit || canReapply || canCancel ? <div className="hr-form-request-actions">{canEdit ? <Button size="lg" variant="secondary" tone="info" onClick={() => onEdit(item)}>編輯</Button> : null}{canReapply ? <Button size="lg" variant="secondary" tone="info" onClick={() => onReapply(item)}>修改後重新申請</Button> : null}{canCancel ? <Button size="lg" variant="secondary" onClick={() => onCancel(item)}>取消申請</Button> : null}</div> : null}
  </article>;
}

/**
 * 逐筆審核對話框。`item` 是開啟當下的快照，`latest` 是最新待審清單裡的同一筆。
 *
 * 兩者不同時不自動換內容，只鎖住核准與駁回並請審核者自己載入：自動換會清掉他打到一半的意見，
 * 也會在處理成功、對話框正在關的那一瞬間把它重新開回來。
 */
function LeaveReviewDialog({ item, latest, onReload, onClose }: { item: LeaveRequest; latest: LeaveRequest | undefined; onReload: (latest: LeaveRequest) => void; onClose: () => void }) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const review = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);
  // 自己剛處理完的那一筆也會從清單消失；那是正在關閉，不是被別人處理掉。
  const snapshot = review.isSuccess ? "current" : reviewSnapshotState(item.request, latest?.request);
  const locked = review.isPending || snapshot !== "current";
  async function submit(decision: "approved" | "rejected") {
    if (decision === "rejected" && !comment.trim()) {
      setError("駁回時請填寫審核意見。");
      return;
    }
    setError("");
    try {
      // 帶上畫面上這一版的版本：申請人在這期間改了內容的話，伺服器會擋下來，不會處理審核者沒看過的內容。
      await review.mutateAsync({ path: `/me/leave-requests/${item.request.id}/review`, method: "POST", values: { decision, comment: comment.trim(), revision: item.request.revision } });
      (closeRequestRef.current ?? onClose)();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "審核失敗，請稍後再試。");
    }
  }
  return <Dialog title="審核請假申請" titleMeta={item.employeeName ?? item.employeeUserId} onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={review.isPending} actions={<>
    <Button variant="secondary" disabled={review.isPending} onClick={onClose}>{snapshot === "gone" ? "關閉" : "取消"}</Button>
    <Button variant="danger" disabled={locked} onClick={() => { void submit("rejected"); }}>駁回</Button>
    <Button tone="success" loading={review.isPending} disabled={locked} onClick={() => { void submit("approved"); }}>核准</Button>
  </>}>
    <div className="hr-form-request-summary"><dl><dt>請假期間</dt><dd>{leavePeriod(item)}</dd><dt>假別</dt><dd>{item.request.leaveType}</dd><dt>時數</dt><dd>{formatHours(item.request.durationMinutes)}</dd><dt>原因</dt><dd>{item.request.reason || "—"}</dd></dl></div>
    <Field label="審核意見" hint="駁回時必填；核准時可留空。"><textarea maxLength={1000} rows={4} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="請填寫審核意見（選填）" /></Field>
    {snapshot !== "current" ? <Alert tone="warning">{REVIEW_SNAPSHOT_NOTICE[snapshot]}</Alert> : error ? <Alert tone="danger">{error}</Alert> : null}
    {/* 打到一半的審核意見留著：只換上面的申請內容。 */}
    {snapshot === "changed" && latest ? <Button variant="secondary" tone="info" size="lg" className="mt-2 justify-self-start" onClick={() => { setError(""); onReload(latest); }}>載入最新內容</Button> : null}
  </Dialog>;
}

function OvertimeReviewDialog({ item, latest, onReload, onClose }: { item: OvertimeRequest; latest: OvertimeRequest | undefined; onReload: (latest: OvertimeRequest) => void; onClose: () => void }) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const review = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);
  // 自己剛處理完的那一筆也會從清單消失；那是正在關閉，不是被別人處理掉。
  const snapshot = review.isSuccess ? "current" : reviewSnapshotState(item.request, latest?.request);
  const locked = review.isPending || snapshot !== "current";
  async function submit(decision: "approved" | "rejected") {
    if (decision === "rejected" && !comment.trim()) {
      setError("駁回時請填寫審核意見。");
      return;
    }
    setError("");
    try {
      // 帶上畫面上這一版的版本：申請人在這期間改了內容的話，伺服器會擋下來，不會處理審核者沒看過的內容。
      await review.mutateAsync({ path: `/me/overtime/${item.request.id}/review`, method: "POST", values: { decision, comment: comment.trim(), revision: item.request.revision } });
      (closeRequestRef.current ?? onClose)();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "審核失敗，請稍後再試。");
    }
  }
  return <Dialog title="審核加班申請" titleMeta={item.employeeName ?? item.employeeUserId} onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={review.isPending} actions={<>
    <Button variant="secondary" disabled={review.isPending} onClick={onClose}>{snapshot === "gone" ? "關閉" : "取消"}</Button>
    <Button variant="danger" disabled={locked} onClick={() => { void submit("rejected"); }}>駁回</Button>
    <Button tone="success" loading={review.isPending} disabled={locked} onClick={() => { void submit("approved"); }}>核准</Button>
  </>}>
    <div className="hr-form-request-summary"><dl><dt>加班期間</dt><dd>{formatTaipei(item.request.requestedStart)}～{formatTaipei(item.request.requestedEnd)}</dd><dt>結算方式</dt><dd>{item.request.settlementKind === "pay" ? "付薪" : "補休"}</dd><dt>原因</dt><dd>{item.request.reason || "—"}</dd></dl></div>
    <Field label="審核意見" hint="駁回時必填；核准時可留空。"><textarea maxLength={1000} rows={4} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="請填寫審核意見（選填）" /></Field>
    {snapshot !== "current" ? <Alert tone="warning">{REVIEW_SNAPSHOT_NOTICE[snapshot]}</Alert> : error ? <Alert tone="danger">{error}</Alert> : null}
    {/* 打到一半的審核意見留著：只換上面的申請內容。 */}
    {snapshot === "changed" && latest ? <Button variant="secondary" tone="info" size="lg" className="mt-2 justify-self-start" onClick={() => { setError(""); onReload(latest); }}>載入最新內容</Button> : null}
  </Dialog>;
}

type OvertimeBatch = { batchId: string; items: OvertimeRequest[] };

/**
 * 月底一次送來的整批加班：逐筆開對話框核准二三十次不實際。駁回各有各的理由，仍然逐筆處理。
 *
 * 送出的是畫面上列出的那幾筆與版本，伺服器只核准一模一樣的集合。`items` 由上層從最新的待審清單取，
 * 被擋下（409）重抓之後這裡會直接換成新的內容，審核者看到的永遠是按下去會核准的東西。
 */
function OvertimeBatchApproveDialog({ batchId, items, settled, onClose }: { batchId: string; items: OvertimeRequest[]; settled: boolean; onClose: () => void }) {
  const [comment, setComment] = useState("");
  const approve = useHrWrite<{ ids: string[] }>();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const totalMinutes = items.reduce((total, item) => total + (utcStampDate(item.request.requestedEnd).getTime() - utcStampDate(item.request.requestedStart).getTime()) / 60_000, 0);
  // 核准成功後清單也會清空；那是正在關閉，不是「已經被別人處理掉」。
  const alreadyHandled = settled && !approve.isPending && !approve.isSuccess;
  function submit() {
    approve.mutate({ path: `/me/overtime/batches/${encodeURIComponent(batchId)}/approve`, method: "POST", values: { comment: comment.trim(), requests: items.map((item) => ({ id: item.request.id, revision: item.request.revision })) } }, { onSuccess: () => (closeRequestRef.current ?? onClose)() });
  }
  return <Dialog title="整批核准加班申請" titleMeta={items[0]?.employeeName ?? items[0]?.employeeUserId} onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={approve.isPending} actions={<>
    <Button variant="secondary" disabled={approve.isPending} onClick={onClose}>{alreadyHandled ? "關閉" : "取消"}</Button>
    <Button tone="success" loading={approve.isPending} loadingLabel="核准中…" disabled={alreadyHandled} onClick={submit}>核准 {items.length} 筆</Button>
  </>}>
    {alreadyHandled
      ? <Alert tone="info">這一批已經沒有待審的申請了，可能已被處理或取消。</Alert>
      : <p>會一次核准下面 {items.length} 筆、共 {formatHours(totalMinutes)}。要駁回其中幾筆的話，請先回清單逐筆審核那幾筆。</p>}
    {/* 原因與結算方式申請人可以逐筆改；只列日期時數的話，審核者會核准到沒看過的內容。 */}
    <ul className="hr-overtime-batch-days">{items.map((item) => <li key={item.request.id}>
      <div><span>{taipeiDay(item.request.requestedStart)}</span><span>{taipeiTimeRange(item.request.requestedStart, item.request.requestedEnd)}</span></div>
      <small>{item.request.settlementKind === "pay" ? "付薪" : "補休"}・{item.request.reason || "未填寫原因"}</small>
    </li>)}</ul>
    <Field label="審核意見（選填）" hint="會附在給申請人的通知裡。"><textarea maxLength={1000} rows={3} value={comment} disabled={approve.isPending || alreadyHandled} onChange={(event) => setComment(event.target.value)} /></Field>
    {approve.error && !alreadyHandled ? <Alert tone="danger">{approve.error.message}</Alert> : null}
  </Dialog>;
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
    <Button tone="success" loading={review.isPending} loadingLabel="核准中…" onClick={() => { void submitAndClose("approved"); }}>核准</Button>
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
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(() => params.get("search") ?? "");
  // 從草稿表單回來時網址會帶 status=draft；預設的「申請中」看不到草稿，使用者會以為它不見了。
  const [statusFilter, setStatusFilter] = useState<RequestStatusFilter>(() => REQUEST_STATUS_OPTIONS.find((option) => option.value === params.get("status"))?.value ?? "pending");
  const [visibleCount, setVisibleCount] = useState(8);
  const [reviewing, setReviewing] = useState<FormRequest | null>(null);
  const [cancelling, setCancelling] = useState<OvertimeRequest | null>(null);
  const [cancellingLeave, setCancellingLeave] = useState<LeaveRequest | null>(null);
  const [reviewingLeave, setReviewingLeave] = useState<LeaveRequest | null>(null);
  const [reviewingOvertime, setReviewingOvertime] = useState<OvertimeRequest | null>(null);
  const [approvingBatch, setApprovingBatch] = useState<OvertimeBatch | null>(null);
  const [correctionAction, setCorrectionAction] = useState<CorrectionAction | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const activeTab = formTab(params.get("tab"));
  // direction 是 null 代表還沒切過分頁：第一次進頁面已經有整頁的進場，分頁不要再疊一次。
  const [tabSlide, setTabSlide] = useState<{ tab: FormTab; direction: SlideDirection | null }>({ tab: activeTab, direction: null });
  const tabDirection = tabSlide.tab === activeTab ? tabSlide.direction : FORM_TABS.indexOf(activeTab) > FORM_TABS.indexOf(tabSlide.tab) ? "forward" : "back";
  if (tabSlide.tab !== activeTab) setTabSlide({ tab: activeTab, direction: tabDirection });
  const query = useHrQuery<{ requests: FormRequest[]; reviewRequests: FormRequest[] }>("/me/form-requests");
  const overtime = useHrQuery<{ requests: OvertimeRequest[]; reviewRequests: OvertimeRequest[] }>("/me/overtime");
  const leave = useHrQuery<{ requests: LeaveRequest[]; reviewRequests: LeaveRequest[] }>("/me/leave-requests");
  const data = query.data;
  const reviewTargetId = params.get("review");
  // 整批加班的通知帶的是批次鍵：審核者用 reviewBatch 看整批待審，申請人用 batch 看那一批的結果。
  const reviewBatchId = params.get("reviewBatch");
  // 批次鍵只有加班有；別的分頁帶著它（手改網址、tab 值不合法落回請假）時當作沒有。
  const recordBatchId = activeTab === "overtime" ? params.get("batch") : null;
  // 從審核結果通知點進來：只列通知提到的那一筆。
  const focusId = params.get("focus");
  const recordsFiltered = Boolean(focusId || recordBatchId);
  const reviewFiltered = Boolean(reviewTargetId || reviewBatchId);
  const reviewForms = (data?.reviewRequests ?? []).filter((request) => !reviewTargetId || request.id === reviewTargetId);
  const reviewLeaves = (leave.data?.reviewRequests ?? []).filter((item) => !reviewTargetId || item.request.id === reviewTargetId);
  const reviewOvertime = (overtime.data?.reviewRequests ?? []).filter((item) => reviewBatchId ? item.request.batchId === reviewBatchId : !reviewTargetId || item.request.id === reviewTargetId);
  const overtimeBatches = reviewableOvertimeBatches(reviewOvertime);
  const reviewTotal = activeTab === "leave" ? leave.data?.reviewRequests.length ?? 0 : activeTab === "overtime" ? overtime.data?.reviewRequests.length ?? 0 : data?.reviewRequests.length ?? 0;
  const reviewShown = activeTab === "leave" ? reviewLeaves.length : activeTab === "overtime" ? reviewOvertime.length : reviewForms.length;
  const reviewTargetMissing = Boolean(reviewFiltered && (
    (activeTab === "leave" && leave.data && !leave.isPending && reviewLeaves.length === 0)
    || (activeTab === "overtime" && overtime.data && !overtime.isPending && reviewOvertime.length === 0)
    || (activeTab === "clock_correction" && data && !query.isPending && reviewForms.length === 0)
  ));

  const filteredLeaves = useMemo(() => (leave.data?.requests ?? []).filter((item) => (!focusId || item.request.id === focusId) && matchesRequest(
    `${item.request.id} ${item.request.leaveType} ${leavePeriod(item)} ${item.request.reason} ${requestStatusLabel(item.request.status)}`,
    item.request.status,
    search,
    statusFilter,
  )), [focusId, leave.data?.requests, search, statusFilter]);
  const filteredOvertime = useMemo(() => (overtime.data?.requests ?? []).filter((item) => (!focusId || item.request.id === focusId) && (!recordBatchId || item.request.batchId === recordBatchId) && matchesRequest(
    `${item.request.id} ${formatTaipei(item.request.requestedStart)} ${formatTaipei(item.request.requestedEnd)} ${item.request.settlementKind === "pay" ? "付薪" : "補休"} ${item.request.reason} ${requestStatusLabel(item.request.status)}`,
    item.request.status,
    search,
    statusFilter,
  )), [focusId, overtime.data?.requests, recordBatchId, search, statusFilter]);
  const filteredCorrections = useMemo(() => (data?.requests ?? []).filter((request) => (!focusId || request.id === focusId) && matchesRequest(
    `${request.id} ${formLabel(request)} ${request.approverName ?? ""} ${request.reason} ${requestStatusLabel(request.status)}`,
    request.status,
    search,
    statusFilter,
  )), [data?.requests, focusId, search, statusFilter]);
  const focusExists = activeTab === "leave" ? leave.data?.requests.some((item) => item.request.id === focusId)
    : activeTab === "overtime" ? overtime.data?.requests.some((item) => item.request.id === focusId)
      : data?.requests.some((request) => request.id === focusId);
  const emptyMessage = emptyRecordsMessage({
    target: focusId ? "request" : recordBatchId ? "batch" : null,
    targetExists: Boolean(focusId ? focusExists : overtime.data?.requests.some((item) => item.request.batchId === recordBatchId)),
    narrowed: Boolean(search || statusFilter !== "all"),
  });
  const activeCount = activeTab === "leave" ? filteredLeaves.length : activeTab === "overtime" ? filteredOvertime.length : filteredCorrections.length;
  const activeError = activeTab === "leave" ? leave.error : activeTab === "overtime" ? overtime.error : query.error;
  const isLoading = query.isPending || overtime.isPending || leave.isPending;
  const hasMore = visibleCount < activeCount;

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
    // 從通知帶進來的篩選只屬於原本那個分頁；留著的話別的分頁會說「這批申請已全部處理」。
    for (const name of ["review", "reviewBatch", "batch", "focus"]) next.delete(name);
    setParams(next, { replace: true });
  }

  function clearParams(...names: string[]) {
    const next = new URLSearchParams(params);
    for (const name of names) next.delete(name);
    setParams(next, { replace: true });
  }

  function startSwipe(event: TouchEvent<HTMLDivElement>) {
    const touch = event.touches[0];
    const target = event.target as Element;
    // 對話框是 portal，React 的事件照樣會冒泡上來，所以要用 DOM 的包含關係再確認一次。
    // 螢幕邊緣留給 iOS 的「滑動返回」，輸入框與分頁列留給它們自己的手勢。
    const usable = touch && event.touches.length === 1
      && event.currentTarget.contains(target)
      && !target.closest("input, select, textarea, .hr-form-tabs")
      && touch.clientX > SWIPE_EDGE_GUARD && touch.clientX < window.innerWidth - SWIPE_EDGE_GUARD;
    swipeStart.current = usable ? { x: touch.clientX, y: touch.clientY } : null;
  }

  function endSwipe(event: TouchEvent<HTMLDivElement>) {
    const start = swipeStart.current;
    const touch = event.changedTouches[0];
    swipeStart.current = null;
    if (!start || !touch) return;
    const deltaX = touch.clientX - start.x;
    // 列表是直向捲動，橫向位移要明顯大於直向才算切分頁，不然捲到一半會被切走。
    if (Math.abs(deltaX) < SWIPE_MIN_DISTANCE || Math.abs(deltaX) < Math.abs(touch.clientY - start.y) * 2) return;
    const next = swipeTarget(FORM_TABS, activeTab, deltaX);
    if (next) selectTab(next);
  }

  function openNewForm() {
    navigate(activeTab === "leave" ? "/forms/leave" : activeTab === "overtime" ? "/forms/overtime" : "/forms/new");
  }

  const tabOptions = FORM_TAB_OPTIONS.map((option) => {
    const count = option.value === "leave"
      ? requestBadgeCount(leave.data?.requests.map((item) => item.request.status)) + (leave.data?.reviewRequests.length ?? 0)
      : option.value === "overtime"
        ? requestBadgeCount(overtime.data?.requests.map((item) => item.request.status)) + (overtime.data?.reviewRequests.length ?? 0)
        : requestBadgeCount(data?.requests.map((item) => item.status)) + (data?.reviewRequests.length ?? 0);
    return {
      ...option,
      label: <><span>{option.label}</span><small>{requestBadgeLabel(count)}</small></>,
    };
  });

  return <div className="page hr-forms-page hr-forms-index-page" onTouchStart={startSwipe} onTouchEnd={endSwipe} onTouchCancel={() => { swipeStart.current = null; }}>
    <PageHeader className="hr-forms-index-head" title="表單申請" actions={<Tooltip label="新增申請" focusable={false}><button type="button" className="grid size-10 flex-none place-items-center rounded-[50%] border-0 bg-brand p-0 text-paper [box-shadow:0_5px_14px_color-mix(in_oklab,var(--color-brand)_24%,transparent)] transition-[background-color,color,scale] duration-120 ease-out motion-reduce:transition-none not-disabled:hover:bg-brand-dark enabled:active:scale-[.96] motion-reduce:enabled:active:scale-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-secondary [&_svg]:size-5 max-[760px]:fixed max-[760px]:right-[max(16px,env(safe-area-inset-right))] max-[760px]:bottom-[calc(var(--hr-safe-bottom)+72px)] max-[760px]:z-[21] max-[760px]:size-[52px]" aria-label="新增申請" onClick={openNewForm}><Icon name="plus" /></button></Tooltip>} />
    {isLoading ? <p className="muted">載入申請紀錄…</p> : null}
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    {overtime.error ? <Alert tone="danger">{overtime.error.message}</Alert> : null}
    {leave.error ? <Alert tone="danger">{leave.error.message}</Alert> : null}
    {reviewTargetMissing ? <Alert tone="info">{reviewBatchId ? "這批申請已全部處理，或不在你目前的待審清單。" : "這筆申請已處理，或不在你目前的待審清單。"}</Alert> : null}
    {/* 從通知點進來只會看到那一筆（或那一批）；待審清單還有別的時要有路回到全部。 */}
    {reviewFiltered && reviewTotal > reviewShown ? <Button variant="text" className="justify-self-start" onClick={() => clearParams("review", "reviewBatch")}>查看全部 {reviewTotal} 筆待審</Button> : null}
    {recordsFiltered ? <Button variant="text" className="justify-self-start" onClick={() => clearParams("batch", "focus")}>{focusId ? "目前只顯示通知提到的申請，改看全部" : "目前只顯示同一批送出的加班，改看全部"}</Button> : null}
    <div className="hr-form-sticky-controls">
      <div className="hr-form-tabs-shell">
        <SegmentedControl className="hr-form-tabs" aria-label="申請表單類型" options={tabOptions} value={activeTab} onChange={(value) => selectTab(formTab(value))} />
      </div>
      <div className="hr-form-filters" aria-label="申請列表篩選">
        <TextField aria-label="搜尋申請" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜尋申請編號、假別、日期或原因" inputClassName="hr-form-search-input" />
        <SelectField aria-label="狀態" value={statusFilter} options={REQUEST_STATUS_OPTIONS} onChange={(event) => setStatusFilter(event.target.value as RequestStatusFilter)} />
      </div>
    </div>
    {/* 從審核結果通知進來時先收起待審面板：身兼審核者的人，通知提到的那一筆會被一長串待審擠到要捲才看得到。 */}
    {!recordsFiltered && activeTab === "clock_correction" && reviewForms.length ? <Panel className="hr-form-section hr-form-review-panel">
      <div className="panel-head"><div><h2>待我審核</h2><p className="muted">只顯示指定你為審核者、且尚未完成處理的申請。</p></div></div>
      <div className="hr-form-request-list">{reviewForms.map((request) => <article className="hr-form-request-card review" key={request.id}>
        <RequestSummary request={request} reviewer />
        <div className="hr-form-review-actions"><Button size="lg" tone="info" onClick={() => setReviewing(request)}>審核</Button></div>
      </article>)}</div>
    </Panel> : null}
    {!recordsFiltered && activeTab === "leave" && reviewLeaves.length ? <Panel className="hr-form-section hr-form-review-panel">
      <div className="panel-head"><div><h2>待我審核</h2><p className="muted">請假申請只有指定主管或 HR 管理者可以處理。</p></div></div>
      <div className="hr-form-request-list">{reviewLeaves.map((item) => <article className="hr-form-request-card review" key={item.request.id}>
        <div className="hr-form-request-summary"><div className="hr-form-request-title"><strong>{item.employeeName ?? item.employeeUserId}・{item.request.leaveType}</strong><StatusBadge tone="info">申請中</StatusBadge></div><dl><dt>期間</dt><dd>{leavePeriod(item)}</dd><dt>時數</dt><dd>{formatHours(item.request.durationMinutes)}</dd><dt>原因</dt><dd>{item.request.reason || "—"}</dd></dl></div>
        <div className="hr-form-review-actions"><Button size="lg" tone="info" onClick={() => setReviewingLeave(item)}>審核</Button></div>
      </article>)}</div>
    </Panel> : null}
    {!recordsFiltered && activeTab === "overtime" && reviewOvertime.length ? <Panel className="hr-form-section hr-form-review-panel">
      <div className="panel-head"><div><h2>待我審核</h2><p className="muted">加班申請由指定主管或 HR 管理者處理。</p></div></div>
      {overtimeBatches.length ? <div className="hr-form-request-list hr-overtime-batch-list">{overtimeBatches.map((batch) => <article className="hr-form-request-card review batch" key={batch.batchId}>
        <div className="hr-form-request-summary"><div className="hr-form-request-title"><strong>{batch.items[0]?.employeeName ?? batch.items[0]?.employeeUserId}・同一批 {batch.items.length} 筆</strong><StatusBadge tone="info">申請中</StatusBadge></div><p className="muted">{batch.items.map((item) => taipeiDay(item.request.requestedStart)).join("、")}</p></div>
        <div className="hr-form-review-actions"><Button size="lg" tone="success" onClick={() => setApprovingBatch(batch)}>整批核准</Button></div>
      </article>)}</div> : null}
      <div className="hr-form-request-list">{reviewOvertime.map((item) => <article className="hr-form-request-card review" key={item.request.id}>
        <div className="hr-form-request-summary"><div className="hr-form-request-title"><strong>{item.employeeName ?? item.employeeUserId}・{formatTaipei(item.request.requestedStart)}</strong><StatusBadge tone="info">申請中</StatusBadge></div><dl><dt>期間</dt><dd>{formatTaipei(item.request.requestedStart)}～{formatTaipei(item.request.requestedEnd)}</dd><dt>結算</dt><dd>{item.request.settlementKind === "pay" ? "付薪" : "補休"}</dd><dt>原因</dt><dd>{item.request.reason || "—"}</dd></dl></div>
        <div className="hr-form-review-actions"><Button size="lg" tone="info" onClick={() => setReviewingOvertime(item)}>審核</Button></div>
      </article>)}</div>
    </Panel> : null}
    <Panel key={activeTab} className={`hr-form-section hr-form-request-panel hr-form-request-panel-${activeTab}${tabDirection ? ` hr-form-tab-transition${tabDirection === "back" ? " back" : ""}` : ""}`}>
      {activeError ? null : activeTab === "leave" ? <div className="hr-form-request-list">{filteredLeaves.slice(0, visibleCount).map((item) => <LeaveRequestCard key={item.request.id} item={item} onEdit={(request) => navigate(`/forms/leave?request=${encodeURIComponent(request.request.id)}`)} onReapply={(request) => navigate(`/forms/leave?copy=${encodeURIComponent(request.request.id)}`)} onCancel={setCancellingLeave} />)}</div> : activeTab === "overtime" ? <div className="hr-form-request-list">{filteredOvertime.slice(0, visibleCount).map((item) => <OvertimeRequestCard key={item.request.id} item={item} onEdit={(request) => navigate(`/forms/overtime?request=${encodeURIComponent(request.request.id)}`)} onReapply={(request) => navigate(`/forms/overtime?copy=${encodeURIComponent(request.request.id)}`)} onCancel={setCancelling} />)}</div> : <div className="hr-form-request-list">{filteredCorrections.slice(0, visibleCount).map((request) => <article className="hr-form-request-card" key={request.id}>
        <RequestSummary request={request} />
        {request.status === "draft" ? <div className="hr-form-request-actions">
          <Button size="lg" variant="secondary" tone="info" onClick={() => navigate(`/forms/new?request=${encodeURIComponent(request.id)}`)}>繼續編輯</Button>
          <Button size="lg" variant="secondary" onClick={() => setCorrectionAction({ request, mode: "delete" })}>刪除草稿</Button>
        </div> : request.status === "pending" ? <div className="hr-form-request-actions">
          <Button size="lg" variant="secondary" onClick={() => setCorrectionAction({ request, mode: "cancel" })}>取消申請</Button>
        </div> : null}
      </article>)}</div>}
      {!isLoading && !activeError && activeCount === 0 ? <div className="hr-form-empty-state"><strong>{emptyMessage.title}</strong><p className="muted">{emptyMessage.hint}</p></div> : null}
      {hasMore ? <div ref={sentinelRef} className="hr-form-load-sentinel" aria-live="polite">載入更多申請…</div> : activeCount > 0 ? <div className="hr-form-list-end">已顯示全部申請</div> : null}
    </Panel>
    {reviewing ? <ReviewDialog request={reviewing} onClose={() => setReviewing(null)} /> : null}
    {reviewingLeave ? <LeaveReviewDialog item={reviewingLeave} latest={leave.data?.reviewRequests.find((item) => item.request.id === reviewingLeave.request.id)} onReload={setReviewingLeave} onClose={() => setReviewingLeave(null)} /> : null}
    {reviewingOvertime ? <OvertimeReviewDialog item={reviewingOvertime} latest={overtime.data?.reviewRequests.find((item) => item.request.id === reviewingOvertime.request.id)} onReload={setReviewingOvertime} onClose={() => setReviewingOvertime(null)} /> : null}
    {approvingBatch ? <OvertimeBatchApproveDialog batchId={approvingBatch.batchId} {...batchDialogItems(overtime.data?.reviewRequests ?? [], approvingBatch)} onClose={() => setApprovingBatch(null)} /> : null}
    {cancelling ? <OvertimeCancelDialog item={cancelling} onClose={() => setCancelling(null)} /> : null}
    {cancellingLeave ? <LeaveCancelDialog item={cancellingLeave} onClose={() => setCancellingLeave(null)} /> : null}
    {correctionAction ? <CorrectionActionDialog action={correctionAction} onClose={() => setCorrectionAction(null)} /> : null}
  </div>;
}

type OvertimeMode = "single" | "multiple";

const OVERTIME_MODE_OPTIONS = [{ value: "single", label: "單日" }, { value: "multiple", label: "多日" }] as const;
const OVERTIME_PRESET_OPTIONS = OVERTIME_HOUR_PRESETS.map((hours) => ({ value: String(hours), label: `${hours} 小時` }));
/** 前台不讓員工選結算方式：選成補休薪資就不計這筆，而審核者改不了。補休由 HR 在後台代登。 */
const SELF_SERVICE_SETTLEMENT_KIND = "pay";

/** 櫃位人員月底一次補整個月：先選時數、再點日期，換個時數繼續點，一次送出。 */
function OvertimeBatchFields({ reason, onReasonChange, onPendingChange, onDone }: { reason: string; onReasonChange: (value: string) => void; onPendingChange: (pending: boolean) => void; onDone: () => void }) {
  const navigate = useNavigate();
  const [month, setMonth] = useState(() => taipeiInputNow().date.slice(0, 7));
  const [hours, setHours] = useState("1");
  const [confirmingUnscheduled, setConfirmingUnscheduled] = useState(false);
  const save = useHrWrite<{ ids: string[] }>();
  const range = monthRange(month);
  const dayQuery = useHrQuery<{ days: HrOvertimeDay[] }>(range ? `/me/overtime-days?${new URLSearchParams(range).toString()}` : "", Boolean(range));
  const days = useMemo(() => (dayQuery.data?.days ?? []).map((day) => {
    const shiftEnd = day.shiftEnd ? taipeiInputFromUtc(day.shiftEnd) : null;
    return { date: day.date, startAt: shiftEnd ? `${shiftEnd.date}T${shiftEnd.time}` : null, hasExisting: day.existing.length > 0 };
  }), [dayQuery.data]);

  const minutes = parseHours(hours);
  const minutesValid = isValidOvertimeMinutes(minutes);
  const { assigned, entries, summary, takenDates, unscheduledDates, unscheduledStartTime, setUnscheduledStartTime, missingUnscheduledStart, complete, toggleDay, reset } = useOvertimeBatchSelection(days, minutes);
  const canSubmit = !save.isPending && Boolean(dayQuery.data) && !dayQuery.error && complete;

  function send() {
    onPendingChange(true);
    save.mutate({ path: "/me/overtime/batch", method: "POST", values: { settlementKind: SELF_SERVICE_SETTLEMENT_KIND, reason, entries } }, {
      onSuccess: onDone,
      // 失敗後班表會重抓、選擇可能跟著變；關掉確認框，讓人先看到被移除的日期與新的小計再決定要不要重送。
      onError: () => setConfirmingUnscheduled(false),
      onSettled: () => onPendingChange(false),
    });
  }
  function submit() {
    if (!canSubmit) return;
    if (unscheduledDates.length) setConfirmingUnscheduled(true);
    else send();
  }

  return <>
    <div className="hr-form-fields">
      <div className="hr-form-field-row">
        <TextField label="月份" type="month" required value={month} disabled={save.isPending} onChange={(event) => { setMonth(event.target.value); reset(); }} />
        <TextField label="每天加班時數（小時）" type="number" inputMode="decimal" min={0.5} max={24} step={0.5} required value={hours} disabled={save.isPending} error={hours.trim() && !minutesValid ? "時數要以 0.5 小時為單位，最多 24 小時。" : undefined} onChange={(event) => setHours(event.target.value)} />
      </div>
      <SegmentedControl className="hr-form-tabs hr-overtime-presets" aria-label="快速選擇加班時數" value={minutes !== null ? hoursText(minutes) : ""} options={OVERTIME_PRESET_OPTIONS} disabled={save.isPending} onChange={setHours} />
      <p className="muted hr-overtime-note">先選時數，再點日期；換個時數可以繼續點別天，再點一次同樣時數就取消。有排班的日期從下班時間起算。</p>
      {dayQuery.error ? <Alert tone="danger">{dayQuery.error.message}</Alert>
        : !range ? <p className="muted">請先選擇月份。</p>
        : dayQuery.isPending ? <p className="muted">載入班表…</p>
        : <OvertimeDayPicker days={days} assigned={assigned} disabled={save.isPending || !minutesValid} onToggle={toggleDay} />}
      {takenDates.length ? <Alert tone="info">{takenDates.join("、")} 已經有加班申請，已從這次的選擇移除。</Alert> : null}
      {unscheduledDates.length ? <TextField label="未排班日開始時間（台北）" type="time" step={1800} required value={unscheduledStartTime} disabled={save.isPending} hint="所有已選的未排班日期都從這個時間開始。" error={missingUnscheduledStart ? "選了未排班的日期，要先填開始時間才能送出。" : undefined} onChange={(event) => setUnscheduledStartTime(event.target.value)} /> : null}
      <div className="hr-leave-duration-card" aria-live="polite">
        <div><span>{summary.days ? `已選 ${summary.days} 天` : "還沒選任何一天"}</span><strong>{hoursText(summary.totalMinutes)} 小時</strong></div>
        {summary.days ? <small>{summary.breakdown}；每一天會是一筆申請。</small> : null}
      </div>
      <Field label="加班原因（選填）" hint="所有選到的日期共用同一個原因。"><textarea maxLength={1000} rows={3} value={reason} disabled={save.isPending} onChange={(event) => onReasonChange(event.target.value)} /></Field>
    </div>
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
    <div className="hr-form-actions">
      <Button size="lg" variant="secondary" onClick={() => navigate("/forms?tab=overtime")} disabled={save.isPending}>取消</Button>
      <Button size="lg" tone="success" loading={save.isPending} onClick={submit} disabled={!canSubmit}>{summary.days ? `送出 ${summary.days} 筆加班申請` : "送出加班申請"}</Button>
    </div>
    {confirmingUnscheduled ? <ConfirmDialog title="確認未排班日加班" confirmLabel="確認送出申請" cancelLabel="返回修改" tone="primary" pending={save.isPending} onConfirm={send} onCancel={() => setConfirmingUnscheduled(false)}>
      <p>以下日期沒有排班，會從 {unscheduledStartTime} 開始計算；有排班的日期仍從下班時間起算。</p>
      <ul className="hr-overtime-unscheduled-dates">{unscheduledDates.map((day) => <li key={day}>{day}</li>)}</ul>
    </ConfirmDialog> : null}
  </>;
}

/** 單日的時數欄位與多日共用同一條規則：0.5 小時為單位、最多 24 小時。 */
function overtimeMinutes(text: string) {
  const minutes = parseHours(text);
  return isValidOvertimeMinutes(minutes) ? minutes : null;
}

export function HrOvertimeForm() {
  const [params] = useSearchParams();
  const requestId = params.get("request");
  const copyId = params.get("copy");
  const editing = Boolean(requestId);
  const copying = Boolean(copyId);
  usePageTitle(editing ? "編輯加班申請" : copying ? "重新申請加班" : "加班申請");
  const navigate = useNavigate();
  const initial = taipeiInputNow();
  const [start, setStart] = useState(`${initial.date}T18:00`);
  const [end, setEnd] = useState(`${initial.date}T20:00`);
  // null 代表時數跟著開始與結束算；有值代表使用者正在填時數，這時改開始時間要連結束一起推。
  // 欄位用 type="text"：type="number" 遇到瀏覽器不認的輸入會回空字串，檢查會被整個繞過。
  const [hoursDraft, setHoursDraft] = useState<string | null>(null);
  // 既有申請可能是補休（HR 後台代登或舊資料）。編輯是改同一筆，沿用原值並在畫面上講明；
  // 重送是建立新申請，跟其他新申請一樣付薪。
  const [settlementKind, setSettlementKind] = useState<"pay" | "compensatory">(SELF_SERVICE_SETTLEMENT_KIND);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<OvertimeMode>("single");
  const [batchPending, setBatchPending] = useState(false);
  const [loadedRevision, setLoadedRevision] = useState<{ id: string; revision: number } | null>(null);
  const save = useHrWrite();
  const restoredDraft = useRef(false);
  const existing = useHrQuery<{ requests: OvertimeRequest[] }>("/me/overtime", editing || copying);
  const existingRequest = existing.data?.requests.find((item) => item.request.id === (requestId ?? copyId));

  useEffect(() => {
    if (!existingRequest) return;
    const startInput = taipeiInputFromUtc(existingRequest.request.requestedStart);
    const endInput = taipeiInputFromUtc(existingRequest.request.requestedEnd);
    setStart(`${startInput.date}T${startInput.time}`);
    setEnd(`${endInput.date}T${endInput.time}`);
    setSettlementKind(copying ? SELF_SERVICE_SETTLEMENT_KIND : existingRequest.request.settlementKind);
    setReason(existingRequest.request.reason);
    setLoadedRevision({ id: existingRequest.request.id, revision: existingRequest.request.revision });
  }, [existingRequest?.request.id]);

  useEffect(() => {
    if (editing || copying || restoredDraft.current) return;
    restoredDraft.current = true;
    try {
      const raw = sessionStorage.getItem("hr:overtime-draft");
      if (!raw) return;
      const draft = JSON.parse(raw) as { start?: string; end?: string; reason?: string };
      if (draft.start) setStart(draft.start);
      if (draft.end) setEnd(draft.end);
      if (draft.reason) setReason(draft.reason);
    } catch {
      sessionStorage.removeItem("hr:overtime-draft");
    }
  }, [copying, editing]);

  useEffect(() => {
    // 多日模式不存草稿：存下來的時段是沒碰過的單日預設值，下次會配上多日打的原因一起被還原。
    if (editing || copying || mode === "multiple" || !restoredDraft.current) return;
    sessionStorage.setItem("hr:overtime-draft", JSON.stringify({ start, end, reason }));
  }, [copying, editing, end, mode, reason, start]);

  if ((editing || copying) && existing.isPending) return <div className="page hr-form-page"><FormPageHeader title={copying ? "重新申請加班" : "編輯加班申請"} description="正在載入申請內容…" returnTo="/forms?tab=overtime" /><p className="muted">載入加班申請…</p></div>;
  if ((editing || copying) && existing.error) return <div className="page hr-form-page"><FormPageHeader title={copying ? "重新申請加班" : "編輯加班申請"} description="無法載入這筆申請。" returnTo="/forms?tab=overtime" /><Alert tone="danger">{existing.error.message}</Alert></div>;
  if ((editing || copying) && !existingRequest) return <div className="page hr-form-page"><FormPageHeader title={copying ? "重新申請加班" : "編輯加班申請"} description="找不到這筆申請。" returnTo="/forms?tab=overtime" /><Alert tone="danger">找不到這筆加班申請。</Alert></div>;
  if (editing && existingRequest?.request.status !== "pending") return <div className="page hr-form-page"><FormPageHeader title="編輯加班申請" description="這筆申請已完成處理。" returnTo="/forms?tab=overtime" /><Alert tone="info">這筆加班申請已完成處理，無法再修改；如需變更請先取消後重新申請。</Alert></div>;
  if (copying && existingRequest?.request.status !== "rejected") return <div className="page hr-form-page"><FormPageHeader title="重新申請加班" description="只有已駁回申請可以複製重送。" returnTo="/forms?tab=overtime" /><Alert tone="info">這筆加班申請不是已駁回狀態，無法從原申請複製重送。</Alert></div>;

  const disabled = save.isPending || ((editing || copying) && existing.isPending) || (editing && loadedRevision?.id !== requestId);
  // 兩個欄位都是台北時間的牆上時刻，補 Z 當成同一個固定時區相減；用瀏覽器時區解析的話，裝置所在地有日光節約時會多或少一小時。
  const requestedMinutes = start && end ? (Date.parse(`${end}Z`) - Date.parse(`${start}Z`)) / 60_000 : 0;
  const draftMinutes = hoursDraft === null ? null : overtimeMinutes(hoursDraft);
  const hoursError = hoursDraft?.trim() && draftMinutes === null ? "時數要以 0.5 小時為單位，最多 24 小時。"
    : requestedMinutes > 0 && requestedMinutes % 30 !== 0 ? "加班時數必須是 0.5 小時的倍數。"
    : start && end && requestedMinutes <= 0 ? "結束時間必須晚於開始時間。" : undefined;
  function changeStart(value: string) {
    setStart(value);
    if (draftMinutes !== null && value) setEnd(addMinutes(value, draftMinutes));
  }
  function changeHours(value: string) {
    setHoursDraft(value);
    const minutes = overtimeMinutes(value);
    if (minutes !== null && start) setEnd(addMinutes(start, minutes));
  }
  function submit() {
    setError("");
    if (!start || !end) {
      setError("請填寫完整的加班開始與結束時間。");
      return;
    }
    if (hoursError) {
      setError(hoursError);
      return;
    }
    save.mutate({ path: editing ? `/me/overtime/${requestId}` : "/me/overtime", method: editing ? "PATCH" : "POST", values: { requestedStart: start, requestedEnd: end, settlementKind, reason, ...(editing ? { revision: loadedRevision?.revision } : {}) } }, { onSuccess: () => { if (!editing) sessionStorage.removeItem("hr:overtime-draft"); navigate("/forms?tab=overtime", { replace: true }); }, onError: (cause) => setError(cause.message) });
  }

  return <div className="page hr-form-page"><FormPageHeader title={editing ? "編輯加班申請" : copying ? "重新申請加班" : "加班申請"} description={editing ? "只能修改待審核的加班申請；已核准的申請請先取消後重新申請。" : copying ? "已帶入原申請內容；送出會建立新申請並保留原駁回紀錄。" : mode === "multiple" ? "先選時數再點日期，每一天會建立一筆申請；選好的日期離開頁面後不會保留。" : "填寫台北時間的申請時段；離開頁面前會暫存未送出的內容。"} returnTo="/forms?tab=overtime" /><Panel>{editing || copying ? null : <SegmentedControl className="hr-form-tabs hr-overtime-mode" aria-label="一次申請幾天" value={mode} options={OVERTIME_MODE_OPTIONS} disabled={save.isPending || batchPending} onChange={(value) => setMode(value === "multiple" ? "multiple" : "single")} />}{mode === "multiple" ? <OvertimeBatchFields reason={reason} onReasonChange={setReason} onPendingChange={setBatchPending} onDone={() => { sessionStorage.removeItem("hr:overtime-draft"); navigate("/forms?tab=overtime", { replace: true }); }} /> : <><div className="hr-form-fields"><div className="hr-form-field-row"><TextField label="開始（台北時間）" type="datetime-local" required value={start} disabled={disabled} onChange={(event) => changeStart(event.target.value)} /><TextField label="結束（台北時間）" type="datetime-local" required value={end} disabled={disabled} onChange={(event) => { setEnd(event.target.value); setHoursDraft(null); }} /></div><TextField label="加班時數（小時）" type="text" inputMode="decimal" value={hoursDraft ?? (requestedMinutes > 0 ? hoursText(requestedMinutes) : "")} disabled={disabled} onChange={(event) => changeHours(event.target.value)} onBlur={() => { if (!hoursDraft?.trim()) setHoursDraft(null); }} hint="填時數會自動換算結束時間。" error={hoursError} /><Field label="加班原因（選填）"><textarea maxLength={1000} rows={5} value={reason} disabled={disabled} onChange={(event) => setReason(event.target.value)} /></Field></div>{existingRequest?.request.settlementKind === "compensatory" ? <Alert tone="info">{editing ? "這筆申請的結算方式是補休，更新後仍是補休、不計加班費。要改成付薪請取消後重新申請。" : "原申請的結算方式是補休；重新送出會改為付薪。需要補休請洽 HR。"}</Alert> : null}{error ? <Alert tone="danger">{error}</Alert> : null}<div className="hr-form-actions"><Button size="lg" variant="secondary" onClick={() => navigate("/forms?tab=overtime")} disabled={disabled}>取消</Button><Button size="lg" tone={editing || copying ? "info" : "success"} loading={save.isPending} onClick={submit} disabled={disabled}>{editing ? "更新加班申請" : copying ? "重新送出加班申請" : "送出加班申請"}</Button></div></>}</Panel></div>;
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
  const [params] = useSearchParams();
  const requestId = params.get("request");
  const copyId = params.get("copy");
  const editing = Boolean(requestId);
  const copying = Boolean(copyId);
  usePageTitle(editing ? "編輯請假申請" : copying ? "重新申請請假" : "請假申請");
  const navigate = useNavigate();
  const initialDate = params.get("date") ?? taipeiInputNow().date;
  const [start, setStart] = useState(`${initialDate}T09:00`);
  const [end, setEnd] = useState(`${initialDate}T18:00`);
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [loadedRevision, setLoadedRevision] = useState<{ id: string; revision: number } | null>(null);
  const existing = useHrQuery<{ requests: LeaveRequest[] }>("/me/leave-requests", editing || copying);
  const existingRequest = existing.data?.requests.find((item) => item.request.id === (requestId ?? copyId));
  const leaveTypesAsOfDate = end.length >= 10 ? end.slice(0, 10) : "";
  const leaveTypesPath = leaveTypesAsOfDate ? `/me/leave-types?asOfDate=${encodeURIComponent(leaveTypesAsOfDate)}` : "/me/leave-types";
  const leaveTypes = useHrQuery<LeaveTypesResponse>(leaveTypesPath);
  const duration = useHrLeaveDuration(start && end ? { startsAt: start, endsAt: end } : null);
  // null 代表時數跟著開始與結束算；有值代表使用者正在填時數，結束時間改由後端依班表反推。
  const [hoursDraft, setHoursDraft] = useState<string | null>(null);
  const draftMinutes = hoursDraft === null ? null : hoursToMinutes(hoursDraft);
  const hoursInvalid = Boolean(hoursDraft?.trim()) && draftMinutes === null;
  // 打「12」會先經過「1」；等輸入停下來才換算，中間值才不會先把結束時間改掉。
  const [settledMinutes, setSettledMinutes] = useState<number | null>(null);
  useEffect(() => {
    if (draftMinutes === null) {
      setSettledMinutes(null);
      return;
    }
    const timer = window.setTimeout(() => setSettledMinutes(draftMinutes), 400);
    return () => window.clearTimeout(timer);
  }, [draftMinutes]);
  const leaveEnd = useHrLeaveEnd(start && settledMinutes !== null ? { startsAt: start, durationMinutes: settledMinutes } : null);
  const hoursPending = settledMinutes !== draftMinutes || leaveEnd.isFetching;
  const save = useHrWrite();
  const restoredDraft = useRef(false);
  const options = leaveTypes.data?.leaveTypes ?? [];
  const selectedType = options.find((leaveType) => leaveType.id === leaveTypeId);
  const calculated = duration.data;
  const durationValid = Boolean(calculated && calculated.durationMinutes >= 30 && calculated.durationMinutes % 30 === 0);
  const credit = matchingLeaveCredit(selectedType, calculated);
  const hasEnoughCredit = selectedType?.leaveKind !== "annual" || Boolean(credit && credit.balanceHalfHours * 30 >= (calculated?.durationMinutes ?? Number.MAX_SAFE_INTEGER));
  const disabled = save.isPending || ((editing || copying) && existing.isPending) || (editing && loadedRevision?.id !== requestId);
  // 時數填錯、換算還在跑或失敗時，結束時間還是舊的；這時送出會送出跟畫面上時數對不起來的時段。
  const canSubmit = Boolean(selectedType && durationValid && hasEnoughCredit && !disabled && !leaveTypes.isPending && !duration.isPending && !hoursInvalid && !hoursPending && !leaveEnd.error && (!editing || existingRequest?.request.status === "pending") && (!copying || existingRequest?.request.status === "rejected"));

  useEffect(() => {
    if (!existingRequest) return;
    const startInput = taipeiInputFromUtc(existingRequest.request.startsAt);
    const endInput = taipeiInputFromUtc(existingRequest.request.endsAt);
    setStart(`${startInput.date}T${startInput.time}`);
    setEnd(`${endInput.date}T${endInput.time}`);
    setLeaveTypeId(existingRequest.request.leaveTypeId ?? "");
    setReason(existingRequest.request.reason);
    setLoadedRevision({ id: existingRequest.request.id, revision: existingRequest.request.revision });
  }, [existingRequest?.request.id]);

  useEffect(() => {
    if (!leaveEnd.data) return;
    const endInput = taipeiInputFromUtc(leaveEnd.data.endsAt);
    setEnd(`${endInput.date}T${endInput.time}`);
  }, [leaveEnd.data]);

  useEffect(() => {
    if (editing || copying || restoredDraft.current) return;
    restoredDraft.current = true;
    try {
      const raw = sessionStorage.getItem("hr:leave-draft");
      if (!raw) return;
      const draft = JSON.parse(raw) as { start?: string; end?: string; leaveTypeId?: string; reason?: string };
      if (draft.start) setStart(draft.start);
      if (draft.end) setEnd(draft.end);
      if (draft.leaveTypeId) setLeaveTypeId(draft.leaveTypeId);
      if (draft.reason) setReason(draft.reason);
    } catch {
      sessionStorage.removeItem("hr:leave-draft");
    }
  }, [copying, editing]);

  useEffect(() => {
    if (editing || copying || !restoredDraft.current) return;
    sessionStorage.setItem("hr:leave-draft", JSON.stringify({ start, end, leaveTypeId, reason }));
  }, [copying, editing, end, leaveTypeId, reason, start]);

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
    const values = { leaveTypeId: selectedType.id, startsAt: start, endsAt: end, reason, ...(editing ? { revision: loadedRevision?.revision } : {}) };
    save.mutate({ path: editing ? `/me/leave-requests/${requestId}` : "/me/leave-requests", method: editing ? "PATCH" : "POST", values }, {
      onSuccess: () => {
        if (!editing) sessionStorage.removeItem("hr:leave-draft");
        navigate("/forms?tab=leave", { replace: true });
      },
      onError: (cause) => setError(cause.message),
    });
  }

  if ((editing || copying) && existing.isPending) return <div className="page hr-form-page"><FormPageHeader title={copying ? "重新申請請假" : "編輯請假申請"} description="正在載入申請內容…" returnTo="/forms?tab=leave" /><p className="muted">載入請假申請…</p></div>;
  if ((editing || copying) && existing.error) return <div className="page hr-form-page"><FormPageHeader title={copying ? "重新申請請假" : "編輯請假申請"} description="無法載入這筆申請。" returnTo="/forms?tab=leave" /><Alert tone="danger">{existing.error.message}</Alert></div>;
  if ((editing || copying) && !existingRequest) return <div className="page hr-form-page"><FormPageHeader title={copying ? "重新申請請假" : "編輯請假申請"} description="找不到這筆申請。" returnTo="/forms?tab=leave" /><Alert tone="danger">找不到這筆請假申請。</Alert></div>;
  if (editing && existingRequest?.request.status !== "pending") return <div className="page hr-form-page"><FormPageHeader title="編輯請假申請" description="這筆申請已完成處理。" returnTo="/forms?tab=leave" /><Alert tone="info">這筆請假申請已完成處理，只有審核中的申請可以修改。</Alert></div>;
  if (copying && existingRequest?.request.status !== "rejected") return <div className="page hr-form-page"><FormPageHeader title="重新申請請假" description="只有已駁回申請可以複製重送。" returnTo="/forms?tab=leave" /><Alert tone="info">這筆請假申請不是已駁回狀態，無法從原申請複製重送。</Alert></div>;

  const leaveTypeOptions = [
    { value: NO_LEAVE_TYPE, label: options.length ? "請選擇假別" : "目前沒有可申請的假別" },
    ...options.map((leaveType) => ({ value: leaveType.id, label: leaveTypeLabel(leaveType) })),
  ];
  return <div className="page hr-form-page">
    <FormPageHeader title={editing ? "編輯請假申請" : copying ? "重新申請請假" : "請假申請"} description={editing ? "只能修改審核中的請假申請；已核准或駁回的申請請重新建立。" : copying ? "已帶入原申請內容；送出會建立新申請並保留原駁回紀錄。" : "系統依工作日、班表與休息時間計算請假時數；離開頁面前會暫存未送出的內容。"} returnTo="/forms?tab=leave" />
    <Panel>
      <div className="hr-form-fields">
        <SelectField label="假別" required value={leaveTypeId || NO_LEAVE_TYPE} options={leaveTypeOptions} disabled={leaveTypes.isPending || disabled} onChange={(event) => setLeaveTypeId(event.target.value === NO_LEAVE_TYPE ? "" : event.target.value)} hint={selectedType?.leaveKind === "annual" ? "特休額度以 0.5 小時為單位，且每個週期獨立計算。" : "此假別的給薪與額度依公司制度及審核結果處理。"} />
        <div className="hr-form-field-row">
          <TextField label="開始（台北時間）" type="datetime-local" step="1800" required value={start} disabled={disabled} onChange={(event) => { const value = event.target.value; setStart(value); if (end && end <= value) setEnd(""); }} />
          <TextField label="結束（台北時間）" type="datetime-local" step="1800" required min={start} value={end} disabled={disabled} onChange={(event) => { setEnd(event.target.value); setHoursDraft(null); }} />
        </div>
        <TextField label="請假時數（小時）" type="text" inputMode="decimal" value={hoursDraft ?? (calculated && durationValid ? hoursText(calculated.durationMinutes) : "")} disabled={disabled} onChange={(event) => setHoursDraft(event.target.value)} onBlur={() => { if (!hoursDraft?.trim()) setHoursDraft(null); }} hint={hoursPending ? "換算結束時間中…" : "填時數會依班表與休息時間換算結束時間。"} error={hoursInvalid ? "請假時數必須是 0.5 小時的倍數，最多 744 小時。" : hoursPending ? undefined : leaveEnd.error?.message} />
        <div className="hr-leave-duration-card" aria-live="polite">
          <div><span>系統計算時數</span><strong>{duration.isPending ? "計算中…" : calculated && durationValid ? formatHours(calculated.durationMinutes) : "尚未完成計算"}</strong></div>
          {calculated ? <small>{calculated.startsOn}～{dateBefore(calculated.endsOn)}，依實際工作日與休息時間計算</small> : null}
        </div>
        {selectedType?.leaveKind === "annual" ? <div className="hr-leave-credit-card" aria-live="polite">
          <div><span>可用特休額度</span><strong>{credit && credit.balanceHalfHours > 0 ? formatHours(credit.balanceHalfHours * 30) : "此時段沒有可用額度"}</strong></div>
          {credit && credit.balanceHalfHours > 0 ? <small>額度週期：{credit.periodStart}～{dateBefore(credit.periodEnd)}；送出後核准才會扣除。</small> : <small>請調整日期至可用額度週期內，或聯絡管理者確認額度。</small>}
        </div> : null}
        <Field label="請假原因（選填）"><textarea maxLength={1000} rows={5} value={reason} disabled={disabled} onChange={(event) => setReason(event.target.value)} placeholder="請說明請假原因（選填）" /></Field>
      </div>
      {leaveTypes.error ? <Alert tone="danger">{leaveTypes.error.message}</Alert> : null}
      {duration.error ? <Alert tone="danger">{duration.error.message}</Alert> : null}
      {selectedType?.leaveKind === "annual" && calculated && !hasEnoughCredit ? <Alert tone="warning">所選時段超過可用特休額度，請縮短時數或調整到其他額度週期。</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="hr-form-actions"><Button size="lg" variant="secondary" onClick={() => navigate("/forms?tab=leave")} disabled={disabled}>取消</Button><Button size="lg" tone={editing || copying ? "info" : "success"} loading={save.isPending} onClick={submit} disabled={!canSubmit}>{editing ? "更新請假申請" : copying ? "重新送出請假申請" : "送出請假申請"}</Button></div>
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
      navigate("/forms?tab=clock_correction", { replace: true, state: { from: location.pathname } });
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
        <Button size="lg" variant="secondary" disabled={saving} onClick={() => navigate(returnTo)}>取消</Button>
        <Button size="lg" tone="success" loading={saving} loadingLabel="送出中…" disabled={!approverUserId} onClick={() => { void submit(); }}>送出補打卡申請</Button>
      </div>
    </Panel>
  </div>;
}
