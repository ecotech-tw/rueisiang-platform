import {
  EXPENSE_AMOUNT_MAX_DOLLARS,
  EXPENSE_DESCRIPTION_MAX,
  EXPENSE_RECEIPT_MAX_FILES,
  EXPENSE_STATUS_LABELS,
  INVOICE_NUMBER_PATTERN,
  SELLER_TAX_ID_PATTERN,
  normalizeInvoiceNumber,
} from "@rueisiang/db/accounting-expense-fields";
import { formatTaipeiDate } from "@rueisiang/db/taipei-time";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { API_BASE_URL } from "../../config.js";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, ConfirmDialog, EmptyRecords, Field, Page, PageHeader, Panel, SelectField, StatusBadge, Textarea, TextField } from "../../ui/index.js";
import { HrApiError, useHrQuery, useHrWrite, type ExpenseOptionsResponse, type MyExpense } from "./api.js";
import { FORM_FIELD_ROW, FORM_FIELDS, FORM_PANEL, FormActions, FormPage, FormPageHeader, MOBILE_CARD } from "./Forms.js";
import { prepareReceiptImage } from "./receipt-image.js";

/*
 * 報公帳的員工端。規格見 docs/accounting-prd.md 第 3 節；審核在會計系統，不在這裡。
 * 跟請假、加班的「表單申請」分開一頁：審核者、狀態與付款流程都不一樣，硬塞進同一張分頁表只會讓兩邊都更難懂。
 */

const STATUS_TONE: Record<MyExpense["status"], "info" | "success" | "danger" | "neutral"> = {
  pending: "info",
  approved: "success",
  rejected: "danger",
  cancelled: "neutral",
  paid: "success",
};

function dollars(amountMinor: number) {
  return `NT$ ${(amountMinor / 100).toLocaleString("zh-TW")}`;
}

function receiptUrl(expenseId: string, receiptId: string) {
  return `${API_BASE_URL}/hr/me/expenses/${encodeURIComponent(expenseId)}/receipts/${encodeURIComponent(receiptId)}`;
}

function payoutNote(expense: MyExpense) {
  if (expense.status === "approved") return expense.payoutMethod === "payroll" ? "核准，會跟月薪一起發。" : "核准，等會計撥款。";
  if (expense.status === "paid") return expense.payoutMethod === "payroll" ? "已隨月薪發放。" : "已撥款。";
  return null;
}

function ExpenseCard({ expense, onCancel }: { expense: MyExpense; onCancel: (expense: MyExpense) => void }) {
  const note = payoutNote(expense);
  return <article className="grid gap-3 rounded-[14px] border border-line bg-paper p-4 max-[760px]:gap-2.5 max-[760px]:p-[13px]">
    <div className="flex items-start justify-between gap-2.5">
      <div className="grid min-w-0 gap-0.5">
        <strong className="text-[16px] tabular-nums max-[760px]:text-[15px]">{dollars(expense.amountMinor)}</strong>
        <span className="text-[13px] text-muted">{expense.spentOn}・{expense.categoryName}{expense.scopeName ? `・${expense.scopeName}` : ""}</span>
      </div>
      <StatusBadge tone={STATUS_TONE[expense.status]}>{EXPENSE_STATUS_LABELS[expense.status]}</StatusBadge>
    </div>
    <p className="m-0 text-[14px] wrap-anywhere max-[760px]:text-[13px]">{expense.description}</p>
    {expense.invoiceNumber ? <p className="m-0 text-[13px] text-muted tabular-nums">發票 {expense.invoiceNumber}{expense.sellerTaxId ? `・統編 ${expense.sellerTaxId}` : ""}</p> : null}
    {expense.receiptIds.length ? <div className="flex flex-wrap gap-2">
      {expense.receiptIds.map((receiptId, index) => <a key={receiptId} href={receiptUrl(expense.id, receiptId)} target="_blank" rel="noreferrer" className="block size-16 overflow-hidden rounded-[10px] outline outline-1 -outline-offset-1 outline-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary" aria-label={`查看第 ${index + 1} 張單據`}>
        <img src={receiptUrl(expense.id, receiptId)} alt="" loading="lazy" className="size-full object-cover" />
      </a>)}
    </div> : null}
    {expense.status === "rejected" && expense.reviewNote ? <Alert tone="danger">{`退回原因：${expense.reviewNote}`}</Alert> : null}
    {note ? <p className="m-0 text-[13px] text-muted">{note}</p> : null}
    {expense.status === "pending" ? <div className="flex justify-end">
      <Button variant="text" icon="close" onClick={() => onCancel(expense)}>撤回</Button>
    </div> : null}
  </article>;
}

export function HrExpenses() {
  usePageTitle("報帳");
  const navigate = useNavigate();
  const query = useHrQuery<{ expenses: MyExpense[] }>("/me/expenses");
  const [cancelling, setCancelling] = useState<MyExpense | null>(null);
  const closeCancel = useRef<((afterClose?: () => void) => void) | null>(null);
  const cancel = useHrWrite();
  const expenses = query.data?.expenses ?? [];
  return <Page className="grid gap-3 [&>*+*]:!mt-0">
    <PageHeader
      title="報帳"
      description="先付了公司的錢，拍下發票送出；會計審核後會撥款，或跟月薪一起發。"
      actions={<Button tone="success" icon="plus" onClick={() => navigate("/expenses/new")}>新增報帳</Button>}
    />
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    {cancel.error ? <Alert tone="danger">{cancel.error.message}</Alert> : null}
    <Panel className={MOBILE_CARD}>
      {query.isPending ? <p className="text-muted">載入報帳紀錄…</p>
        : expenses.length === 0 ? <EmptyRecords title="還沒有報帳紀錄" hint="按「新增報帳」，拍下發票就能送出。" />
        : <div className="grid gap-3">{expenses.map((expense) => <ExpenseCard key={expense.id} expense={expense} onCancel={(target) => { cancel.reset(); setCancelling(target); }} />)}</div>}
    </Panel>
    {cancelling ? <ConfirmDialog
      title="撤回這張報帳單？"
      confirmLabel="撤回"
      pending={cancel.isPending}
      closeRequestRef={closeCancel}
      onCancel={() => setCancelling(null)}
      onConfirm={() => cancel.mutate({ path: `/me/expenses/${encodeURIComponent(cancelling.id)}/cancel`, method: "POST", values: { revision: cancelling.revision } }, {
        onSettled: () => closeCancel.current?.(() => setCancelling(null)),
      })}
    >
      <p className="m-0">{dollars(cancelling.amountMinor)}・{cancelling.description}</p>
      <p className="m-0 text-muted">撤回後會計就不會審這張；要報的話得重新送一張。</p>
    </ConfirmDialog> : null}
  </Page>;
}

interface PendingReceipt { key: string; file: File; preview: string }

export function HrExpenseForm() {
  usePageTitle("新增報帳");
  const navigate = useNavigate();
  const options = useHrQuery<ExpenseOptionsResponse>("/me/expense-options");
  const today = formatTaipeiDate(new Date());
  // 每次打開表單一個識別碼：連按兩下、或網路斷掉重送，伺服器都只會留一張。
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const [categoryId, setCategoryId] = useState("");
  const [scopeId, setScopeId] = useState("");
  const [spentOn, setSpentOn] = useState(today);
  const [amount, setAmount] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [sellerTaxId, setSellerTaxId] = useState("");
  const [description, setDescription] = useState("");
  const [receipts, setReceipts] = useState<PendingReceipt[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [localError, setLocalError] = useState("");
  const [duplicateWarning, setDuplicateWarning] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const save = useHrWrite();
  const receiptsRef = useRef(receipts);
  receiptsRef.current = receipts;
  useEffect(() => () => { for (const receipt of receiptsRef.current) URL.revokeObjectURL(receipt.preview); }, []);
  useEffect(() => {
    const first = options.data?.categories[0];
    if (!categoryId && first) setCategoryId(first.id);
  }, [categoryId, options.data?.categories]);

  async function addFiles(list: FileList | null) {
    if (!list?.length) return;
    setLocalError("");
    const room = EXPENSE_RECEIPT_MAX_FILES - receipts.length;
    const chosen = [...list].slice(0, room);
    if (list.length > room) setLocalError(`單據照片最多 ${EXPENSE_RECEIPT_MAX_FILES} 張，多的沒有加進來。`);
    setPreparing(true);
    try {
      const prepared: PendingReceipt[] = [];
      for (const file of chosen) {
        try {
          const resized = await prepareReceiptImage(file);
          prepared.push({ key: crypto.randomUUID(), file: resized, preview: URL.createObjectURL(resized) });
        } catch {
          setLocalError(`「${file.name}」無法讀取，請換一張照片。`);
        }
      }
      setReceipts((current) => [...current, ...prepared]);
    } finally {
      setPreparing(false);
      if (input.current) input.current.value = "";
    }
  }

  function removeReceipt(key: string) {
    setReceipts((current) => current.filter((receipt) => {
      if (receipt.key === key) URL.revokeObjectURL(receipt.preview);
      return receipt.key !== key;
    }));
  }

  function validate() {
    const amountDollars = Number(amount);
    if (!/^\d+$/.test(amount) || amountDollars < 1 || amountDollars > EXPENSE_AMOUNT_MAX_DOLLARS) return `金額請填 1～${EXPENSE_AMOUNT_MAX_DOLLARS.toLocaleString("zh-TW")} 的整數元。`;
    if (!spentOn || spentOn > today) return "消費日期不能晚於今天。";
    if (!categoryId) return "請選擇支出類別。";
    const invoice = normalizeInvoiceNumber(invoiceNumber);
    if (invoice && !INVOICE_NUMBER_PATTERN.test(invoice)) return "發票號碼應為兩個英文字母加八位數字，例如 AB12345678。";
    if (sellerTaxId.trim() && !SELLER_TAX_ID_PATTERN.test(sellerTaxId.trim())) return "賣方統編應為八位數字。";
    if (!description.trim()) return "請填寫用途。";
    if (!receipts.length) return "請至少附上一張單據照片。";
    return "";
  }

  function submit(confirmDuplicate: boolean) {
    const problem = validate();
    setLocalError(problem);
    if (problem) return;
    const formData = new FormData();
    const values: Record<string, string> = { clientRequestId, categoryId, scopeId, spentOn, amountDollars: amount, invoiceNumber, sellerTaxId, description, confirmDuplicate: String(confirmDuplicate) };
    for (const [key, value] of Object.entries(values)) formData.set(key, value);
    for (const receipt of receipts) formData.append("receipts", receipt.file, receipt.file.name);
    save.mutate({ path: "/me/expenses", method: "POST", formData }, {
      onSuccess: () => navigate("/expenses", { replace: true }),
      onError: (error) => {
        if (error instanceof HrApiError && error.code === "duplicate_invoice") setDuplicateWarning(error.message);
      },
    });
  }

  const pending = save.isPending || preparing;
  const categoryOptions = (options.data?.categories ?? []).map((category) => ({ label: category.name, value: category.id }));
  const scopeOptions = [{ label: "不指定", value: "" }, ...(options.data?.scopes ?? []).map((scope) => ({ label: scope.name, value: scope.id }))];
  const saveError = save.error && !(save.error instanceof HrApiError && save.error.code === "duplicate_invoice") ? save.error.message : "";
  return <FormPage>
    <FormPageHeader title="新增報帳" description="送出後由會計審核，結果會顯示在報帳紀錄。" returnTo="/expenses" backLabel="返回報帳" />
    {options.error ? <Alert tone="danger">{options.error.message}</Alert> : null}
    <Panel className={FORM_PANEL}>
      <div className={FORM_FIELDS}>
        <Field label="單據照片" required hint={`發票或收據，最多 ${EXPENSE_RECEIPT_MAX_FILES} 張；照片會先縮小再上傳。`}>
          <div className="flex flex-wrap gap-2">
            {receipts.map((receipt, index) => <div key={receipt.key} className="relative size-20">
              <img src={receipt.preview} alt={`第 ${index + 1} 張單據`} className="size-full rounded-[12px] object-cover outline outline-1 -outline-offset-1 outline-black/10" />
              <button type="button" aria-label={`移除第 ${index + 1} 張單據`} disabled={pending} onClick={() => removeReceipt(receipt.key)} className="absolute -top-2 -right-2 grid size-8 place-items-center rounded-full border-0 bg-ink text-canvas transition-[scale] duration-150 ease-out active:scale-96 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary">
                <Icon name="close" className="size-4" />
              </button>
            </div>)}
            {receipts.length < EXPENSE_RECEIPT_MAX_FILES ? <button type="button" disabled={pending} onClick={() => input.current?.click()} className="grid size-20 place-items-center content-center gap-1 rounded-[12px] border border-dashed border-line bg-canvas text-[12px] text-muted transition-[background-color,scale] duration-150 ease-out hover:bg-brand/4 active:scale-96 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary">
              <Icon name="camera" className="size-6" />
              {preparing ? "處理中…" : "拍照或選圖"}
            </button> : null}
          </div>
          <input ref={input} type="file" accept="image/*" multiple hidden aria-label="選擇單據照片" onChange={(event) => { void addFiles(event.target.files); }} />
        </Field>
        <div className={FORM_FIELD_ROW}>
          <TextField label="金額（元）" required inputMode="numeric" pattern="[0-9]*" value={amount} disabled={pending} placeholder="例如 350" onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, ""))} />
          <TextField label="消費日期" required type="date" max={today} value={spentOn} disabled={pending} onChange={(event) => setSpentOn(event.target.value)} />
        </div>
        <div className={FORM_FIELD_ROW}>
          <SelectField label="支出類別" required value={categoryId} disabled={pending || options.isPending} onChange={(event) => setCategoryId(event.target.value)} options={categoryOptions} />
          <SelectField label="店別" value={scopeId} disabled={pending || options.isPending} onChange={(event) => setScopeId(event.target.value)} options={scopeOptions} hint="這筆錢是為哪家店花的；不確定就不指定。" />
        </div>
        <div className={FORM_FIELD_ROW}>
          <TextField label="發票號碼" value={invoiceNumber} disabled={pending} placeholder="AB12345678" autoCapitalize="characters" onChange={(event) => { setInvoiceNumber(event.target.value); setDuplicateWarning(""); }} hint="收據沒有號碼可以留空。" />
          <TextField label="賣方統編" inputMode="numeric" value={sellerTaxId} disabled={pending} placeholder="選填" onChange={(event) => setSellerTaxId(event.target.value.replace(/[^\d]/g, "").slice(0, 8))} />
        </div>
        <Field label="用途" required hint={`最多 ${EXPENSE_DESCRIPTION_MAX} 字。`}>
          <Textarea required maxLength={EXPENSE_DESCRIPTION_MAX} rows={3} value={description} disabled={pending} placeholder="例如：西門店清潔用品" onChange={(event) => setDescription(event.target.value)} />
        </Field>
      </div>
      {duplicateWarning ? <Alert tone="warning">{duplicateWarning}</Alert> : null}
      {localError ? <Alert tone="danger">{localError}</Alert> : null}
      {saveError ? <Alert tone="danger">{saveError}</Alert> : null}
      <FormActions>
        <Button size="lg" variant="secondary" disabled={save.isPending} onClick={() => navigate("/expenses")}>取消</Button>
        <Button size="lg" tone="success" loading={save.isPending} loadingLabel="送出中…" disabled={preparing} onClick={() => submit(Boolean(duplicateWarning))}>{duplicateWarning ? "確定再報一次" : "送出報帳"}</Button>
      </FormActions>
    </Panel>
  </FormPage>;
}
