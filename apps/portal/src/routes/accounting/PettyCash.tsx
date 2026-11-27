import { taipeiMinuteFromUtcWallClock } from "@rueisiang/db/taipei-time";
import { useRef, useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, EmptyState, Page, PageHeader, Panel, StatusBadge, TextField } from "../../ui/index.js";
import { useAccountingQuery, useAccountingWrite, type PettyCashEntry, type PettyCashLedger } from "./api.js";

/*
 * 零用金：全公司一個錢箱。餘額與每一筆進出（增加、減少、報帳撥款、退回）都在這一頁。
 * 紀錄不能改、不能刪；輸入錯了就再記一筆「減少」或「增加」並寫原因。
 */

type CloseRef = { current: ((afterClose?: () => void) => void) | null };

const KIND: Record<PettyCashEntry["kind"], { label: string; tone: "success" | "warning" | "info" | "neutral" }> = {
  top_up: { label: "增加", tone: "success" },
  reduce: { label: "減少", tone: "warning" },
  payout: { label: "報帳撥款", tone: "info" },
  refund: { label: "退回", tone: "neutral" },
};

function dollars(amountMinor: number) {
  return `NT$ ${(amountMinor / 100).toLocaleString("zh-TW")}`;
}

function signed(amountMinor: number) {
  return `${amountMinor > 0 ? "+" : "−"}${dollars(Math.abs(amountMinor))}`;
}

function AdjustDialog({ kind, onClose }: { kind: "top_up" | "reduce"; onClose: () => void }) {
  const closeRef: CloseRef = useRef(null);
  const write = useAccountingWrite();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const reduce = kind === "reduce";
  const ready = /^\d+$/.test(amount) && Number(amount) >= 1 && (!reduce || note.trim());
  const close = () => (closeRef.current ?? ((after?: () => void) => after?.()))(onClose);
  return <Dialog
    title={reduce ? "減少零用金" : "增加零用金"}
    onClose={onClose}
    closeRequestRef={closeRef}
    closeDisabled={write.isPending}
    actions={<>
      <Button variant="secondary" disabled={write.isPending} onClick={close}>取消</Button>
      <Button tone={reduce ? undefined : "success"} variant={reduce ? "danger" : undefined} loading={write.isPending} disabled={!ready}
        onClick={() => write.mutate({ path: "/petty-cash", method: "POST", values: { kind, amountDollars: Number(amount), note } }, { onSuccess: close })}>
        {reduce ? "減少" : "增加"}
      </Button>
    </>}
  >
    <TextField label="金額（元）" required inputMode="numeric" autoFocus value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, "").slice(0, 8))} />
    <TextField label="原因" required={reduce} maxLength={500} value={note} placeholder={reduce ? "例如：上一筆多打了一個 0" : "選填"} onChange={(event) => setNote(event.target.value)} />
    {write.error ? <Alert tone="danger">{write.error.message}</Alert> : null}
  </Dialog>;
}

export function AccountingPettyCash() {
  usePageTitle("零用金");
  const { permissions } = useSession();
  const canWrite = permissions.has("accounting:petty-cash:write");
  const query = useAccountingQuery<PettyCashLedger>("/petty-cash");
  const [adjusting, setAdjusting] = useState<"top_up" | "reduce" | null>(null);
  const entries = query.data?.entries ?? [];

  return <Page layout="fills">
    <PageHeader title="零用金" actions={canWrite ? <>
      <Button variant="secondary" disabled={!query.data} onClick={() => setAdjusting("reduce")}>減少</Button>
      <Button tone="success" icon="plus" disabled={!query.data} onClick={() => setAdjusting("top_up")}>增加</Button>
    </> : null} />
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    <Panel grows>
      {query.data ? <p className="m-0 mb-4 flex items-baseline gap-3">
        <span className="text-[14px] text-muted">目前餘額</span>
        <span className="text-[28px] font-semibold tabular-nums">{dollars(query.data.balanceMinor)}</span>
      </p> : null}
      {query.isPending ? <p className="text-muted">載入零用金…</p>
        : entries.length === 0 ? <EmptyState>還沒有任何紀錄。</EmptyState>
        : <DataTable>
          <thead>
            <tr>
              <th>時間</th>
              <th>種類</th>
              <th>內容</th>
              <th>經手人</th>
              <th className="numeric">金額</th>
              <th className="numeric">餘額</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => <tr key={entry.id}>
              <td data-label="時間" className="tabular-nums">{taipeiMinuteFromUtcWallClock(entry.createdAt)}</td>
              <td data-label="種類"><StatusBadge tone={KIND[entry.kind].tone}>{KIND[entry.kind].label}</StatusBadge></td>
              <td data-label="內容"><span className="line-clamp-2 wrap-anywhere">{entry.expenseDescription ?? (entry.note || "—")}</span></td>
              <td data-label="經手人">{entry.actorName}</td>
              <td data-label="金額" className="numeric">{signed(entry.amountMinor)}</td>
              <td data-label="餘額" className="numeric">{dollars(entry.balanceAfterMinor)}</td>
            </tr>)}
          </tbody>
        </DataTable>}
    </Panel>
    {adjusting ? <AdjustDialog kind={adjusting} onClose={() => setAdjusting(null)} /> : null}
  </Page>;
}
