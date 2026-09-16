import { useState } from "react";
import { Alert, Button, Dialog } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type InsuranceRateTableRecord } from "./api.js";
import { InsuranceRateTableEditor } from "./InsuranceRateTableEditor.js";

const SCHEMES = ["labor", "health"] as const;
type InsuranceScheme = typeof SCHEMES[number];
const SCHEME_LABEL: Record<InsuranceScheme, string> = { labor: "勞保", health: "健保" };

function statusLabel(table: InsuranceRateTableRecord | null) {
  if (!table) return "尚未建立";
  return table.status === "draft" ? "待審閱" : table.status === "active" ? "目前啟用" : "已封存";
}

export function InsuranceRateManagementDialog({ year, onClose }: { year: number; onClose: () => void }) {
  const [scheme, setScheme] = useState<InsuranceScheme>("labor");
  const [editorBusy, setEditorBusy] = useState(false);
  const rates = useHrQuery<{ tables: InsuranceRateTableRecord[] }>(`/insurance-rates?year=${year}`);
  const getRates = useHrWrite<{ tables: InsuranceRateTableRecord[] }>();
  const activateRate = useHrWrite();
  const tables = rates.data?.tables ?? [];
  const draft = tables.find((table) => table.scheme === scheme && table.status === "draft");
  const active = tables.find((table) => table.scheme === scheme && table.status === "active");
  const editingTable = draft ?? active ?? null;
  const refresh = () => { void rates.refetch(); };

  return <>
    <Dialog title="級距管理" titleMeta={`${year} 年・勞保與健保投保級距`} onClose={onClose} closeDisabled={getRates.isPending || activateRate.isPending || editorBusy} className="wide">
      <div className="hr-rate-management-intro"><strong>管理年度投保級距</strong><p>可在這裡取得官方級距，或直接建立人工版本。人工版本必須留下來源或覆核備註；啟用後的版本與歷史版本不可直接修改。</p></div>
      <div className="hr-rate-management-toolbar">
        <div className="segmented-control hr-rate-scheme-tabs" role="group" aria-label="級距種類">
          {SCHEMES.map((item) => <button type="button" className={scheme === item ? "selected" : ""} aria-pressed={scheme === item} key={item} onClick={() => setScheme(item)}>{SCHEME_LABEL[item]}{tables.some((table) => table.scheme === item && table.status === "draft") ? "・待審閱" : ""}</button>)}
        </div>
        <div className="row-actions">
          <Button icon="sync" loading={getRates.isPending} loadingLabel="取得中…" onClick={() => getRates.mutate({ path: "/insurance-rates/sync", method: "POST", values: { year } }, { onSuccess: refresh })}>取得級距</Button>
          {draft ? <Button variant="secondary" loading={activateRate.isPending} onClick={() => activateRate.mutate({ path: `/insurance-rates/${draft.id}/activate`, method: "POST", values: {} }, { onSuccess: refresh })}>啟用{SCHEME_LABEL[scheme]}草稿</Button> : null}
        </div>
      </div>
      {rates.error || getRates.error || activateRate.error ? <Alert tone="danger">{rates.error?.message ?? getRates.error?.message ?? activateRate.error?.message}</Alert> : null}
      <div className="hr-rate-management-context"><span className={`status ${editingTable?.status === "draft" ? "status-development" : editingTable?.status === "active" ? "status-active" : "status-invited"}`}>{statusLabel(editingTable)}</span><span>{editingTable ? `${SCHEME_LABEL[scheme]}目前有 ${editingTable.brackets.length} 筆級距` : `尚無${SCHEME_LABEL[scheme]}級距`}</span>{editingTable?.sourceKind === "manual" ? <span className="status status-manual">人工維護</span> : editingTable ? <span className="status status-active">官方資料</span> : null}</div>
      {rates.isPending ? <div className="hr-rate-management-loading" role="status">正在載入級距…</div> : <InsuranceRateTableEditor key={`${scheme}-${editingTable?.id ?? "new"}`} scheme={scheme} year={year} table={editingTable} onSaved={refresh} onDeleted={refresh} onBusy={setEditorBusy} />}
    </Dialog>
  </>;
}
