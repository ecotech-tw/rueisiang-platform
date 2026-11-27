import type { CyberbizOrderRestock } from "@rueisiang/db/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Alert, Button, Field, StatusBadge, Textarea, type StatusTone } from "../../ui/index.js";

const LABELS: Record<CyberbizOrderRestock["state"], string> = {
  pending: "等待處理", checking: "核對中", applying: "送出中", applied: "已確認調整", unchanged: "無須調整",
  observed: "僅觀察・未寫入", skipped: "不適用／未執行", review: "待人工確認・不會自動重送",
};

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `讀取失敗（${response.status}）`);
  return body as T;
}

export function OrderRestockDetails({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [resolution, setResolution] = useState<"applied" | "skipped" | null>(null);
  const { permissions } = useSession();
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ["wms", "order-restock", id], enabled: open,
    queryFn: async () => readResponse<CyberbizOrderRestock>(await fetch(`/api/wms/order-restocks/${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store" })),
    staleTime: 0,
  });
  const mutation = useMutation({
    mutationFn: async (value: "applied" | "skipped") => readResponse<CyberbizOrderRestock>(await fetch(`/api/wms/order-restocks/${encodeURIComponent(id)}/resolve`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resolution: value, reason }),
    })),
    onSuccess: async () => {
      setResolution(null);
      setReason("");
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["wms", "order-restock", id] }),
        cache.invalidateQueries({ queryKey: ["wms", "activity"] }),
      ]);
    },
  });
  const row = query.data;
  const tone: StatusTone = row?.state === "review" ? "danger" : row?.state === "applied" ? "success" : "info";
  return (
    <details className="mt-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-[13px] text-brand-dark focus-visible:outline-2 focus-visible:outline-secondary">回補明細與查核</summary>
      <div className="mt-2 grid gap-3">
        {query.isPending ? <p role="status">讀取回補明細中…</p> : null}
        {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
        {row ? <>
          <div><StatusBadge tone={tone}>{LABELS[row.state]}</StatusBadge></div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px] [&_dt]:text-muted [&_dd]:m-0 [&_dd]:break-all [&_dd]:tabular-nums">
            <dt>模式</dt><dd>{row.mode === "apply" ? "實際調整" : "觀察模式（不寫庫存）"}</dd>
            <dt>訂單</dt><dd>{row.orderName}（{row.orderId}）</dd>
            <dt>事件</dt><dd>{row.phase === "create" ? "官網下單" : "取消訂單校正"}</dd>
            <dt>商品</dt><dd>{row.sku || "未能識別"} × {row.quantity}</dd>
            <dt>款式 ID</dt><dd>{row.variantId || "—"}</dd>
            <dt>調整前官網</dt><dd>{row.remoteBefore ?? "未讀取"}</dd>
            <dt>WMS 目標</dt><dd>{row.targetQuantity ?? "未確認"}</dd>
            <dt>調整後官網</dt><dd>{row.remoteAfter ?? "未確認／未寫入"}</dd>
            <dt>處理次數</dt><dd>{row.attempts}</dd>
            <dt>說明</dt><dd>{row.reason}</dd>
            <dt>追蹤編號</dt><dd>{row.id}</dd>
          </dl>
          {row.state === "review" && permissions.has("wms:sync:trigger") ? <>
            <Alert tone="info">請先在 CYBERBIZ 核對實際異動及單據。以下操作只登記查核結果，不會調整庫存或重新回補。</Alert>
            <Field label="人工查核說明" required hint="至少 5 個字，請填單據、實際調整結果及判斷依據。">
              <Textarea value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} disabled={mutation.isPending} />
            </Field>
            <div className="flex flex-wrap gap-2">
              {row.mode === "apply" && row.itemId && row.targetQuantity !== null ? <Button variant="secondary" disabled={reason.trim().length < 5 || mutation.isPending} onClick={() => { mutation.reset(); setResolution("applied"); }}>確認回補已完成</Button> : null}
              <Button variant="secondary" disabled={reason.trim().length < 5 || mutation.isPending} onClick={() => { mutation.reset(); setResolution("skipped"); }}>確認未回補且不再執行</Button>
            </div>
          </> : null}
        </> : null}
      </div>
      {resolution ? <ConfirmDialog
        title="登記人工查核結果"
        confirmLabel="確認登記"
        tone="primary"
        pending={mutation.isPending}
        onCancel={() => setResolution(null)}
        onConfirm={() => mutation.mutate(resolution)}
      >
        <p>{resolution === "applied" ? "確認原訂單回補已實際完成。之後若訂單取消，系統可能依這筆已完成紀錄進行反向校正。" : "確認本單未回補且不再執行；之後取消訂單也不會依本筆反向校正。若你已人工完成相同回補，應選擇『確認回補已完成』，不要標記為未執行。"}</p>
        <p>這裡不會呼叫庫存 API，查核人與說明會寫入操作紀錄。</p>
        {mutation.error ? <Alert tone="danger">{mutation.error.message}</Alert> : null}
      </ConfirmDialog> : null}
    </details>
  );
}
