import { parseDbDate } from "@rueisiang/db/db-timestamp";
import { useState } from "react";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Panel, StatusBadge } from "../../ui/index.js";
import { useHrQuery, useHrWrite } from "./api.js";

interface RfidCard { id: string; cardCode: string; protocolCode: string; linkedAt: string }
interface Enrollment { id: string; status: "listening" | "captured" | "confirmed" | "cancelled" | "expired"; candidateCardCode: string | null; candidateProtocolCode: string | null; scannedAt: string | null }

function dateTime(value: string) {
  const parsed = parseDbDate(value);
  return parsed ? parsed.toLocaleString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" }) : value;
}

export function EmployeeRfidCard({ employmentId, active, canRead, canWrite }: { employmentId: string; active: boolean; canRead: boolean; canWrite: boolean }) {
  const toast = useToast();
  const [sessionId, setSessionId] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const card = useHrQuery<{ card: RfidCard | null }>(`/employments/${encodeURIComponent(employmentId)}/rfid-card`, canRead, { keepPreviousData: false });
  const enrollment = useHrQuery<{ enrollment: Enrollment }>(`/employments/${encodeURIComponent(employmentId)}/rfid-enrollments/${encodeURIComponent(sessionId)}`, Boolean(sessionId), { keepPreviousData: false, refetchInterval: sessionId ? 1000 : false });
  const start = useHrWrite<{ sessionId: string }>();
  const confirm = useHrWrite<{ card: RfidCard }>();
  const cancel = useHrWrite();
  const revoke = useHrWrite();
  const current = card.data?.card;
  const pending = start.isPending || confirm.isPending || cancel.isPending || revoke.isPending;
  const begin = () => start.mutate({ path: `/employments/${encodeURIComponent(employmentId)}/rfid-enrollments`, method: "POST", values: {} }, { onSuccess: (result) => setSessionId(result.sessionId) });
  const stop = (afterStop?: () => void) => {
    if (!sessionId) return;
    cancel.mutate({ path: `/employments/${encodeURIComponent(employmentId)}/rfid-enrollments/${encodeURIComponent(sessionId)}/cancel`, method: "POST", values: {} }, { onSuccess: () => { setSessionId(""); afterStop?.(); } });
  };
  const session = enrollment.data?.enrollment;

  return <Panel id="employee-rfid" title="RFID 卡片" description="卡片綁定後可供後續打卡流程識別員工；卡號不是安全認證方式。">
    {!canRead ? <p className="text-muted">卡片資料僅限員工管理權限查看。</p> : card.isPending ? <p className="text-muted">載入卡片資料…</p> : card.error ? <Alert tone="danger">{card.error.message}</Alert> : <>
      {current ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-soft-line p-4">
        <div><div className="flex flex-wrap items-center gap-2"><StatusBadge tone="success">已綁定</StatusBadge><span className="font-semibold text-ink">{current.protocolCode} · {current.cardCode}</span></div><p className="mb-0 mt-2 text-sm text-muted">綁定時間：{dateTime(current.linkedAt)}</p></div>
        {canWrite ? <Button variant="secondary" tone="danger" disabled={pending} onClick={() => setConfirmRevoke(true)}>解除卡片</Button> : null}
      </div> : <p className="text-muted">尚未綁定 RFID 卡片。</p>}
      {active && canWrite && !sessionId ? <div className="mt-4 flex flex-wrap items-center gap-3"><Button icon="key" tone="success" loading={start.isPending} onClick={begin}>{current ? "重新感應綁定" : "開始感應新卡"}</Button><span className="text-sm text-muted">開始後請在 2 分鐘內感應卡片，再確認卡號。</span></div> : null}
      {!active ? <p className="text-muted">未在職員工不能新增卡片綁定。</p> : null}
      {sessionId ? <div className="mt-4 rounded-card border border-soft-line p-4" aria-live="polite">
        {!session ? <p className="text-muted">已開始等待 Gateway 傳入感應資料…</p> : session.status === "listening" ? <><p className="mb-3 font-semibold text-ink">等待卡片感應，請將要綁定的新卡靠近讀卡器。</p><Button variant="secondary" disabled={pending} loading={cancel.isPending} onClick={() => stop()}>取消感應</Button></> : session.status === "captured" ? <>
          <Alert tone="info">已讀取卡片：<strong>{session.candidateProtocolCode} · {session.candidateCardCode}</strong>。確認後會綁定到這位員工{current ? "並取代原卡片" : ""}。</Alert>
          {session.scannedAt ? <p className="text-sm text-muted">感應時間：{dateTime(session.scannedAt)}</p> : null}
          <div className="flex flex-wrap justify-end gap-2"><Button variant="secondary" disabled={pending} loading={cancel.isPending} onClick={() => stop(begin)}>重新感應</Button><Button icon="check" tone="success" disabled={pending} loading={confirm.isPending} onClick={() => confirm.mutate({ path: `/employments/${encodeURIComponent(employmentId)}/rfid-enrollments/${encodeURIComponent(sessionId)}/confirm`, method: "POST", values: {} }, { onSuccess: () => { setSessionId(""); void card.refetch(); toast.show("RFID 卡片已綁定", "success"); } })}>確認綁定</Button></div>
        </> : session.status === "expired" ? <><Alert tone="warning">感應時間已到，請重新開始。</Alert><Button variant="secondary" onClick={() => setSessionId("")}>關閉</Button></> : <><Alert tone={session.status === "confirmed" ? "success" : "neutral"}>{session.status === "confirmed" ? "卡片已完成綁定。" : "感應已取消。"}</Alert><Button variant="secondary" onClick={() => setSessionId("")}>關閉</Button></>}
        {enrollment.error ? <Alert tone="danger">{enrollment.error.message}</Alert> : null}
      </div> : null}
    </>}
    {confirmRevoke ? <ConfirmDialog title="解除員工 RFID 卡片？" confirmLabel="解除卡片" pending={revoke.isPending} onCancel={() => setConfirmRevoke(false)} onConfirm={() => revoke.mutate({ path: `/employments/${encodeURIComponent(employmentId)}/rfid-card`, method: "DELETE", values: {} }, { onSuccess: () => { setConfirmRevoke(false); void card.refetch(); toast.show("RFID 卡片已解除", "success"); } })}><p>解除後，這張卡片不會再對應到該員工；既有打卡歷史不會刪除。</p>{revoke.error ? <Alert tone="danger">{revoke.error.message}</Alert> : null}</ConfirmDialog> : null}
  </Panel>;
}
