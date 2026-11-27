import { taipeiMinuteFromUtcWallClock } from "@rueisiang/db/taipei-time";
import { useRef, useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, EmptyState, Page, PageHeader, Panel, StatusBadge, TextField } from "../../ui/index.js";
import { useAccountingQuery, useAccountingWrite, type PettyCashEntry, type PettyCashLedger } from "./api.js";

/*
 * 零用金：全公司一個錢箱。餘額與每一筆進出（增加、報帳撥款、退回）都在這一頁。
 * 紀錄不能改、不能刪；會計只能增加，錢只會因為報帳撥款出去（使用者決定不要手動減少）。
 * 「增加」打錯金額就按那一筆的「更正」輸入正確金額：記一筆差額。可以更正很多次；更正不另佔一列，
 * 那一筆增加直接顯示更正後的金額，每次增減的金額與原因寫在下面當備註（使用者決定）。
 */

type CloseRef = { current: ((afterClose?: () => void) => void) | null };

const KIND: Record<PettyCashEntry["kind"], { label: string; tone: "success" | "warning" | "info" | "neutral" }> = {
  top_up: { label: "增加", tone: "success" },
  payout: { label: "報帳撥款", tone: "info" },
  refund: { label: "退回", tone: "neutral" },
};

function dollars(amountMinor: number) {
  return `NT$ ${(amountMinor / 100).toLocaleString("zh-TW")}`;
}

function signed(amountMinor: number) {
  return `${amountMinor > 0 ? "+" : "−"}${dollars(Math.abs(amountMinor))}`;
}

function TopUpDialog({ onClose }: { onClose: () => void }) {
  const closeRef: CloseRef = useRef(null);
  const write = useAccountingWrite();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const ready = /^\d+$/.test(amount) && Number(amount) >= 1;
  const close = () => (closeRef.current ?? ((after?: () => void) => after?.()))(onClose);
  return <Dialog
    title="增加零用金"
    onClose={onClose}
    closeRequestRef={closeRef}
    closeDisabled={write.isPending}
    actions={<>
      <Button variant="secondary" disabled={write.isPending} onClick={close}>取消</Button>
      <Button tone="success" loading={write.isPending} disabled={!ready}
        onClick={() => write.mutate({ path: "/petty-cash", method: "POST", values: { amountDollars: Number(amount), note } }, { onSuccess: close })}>
        增加
      </Button>
    </>}
  >
    <TextField label="金額（元）" required inputMode="numeric" autoFocus value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, "").slice(0, 8))} />
    <TextField label="備註" maxLength={500} value={note} placeholder="選填" onChange={(event) => setNote(event.target.value)} />
    {write.error ? <Alert tone="danger">{write.error.message}</Alert> : null}
  </Dialog>;
}

function CorrectDialog({ entry, onClose }: { entry: PettyCashEntry; onClose: () => void }) {
  const closeRef: CloseRef = useRef(null);
  const write = useAccountingWrite();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const correctMinor = /^\d+$/.test(amount) ? Number(amount) * 100 : null;
  const delta = correctMinor === null ? null : correctMinor - entry.amountMinor;
  const ready = delta !== null && delta !== 0 && note.trim();
  const close = () => (closeRef.current ?? ((after?: () => void) => after?.()))(onClose);
  return <Dialog
    title="更正金額"
    onClose={onClose}
    closeRequestRef={closeRef}
    closeDisabled={write.isPending}
    actions={<>
      <Button variant="secondary" disabled={write.isPending} onClick={close}>取消</Button>
      <Button tone="success" loading={write.isPending} disabled={!ready}
        onClick={() => write.mutate({ path: `/petty-cash/${encodeURIComponent(entry.id)}/correct`, method: "POST", values: { amountDollars: Number(amount), note } }, { onSuccess: close })}>
        更正
      </Button>
    </>}
  >
    <p className="m-0 text-[14px] text-muted">{`${taipeiMinuteFromUtcWallClock(entry.createdAt)} 的增加，目前是 ${dollars(entry.amountMinor)}`}</p>
    <TextField label="正確金額（元）" required inputMode="numeric" autoFocus value={amount}
      hint={delta ? `會記一筆 ${signed(delta)}` : undefined}
      onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, "").slice(0, 8))} />
    <TextField label="更正原因" required maxLength={500} value={note} placeholder="例如：多打了一個 0" onChange={(event) => setNote(event.target.value)} />
  </Dialog>;
}

export function AccountingPettyCash() {
  usePageTitle("零用金");
  const { permissions } = useSession();
  const canWrite = permissions.has("accounting:petty-cash:write");
  const query = useAccountingQuery<PettyCashLedger>("/petty-cash");
  const [toppingUp, setToppingUp] = useState(false);
  const [correcting, setCorrecting] = useState<PettyCashEntry | null>(null);
  const entries = query.data?.entries ?? [];

  return <Page layout="fills">
    <PageHeader title="零用金" actions={canWrite ? <Button tone="success" icon="plus" disabled={!query.data} onClick={() => setToppingUp(true)}>增加</Button> : null} />
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
              {canWrite ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => <tr key={entry.id}>
              <td data-label="時間" className="tabular-nums">{taipeiMinuteFromUtcWallClock(entry.createdAt)}</td>
              <td data-label="種類"><StatusBadge tone={KIND[entry.kind].tone}>{KIND[entry.kind].label}</StatusBadge></td>
              <td data-label="內容">
                <span className="line-clamp-2 wrap-anywhere">{entry.expenseDescription ?? (entry.note || "—")}</span>
                {entry.corrections.map((item) => <span key={item.id} className="block text-[13px] text-muted wrap-anywhere">{`更正 ${signed(item.amountMinor)}：${item.note}`}</span>)}
              </td>
              <td data-label="經手人">{entry.actorName}</td>
              <td data-label="金額" className="numeric">{signed(entry.amountMinor)}</td>
              <td data-label="餘額" className="numeric">{dollars(entry.balanceAfterMinor)}</td>
              {canWrite ? <td data-label="操作">{entry.kind === "top_up" ? <Button variant="secondary" onClick={() => setCorrecting(entry)}>更正</Button> : null}</td> : null}
            </tr>)}
          </tbody>
        </DataTable>}
    </Panel>
    {toppingUp ? <TopUpDialog onClose={() => setToppingUp(false)} /> : null}
    {correcting ? <CorrectDialog entry={correcting} onClose={() => setCorrecting(null)} /> : null}
  </Page>;
}
