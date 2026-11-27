import { EXPENSE_AMOUNT_MAX_DOLLARS, EXPENSE_DESCRIPTION_MAX, EXPENSE_RECEIPT_MAX_FILES, EXPENSE_RECEIPT_UPLOAD_SIDE, normalizeInvoiceNumber } from "@rueisiang/db/accounting-expense-fields";
import { formatTaipeiDate } from "@rueisiang/db/taipei-time";
import { prepareReceiptImage, randomId } from "@rueisiang/ui";
import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Alert, Button, DataTable, Dialog, EmptyState, Field, FieldGrid, FilterInput, FilterSelect, FilterToolbar, Page, PageHeader, Panel, SelectField, StatusBadge, Textarea, TextField } from "../../ui/index.js";
import { AccountingApiError, receiptUrl, useAccountingQuery, useAccountingWrite, type CompanyExpenseOptions, type LedgerEntry, type LedgerPayer } from "./api.js";
import { downloadLedgerXlsx, ledgerStatusText } from "./ledger-export.js";

/*
 * 支出帳：一個月所有算數的支出（公司直接付的，加上核准過的員工報帳），篩選後可以匯出 Excel。
 * 公司支出在這裡登記、修改、作廢；員工報帳的審核在「報帳」頁，這裡只列出來。
 */

type CloseRef = { current: ((afterClose?: () => void) => void) | null };

const PAYER_OPTIONS: { value: LedgerPayer; label: string }[] = [
  { value: "all", label: "全部付款" },
  { value: "company", label: "公司直接付" },
  { value: "employee_advance", label: "員工代墊" },
];

function dollars(amountMinor: number) {
  return `NT$ ${(amountMinor / 100).toLocaleString("zh-TW")}`;
}

function requestClose(ref: CloseRef, afterClose: () => void) {
  (ref.current ?? ((after?: () => void) => after?.()))(afterClose);
}

function CompanyExpenseDialog({ entry, options, onClose }: { entry: LedgerEntry | null; options: CompanyExpenseOptions; onClose: () => void }) {
  const closeRef: CloseRef = useRef(null);
  const write = useAccountingWrite({ quietCodes: ["duplicate_invoice"] });
  const [clientRequestId] = useState(randomId);
  const [spentOn, setSpentOn] = useState(entry?.spentOn ?? "");
  const [amount, setAmount] = useState(entry ? String(entry.amountMinor / 100) : "");
  const [categoryId, setCategoryId] = useState(entry?.categoryId ?? "");
  const [scopeId, setScopeId] = useState(entry?.scopeId ?? "");
  const [invoiceNumber, setInvoiceNumber] = useState(entry?.invoiceNumber ?? "");
  const [sellerTaxId, setSellerTaxId] = useState(entry?.sellerTaxId ?? "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [photos, setPhotos] = useState<File[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const today = formatTaipeiDate(new Date());
  const duplicate = write.error instanceof AccountingApiError && write.error.code === "duplicate_invoice";
  // 編輯時類別清單只有啟用中的；這筆用的類別停用了，也要列出來，不然下拉會顯示空白。
  const categories = entry && !options.categories.some((category) => category.id === entry.categoryId)
    ? [...options.categories, { id: entry.categoryId, name: `${entry.categoryName}（已停用）` }] : options.categories;
  const ready = spentOn && /^\d+$/.test(amount) && Number(amount) >= 1 && categoryId && description.trim();
  const close = () => requestClose(closeRef, onClose);

  const save = () => {
    const fields = { categoryId, scopeId, spentOn, invoiceNumber: normalizeInvoiceNumber(invoiceNumber), sellerTaxId: sellerTaxId.trim(), description };
    if (entry) {
      write.mutate({ path: `/company-expenses/${encodeURIComponent(entry.id)}`, method: "PATCH", values: { ...fields, amountDollars: Number(amount), revision: entry.revision, confirmDuplicate: duplicate } }, { onSuccess: close });
      return;
    }
    const form = new FormData();
    for (const [key, value] of Object.entries({ ...fields, amountDollars: amount, clientRequestId, confirmDuplicate: String(duplicate) })) form.set(key, value);
    for (const photo of photos) form.append("receipts", photo);
    write.mutate({ path: "/company-expenses", method: "POST", values: form }, { onSuccess: close });
  };

  const pickPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    setPreparing(true);
    try {
      const resized = await Promise.all([...files].slice(0, EXPENSE_RECEIPT_MAX_FILES - photos.length).map((file) => prepareReceiptImage(file, EXPENSE_RECEIPT_UPLOAD_SIDE).catch(() => file)));
      setPhotos((current) => [...current, ...resized].slice(0, EXPENSE_RECEIPT_MAX_FILES));
    } finally {
      setPreparing(false);
    }
  };

  return <>
    <Dialog
      title={entry ? "修改公司支出" : "登記公司支出"}
      onClose={onClose}
      closeRequestRef={closeRef}
      closeDisabled={write.isPending}
      actions={<>
        {entry ? <Button variant="danger" disabled={write.isPending} onClick={() => setVoiding(true)}>作廢</Button> : null}
        <Button variant="secondary" disabled={write.isPending} onClick={close}>取消</Button>
        <Button tone="success" loading={write.isPending} disabled={!ready || preparing} onClick={save}>{duplicate ? "仍要儲存" : "儲存"}</Button>
      </>}
    >
      <FieldGrid columns={2}>
        <TextField label="消費日期" required type="date" max={today} value={spentOn} onChange={(event) => setSpentOn(event.target.value)} />
        <TextField label="金額（元）" required inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, "").slice(0, String(EXPENSE_AMOUNT_MAX_DOLLARS).length))} />
        <TextField label="發票號碼" value={invoiceNumber} maxLength={12} placeholder="收據就留空" onChange={(event) => setInvoiceNumber(event.target.value)} />
        <TextField label="賣方統編" inputMode="numeric" value={sellerTaxId} maxLength={8} onChange={(event) => setSellerTaxId(event.target.value.replace(/[^\d]/g, ""))} />
        <SelectField label="類別" required placeholder="選擇類別" value={categoryId} onValueChange={setCategoryId} options={categories.map((category) => ({ value: category.id, label: category.name }))} />
        <SelectField label="店別" value={scopeId} onValueChange={setScopeId} options={[{ value: "", label: "不指定" }, ...options.scopes.map((scope) => ({ value: scope.id, label: scope.name }))]} />
      </FieldGrid>
      <Field label="用途說明" required>
        <Textarea rows={2} maxLength={EXPENSE_DESCRIPTION_MAX} value={description} placeholder="例如：11 月冷氣保養" onChange={(event) => setDescription(event.target.value)} />
      </Field>
      {entry ? (entry.receiptIds.length ? <div className="grid grid-cols-4 gap-2">
        {entry.receiptIds.map((receiptId, index) => <a key={receiptId} href={receiptUrl(entry.id, receiptId)} target="_blank" rel="noreferrer" aria-label={`開啟第 ${index + 1} 張單據`} className="block aspect-square overflow-hidden rounded-[12px] outline outline-1 -outline-offset-1 outline-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary">
          <img src={receiptUrl(entry.id, receiptId)} alt="" loading="lazy" className="size-full object-cover" />
        </a>)}
      </div> : null)
        : <Field as="div" label="單據照片" hint={invoiceNumber.trim() ? `選填，最多 ${EXPENSE_RECEIPT_MAX_FILES} 張。` : "沒有發票號碼時必附。"}>
          <div className="flex flex-wrap items-center gap-2">
            {photos.map((photo, index) => <Button key={`${photo.name}-${index}`} variant="secondary" icon="trash" onClick={() => setPhotos((current) => current.filter((_, other) => other !== index))}>{`照片 ${index + 1}`}</Button>)}
            {photos.length < EXPENSE_RECEIPT_MAX_FILES ? <label className="inline-flex">
              <input type="file" accept="image/*" multiple className="sr-only peer" onChange={(event) => { void pickPhotos(event.target.files); event.target.value = ""; }} />
              <span className="inline-flex h-9 cursor-pointer items-center rounded-full border border-line px-4 text-[14px] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-secondary">{preparing ? "處理中…" : "加照片"}</span>
            </label> : null}
          </div>
        </Field>}
      {duplicate ? <Alert tone="warning">這個發票號碼已經登記或報過了。確定不是重複的話，再按一次「仍要儲存」。</Alert> : null}
    </Dialog>
    {voiding && entry ? <ConfirmDialog title="作廢這筆支出？" confirmLabel="作廢" pending={write.isPending} onCancel={() => { if (!write.isPending) setVoiding(false); }}
      onConfirm={() => write.mutate({ path: `/company-expenses/${encodeURIComponent(entry.id)}/void`, method: "POST", values: { revision: entry.revision } }, { onSuccess: () => { setVoiding(false); close(); } })}>
      <p>{`${entry.spentOn}・${dollars(entry.amountMinor)}・${entry.description}`}</p>
      <p>作廢後不算進支出與匯出，紀錄會留著。</p>
    </ConfirmDialog> : null}
  </>;
}

export function AccountingLedger() {
  usePageTitle("支出");
  const { permissions } = useSession();
  const canWrite = permissions.has("accounting:expense:write");
  const [params, setParams] = useSearchParams();
  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? params.get("month")! : formatTaipeiDate(new Date()).slice(0, 7);
  const payer = (PAYER_OPTIONS.find((option) => option.value === params.get("payer"))?.value ?? "all");
  const categoryId = params.get("categoryId") ?? "";
  const scopeId = params.get("scopeId") ?? "";
  const query = useAccountingQuery<{ entries: LedgerEntry[]; totalMinor: number }>(`/ledger?${new URLSearchParams({ month, payer, categoryId, scopeId }).toString()}`);
  const options = useAccountingQuery<CompanyExpenseOptions>("/company-expenses/options");
  const [editing, setEditing] = useState<{ entry: LedgerEntry | null } | null>(null);
  const [exporting, setExporting] = useState(false);
  const entries = query.data?.entries ?? [];
  const update = (patch: Record<string, string>) => setParams((current) => {
    const next = new URLSearchParams(current);
    for (const [key, value] of Object.entries(patch)) { if (value && value !== "all") next.set(key, value); else next.delete(key); }
    return next;
  }, { replace: true });
  const exportLabel = [scopeId && options.data?.scopes.find((scope) => scope.id === scopeId)?.name, categoryId && options.data?.categories.find((category) => category.id === categoryId)?.name, payer !== "all" ? PAYER_OPTIONS.find((option) => option.value === payer)?.label : ""].filter(Boolean).join("_");
  const exportXlsx = async () => {
    setExporting(true);
    try { await downloadLedgerXlsx(entries, month, exportLabel); }
    finally { setExporting(false); }
  };

  return <Page layout="fills">
    <PageHeader title="支出" actions={<>
      <Button variant="secondary" icon="download" loading={exporting} disabled={!entries.length} onClick={() => { void exportXlsx(); }}>匯出 Excel</Button>
      {canWrite ? <Button tone="success" icon="plus" disabled={!options.data} onClick={() => setEditing({ entry: null })}>登記支出</Button> : null}
    </>} />
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    <Panel grows>
      <FilterToolbar>
        <FilterInput label="月份" type="month" value={month} onChange={(event) => update({ month: event.target.value })} />
        <FilterSelect label="付款" value={payer} options={PAYER_OPTIONS} onChange={(event) => update({ payer: event.target.value })} />
        <FilterSelect label="類別" value={categoryId} options={[{ value: "", label: "全部類別" }, ...(options.data?.categories ?? []).map((category) => ({ value: category.id, label: category.name }))]} onChange={(event) => update({ categoryId: event.target.value })} />
        <FilterSelect label="店別" value={scopeId} options={[{ value: "", label: "全部店別" }, ...(options.data?.scopes ?? []).map((scope) => ({ value: scope.id, label: scope.name }))]} onChange={(event) => update({ scopeId: event.target.value })} />
        {query.data ? <span className="ml-auto text-[14px] tabular-nums max-[760px]:ml-0">{`${entries.length} 筆・合計 ${dollars(query.data.totalMinor)}`}</span> : null}
      </FilterToolbar>
      {query.isPending ? <p className="text-muted">載入支出…</p>
        : entries.length === 0 ? <EmptyState>這個月沒有符合條件的支出。</EmptyState>
        : <DataTable>
          <thead>
            <tr>
              <th>消費日期</th>
              <th>類別</th>
              <th>用途</th>
              <th>店別</th>
              <th>付款</th>
              <th className="numeric">金額</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => <tr key={entry.id}>
              <td data-label="消費日期" className="tabular-nums">{entry.spentOn}</td>
              <td data-label="類別">{entry.categoryName}</td>
              <td data-label="用途"><span className="line-clamp-2 wrap-anywhere">{entry.description}</span></td>
              <td data-label="店別">{entry.scopeName ?? "—"}</td>
              <td data-label="付款">{entry.payerKind === "company" ? "公司直接付" : <span className="inline-flex flex-wrap items-center gap-1.5">{`員工代墊・${entry.personName}`}<StatusBadge tone={entry.status === "paid" ? "success" : "warning"}>{ledgerStatusText(entry)}</StatusBadge></span>}</td>
              <td data-label="金額" className="numeric">{dollars(entry.amountMinor)}</td>
              <td data-label="操作">{canWrite && entry.payerKind === "company" && options.data ? <Button variant="secondary" onClick={() => setEditing({ entry })}>修改</Button> : null}</td>
            </tr>)}
          </tbody>
        </DataTable>}
    </Panel>
    {editing && options.data ? <CompanyExpenseDialog entry={editing.entry} options={options.data} onClose={() => setEditing(null)} /> : null}
  </Page>;
}
