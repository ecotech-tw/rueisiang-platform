import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, TextField, Tooltip } from "../../ui/index.js";
import { shiftTimeRange, useHrQuery, useHrWrite, type HrShiftsResponse, type ScheduleScope, type ScheduleShift } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

/** 同一家店依上班時間排：早班在晚班前面，讀起來才像一天的順序。 */
function byStartTime(a: ScheduleShift, b: ScheduleShift) {
  return a.startSecond - b.startSecond || a.endSecond - b.endSecond || a.name.localeCompare(b.name, "zh-TW");
}

function clock(seconds: number) {
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}`;
}

interface ShiftRowDraft {
  key: string;
  original: ScheduleShift | null;
  name: string;
  startTime: string;
  endTime: string;
  standardMinutes: string;
  breakMinutes: string;
}

function rowsFromShifts(shifts: ScheduleShift[]): ShiftRowDraft[] {
  return shifts.map((shift) => ({ key: shift.versionId, original: shift, name: shift.name, startTime: clock(shift.startSecond), endTime: clock(shift.endSecond), standardMinutes: String(shift.standardMinutes), breakMinutes: String(shift.breakMinutes) }));
}

/*
 * 計薪工時與休息時間一定要跟著每一次修改送出：後端沒收到這兩個欄位時會依時段重算預設值，
 * 只改名稱就會把人工設定好的工時洗掉，而薪資的時數是從這裡來的。
 */
function validWorkMinutes(row: ShiftRowDraft) {
  const standard = Number(row.standardMinutes);
  const rest = Number(row.breakMinutes);
  const duration = Number(row.endTime.slice(0, 2)) * 60 + Number(row.endTime.slice(3)) - Number(row.startTime.slice(0, 2)) * 60 - Number(row.startTime.slice(3));
  return row.standardMinutes.trim() !== "" && row.breakMinutes.trim() !== "" && Number.isSafeInteger(standard) && Number.isSafeInteger(rest)
    && standard >= 0 && standard <= 1440 && rest >= 0 && rest <= 1440 && standard + rest <= duration;
}

function rowChanged(row: ShiftRowDraft) {
  if (!row.original) return true;
  if (row.original.endDayOffset) return false;
  return row.name.trim() !== row.original.name || row.startTime !== clock(row.original.startSecond) || row.endTime !== clock(row.original.endSecond)
    || row.standardMinutes !== String(row.original.standardMinutes) || row.breakMinutes !== String(row.original.breakMinutes);
}

/**
 * 一家店的班別，全部在同一個視窗裡完成。
 *
 * 每列都是可直接編輯的草稿；新增、修改與刪除一起在右下角「儲存」時送出，
 * 和敘薪的項目編輯保持同一種操作節奏，不需要先找一顆編輯按鈕再跳到另一張表單。
 */
function StoreShiftsDialog({ scope, shifts, canWrite, onClose, onSaved }: { scope: ScheduleScope; shifts: ScheduleShift[]; canWrite: boolean; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [rows, setRows] = useState(() => rowsFromShifts(shifts));
  const [removedRows, setRemovedRows] = useState<ScheduleShift[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const save = useHrWrite();
  const toast = useToast();
  const hasChanges = removedRows.length > 0 || rows.length !== shifts.length || rows.some(rowChanged);

  const updateRow = (key: string, patch: Partial<Pick<ShiftRowDraft, "name" | "startTime" | "endTime" | "standardMinutes" | "breakMinutes">>) => {
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
    setMessage(null);
  };

  const addNewRow = () => {
    setRows((current) => [...current, { key: `new-${crypto.randomUUID()}`, original: null, name: "", startTime: "09:00", endTime: "18:00", standardMinutes: "480", breakMinutes: "60" }]);
    setMessage(null);
  };

  const removeRow = (row: ShiftRowDraft) => {
    if (save.isPending) return;
    if (row.original) setRemovedRows((current) => [...current, row.original!]);
    setRows((current) => current.filter((candidate) => candidate.key !== row.key));
    setMessage(null);
  };

  const saveAll = async () => {
    if (!hasChanges || save.isPending) return;
    save.reset();
    setMessage(null);

    const names = new Set<string>();
    for (const row of rows) {
      const name = row.name.trim();
      if (!name) { setMessage("每個班別都要有名稱，未完成的列請先刪除。"); return; }
      if (names.has(name)) { setMessage(`班別名稱「${name}」重複了，請改成不同名稱。`); return; }
      names.add(name);
      if (row.original?.endDayOffset) continue;
      if (!row.startTime || !row.endTime) { setMessage(`「${name}」請填寫開始與結束時間。`); return; }
      if (row.endTime <= row.startTime) { setMessage(`「${name}」的結束時間必須晚於開始時間。`); return; }
      if (!validWorkMinutes(row)) { setMessage(`「${name}」的計薪工時與休息時間必須是整數分鐘，合計不可超過班別時長。`); return; }
    }

    try {
      for (const row of removedRows) {
        await save.mutateAsync({ path: `/shift-templates/${encodeURIComponent(row.templateId)}`, method: "DELETE", values: { scopeId: scope.id, revision: row.revision } });
      }
      for (const row of rows) {
        const name = row.name.trim();
        if (row.original) {
          if (!rowChanged(row)) continue;
          await save.mutateAsync({ path: `/shift-templates/${encodeURIComponent(row.original.templateId)}`, method: "PATCH", values: { scopeId: scope.id, name, startTime: row.startTime, endTime: row.endTime, standardMinutes: Number(row.standardMinutes), breakMinutes: Number(row.breakMinutes), revision: row.original.revision } });
        } else {
          await save.mutateAsync({ path: "/shift-templates", method: "POST", values: { scopeId: scope.id, name, startTime: row.startTime, endTime: row.endTime, standardMinutes: Number(row.standardMinutes), breakMinutes: Number(row.breakMinutes) } });
        }
      }
      await onSaved();
      toast.show("班別設定已儲存。");
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "班別設定儲存失敗，請稍後再試。");
    }
  };

  return <Dialog
    title={scope.name}
    onClose={onClose}
    closeDisabled={save.isPending}
    actions={canWrite ? <Button loading={save.isPending} disabled={!hasChanges} onClick={() => { void saveAll(); }}>儲存</Button> : undefined}
  >
    <div className="shift-items">
      <span className="shift-items-label">班別時段</span>
      <div className="shift-items-head" aria-hidden="true"><span>班別</span><span>開始時間</span><span>結束時間</span><span>計薪工時（分鐘）</span><span>休息（分鐘）</span><span className="shift-item-spacer" /></div>
      {rows.map((row) => {
        const legacyOvernight = Boolean(row.original?.endDayOffset);
        return <div key={row.key} className={`shift-item-row${row.original ? "" : " shift-item-row-draft"}`}>
          <TextField label="班別" aria-label={`${row.name || "班別"}名稱`} required maxLength={100} placeholder="例如：早班" value={row.name} disabled={!canWrite || legacyOvernight || save.isPending} onChange={(event) => updateRow(row.key, { name: event.target.value })} />
          <TextField label="開始時間" aria-label={`${row.name || "班別"}開始時間`} type="time" required value={row.startTime} disabled={!canWrite || legacyOvernight || save.isPending} onChange={(event) => updateRow(row.key, { startTime: event.target.value })} />
          <TextField label="結束時間" aria-label={`${row.name || "班別"}結束時間`} type="time" required value={row.endTime} disabled={!canWrite || legacyOvernight || save.isPending} onChange={(event) => updateRow(row.key, { endTime: event.target.value })} />
          <TextField label="計薪工時（分鐘）" aria-label={`${row.name || "班別"}計薪工時（分鐘）`} type="number" min="0" max="1440" step="1" required value={row.standardMinutes} disabled={!canWrite || legacyOvernight || save.isPending} onChange={(event) => updateRow(row.key, { standardMinutes: event.target.value })} />
          <TextField label="休息（分鐘）" aria-label={`${row.name || "班別"}休息時間（分鐘）`} type="number" min="0" max="1440" step="1" required value={row.breakMinutes} disabled={!canWrite || legacyOvernight || save.isPending} onChange={(event) => updateRow(row.key, { breakMinutes: event.target.value })} />
          {canWrite ? <Tooltip label={`刪除${row.name ? ` ${row.name}` : "這個班別"}`} focusable={false}>
            <Button variant="icon" icon="trash" className="danger hr-bonus-action-delete" aria-label={`刪除${row.name || "這個班別"}`} disabled={save.isPending} onClick={() => removeRow(row)} />
          </Tooltip> : <span className="shift-item-spacer" aria-hidden="true" />}
          {legacyOvernight ? <small className="shift-item-note">跨午夜的舊班別，請刪除後重新建立。</small> : null}
        </div>;
      })}
      {!rows.length ? <p className="muted shift-items-empty">尚未設定班別，按下「新增班別」後會直接出現可編輯的列。</p> : null}
      {message || save.error ? <Alert tone="danger">{message ?? save.error?.message}</Alert> : null}
      <div className="shift-items-foot">
        {canWrite ? <Button variant="secondary" icon="plus" disabled={save.isPending} onClick={addNewRow}>新增班別</Button> : <span />}
        <p className="shift-items-total">共 <strong>{rows.length}</strong> 個班別</p>
      </div>
    </div>
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
            <td data-label="班別">{list.length ? list.map((shift) => `${shift.name} ${shiftTimeRange(shift)}（計薪 ${(shift.standardMinutes / 60).toFixed(1)} 小時／休息 ${shift.breakMinutes} 分鐘）`).join("、") : <span className="muted">尚未設定</span>}</td>
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
