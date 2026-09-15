import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, Field, PageHeader, Panel, SelectField, StatusBadge, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type FormApproversResponse, type FormRequest, type FormRequestStatus, type OvertimeRequest } from "./api.js";

const statusCopy: Record<FormRequestStatus, { label: string; tone: "neutral" | "info" | "success" | "danger" }> = {
  draft: { label: "草稿", tone: "neutral" },
  pending: { label: "申請中", tone: "info" },
  approved: { label: "已核准", tone: "success" },
  rejected: { label: "已駁回", tone: "danger" },
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

function formLabel(request: FormRequest) {
  return `${request.correctionDate} ${request.requestedEventKind === "clock_in" ? "上班" : "下班"}補打卡`;
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

function ReviewDialog({ request, onClose }: { request: FormRequest; onClose: () => void }) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const review = useHrWrite();

  async function submit(decision: "approved" | "rejected") {
    if (decision === "rejected" && !comment.trim()) {
      setError("駁回時請填寫審核意見。");
      return;
    }
    setError("");
    try {
      await review.mutateAsync({ path: `/me/form-requests/${request.id}/review`, method: "POST", values: { decision, comment: comment.trim() } });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "審核失敗，請稍後再試。");
    }
  }

  return <Dialog title="審核補打卡申請" titleMeta={request.requesterName ?? request.employeeUserId} onClose={onClose} closeDisabled={review.isPending} actions={<>
    <Button variant="secondary" disabled={review.isPending} onClick={onClose}>取消</Button>
    <Button variant="danger" disabled={review.isPending} onClick={() => { void submit("rejected"); }}>駁回</Button>
    <Button loading={review.isPending} loadingLabel="核准中…" onClick={() => { void submit("approved"); }}>核准</Button>
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
  const [reviewing, setReviewing] = useState<FormRequest | null>(null);
  const query = useHrQuery<{ requests: FormRequest[]; reviewRequests: FormRequest[] }>("/me/form-requests");
  const overtime = useHrQuery<{ requests: OvertimeRequest[] }>("/me/overtime");
  const data = query.data;
  return <div className="page hr-forms-page">
    <PageHeader title="表單申請" description="補打卡與加班申請送出後，會保留申請紀錄並交由管理流程審核。" actions={<div className="button-row"><Button variant="secondary" icon="plus" onClick={() => navigate("/forms/overtime")}>新增加班</Button><Button icon="plus" onClick={() => navigate("/forms/new")}>新增補打卡</Button></div>} />
    {query.isPending ? <p className="muted">載入申請單…</p> : null}
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    {data?.reviewRequests.length ? <Panel className="hr-form-review-panel">
      <div className="panel-head"><div><h2>待我審核</h2><p className="muted">只顯示指定你為審核者、且尚未完成處理的申請。</p></div></div>
      <div className="hr-form-request-list">{data.reviewRequests.map((request) => <article className="hr-form-request-card review" key={request.id}>
        <RequestSummary request={request} reviewer />
        <div className="hr-form-review-actions"><Button onClick={() => setReviewing(request)}>審核</Button></div>
      </article>)}</div>
    </Panel> : null}
    <Panel>
      <div className="panel-head"><div><h2>我的加班申請</h2><p className="muted">加班與特殊上班日分開；只有核准且選擇付薪的時段才會進入薪資試算。</p></div></div>
      {overtime.error ? <Alert tone="danger">{overtime.error.message}</Alert> : null}
      {overtime.data?.requests.length ? <div className="hr-form-request-list">{overtime.data.requests.map((item) => <article className="hr-form-request-card" key={item.request.id}><div className="hr-form-request-title"><strong>{formatTaipei(item.request.requestedStart)}～{formatTaipei(item.request.requestedEnd)}</strong><StatusBadge tone={item.request.status === "approved" ? "success" : item.request.status === "rejected" ? "danger" : "info"}>{item.request.status === "pending" ? "申請中" : item.request.status === "approved" ? "已核准" : item.request.status === "rejected" ? "已駁回" : item.request.status === "cancelled" ? "已取消" : "草稿"}</StatusBadge></div><p>{item.request.settlementKind === "pay" ? "付薪" : "補休"}・倍率 {(item.request.ratePpm / 10_000).toFixed(2)}%・{item.request.reason}</p>{item.request.decisionReason ? <small>審核意見：{item.request.decisionReason}</small> : null}</article>)}</div> : <p className="muted">目前沒有加班申請紀錄。</p>}
    </Panel>
    <Panel>
      <div className="panel-head"><div><h2>我的補打卡申請</h2><p className="muted">可查看草稿、申請中、已核准與已駁回的處理進度。</p></div></div>
      {data?.requests.length ? <div className="hr-form-request-list">{data.requests.map((request) => <article className="hr-form-request-card" key={request.id}>
        <RequestSummary request={request} />
        {request.status === "draft" ? <Button variant="secondary" onClick={() => navigate(`/forms/new?request=${encodeURIComponent(request.id)}`)}>繼續編輯</Button> : null}
      </article>)}</div> : <p className="muted">目前沒有申請紀錄。</p>}
    </Panel>
    {reviewing ? <ReviewDialog request={reviewing} onClose={() => setReviewing(null)} /> : null}
  </div>;
}

export function HrOvertimeForm() {
  usePageTitle("加班申請");
  const navigate = useNavigate();
  const initial = taipeiInputNow();
  const [start, setStart] = useState(`${initial.date}T18:00`);
  const [end, setEnd] = useState(`${initial.date}T20:00`);
  const [settlementKind, setSettlementKind] = useState<"pay" | "compensatory">("pay");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const save = useHrWrite();
  function stamp(value: string) {
    const normalized = `${value.replace("T", " ")}:00`;
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(normalized);
    if (!match) return normalized;
    const wallClock = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
    if (Number.isNaN(wallClock) || new Date(wallClock).toISOString().slice(0, 19).replace("T", " ") !== normalized) return normalized;
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", calendar: "gregory", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    let timestamp = wallClock;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = formatter.formatToParts(new Date(timestamp));
      const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
      const observedWallClock = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
      const correction = observedWallClock - wallClock;
      if (correction === 0) break;
      timestamp -= correction;
    }
    return new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
  }
  return <div className="page hr-form-page"><PageHeader title="加班申請" description="填寫台北時間的申請時段；倍率由公司已確認的加班制度決定，申請人不能自行修改。核准前不會進入薪資結算。" /><Panel><div className="hr-form-fields"><div className="hr-form-field-row"><TextField label="開始（台北時間）" type="datetime-local" required value={start} onChange={(event) => setStart(event.target.value)} /><TextField label="結束（台北時間）" type="datetime-local" required value={end} onChange={(event) => setEnd(event.target.value)} /></div><div className="hr-form-field-row"><SelectField label="結算方式" value={settlementKind} options={[{ value: "pay", label: "付薪" }, { value: "compensatory", label: "補休" }]} onChange={(event) => setSettlementKind(event.target.value as "pay" | "compensatory")} /><p className="form-hint">目前制度倍率：133.33%（由伺服器套用）</p></div><Field label="加班原因" required><textarea required maxLength={1000} rows={5} value={reason} onChange={(event) => setReason(event.target.value)} /></Field></div>{error ? <Alert tone="danger">{error}</Alert> : null}<div className="hr-form-actions"><Button variant="secondary" onClick={() => navigate("/forms")}>取消</Button><Button loading={save.isPending} onClick={() => { setError(""); save.mutate({ path: "/me/overtime", method: "POST", values: { requestedStart: stamp(start), requestedEnd: stamp(end), settlementKind, reason } }, { onSuccess: () => navigate("/forms", { replace: true }), onError: (cause) => setError(cause.message) }); }}>送出加班申請</Button></div></Panel></div>;
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

  async function submit(saveAndSubmit: boolean) {
    setLocalError("");
    const values = { correctionDate, requestedTime, requestedEventKind, reason, approverUserId: approverUserId || null };
    try {
      const saved = await save.mutateAsync({ path: requestId ? `/me/form-requests/${requestId}` : "/me/form-requests", method: requestId ? "PATCH" : "POST", values });
      if (saveAndSubmit) await save.mutateAsync({ path: `/me/form-requests/${saved.id}/submit`, method: "POST", values: {} });
      navigate("/forms", { replace: true, state: { from: location.pathname } });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "申請單儲存失敗，請稍後再試。");
    }
  }

  if (existing.isPending) return <div className="page"><p className="muted">載入申請單…</p></div>;
  if (existing.error) return <div className="page"><Alert tone="danger">{existing.error.message}</Alert></div>;
  if (existing.data?.request.status !== undefined && existing.data.request.status !== "draft") return <div className="page"><Alert tone="info">這份申請單已送出，無法再修改。</Alert><Button variant="secondary" onClick={() => navigate("/forms")}>返回表單申請</Button></div>;

  const approverOptions = [
    { label: "請選擇審核者", value: "" },
    ...(approvers.data?.approvers ?? []).map((approver) => ({ label: approver.name, value: approver.id })),
  ];
  return <div className="page hr-form-page">
    <PageHeader title="補打卡申請單" description="補登實際應出勤時間，送出後由指定審核者確認。" />
    <Panel>
      <div className="hr-form-type-card"><span className="hr-form-type-icon">補</span><div><strong>補打卡</strong><small>目前開放的表單</small></div></div>
      <div className="hr-form-fields">
        <div className="hr-form-field-row">
          <TextField label="補打卡日期" required type="date" value={correctionDate} onChange={(event) => setCorrectionDate(event.target.value)} />
          <TextField label="補打卡時間" required type="time" value={requestedTime} onChange={(event) => setRequestedTime(event.target.value)} />
        </div>
        <SelectField label="補登類型" required value={requestedEventKind} onChange={(event) => setRequestedEventKind(event.target.value as "clock_in" | "clock_out")} options={[{ label: "上班打卡", value: "clock_in" }, { label: "下班打卡", value: "clock_out" }]} />
        <SelectField label="審核者" required value={approverUserId} onChange={(event) => setApproverUserId(event.target.value)} options={approverOptions} hint={approvers.data?.defaultApproverUserId ? "預設帶入後台設定的員工主管，可依需要改選其他審核者。" : "尚未設定員工主管，請先選擇一位啟用中的員工審核。"} />
        <Field label="申請原因" required hint="最多 1000 字，請說明未能正常打卡的原因。">
          <textarea required maxLength={1000} rows={5} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：手機當日故障，抵達辦公位置後無法完成打卡。" />
        </Field>
      </div>
      {approvers.error ? <Alert tone="danger">{approvers.error.message}</Alert> : null}
      {localError ? <Alert tone="danger">{localError}</Alert> : null}
      {save.isPending ? <p className="form-hint">正在儲存申請單…</p> : null}
      <div className="hr-form-actions">
        <Button variant="secondary" disabled={save.isPending} onClick={() => navigate("/forms")}>取消</Button>
        <Button variant="secondary" disabled={save.isPending} onClick={() => { void submit(false); }}>儲存草稿</Button>
        <Button disabled={save.isPending || !approverUserId} onClick={() => { void submit(true); }}>送出申請</Button>
      </div>
    </Panel>
  </div>;
}
