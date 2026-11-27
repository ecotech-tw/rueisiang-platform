import { payrollPeriodLabel } from "@rueisiang/db/accounting-expense-fields";
import { taipeiMinuteFromUtcWallClock } from "@rueisiang/db/taipei-time";
import { useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, EmptyState, Field, Page, PageHeader, PageTabControl, Panel, SegmentedControl, StatusBadge, Textarea } from "../../ui/index.js";
import { receiptUrl, useAccountingQuery, useAccountingWrite, type ApproveResult, type ExpenseStatus, type ExpenseStatusFilter, type PettyCashLedger, type ReviewExpense } from "./api.js";

/*
 * 會計看報帳的唯一一頁：審核、撥款、查紀錄都在這裡，用狀態分頁切，不另開頁面。
 * 動作都在明細裡（看得到單據照片才能審），清單只放摘要。
 */

const STATUS_TABS: { value: ExpenseStatusFilter; label: string }[] = [
  { value: "pending", label: "待審核" },
  { value: "approved", label: "待撥款" },
  { value: "paid", label: "已付款" },
  { value: "rejected", label: "已駁回" },
  { value: "all", label: "全部" },
];

const STATUS_BADGE: Record<ExpenseStatus, { label: string; tone: "info" | "warning" | "success" | "danger" | "neutral" }> = {
  pending: { label: "待審核", tone: "info" },
  approved: { label: "待撥款", tone: "warning" },
  paid: { label: "已付款", tone: "success" },
  rejected: { label: "已駁回", tone: "danger" },
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

function payoutText(expense: ReviewExpense) {
  if (expense.payoutMethod === "payroll" && expense.payrollPeriodKey) return `併入 ${payrollPeriodLabel(expense.payrollPeriodKey)}薪資`;
  return expense.payoutMethod === "direct" ? "直接撥款" : null;
}

function ExpenseDetail({ expense, canReview, isOwn, onClose }: { expense: ReviewExpense; canReview: boolean; isOwn: boolean; onClose: () => void }) {
  const closeRef: CloseRef = useRef(null);
  const write = useAccountingWrite<Partial<ApproveResult>>();
  const toast = useToast();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [payout, setPayout] = useState<"direct" | "payroll">("direct");
  const [reverting, setReverting] = useState<"revert-payment" | "unapprove" | null>(null);
  const payoutLabel = payoutText(expense);
  const badge = STATUS_BADGE[expense.status];
  const act = (action: "approve" | "reject" | "paid" | "revert-payment" | "unapprove", values: Record<string, unknown> = {}) => write.mutate(
    { path: `/expenses/${encodeURIComponent(expense.id)}/${action}`, method: "POST", values: { revision: expense.revision, ...values } },
    { onSuccess: (result) => {
      // 直接撥款但零用金不夠：單子停在待撥款，要讓會計知道還沒付出去。
      if (result.pettyCashShort) toast.show("零用金餘額不足，已移到待撥款。", "info");
      setReverting(null);
      requestClose(closeRef, onClose);
    } },
  );
  const close = () => requestClose(closeRef, onClose);
  const reviewable = canReview && !isOwn;
  const approving = reviewable && expense.status === "pending" && !rejecting;
  // 待撥款（含併入月薪、那個月還沒結帳）的也能退回；已付款的要先退回待撥款。
  const rejectable = reviewable && (expense.status === "pending" || expense.status === "approved");
  // 直接撥款會從零用金扣：核准與標記撥款前讓會計看到餘額。
  const usesPettyCash = reviewable && (expense.status === "pending" || (expense.status === "approved" && expense.payoutMethod === "direct"));
  const pettyCash = useAccountingQuery<PettyCashLedger>("/petty-cash", usesPettyCash);
  const balance = pettyCash.data?.balanceMinor;
  const balanceText = balance === undefined ? null
    : `零用金餘額 ${dollars(balance)}${balance >= expense.amountMinor ? "" : "，不夠付這張"}。`;
  const approve = () => act("approve", payout === "payroll" && expense.payrollOption ? { payoutMethod: "payroll", payrollPeriodKey: expense.payrollOption } : { payoutMethod: "direct" });

  const actions = rejecting
    ? <>
      <Button variant="secondary" disabled={write.isPending} onClick={() => setRejecting(false)}>取消</Button>
      <Button variant="danger" loading={write.isPending} disabled={!note.trim()} onClick={() => act("reject", { note })}>確認駁回</Button>
    </>
    : <>
      {rejectable ? <Button variant="secondary" disabled={write.isPending} onClick={() => setRejecting(true)}>駁回</Button> : null}
      {approving ? <Button tone="success" loading={write.isPending} onClick={approve}>核准</Button> : null}
      {reviewable && expense.status === "approved" ? <Button variant="secondary" disabled={write.isPending} onClick={() => setReverting("unapprove")}>取消核准</Button> : null}
      {reviewable && expense.status === "paid" && expense.payoutMethod === "direct" ? <Button variant="secondary" disabled={write.isPending} onClick={() => setReverting("revert-payment")}>退回待撥款</Button> : null}
      {reviewable && expense.status === "approved" && expense.payoutMethod === "direct"
        ? <Button tone="success" loading={write.isPending} onClick={() => act("paid")}>標記已撥款</Button> : null}
      <Button variant="secondary" disabled={write.isPending} onClick={close}>關閉</Button>
    </>;

  return <><Dialog title={dollars(expense.amountMinor)} titleMeta={<StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>} onClose={onClose} closeRequestRef={closeRef} closeDisabled={write.isPending} actions={actions}>
    <p className="m-0 text-[15px] font-semibold wrap-anywhere">{expense.description}</p>
    {isOwn && canReview && (expense.status === "pending" || expense.status === "approved") ? <Alert tone="info">這是你自己的報帳，請另一位會計或管理者處理。</Alert> : null}
    {expense.duplicateInvoiceCount > 0 ? <Alert tone="warning">{`這個發票號碼另外還有 ${expense.duplicateInvoiceCount} 張報帳單，核准前請確認不是重複報帳。`}</Alert> : null}
    {expense.status === "rejected" && expense.reviewNote ? <Alert tone="danger">{`駁回原因：${expense.reviewNote}`}</Alert> : null}
    {approving ? <Field as="div" label="發放方式" hint={payout === "direct"
      ? `${expense.payrollOption ? "" : "沒有在職資料或薪資月份已結帳，只能直接撥款。"}${balanceText ?? ""}`
      : expense.payrollOption ? `${payrollPeriodLabel(expense.payrollOption)}的薪資會多一筆「代墊款」。` : undefined}>
      <SegmentedControl aria-label="發放方式" value={payout} onChange={(value) => setPayout(value === "payroll" ? "payroll" : "direct")} options={[
        { value: "direct", label: "直接撥款" },
        { value: "payroll", label: expense.payrollOption ? `併入 ${payrollPeriodLabel(expense.payrollOption)}薪資` : "併入月薪", disabled: !expense.payrollOption },
      ]} />
    </Field> : null}
    {reviewable && expense.status === "approved" && expense.payoutMethod === "direct" && balanceText ? <p className="m-0 text-[13px] text-muted">{balanceText}</p> : null}
    {rejecting ? <Field label="駁回原因" required hint={expense.payoutMethod === "payroll" ? "員工會看到這段話；薪資裡的代墊款會一起拿掉。" : "員工會看到這段話，寫清楚要怎麼改。"}>
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
      {payoutLabel && expense.status !== "rejected" ? <DetailRow label="發放方式">{payoutLabel}</DetailRow> : null}
      {expense.paidAt ? <DetailRow label="撥款時間">{taipeiMinuteFromUtcWallClock(expense.paidAt)}</DetailRow> : null}
    </dl>
  </Dialog>
  {reverting ? <ConfirmDialog
    title={reverting === "unapprove" ? "取消核准，回到待審核？" : "退回待撥款？"}
    confirmLabel={reverting === "unapprove" ? "取消核准" : "退回待撥款"}
    pending={write.isPending}
    onCancel={() => { if (!write.isPending) setReverting(null); }}
    onConfirm={() => act(reverting)}
  >
    <p>{reverting === "unapprove"
      ? (expense.payoutMethod === "payroll" ? "薪資裡的代墊款會一起拿掉。員工不會收到通知。" : "員工不會收到通知。")
      : "從零用金付的錢會退回零用金。員工不會收到通知。"}</p>
  </ConfirmDialog> : null}
  </>;
}

export function AccountingExpenses() {
  usePageTitle("報帳");
  const { permissions, user } = useSession();
  const [params, setParams] = useSearchParams();
  const status = (STATUS_TABS.find((tab) => tab.value === params.get("status"))?.value ?? "pending");
  const query = useAccountingQuery<{ expenses: ReviewExpense[] }>(`/expenses?status=${status}`);
  // 打開時存一份快照：核准、退回後那張單會從目前分頁的清單消失，從清單裡找的話明細會直接卸載、沒有退場動畫。
  const [viewing, setViewing] = useState<ReviewExpense | null>(null);
  const expenses = query.data?.expenses ?? [];
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
                <td data-label="操作"><Button variant="secondary" onClick={() => setViewing(expense)}>查看</Button></td>
              </tr>;
            })}
          </tbody>
        </DataTable>}
    </Panel>
    {viewing ? <ExpenseDetail expense={viewing} canReview={canReview} isOwn={viewing.submitterUserId === user?.id} onClose={() => setViewing(null)} /> : null}
  </Page>;
}
