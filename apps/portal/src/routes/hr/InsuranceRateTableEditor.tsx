import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Alert, Button, DataTable, EmptyState, TextField } from "../../ui/index.js";
import { useHrWrite, type InsuranceBracket, type InsuranceRateTableRecord } from "./api.js";

const SCHEME_LABEL: Record<"labor" | "health", string> = { labor: "勞保", health: "健保" };
const RATE_INPUT = "numeric min-h-10 w-full min-w-0 rounded-[10px] border border-line bg-paper px-2.5 py-2 text-ink [font:inherit] transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:bg-canvas focus-visible:border-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-secondary max-[760px]:min-h-[38px]";

interface BracketDraft extends InsuranceBracket {
  key: string;
  upperSalary: number | null;
  employeeAmountMinor: number | null;
}

function draftKey() {
  return `bracket-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toDraft(bracket: InsuranceBracket & { employeeAmountMinor?: number | null }): BracketDraft {
  return { ...bracket, key: draftKey(), employeeAmountMinor: bracket.employeeAmountMinor ?? null };
}

function integer(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function employeeAmountLabel(amountMinor: number | null | undefined) {
  return amountMinor === null || amountMinor === undefined
    ? "尚未設定"
    : `NT$ ${Math.round(amountMinor / 100).toLocaleString("zh-TW")}`;
}

export function InsuranceRateTableEditor({ scheme, year, table, onSaved, onDeleted, onBusy }: {
  scheme: "labor" | "health";
  year: number;
  table: InsuranceRateTableRecord | null;
  onSaved?: () => void;
  onDeleted?: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const isExistingDraft = table?.status === "draft";
  const [brackets, setBrackets] = useState<BracketDraft[]>(() => (table?.brackets ?? []).map(toDraft));
  const [sourceUrl, setSourceUrl] = useState(() => table?.sourceUrl === "manual" ? "" : table?.sourceUrl ?? "");
  const [note, setNote] = useState(() => table?.note ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useHrWrite();
  const remove = useHrWrite();
  const closeRequestRef = useRef<((afterClose?: () => void) => void) | null>(null);

  useEffect(() => { onBusy?.(save.isPending || remove.isPending); }, [onBusy, remove.isPending, save.isPending]);

  const updateBracket = (key: string, patch: Partial<Pick<InsuranceBracket, "lowerSalary" | "upperSalary" | "insuredAmount">>) => {
    setBrackets((current) => current.map((bracket) => bracket.key === key
      ? { ...bracket, ...patch, ...(patch.insuredAmount !== undefined ? { employeeAmountMinor: null } : {}) }
      : bracket));
  };
  const addBracket = () => {
    setBrackets((current) => [...current, { key: draftKey(), level: current.length + 1, lowerSalary: 0, upperSalary: null, insuredAmount: 0, employeeAmountMinor: null }]);
  };
  const removeBracket = (key: string) => {
    setBrackets((current) => current.filter((item) => item.key !== key).map((item, index) => ({ ...item, level: index + 1 })));
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!note.trim()) { setMessage("請留下級距來源或覆核備註。"); return; }
    const values: InsuranceBracket[] = [];
    for (const [index, bracket] of brackets.entries()) {
      const level = index + 1;
      const lowerSalary = integer(String(bracket.lowerSalary));
      const insuredAmount = integer(String(bracket.insuredAmount));
      if (lowerSalary === null || insuredAmount === null || insuredAmount <= 0) {
        setMessage(`第 ${index + 1} 筆級距的下限與投保金額必須是有效的非負整數。`);
        return;
      }
      if (bracket.upperSalary !== null && (!Number.isSafeInteger(bracket.upperSalary) || bracket.upperSalary < lowerSalary)) {
        setMessage(`第 ${index + 1} 筆級距的上限必須大於或等於下限。`);
        return;
      }
      values.push({ level, lowerSalary, upperSalary: bracket.upperSalary, insuredAmount });
    }
    setMessage(null);
    const input = { brackets: values, sourceUrl, note, ...(isExistingDraft ? { contentHash: table.contentHash } : { scheme, year }) };
    save.mutate({ path: isExistingDraft ? `/insurance-rates/${table.id}` : "/insurance-rates", method: isExistingDraft ? "PATCH" : "POST", values: input }, { onSuccess: onSaved });
  };
  const confirmRemove = () => {
    if (!isExistingDraft) return;
    remove.mutate({ path: `/insurance-rates/${table.id}`, method: "DELETE", values: { contentHash: table.contentHash } }, { onSuccess: () => {
      const afterDelete = onDeleted ?? onSaved;
      if (closeRequestRef.current) closeRequestRef.current(afterDelete);
      else { setConfirmDelete(false); afterDelete?.(); }
    } });
  };

  return <>
    <form className="grid gap-[18px] pb-4" onSubmit={submit}>
      <div className="flex flex-wrap items-baseline gap-2.5 px-0.5"><strong className="text-[14px] text-ink">{isExistingDraft ? "編輯待審閱版本" : table ? "從目前啟用版本建立人工版本" : "建立人工版本"}</strong><span className="muted text-[12px]">{year} 年・{SCHEME_LABEL[scheme]}；人工資料會保留來源與覆核備註。</span></div>
      <div className="grid min-w-0 gap-4">
        <DataTable containerClassName="isolate max-h-[380px] overflow-y-auto rounded-2xl border border-ink/10 bg-paper/30 [box-shadow:0_1px_0_--alpha(var(--color-paper)/70%)_inset,0_0_0_1px_--alpha(var(--color-paper)/18%)_inset,0_12px_24px_--alpha(var(--color-ink)/8%)] [scrollbar-gutter:stable]" className="min-w-[820px] border-separate border-spacing-0 max-[760px]:min-w-0 [&_th]:h-11 [&_th]:py-1.5 [&_th]:text-[12px] min-[761px]:[&_td]:py-2 [[data-table-scroll]>&_thead_th:first-child]:rounded-tl-[14px] [[data-table-scroll]>&_thead_th:last-child]:rounded-tr-[14px]">
            <thead><tr><th>級距</th><th>薪資下限（元）</th><th>薪資上限（元）</th><th>投保金額（元）</th><th>員工負擔／月<br /><span className="muted text-[10px] font-medium">健保以 0 位眷屬</span></th><th>操作</th></tr></thead>
            <tbody>
              {brackets.map((bracket, index) => <tr key={bracket.key}>
                <td data-label="級距"><output className="grid min-h-10 w-full place-items-center rounded-[10px] border border-soft-line bg-paper/54 px-2.5 py-2 font-extrabold text-muted tabular-nums max-[760px]:min-h-[38px]" aria-label={`第 ${index + 1} 筆級距序號`}>{index + 1}</output></td>
                <td data-label="薪資下限（元）"><input className={RATE_INPUT} type="number" min="0" step="1" value={bracket.lowerSalary} aria-label={`第 ${index + 1} 筆薪資下限`} onChange={(event) => updateBracket(bracket.key, { lowerSalary: Number(event.target.value) })} /></td>
                <td data-label="薪資上限（元）"><input className={RATE_INPUT} type="number" min="0" step="1" value={bracket.upperSalary ?? ""} placeholder="無上限" aria-label={`第 ${index + 1} 筆薪資上限，留空表示無上限`} onChange={(event) => updateBracket(bracket.key, { upperSalary: event.target.value.trim() ? Number(event.target.value) : null })} /></td>
                <td data-label="投保金額（元）"><input className={RATE_INPUT} type="number" min="1" step="1" value={bracket.insuredAmount} aria-label={`第 ${index + 1} 筆投保金額`} onChange={(event) => updateBracket(bracket.key, { insuredAmount: Number(event.target.value) })} /></td>
                <td data-label="員工負擔／月"><output className="numeric grid min-h-10 items-center justify-items-end px-2.5 py-2 font-bold whitespace-nowrap text-brand-dark tabular-nums" aria-label={`第 ${index + 1} 筆級距員工每月負擔`}>{employeeAmountLabel(bracket.employeeAmountMinor)}</output></td>
                <td data-label="操作"><Button type="button" variant="icon" icon="trash" title={`刪除第 ${index + 1} 筆級距`} aria-label={`刪除第 ${index + 1} 筆級距`} onClick={() => removeBracket(bracket.key)} /></td>
              </tr>)}
            </tbody>
        </DataTable>
        {!brackets.length ? <EmptyState className="mt-[18px]">尚無級距，請新增一筆。</EmptyState> : null}
        <div className="flex flex-wrap items-center gap-4 px-0.5"><Button type="button" icon="plus" tone="success" mobileIconOnly onClick={addBracket}>新增級距</Button><span className="muted">薪資下限填 0 代表「以下」級距；員工負擔由該年度費率計算，健保欄先以 0 位眷屬呈現。</span></div>
      </div>
      <div className="field-grid gap-5">
        <TextField label="資料來源網址或公告名稱（可留空）" value={sourceUrl} maxLength={500} onChange={(event) => setSourceUrl(event.target.value)} />
        <TextField label="人工維護備註" required value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} hint="請填官方公告、文件名稱或主管覆核依據。" />
      </div>
      {message || save.error || remove.error ? <Alert tone="danger">{message || save.error?.message || remove.error?.message}</Alert> : null}
      <div className="flex flex-wrap justify-end gap-3 pt-1">
        {isExistingDraft ? <Button type="button" variant="danger" icon="trash" onClick={() => setConfirmDelete(true)} disabled={save.isPending || remove.isPending}>刪除草稿</Button> : null}
        <Button type="submit" tone={isExistingDraft ? "info" : "success"} loading={save.isPending}>儲存</Button>
      </div>
    </form>
    {confirmDelete ? <ConfirmDialog title={`刪除${SCHEME_LABEL[scheme]}級距草稿？`} pending={remove.isPending} closeRequestRef={closeRequestRef} onCancel={() => setConfirmDelete(false)} onConfirm={confirmRemove}><p>這只會刪除尚未啟用的待審閱版本，不會影響目前啟用或歷史級距。</p></ConfirmDialog> : null}
  </>;
}
