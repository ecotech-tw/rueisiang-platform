import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, TextField } from "../../ui/index.js";
import { shiftTimeRange, useHrQuery, useHrWrite, type HrShiftsResponse, type ScheduleScope, type ScheduleShift } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

/** 同一家店依上班時間排：早班在晚班前面，讀起來才像一天的順序。 */
function byStartTime(a: ScheduleShift, b: ScheduleShift) {
  return a.startSecond - b.startSecond || a.endSecond - b.endSecond || a.name.localeCompare(b.name, "zh-TW");
}

function clock(seconds: number) {
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}`;
}

/** 視窗裡目前在看什麼：班別清單、新增／修改的表單，或刪除確認。 */
type View = { kind: "list" } | { kind: "create" } | { kind: "edit"; shift: ScheduleShift } | { kind: "delete"; shift: ScheduleShift };

/**
 * 一家店的班別，全部在同一個視窗裡完成。
 *
 * 新增、修改、刪除確認都不開第二層視窗，而是換掉同一個視窗的內容：視窗疊視窗時，
 * 按 Esc 或點遮罩到底關哪一層沒人說得準，存完也不容易回到原本那張清單。
 */
function StoreShiftsDialog({ scope, shifts, canWrite, onClose, onSaved }: { scope: ScheduleScope; shifts: ScheduleShift[]; canWrite: boolean; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00");
  const save = useHrWrite();
  const toast = useToast();

  const openForm = (next: View) => {
    save.reset();
    const shift = next.kind === "edit" ? next.shift : null;
    setName(shift?.name ?? "");
    setStartTime(shift ? clock(shift.startSecond) : "09:00");
    setEndTime(shift ? clock(shift.endSecond) : "18:00");
    setView(next);
  };

  if (view.kind === "list") {
    return <Dialog title={scope.name} onClose={onClose} actions={canWrite ? <Button icon="plus" className="add-action" onClick={() => openForm({ kind: "create" })}>新增班別</Button> : undefined}>
      {shifts.length ? <div className="table-scroll"><table className="data-table"><thead><tr>
        <th>班別</th><th className="numeric">上班時間</th>{canWrite ? <th><span className="sr-only">操作</span></th> : null}
      </tr></thead><tbody>
        {shifts.map((shift) => <tr key={shift.versionId}>
          <td data-label="班別"><span className="cell-strong">{shift.name}</span></td>
          <td data-label="上班時間" className="numeric">{shiftTimeRange(shift)}</td>
          {canWrite ? <td data-label="操作"><div className="row-actions">
            <Button variant="icon" icon="edit" className="compensation-action-update" title={`修改 ${shift.name}`} aria-label={`修改 ${shift.name}`} onClick={() => openForm({ kind: "edit", shift })} />
            <Button variant="icon" icon="trash" className="danger hr-bonus-action-delete" title={`刪除 ${shift.name}`} aria-label={`刪除 ${shift.name}`} onClick={() => { save.reset(); setView({ kind: "delete", shift }); }} />
          </div></td> : null}
        </tr>)}
      </tbody></table></div> : <p className="muted">這家店還沒有班別。新增之後，排班月曆才選得到。</p>}
    </Dialog>;
  }

  if (view.kind === "delete") {
    const target = view.shift;
    return <Dialog
      title={`刪除班別 · ${scope.name}`}
      role="alertdialog"
      onClose={onClose}
      closeDisabled={save.isPending}
      actions={<><Button variant="secondary" disabled={save.isPending} onClick={() => { save.reset(); setView({ kind: "list" }); }}>取消</Button><Button variant="danger" icon="trash" loading={save.isPending} onClick={() => save.mutate(
        { path: `/shift-templates/${encodeURIComponent(target.templateId)}`, method: "DELETE", values: { scopeId: scope.id, revision: target.revision } },
        { onSuccess: async () => { toast.show(`已刪除班別「${target.name}」。`); await onSaved(); setView({ kind: "list" }); } },
      )}>刪除班別</Button></>}
    >
      <p>確定刪除「{target.name}」（{shiftTimeRange(target)}）？</p>
      {/* 已排進排班的班別刪不掉；錯誤留在畫面上說明排在哪，讓人知道要先去排班月曆處理，而不是只閃一下提示。 */}
      {save.error ? <Alert tone="danger">{save.error.message}</Alert> : <p className="muted">只有還沒排進任何排班的班別可以刪除。</p>}
    </Dialog>;
  }

  const editing = view.kind === "edit" ? view.shift : null;
  // 班別一律當天上下班；結束早於開始多半是打錯，送出前就擋，不必等後端回一句看不出錯在哪的訊息。
  const invalidRange = Boolean(startTime && endTime && endTime <= startTime);
  const back = () => { save.reset(); setView({ kind: "list" }); };
  return <Dialog
    title={editing ? `修改班別 · ${scope.name}` : `新增班別 · ${scope.name}`}
    onClose={onClose}
    closeDisabled={save.isPending}
    formProps={{ onSubmit: (event) => {
      event.preventDefault();
      if (invalidRange) return;
      const values = { scopeId: scope.id, name, startTime, endTime };
      save.mutate(editing
        ? { path: `/shift-templates/${encodeURIComponent(editing.templateId)}`, method: "PATCH", values: { ...values, revision: editing.revision } }
        : { path: "/shift-templates", method: "POST", values }, {
        onSuccess: async () => {
          toast.show(editing ? `已修改班別「${name.trim()}」。` : `已新增班別「${name.trim()}」。`);
          await onSaved();
          setView({ kind: "list" });
        },
      });
    } }}
    actions={<><Button type="button" variant="secondary" disabled={save.isPending} onClick={back}>返回</Button><Button type="submit" loading={save.isPending} disabled={invalidRange}>{editing ? "儲存修改" : "建立班別"}</Button></>}
  >
    <TextField label="班別名稱" required maxLength={100} placeholder="例如：早班" value={name} onChange={(event) => setName(event.target.value)} />
    <div className="form-grid two">
      <TextField label="開始時間" type="time" required value={startTime} onChange={(event) => setStartTime(event.target.value)} />
      <TextField label="結束時間" type="time" required value={endTime} onChange={(event) => setEndTime(event.target.value)} />
    </div>
    {/* 修改是直接改在原本的班別上：已經排出去的班存著自己的時間，但那個月重新按儲存就會套用新時間。這句要在按下去之前讀得到。 */}
    {editing ? <p className="muted">修改會直接套用到這個班別。已排好的班維持原本時間，但該月份重新儲存排班時會改用新時間；已結算的月份請先鎖定。</p> : null}
    {invalidRange ? <Alert tone="danger">結束時間必須晚於開始時間。</Alert> : null}
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
  </Dialog>;
}

export function HrShifts() {
  usePageTitle("班別管理");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:schedule:read");
  const canWrite = permissions.has("hr:schedule:write");
  const shifts = useHrQuery<HrShiftsResponse>("/shift-templates", canRead);
  const [openScopeId, setOpenScopeId] = useState<string | null>(null);
  const data = shifts.data;

  const shiftsByScope = useMemo(() => {
    const grouped = new Map<string, ScheduleShift[]>();
    for (const shift of data?.shifts ?? []) grouped.set(shift.scopeId, [...(grouped.get(shift.scopeId) ?? []), shift]);
    for (const list of grouped.values()) list.sort(byStartTime);
    return grouped;
  }, [data?.shifts]);

  if (!canRead) return <Alert tone="danger">你沒有檢視班別的權限。</Alert>;
  if (shifts.isPending) return <HrPageSkeleton variant="table" />;
  if (shifts.error || !data) return <div className="page"><Alert tone="danger">{shifts.error?.message ?? "班別資料載入失敗。"}</Alert></div>;

  const openScope = data.scopes.find((scope) => scope.id === openScopeId);
  return <div className="page fills">
    <PageHeader title="班別管理" />
    <Panel className="grows">
      <div className="table-scroll"><table className="data-table"><thead><tr>
        <th>營運據點</th><th className="numeric">班別數</th><th>班別</th>
      </tr></thead><tbody>
        {data.scopes.map((scope) => {
          const list = shiftsByScope.get(scope.id) ?? [];
          return <tr key={scope.id} className="clickable-row" role="button" tabIndex={0} aria-haspopup="dialog" onClick={() => setOpenScopeId(scope.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpenScopeId(scope.id); } }}>
            <td data-label="營運據點"><span className="cell-strong">{scope.name}</span></td>
            <td data-label="班別數" className="numeric">{list.length}</td>
            {/* 沒有班別的店在排班月曆選不到任何班，所以要一眼看得出來，不是留一格空白。 */}
            <td data-label="班別">{list.length ? list.map((shift) => `${shift.name} ${shiftTimeRange(shift)}`).join("、") : <span className="muted">尚未設定</span>}</td>
          </tr>;
        })}
      </tbody></table></div>
      {!data.scopes.length ? <p className="muted table-note">目前沒有啟用中的營運據點。</p> : null}
    </Panel>
    {openScope ? <StoreShiftsDialog
      scope={openScope}
      shifts={shiftsByScope.get(openScope.id) ?? []}
      canWrite={canWrite}
      onClose={() => setOpenScopeId(null)}
      onSaved={() => shifts.refetch()}
    /> : null}
  </div>;
}
