import { taipeiMinuteFromUtcWallClock } from "@rueisiang/db/taipei-time";
import { useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, EmptyState, Field, Page, PageHeader, PageTabControl, Panel, StatusBadge, Textarea } from "../../ui/index.js";
import { receiptUrl, useAccountingQuery, useAccountingWrite, type ExpenseStatus, type ExpenseStatusFilter, type ReviewExpense } from "./api.js";

/*
 * 會計看報帳的唯一一頁：審核、撥款、查紀錄都在這裡，用狀態分頁切，不另開頁面。
 * 動作都在明細裡（看得到單據照片才能審），清單只放摘要。
 */

const STATUS_TABS: { value: ExpenseStatusFilter; label: string }[] = [
  { value: "pending", label: "待審核" },
  { value: "approved", label: "待撥款" },
  { value: "paid", label: "已付款" },
  { value: "rejected", label: "已退回" },
  { value: "all", label: "全部" },
];

const STATUS_BADGE: Record<ExpenseStatus, { label: string; tone: "info" | "warning" | "success" | "danger" | "neutral" }> = {
  pending: { label: "待審核", tone: "info" },
  approved: { label: "待撥款", tone: "warning" },
  paid: { label: "已付款", tone: "success" },
  rejected: { label: "已退回", tone: "danger" },
  cancelled: { label: "已撤回", tone: "neutral" },
};

type CloseRef = { current: ((afterClose?: () => void) => void) | null };

function dollars(amountMinor: number) {
  return `NT$ ${(amountMinor / 100).toLocaleString("zh-TW")}`;
}

function requestClose(ref: CloseRef, afterClose: () => void) {
  (ref.current ?? ((after?: () => void) => after?.()))(afterClose);
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-baseline justify-between gap-4 py-2.5">
    <dt className="shrink-0 text-[13px] text-muted">{label}</dt>
    <dd className="m-0 min-w-0 text-right text-[14px] wrap-anywhere">{children}</dd>
  </div>;
}

function ExpenseDetail({ expense, canReview, isOwn, onClose }: { expense: ReviewExpense; canReview: boolean; isOwn: boolean; onClose: () => void }) {
  const closeRef: CloseRef = useRef(null);
  const write = useAccountingWrite();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const badge = STATUS_BADGE[expense.status];
  const act = (action: "approve" | "reject" | "paid", values: Record<string, unknown> = {}) => write.mutate(
    { path: `/expenses/${encodeURIComponent(expense.id)}/${action}`, method: "POST", values: { revision: expense.revision, ...values } },
    { onSuccess: () => requestClose(closeRef, onClose) },
  );
  const close = () => requestClose(closeRef, onClose);
  const reviewable = canReview && !isOwn;

  const actions = rejecting
    ? <>
      <Button variant="secondary" disabled={write.isPending} onClick={() => setRejecting(false)}>取消</Button>
      <Button variant="danger" loading={write.isPending} disabled={!note.trim()} onClick={() => act("reject", { note })}>確認退回</Button>
    </>
    : <>
      {reviewable && expense.status === "pending" ? <>
        <Button variant="secondary" disabled={write.isPending} onClick={() => setRejecting(true)}>退回</Button>
        <Button tone="success" loading={write.isPending} onClick={() => act("approve", { payoutMethod: "direct" })}>核准（直接撥款）</Button>
      </> : null}
      {reviewable && expense.status === "approved" && expense.payoutMethod === "direct"
        ? <Button tone="success" loading={write.isPending} onClick={() => act("paid")}>標記已撥款</Button> : null}
      <Button variant="secondary" disabled={write.isPending} onClick={close}>關閉</Button>
    </>;

  return <Dialog title={dollars(expense.amountMinor)} titleMeta={<StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>} onClose={onClose} closeRequestRef={closeRef} closeDisabled={write.isPending} actions={actions}>
    <p className="m-0 text-[15px] font-semibold wrap-anywhere">{expense.description}</p>
    {isOwn && canReview && (expense.status === "pending" || expense.status === "approved") ? <Alert tone="info">這是你自己的報帳，請另一位會計或管理者處理。</Alert> : null}
    {expense.duplicateInvoiceCount > 0 ? <Alert tone="warning">{`這個發票號碼另外還有 ${expense.duplicateInvoiceCount} 張報帳單，核准前請確認不是重複報帳。`}</Alert> : null}
    {expense.status === "rejected" && expense.reviewNote ? <Alert tone="danger">{`退回原因：${expense.reviewNote}`}</Alert> : null}
    {rejecting ? <Field label="退回原因" required hint="員工會看到這段話，寫清楚要怎麼改。">
      <Textarea autoFocus maxLength={500} rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：發票抬頭不是公司，請重新開立。" />
    </Field> : null}
    {expense.receiptIds.length ? <div className="grid grid-cols-3 gap-2">
      {expense.receiptIds.map((receiptId, index) => <a key={receiptId} href={receiptUrl(expense.id, receiptId)} target="_blank" rel="noreferrer" aria-label={`開啟第 ${index + 1} 張單據`} className="block aspect-square overflow-hidden rounded-[12px] outline outline-1 -outline-offset-1 outline-black/10 transition-[scale] duration-150 ease-out active:scale-96 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary">
        <img src={receiptUrl(expense.id, receiptId)} alt="" loading="lazy" className="size-full object-cover" />
      </a>)}
    </div> : <p className="m-0 text-[13px] text-muted">沒有附單據照片（有發票號碼時照片是選填）。</p>}
    <dl className="m-0 grid divide-y divide-soft-line">
      <DetailRow label="送件人">{expense.employeeNumber ? `${expense.employeeNumber}・${expense.submitterName}` : expense.submitterName}</DetailRow>
      <DetailRow label="消費日期">{expense.spentOn}</DetailRow>
      <DetailRow label="類別">{expense.categoryName}</DetailRow>
      <DetailRow label="發票號碼"><span className="tabular-nums">{expense.invoiceNumber || "—（收據）"}</span></DetailRow>
      {expense.sellerTaxId ? <DetailRow label="賣方統編"><span className="tabular-nums">{expense.sellerTaxId}</span></DetailRow> : null}
      <DetailRow label="送件時間">{taipeiMinuteFromUtcWallClock(expense.createdAt)}</DetailRow>
      {expense.reviewerName ? <DetailRow label="審核者">{expense.reviewerName}</DetailRow> : null}
      {expense.paidAt ? <DetailRow label="撥款時間">{taipeiMinuteFromUtcWallClock(expense.paidAt)}</DetailRow> : null}
    </dl>
  </Dialog>;
}

export function AccountingExpenses() {
  usePageTitle("報帳");
  const { permissions, user } = useSession();
  const [params, setParams] = useSearchParams();
  const status = (STATUS_TABS.find((tab) => tab.value === params.get("status"))?.value ?? "pending");
  const query = useAccountingQuery<{ expenses: ReviewExpense[] }>(`/expenses?status=${status}`);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const expenses = query.data?.expenses ?? [];
  const viewing = expenses.find((expense) => expense.id === viewingId) ?? null;
  const canReview = permissions.has("accounting:expense:review");

  return <Page layout="fills">
    <PageHeader title="報帳" />
    <PageTabControl label="報帳狀態" options={STATUS_TABS} value={status} onChange={(value) => setParams(value === "pending" ? {} : { status: value }, { replace: true })} />
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    <Panel grows>
      {query.isPending ? <p className="text-muted">載入報帳…</p>
        : expenses.length === 0 ? <EmptyState>{status === "pending" ? "沒有待審核的報帳。" : "這個狀態沒有報帳。"}</EmptyState>
        : <DataTable>
          <thead>
            <tr>
              <th>消費日期</th>
              <th>送件人</th>
              <th>類別</th>
              <th>用途</th>
              <th className="numeric">金額</th>
              <th>狀態</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {expenses.map((expense) => {
              const badge = STATUS_BADGE[expense.status];
              return <tr key={expense.id}>
                <td data-label="消費日期" className="tabular-nums">{expense.spentOn}</td>
                <td data-label="送件人">{expense.submitterName}</td>
                <td data-label="類別">{expense.categoryName}</td>
                <td data-label="用途"><span className="line-clamp-2 wrap-anywhere">{expense.description}</span>{expense.duplicateInvoiceCount > 0 ? <StatusBadge tone="warning" className="mt-1">發票號碼重複</StatusBadge> : null}</td>
                <td data-label="金額" className="numeric">{dollars(expense.amountMinor)}</td>
                <td data-label="狀態"><StatusBadge tone={badge.tone}>{badge.label}</StatusBadge></td>
                <td data-label="操作"><Button variant="secondary" onClick={() => setViewingId(expense.id)}>查看</Button></td>
              </tr>;
            })}
          </tbody>
        </DataTable>}
    </Panel>
    {viewing ? <ExpenseDetail expense={viewing} canReview={canReview} isOwn={viewing.submitterUserId === user?.id} onClose={() => setViewingId(null)} /> : null}
  </Page>;
}
