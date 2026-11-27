import {
  EXPENSE_AMOUNT_MAX_DOLLARS,
  EXPENSE_DESCRIPTION_MAX,
  EXPENSE_RECEIPT_MAX_FILES,
  EXPENSE_RECEIPT_UPLOAD_SIDE,
  EXPENSE_STATUS_LABELS,
  payrollPeriodLabel,
  earliestExpenseDate,
  INVOICE_NUMBER_PATTERN,
  SELLER_TAX_ID_PATTERN,
  normalizeInvoiceNumber,
} from "@rueisiang/db/accounting-expense-fields";
import { formatTaipeiDate } from "@rueisiang/db/taipei-time";
import { prepareReceiptImage, randomId } from "@rueisiang/ui";
import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { API_BASE_URL } from "../../config.js";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, ConfirmDialog, Dialog, EmptyRecords, Field, Input, Page, PageHeader, Panel, SelectField, StatusBadge, Textarea, TextField } from "../../ui/index.js";
import { HrApiError, useHrQuery, useHrWrite, type ExpenseOptionsResponse, type MyExpense } from "./api.js";
import { ExpenseHistory } from "./ExpenseHistory.js";
import { FORM_FIELD_ROW, FORM_FIELDS, FORM_PANEL, FormActions, FormPage, FormPageHeader, MOBILE_CARD } from "./Forms.js";
import { NotInvoiceQrError, scanInvoiceQr } from "./invoice-qr.js";

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
  const period = expense.payrollPeriodKey ? payrollPeriodLabel(expense.payrollPeriodKey) : null;
  if (expense.status === "approved") return period ? `核准，會跟 ${period}的薪資一起發。` : "核准，等會計撥款。";
  if (expense.status === "paid") return period ? `已隨 ${period}的薪資發放。` : "已撥款。";
  return null;
}

// 圖片外框用純黑 10%，不用帶色的灰，才不會像邊緣髒掉。
const RECEIPT_OUTLINE = "outline outline-1 -outline-offset-1 outline-black/10";

type CloseRef = MutableRefObject<((afterClose?: () => void) => void) | null>;

/** Dialog 的 ref 還沒掛上時也要關得掉，跟大頭貼的移除對話框同一種寫法。 */
function requestClose(ref: CloseRef, afterClose: () => void) {
  (ref.current ?? ((after?: () => void) => after?.()))(afterClose);
}

function expenseMeta(expense: MyExpense) {
  return [expense.spentOn, expense.categoryName, expense.scopeName].filter(Boolean).join("・");
}

/*
 * Material 的清單列：前面是單據縮圖，中間是「買了什麼」，右邊是金額與狀態。整列是一顆按鈕，點了看明細。
 * 列上不放撤回之類的動作：只有待審核的列才有，放上去會讓每列高度不一、按鈕孤零零掛在角落；動作集中在明細裡。
 */
function ExpenseRow({ expense, onOpen }: { expense: MyExpense; onOpen: (expense: MyExpense) => void }) {
  const first = expense.receiptIds[0];
  return <li>
    <button type="button" onClick={() => onOpen(expense)} className="-mx-2 grid w-[calc(100%+16px)] grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] border-0 bg-transparent px-2 py-3 text-left text-ink transition-[background-color] duration-150 ease-out hover:bg-brand/4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary">
      {first ? <span className={`relative block size-14 overflow-hidden rounded-[12px] ${RECEIPT_OUTLINE}`}>
        <img src={receiptUrl(expense.id, first)} alt="" loading="lazy" className="size-full object-cover" />
        {expense.receiptIds.length > 1 ? <span className="absolute right-1 bottom-1 rounded-full bg-ink/72 px-1.5 text-[11px] leading-[18px] font-semibold text-canvas tabular-nums">{expense.receiptIds.length}</span> : null}
      </span> : <span className="grid size-14 place-items-center rounded-[12px] bg-canvas text-muted"><Icon name="attachment" className="size-6" /></span>}
      <span className="grid min-w-0 gap-1">
        <strong className="line-clamp-2 text-[15px] leading-[1.4] font-semibold wrap-anywhere">{expense.description}</strong>
        <span className="truncate text-[13px] leading-[1.45] text-muted">{expenseMeta(expense)}</span>
      </span>
      <span className="grid justify-items-end gap-1.5">
        <strong className="text-[15px] leading-[1.4] font-semibold whitespace-nowrap tabular-nums">{dollars(expense.amountMinor)}</strong>
        <StatusBadge tone={STATUS_TONE[expense.status]}>{EXPENSE_STATUS_LABELS[expense.status]}</StatusBadge>
      </span>
    </button>
  </li>;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-baseline justify-between gap-4 py-2.5">
    <dt className="shrink-0 text-[13px] text-muted">{label}</dt>
    <dd className="m-0 min-w-0 text-right text-[14px] wrap-anywhere">{children}</dd>
  </div>;
}

function ExpenseDetail({ expense, onClose, onCancel, onEdit, closeRequestRef }: { expense: MyExpense; onClose: () => void; onCancel: () => void; onEdit: () => void; closeRequestRef: CloseRef }) {
  const note = payoutNote(expense);
  return <Dialog
    title={dollars(expense.amountMinor)}
    titleMeta={<StatusBadge tone={STATUS_TONE[expense.status]}>{EXPENSE_STATUS_LABELS[expense.status]}</StatusBadge>}
    onClose={onClose}
    closeRequestRef={closeRequestRef}
    actions={<>
      {expense.status === "pending" ? <>
        <Button variant="danger" onClick={onCancel}>撤回</Button>
        <Button variant="secondary" icon="edit" onClick={onEdit}>編輯</Button>
      </> : null}
      <Button variant="secondary" onClick={() => requestClose(closeRequestRef, onClose)}>關閉</Button>
    </>}
  >
    <p className="m-0 text-[15px] font-semibold wrap-anywhere">{expense.description}</p>
    {expense.status === "rejected" && expense.reviewNote ? <Alert tone="danger">{`駁回原因：${expense.reviewNote}`}</Alert> : null}
    {note ? <Alert tone="info">{note}</Alert> : null}
    {expense.receiptIds.length ? <div className="grid grid-cols-3 gap-2">
      {expense.receiptIds.map((receiptId, index) => <a key={receiptId} href={receiptUrl(expense.id, receiptId)} target="_blank" rel="noreferrer" aria-label={`開啟第 ${index + 1} 張單據`} className={`block aspect-square overflow-hidden rounded-[12px] transition-[scale] duration-150 ease-out active:scale-96 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary ${RECEIPT_OUTLINE}`}>
        <img src={receiptUrl(expense.id, receiptId)} alt="" loading="lazy" className="size-full object-cover" />
      </a>)}
    </div> : null}
    <dl className="m-0 grid divide-y divide-soft-line">
      <DetailRow label="消費日期">{expense.spentOn}</DetailRow>
      <DetailRow label="類別">{expense.categoryName}</DetailRow>
      {expense.scopeName ? <DetailRow label="店別">{expense.scopeName}</DetailRow> : null}
      {expense.invoiceNumber ? <DetailRow label="發票號碼"><span className="tabular-nums">{expense.invoiceNumber}</span></DetailRow> : null}
      {expense.sellerTaxId ? <DetailRow label="賣方統編"><span className="tabular-nums">{expense.sellerTaxId}</span></DetailRow> : null}
    </dl>
    <ExpenseHistory expenseId={expense.id} />
  </Dialog>;
}

export function HrExpenses() {
  usePageTitle("報帳");
  const navigate = useNavigate();
  const query = useHrQuery<{ expenses: MyExpense[] }>("/me/expenses");
  const [viewing, setViewing] = useState<MyExpense | null>(null);
  const [params, setParams] = useSearchParams();
  // 從通知點進來（?focus=報帳單 ID）：資料到了就打開那一張的明細，參數用完就拿掉，關掉後不會再自己彈出來。
  const focus = params.get("focus");
  useEffect(() => {
    if (!focus || !query.data) return;
    const target = query.data.expenses.find((expense) => expense.id === focus);
    if (target) setViewing(target);
    setParams((current) => { const next = new URLSearchParams(current); next.delete("focus"); return next; }, { replace: true });
  }, [focus, query.data, setParams]);
  const [cancelling, setCancelling] = useState<MyExpense | null>(null);
  const closeDetail: CloseRef = useRef(null);
  const closeCancel: CloseRef = useRef(null);
  const cancel = useHrWrite();
  const expenses = query.data?.expenses ?? [];
  return <Page className="grid gap-3 [&>*+*]:!mt-0">
    <PageHeader
      title="報帳"
      actions={<Button tone="success" icon="plus" onClick={() => navigate("/expenses/new")}>新增報帳</Button>}
    />
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    {cancel.error ? <Alert tone="danger">{cancel.error.message}</Alert> : null}
    <Panel className={MOBILE_CARD}>
      {query.isPending ? <p className="text-muted">載入報帳紀錄…</p>
        : expenses.length === 0 ? <EmptyRecords title="還沒有報帳紀錄" hint="按「新增報帳」，拍下發票就能送出。" />
        : <ul className="m-0 grid list-none divide-y divide-soft-line p-0">{expenses.map((expense) => <ExpenseRow key={expense.id} expense={expense} onOpen={setViewing} />)}</ul>}
    </Panel>
    {viewing ? <ExpenseDetail
      expense={viewing}
      closeRequestRef={closeDetail}
      onClose={() => setViewing(null)}
      // 先讓明細走完退場再開確認框；兩個 Dialog 同時疊著，焦點與背景遮罩都會亂。
      onCancel={() => requestClose(closeDetail, () => { setViewing(null); cancel.reset(); setCancelling(viewing); })}
      onEdit={() => requestClose(closeDetail, () => { setViewing(null); navigate(`/expenses/${encodeURIComponent(viewing.id)}/edit`); })}
    /> : null}
    {cancelling ? <ConfirmDialog
      title="撤回這張報帳單？"
      confirmLabel="撤回"
      pending={cancel.isPending}
      closeRequestRef={closeCancel}
      onCancel={() => setCancelling(null)}
      onConfirm={() => cancel.mutate({ path: `/me/expenses/${encodeURIComponent(cancelling.id)}/cancel`, method: "POST", values: { revision: cancelling.revision } }, {
        onSettled: () => requestClose(closeCancel, () => setCancelling(null)),
      })}
    >
      <p className="m-0">{dollars(cancelling.amountMinor)}・{cancelling.description}</p>
      <p className="m-0 text-muted">撤回後會計就不會審這張；要報的話得重新送一張。</p>
    </ConfirmDialog> : null}
  </Page>;
}

/*
 * 處理照片與讀 QR code 要一兩秒，期間整個表單都不能動（照片還沒加進來就送出、或又按一次掃描都會亂）。
 * 用全螢幕遮罩擋住並說明在做什麼：手機上欄位旁邊的一行小字很容易被鍵盤或捲動蓋掉，看起來像當掉。
 * 掛到 body 底下：頁面切換的進場動畫有 transform，fixed 放在裡面會跟著頁面位移。
 */
function BusyOverlay({ label }: { label: string }) {
  return createPortal(<div role="status" aria-live="polite" className="fixed inset-0 z-50 grid place-items-center bg-ink/45 backdrop-blur-[2px]">
    <div className="grid justify-items-center gap-3 rounded-[20px] bg-paper px-7 py-6 [box-shadow:0_12px_32px_--alpha(var(--color-ink)/18%)]">
      <span aria-hidden="true" className="size-9 animate-spin rounded-full border-[3px] border-brand/20 border-t-brand motion-reduce:animate-none" />
      <span className="text-[15px] font-semibold text-ink">{label}</span>
    </div>
  </div>, document.body);
}

interface PendingReceipt { key: string; file: File; preview: string }

/** 待審核的單才能改；從明細的「編輯」進來，資料從清單拿，不另外開一支讀單張的 API。 */
export function HrExpenseEdit() {
  const { id = "" } = useParams();
  const query = useHrQuery<{ expenses: MyExpense[] }>("/me/expenses");
  const expense = query.data?.expenses.find((item) => item.id === id);
  if (query.isPending) return <FormPage><p className="text-muted">載入報帳…</p></FormPage>;
  if (!expense || expense.status !== "pending") return <FormPage>
    <FormPageHeader title="編輯報帳" description="會計審核前都可以改。" returnTo="/expenses" backLabel="返回報帳" />
    <Alert tone="warning">這張報帳單已經不是待審核，不能修改。</Alert>
  </FormPage>;
  return <HrExpenseForm editing={expense} />;
}

export function HrExpenseForm({ editing }: { editing?: MyExpense } = {}) {
  usePageTitle(editing ? "編輯報帳" : "新增報帳");
  const navigate = useNavigate();
  const options = useHrQuery<ExpenseOptionsResponse>("/me/expense-options");
  const today = formatTaipeiDate(new Date());
  const earliest = earliestExpenseDate(today);
  // 每次打開表單一個識別碼：連按兩下、或網路斷掉重送，伺服器都只會留一張。
  const [clientRequestId] = useState(randomId);
  const [categoryId, setCategoryId] = useState(editing?.categoryId ?? "");
  const [spentOn, setSpentOn] = useState(editing?.spentOn ?? "");
  const [amount, setAmount] = useState(editing ? String(editing.amountMinor / 100) : "");
  const [invoiceNumber, setInvoiceNumber] = useState(editing?.invoiceNumber ?? "");
  const [sellerTaxId, setSellerTaxId] = useState(editing?.sellerTaxId ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  // 編輯時已經在伺服器上的照片：按移除只是記下來，存檔時才真的刪。
  const [keptReceiptIds, setKeptReceiptIds] = useState<string[]>(editing?.receiptIds ?? []);
  const [receipts, setReceipts] = useState<PendingReceipt[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [localError, setLocalError] = useState("");
  const [duplicateWarning, setDuplicateWarning] = useState("");
  const [scanning, setScanning] = useState(false);
  const [qrNotice, setQrNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const scanInput = useRef<HTMLInputElement>(null);
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
    const room = EXPENSE_RECEIPT_MAX_FILES - keptReceiptIds.length - receipts.length;
    const chosen = [...list].slice(0, room);
    if (list.length > room) setLocalError(`單據照片最多 ${EXPENSE_RECEIPT_MAX_FILES} 張，多的沒有加進來。`);
    setPreparing(true);
    try {
      const prepared: PendingReceipt[] = [];
      for (const file of chosen) {
        try {
          const resized = await prepareReceiptImage(file, EXPENSE_RECEIPT_UPLOAD_SIDE);
          prepared.push({ key: randomId(), file: resized, preview: URL.createObjectURL(resized) });
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

  /*
   * 發票號碼旁的掃描鈕：只讀 QR code 帶入欄位，那張照片不會變成單據（單據照片是選填的補充資料，
   * 加照片時也不順手讀，免得每加一張補充照片就被讀取遮罩擋一兩秒）。
   * 讀到就整組帶入（重拍可以修正上一次），欄位填好就是回饋；讀不到才講，不擋送出、讓使用者手填。
   */
  async function scanInvoice(list: FileList | null) {
    const file = list?.[0];
    if (scanInput.current) scanInput.current.value = "";
    if (!file) return;
    setQrNotice("");
    setScanning(true);
    try {
      const fields = await scanInvoiceQr(file);
      if (!fields) {
        setQrNotice("沒讀到 QR code，請再拍一次或手填。");
        return;
      }
      setInvoiceNumber(fields.invoiceNumber);
      setSellerTaxId(fields.sellerTaxId);
      setAmount(String(fields.amountDollars));
      setSpentOn(fields.spentOn);
      setDuplicateWarning("");
    } catch (error) {
      if (error instanceof NotInvoiceQrError) {
        setQrNotice("這不是電子發票的 QR code，請拍證明聯左邊那個或手填。");
        return;
      }
      // 解碼器載入或執行失敗跟「照片裡找不到」要分開講：前者重拍幾次都不會好，回報時也才看得出是哪一種。
      setQrNotice(`讀取失敗（${(error instanceof Error ? error.message : String(error)).slice(0, 80)}），請手填。`);
    } finally {
      setScanning(false);
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
    if (!spentOn) return "請選擇消費日期。";
    if (spentOn > today) return "消費日期不能晚於今天。";
    if (spentOn < earliest) return `消費日期只能是一年內（${earliest} 以後）；更早的單據請直接找會計。`;
    if (!categoryId) return "請選擇支出類別。";
    const invoice = normalizeInvoiceNumber(invoiceNumber);
    if (invoice && !INVOICE_NUMBER_PATTERN.test(invoice)) return "發票號碼應為兩個英文字母加八位數字，例如 AB12345678。";
    if (sellerTaxId.trim() && !SELLER_TAX_ID_PATTERN.test(sellerTaxId.trim())) return "賣方統編應為八位數字。";
    if (!description.trim()) return "請填寫用途。";
    if (!invoice && !receipts.length && !keptReceiptIds.length) return "沒有發票號碼時，請附上收據照片。";
    return "";
  }

  function submit(confirmDuplicate: boolean) {
    const problem = validate();
    setLocalError(problem);
    if (problem) return;
    const formData = new FormData();
    const values: Record<string, string> = { categoryId, spentOn, amountDollars: amount, invoiceNumber, sellerTaxId, description, confirmDuplicate: String(confirmDuplicate) };
    for (const [key, value] of Object.entries(values)) formData.set(key, value);
    if (editing) {
      formData.set("revision", String(editing.revision));
      for (const receiptId of editing.receiptIds.filter((receiptId) => !keptReceiptIds.includes(receiptId))) formData.append("removeReceiptIds", receiptId);
    } else {
      formData.set("clientRequestId", clientRequestId);
    }
    for (const receipt of receipts) formData.append("receipts", receipt.file, receipt.file.name);
    save.mutate({ path: editing ? `/me/expenses/${encodeURIComponent(editing.id)}/edit` : "/me/expenses", method: "POST", formData }, {
      onSuccess: () => navigate("/expenses", { replace: true }),
      onError: (error) => {
        if (error instanceof HrApiError && error.code === "duplicate_invoice") setDuplicateWarning(error.message);
      },
    });
  }

  const pending = save.isPending || preparing || scanning;
  const categoryOptions = (options.data?.categories ?? []).map((category) => ({ label: category.name, value: category.id }));
  // 編輯時原本的類別可能已經停用、不在清單裡；照原類別存仍然可以，所以補回選項，不然下拉會是空白。
  if (editing && !categoryOptions.some((option) => option.value === editing.categoryId)) categoryOptions.push({ label: editing.categoryName, value: editing.categoryId });
  const saveError = save.error && !(save.error instanceof HrApiError && save.error.code === "duplicate_invoice") ? save.error.message : "";
  return <FormPage>
    {scanning ? <BusyOverlay label="讀取發票中…" /> : preparing ? <BusyOverlay label="處理照片中…" /> : null}
    <FormPageHeader title={editing ? "編輯報帳" : "新增報帳"} description={editing ? "會計審核前都可以改。" : "送出後由會計審核，結果會顯示在報帳紀錄。"} returnTo="/expenses" backLabel="返回報帳" />
    {options.error ? <Alert tone="danger">{options.error.message}</Alert> : null}
    <Panel className={FORM_PANEL}>
      <div className={FORM_FIELDS}>
        {/*
          * 掃得到的四欄排在最前面：先掃發票，剩下要自己填的（類別、用途）接在後面，
          * 不用在已經填好的欄位之間跳來跳去。中間一條分隔線把「發票上的資料」和「這筆錢的用途」分開。
          */}
        <div className={FORM_FIELD_ROW}>
          {/* 掃描鈕放在發票號碼欄位裡：掃 QR code 是為了填發票這幾欄，跟單據照片無關。 */}
          <Field label="發票號碼" hint="電子發票按右邊的圖示掃描，自動帶入號碼、統編、金額與日期；收據可以留空。">
            <div className="relative min-w-0">
              <Input className="w-full pr-11" value={invoiceNumber} disabled={pending} placeholder="AB12345678" autoCapitalize="characters" aria-label="發票號碼" onChange={(event) => { setInvoiceNumber(event.target.value); setDuplicateWarning(""); }} />
              <Button variant="icon" icon="qrScan" className="absolute inset-y-0 right-0.5 my-auto" aria-label="掃描電子發票 QR code" disabled={pending || scanning} onClick={() => scanInput.current?.click()} />
              <input ref={scanInput} type="file" accept="image/*" capture="environment" hidden aria-label="拍攝電子發票 QR code" onChange={(event) => { void scanInvoice(event.target.files); }} />
            </div>
          </Field>
          <TextField label="賣方統編" inputMode="numeric" value={sellerTaxId} disabled={pending} placeholder="選填" onChange={(event) => setSellerTaxId(event.target.value.replace(/[^\d]/g, "").slice(0, 8))} />
        </div>
        {qrNotice ? <Alert tone="warning">{qrNotice}</Alert> : null}
        <div className={FORM_FIELD_ROW}>
          <TextField label="金額（元）" required inputMode="numeric" pattern="[0-9]*" value={amount} disabled={pending} placeholder="例如 350" onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, ""))} />
          <TextField label="消費日期" required type="date" min={earliest} max={today} value={spentOn} disabled={pending} onChange={(event) => setSpentOn(event.target.value)} />
        </div>
        <hr className="m-0 border-0 border-t border-soft-line" />
        <SelectField label="支出類別" required value={categoryId} disabled={pending || options.isPending} onChange={(event) => setCategoryId(event.target.value)} options={categoryOptions} />
        <Field label="用途" required hint={`最多 ${EXPENSE_DESCRIPTION_MAX} 字。`}>
          <Textarea required maxLength={EXPENSE_DESCRIPTION_MAX} rows={3} value={description} disabled={pending} placeholder="例如：西門店清潔用品" onChange={(event) => setDescription(event.target.value)} />
        </Field>
        {/* 有發票號碼時照片是補充資料；收據沒有號碼，照片是唯一的憑證，所以這時候才必填。 */}
        <Field label="單據照片" required={!invoiceNumber.trim()} hint={`最多 ${EXPENSE_RECEIPT_MAX_FILES} 張，可以拍照或從相簿選。收據（沒有發票號碼）一定要附；有發票號碼時選填。`}>
          <div className="flex flex-wrap gap-2">
            {editing ? keptReceiptIds.map((receiptId, index) => <div key={receiptId} className="relative size-20">
              <img src={receiptUrl(editing.id, receiptId)} alt={`第 ${index + 1} 張單據`} className="size-full rounded-[12px] object-cover outline outline-1 -outline-offset-1 outline-black/10" />
              <button type="button" aria-label={`移除第 ${index + 1} 張單據`} disabled={pending} onClick={() => setKeptReceiptIds((current) => current.filter((other) => other !== receiptId))} className="absolute -top-2 -right-2 grid size-8 place-items-center rounded-full border-0 bg-ink text-canvas transition-[scale] duration-150 ease-out active:scale-96 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary">
                <Icon name="close" className="size-4" />
              </button>
            </div>) : null}
            {receipts.map((receipt, index) => <div key={receipt.key} className="relative size-20">
              <img src={receipt.preview} alt={`第 ${keptReceiptIds.length + index + 1} 張單據`} className="size-full rounded-[12px] object-cover outline outline-1 -outline-offset-1 outline-black/10" />
              <button type="button" aria-label={`移除第 ${keptReceiptIds.length + index + 1} 張單據`} disabled={pending} onClick={() => removeReceipt(receipt.key)} className="absolute -top-2 -right-2 grid size-8 place-items-center rounded-full border-0 bg-ink text-canvas transition-[scale] duration-150 ease-out active:scale-96 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary">
                <Icon name="close" className="size-4" />
              </button>
            </div>)}
            {keptReceiptIds.length + receipts.length < EXPENSE_RECEIPT_MAX_FILES ? <button type="button" disabled={pending} onClick={() => input.current?.click()} className="grid size-20 place-items-center content-center gap-1 rounded-[12px] border border-dashed border-line bg-canvas text-[12px] text-muted transition-[background-color,scale] duration-150 ease-out hover:bg-brand/4 active:scale-96 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary">
              <Icon name="camera" className="size-6" />
              拍照或選圖
            </button> : null}
          </div>
          <input ref={input} type="file" accept="image/*" multiple hidden aria-label="選擇單據照片" onChange={(event) => { void addFiles(event.target.files); }} />
        </Field>
      </div>
      {duplicateWarning ? <Alert tone="warning">{duplicateWarning}</Alert> : null}
      {localError ? <Alert tone="danger">{localError}</Alert> : null}
      {saveError ? <Alert tone="danger">{saveError}</Alert> : null}
      <FormActions>
        <Button size="lg" variant="secondary" disabled={save.isPending} onClick={() => navigate("/expenses")}>取消</Button>
        <Button size="lg" tone="success" loading={save.isPending} loadingLabel={editing ? "儲存中…" : "送出中…"} disabled={preparing} onClick={() => submit(Boolean(duplicateWarning))}>{duplicateWarning ? (editing ? "確定儲存" : "確定再報一次") : editing ? "儲存修改" : "送出報帳"}</Button>
      </FormActions>
    </Panel>
  </FormPage>;
}
