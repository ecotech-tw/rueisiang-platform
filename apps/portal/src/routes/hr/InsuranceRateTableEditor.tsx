import { useEffect, useState } from "react";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Alert, Button, TextField } from "../../ui/index.js";
import { useHrWrite, type InsuranceBracket, type InsuranceRateTableRecord } from "./api.js";

const SCHEME_LABEL: Record<"labor" | "health", string> = { labor: "勞保", health: "健保" };

interface BracketDraft extends InsuranceBracket {
  key: string;
  upperSalary: number | null;
}

function draftKey() {
  return `bracket-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toDraft(bracket: InsuranceBracket): BracketDraft {
  return { ...bracket, key: draftKey() };
}

function integer(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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

  useEffect(() => { onBusy?.(save.isPending || remove.isPending); }, [onBusy, remove.isPending, save.isPending]);

  const updateBracket = (key: string, patch: Partial<Pick<InsuranceBracket, "lowerSalary" | "upperSalary" | "insuredAmount">>) => {
    setBrackets((current) => current.map((bracket) => bracket.key === key ? { ...bracket, ...patch } : bracket));
  };
  const addBracket = () => {
    setBrackets((current) => [...current, { key: draftKey(), level: current.length + 1, lowerSalary: 0, upperSalary: null, insuredAmount: 0 }]);
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
    remove.mutate({ path: `/insurance-rates/${table.id}`, method: "DELETE", values: {} }, { onSuccess: () => { setConfirmDelete(false); (onDeleted ?? onSaved)?.(); } });
  };

  return <>
    <form className="hr-rate-editor-form" onSubmit={submit}>
      <div className="hr-rate-editor-intro"><strong>{isExistingDraft ? "編輯待審閱版本" : table ? "從目前啟用版本建立人工版本" : "建立人工版本"}</strong><span className="muted">{year} 年・{SCHEME_LABEL[scheme]}；人工資料會保留來源與覆核備註。</span></div>
      <div className="hr-rate-editor">
        <div className="table-scroll hr-rate-editor-scroll">
          <table className="data-table compact hr-rate-editor-table">
            <thead><tr><th>級距</th><th>薪資下限（元）</th><th>薪資上限（元）</th><th>投保金額（元）</th><th>操作</th></tr></thead>
            <tbody>
              {brackets.map((bracket, index) => <tr key={bracket.key}>
                <td data-label="級距"><output className="hr-rate-level" aria-label={`第 ${index + 1} 筆級距序號`}>{index + 1}</output></td>
                <td data-label="薪資下限（元）"><input className="hr-rate-input numeric" type="number" min="0" step="1" value={bracket.lowerSalary} aria-label={`第 ${index + 1} 筆薪資下限`} onChange={(event) => updateBracket(bracket.key, { lowerSalary: Number(event.target.value) })} /></td>
                <td data-label="薪資上限（元）"><input className="hr-rate-input numeric" type="number" min="0" step="1" value={bracket.upperSalary ?? ""} placeholder="無上限" aria-label={`第 ${index + 1} 筆薪資上限，留空表示無上限`} onChange={(event) => updateBracket(bracket.key, { upperSalary: event.target.value.trim() ? Number(event.target.value) : null })} /></td>
                <td data-label="投保金額（元）"><input className="hr-rate-input numeric" type="number" min="1" step="1" value={bracket.insuredAmount} aria-label={`第 ${index + 1} 筆投保金額`} onChange={(event) => updateBracket(bracket.key, { insuredAmount: Number(event.target.value) })} /></td>
                <td data-label="操作"><Button type="button" variant="icon" icon="trash" title={`刪除第 ${index + 1} 筆級距`} aria-label={`刪除第 ${index + 1} 筆級距`} onClick={() => removeBracket(bracket.key)} /></td>
              </tr>)}
            </tbody>
          </table>
        </div>
        {!brackets.length ? <p className="empty-state">尚無級距，請新增一筆。</p> : null}
        <div className="hr-rate-editor-foot"><Button type="button" variant="secondary" icon="plus" onClick={addBracket}>新增級距</Button><span className="muted">上限留空代表該級距沒有上限。</span></div>
      </div>
      <div className="field-grid">
        <TextField label="資料來源網址或公告名稱（可留空）" value={sourceUrl} maxLength={500} onChange={(event) => setSourceUrl(event.target.value)} />
        <TextField label="人工維護備註" required value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} hint="請填官方公告、文件名稱或主管覆核依據。" />
      </div>
      {message || save.error || remove.error ? <Alert tone="danger">{message || save.error?.message || remove.error?.message}</Alert> : null}
      <div className="hr-rate-editor-actions">
        {isExistingDraft ? <Button type="button" variant="danger" icon="trash" onClick={() => setConfirmDelete(true)} disabled={save.isPending || remove.isPending}>刪除草稿</Button> : null}
        <Button type="submit" loading={save.isPending}>保存級距</Button>
      </div>
    </form>
    {confirmDelete ? <ConfirmDialog title={`刪除${SCHEME_LABEL[scheme]}級距草稿？`} pending={remove.isPending} onCancel={() => setConfirmDelete(false)} onConfirm={confirmRemove}><p>這只會刪除尚未啟用的待審閱版本，不會影響目前啟用或歷史級距。</p></ConfirmDialog> : null}
  </>;
}
