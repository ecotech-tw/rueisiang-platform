import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, Field, PageHeader, Panel } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type HrOvertimeRequest } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

function taipeiInputValue(value: string) {
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(parsed);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
function taipeiDisplayValue(value: string) {
  const inputValue = taipeiInputValue(value);
  return inputValue ? inputValue.replace("T", " ") : value;
}

function ReviewDialog({ item, onClose, onDone }: { item: HrOvertimeRequest; onClose: () => void; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const [actualStart, setActualStart] = useState(() => taipeiInputValue(item.request.requestedStart));
  const [actualEnd, setActualEnd] = useState(() => taipeiInputValue(item.request.requestedEnd));
  const review = useHrWrite();
  function decide(decision: "approved" | "rejected") {
    if (decision === "rejected" && !comment.trim()) return;
    review.mutate({ path: `/overtime/${item.request.id}/review`, method: "POST", values: { decision, comment, actualStart, actualEnd } }, { onSuccess: () => { onDone(); onClose(); } });
  }
  return <Dialog title="審核加班申請" titleMeta={`${item.employeeName ?? "員工"}・${item.employeeNumber ?? ""}`} onClose={onClose} closeDisabled={review.isPending} actions={<><Button variant="secondary" onClick={onClose}>取消</Button><Button variant="danger" loading={review.isPending} onClick={() => decide("rejected")} disabled={!comment.trim()}>駁回</Button><Button loading={review.isPending} onClick={() => decide("approved")}>核准</Button></>}><dl><dt>申請時段（台北）</dt><dd>{taipeiDisplayValue(item.request.requestedStart)}～{taipeiDisplayValue(item.request.requestedEnd)}</dd><dt>結算方式</dt><dd>{item.request.settlementKind === "pay" ? "付薪" : "補休"}・伺服器制度倍率 {(item.request.ratePpm / 10_000).toFixed(2)}%</dd><dt>原因</dt><dd>{item.request.reason}</dd></dl><div className="form-grid two"><Field label="實際開始（台北）" hint="可縮短，不能超出申請時段"><input type="datetime-local" step="60" value={actualStart} onChange={(event) => setActualStart(event.target.value)} /></Field><Field label="實際結束（台北）"><input type="datetime-local" step="60" value={actualEnd} onChange={(event) => setActualEnd(event.target.value)} /></Field></div><Field label="審核意見" hint="駁回時必填"><textarea rows={4} maxLength={1000} value={comment} onChange={(event) => setComment(event.target.value)} /></Field>{review.error ? <Alert tone="danger">{review.error.message}</Alert> : null}</Dialog>;
}

export function HrOvertimeRequests() {
  usePageTitle("加班審核"); const { permissions } = useSession(); const canRead = permissions.has("hr:request:review"); const query = useHrQuery<{ requests: HrOvertimeRequest[] }>("/overtime", canRead); const [reviewing, setReviewing] = useState<HrOvertimeRequest | null>(null);
  if (!canRead) return <Alert tone="danger">你沒有審核加班申請的權限。</Alert>;
  if (query.isPending) return <HrPageSkeleton variant="table" />;
  const pending = query.data?.requests.filter((item) => item.request.status === "pending") ?? [];
  return <div className="page fills"><PageHeader title="加班審核" description="加班申請與特殊上班日分開；只有核准且選擇付薪的時段才會進入薪資試算。" /><Panel className="grows">{query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}<div className="table-scroll"><table className="data-table"><thead><tr><th>員工</th><th>申請時段</th><th>方式</th><th>倍率</th><th>原因</th><th>狀態</th><th>操作</th></tr></thead><tbody>{(query.data?.requests ?? []).map((item) => <tr key={item.request.id}><td>{item.employeeName ?? "—"}<small className="muted">{item.employeeNumber}</small></td><td>{taipeiDisplayValue(item.request.requestedStart)}<br />～{taipeiDisplayValue(item.request.requestedEnd)}</td><td>{item.request.settlementKind === "pay" ? "付薪" : "補休"}</td><td>{(item.request.ratePpm / 10_000).toFixed(2)}%（制度）</td><td>{item.request.reason}</td><td>{item.request.status === "pending" ? "待審核" : item.request.status === "approved" ? "已核准" : item.request.status === "rejected" ? "已駁回" : item.request.status}</td><td>{item.request.status === "pending" ? <Button variant="secondary" onClick={() => setReviewing(item)}>審核</Button> : "—"}</td></tr>)}</tbody></table></div>{!pending.length ? <p className="empty-state">目前沒有待審核加班申請。</p> : null}</Panel>{reviewing ? <ReviewDialog item={reviewing} onClose={() => setReviewing(null)} onDone={() => void query.refetch()} /> : null}</div>;
}
