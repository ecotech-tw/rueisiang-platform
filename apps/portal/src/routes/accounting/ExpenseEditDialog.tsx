import { EXPENSE_AMOUNT_MAX_DOLLARS, EXPENSE_DESCRIPTION_MAX, normalizeInvoiceNumber } from "@rueisiang/db/accounting-expense-fields";
import { formatTaipeiDate } from "@rueisiang/db/taipei-time";
import { useRef, useState } from "react";
import { Alert, Button, Dialog, Field, FieldGrid, SelectField, Textarea, TextField } from "../../ui/index.js";
import { AccountingApiError, useAccountingQuery, useAccountingWrite, type ExpenseCategory, type ReviewExpense } from "./api.js";

/*
 * 會計修改待審核的報帳。只改文字欄位，照片是送件人提供的憑證，不在這裡動。
 * 存檔後伺服器記下改了哪些欄位並通知送件人；自己的單伺服器會擋，畫面上也不出現這顆按鈕。
 */

type CloseRef = { current: ((afterClose?: () => void) => void) | null };

export function ExpenseEditDialog({ expense, onClose }: { expense: ReviewExpense; onClose: () => void }) {
  const closeRef: CloseRef = useRef(null);
  const write = useAccountingWrite({ quietCodes: ["duplicate_invoice"] });
  const categories = useAccountingQuery<{ categories: ExpenseCategory[] }>("/categories");
  const [spentOn, setSpentOn] = useState(expense.spentOn);
  const [amount, setAmount] = useState(String(expense.amountMinor / 100));
  const [categoryId, setCategoryId] = useState(expense.categoryId);
  const [invoiceNumber, setInvoiceNumber] = useState(expense.invoiceNumber);
  const [sellerTaxId, setSellerTaxId] = useState(expense.sellerTaxId);
  const [description, setDescription] = useState(expense.description);
  const today = formatTaipeiDate(new Date());
  const duplicate = write.error instanceof AccountingApiError && write.error.code === "duplicate_invoice";
  // 停用的類別不給選，但這張單原本的類別就算停用了也要列出來，照原類別存仍然可以。
  const options = (categories.data?.categories ?? [])
    .filter((category) => !category.archived || category.id === expense.categoryId)
    .map((category) => ({ value: category.id, label: category.archived ? `${category.name}（已停用）` : category.name }));
  const ready = spentOn && /^\d+$/.test(amount) && Number(amount) >= 1 && categoryId && description.trim();
  const close = () => (closeRef.current ?? ((after?: () => void) => after?.()))(onClose);
  const save = () => write.mutate({
    path: `/expenses/${encodeURIComponent(expense.id)}`,
    method: "PATCH",
    values: { categoryId, spentOn, amountDollars: Number(amount), invoiceNumber: normalizeInvoiceNumber(invoiceNumber), sellerTaxId: sellerTaxId.trim(), description, revision: expense.revision, confirmDuplicate: duplicate },
  }, { onSuccess: close });

  return <Dialog
    title="修改報帳"
    onClose={onClose}
    closeRequestRef={closeRef}
    closeDisabled={write.isPending}
    actions={<>
      <Button variant="secondary" disabled={write.isPending} onClick={close}>取消</Button>
      <Button tone="success" loading={write.isPending} disabled={!ready} onClick={save}>{duplicate ? "仍要儲存" : "儲存"}</Button>
    </>}
  >
    <FieldGrid columns={2}>
      <TextField label="消費日期" required type="date" max={today} value={spentOn} onChange={(event) => setSpentOn(event.target.value)} />
      <TextField label="金額（元）" required inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, "").slice(0, String(EXPENSE_AMOUNT_MAX_DOLLARS).length))} />
      <TextField label="發票號碼" value={invoiceNumber} maxLength={12} placeholder="收據就留空" onChange={(event) => {
        // 換了號碼就重新檢查重複，不沿用上一個號碼的「仍要儲存」。
        if (duplicate) write.reset();
        setInvoiceNumber(event.target.value);
      }} />
      <TextField label="賣方統編" inputMode="numeric" value={sellerTaxId} maxLength={8} onChange={(event) => setSellerTaxId(event.target.value.replace(/[^\d]/g, ""))} />
    </FieldGrid>
    <SelectField label="類別" required value={categoryId} onValueChange={setCategoryId} options={options} />
    <Field label="用途" required>
      <Textarea rows={2} maxLength={EXPENSE_DESCRIPTION_MAX} value={description} onChange={(event) => setDescription(event.target.value)} />
    </Field>
    <p className="m-0 text-[13px] text-muted">存檔後會通知送件人，並留下修改紀錄。</p>
    {duplicate ? <Alert tone="warning">這個發票號碼已經有人報過。確定不是重複的話，再按一次「仍要儲存」。</Alert> : null}
  </Dialog>;
}
