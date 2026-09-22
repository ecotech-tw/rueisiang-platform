import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, TextField, Tooltip } from "../../ui/index.js";
import { groupShiftsByTemplate, shiftTimeRange, useHrQuery, useHrWrite, HR_DAY_TYPES, HR_DAY_TYPE_LABELS, type HrDayType, type HrShiftsResponse, type ScheduleScope, type ScheduleShift } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

/** 同一家店依平日的上班時間排：早班在晚班前面，讀起來才像一天的順序。 */
function byStartTime(a: ShiftGroup, b: ShiftGroup) {
  return a.weekday.startSecond - b.weekday.startSecond || a.weekday.endSecond - b.weekday.endSecond || a.name.localeCompare(b.name, "zh-TW");
}

function clock(seconds: number) {
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}`;
}

/** 一個班別與它的每個日型時間；平日那組一定存在，其他兩組可有可無。 */
interface ShiftGroup {
  templateId: string;
  name: string;
  revision: number;
  scopeId: string;
  weekday: ScheduleShift;
  versions: ScheduleShift[];
}

function toGroups(shifts: ScheduleShift[]): ShiftGroup[] {
  const groups: ShiftGroup[] = [];
  for (const versions of groupShiftsByTemplate(shifts).values()) {
    const weekday = versions.find((shift) => shift.dayType === "weekday") ?? versions[0];
    if (!weekday) continue;
    groups.push({ templateId: weekday.templateId, name: weekday.name, revision: weekday.revision, scopeId: weekday.scopeId, weekday, versions });
  }
  return groups;
}

/** 草稿裡「沒設定這個日型」就是 null；送出時不放進 times，後端會把那一組刪掉。 */
type TimeDraft = { startTime: string; endTime: string } | null;

interface ShiftRowDraft {
  key: string;
  original: ShiftGroup | null;
  name: string;
  times: Record<HrDayType, TimeDraft>;
}

function rowsFromGroups(groups: ShiftGroup[]): ShiftRowDraft[] {
  return groups.map((group) => ({
    key: group.templateId,
    original: group,
    name: group.name,
    times: Object.fromEntries(HR_DAY_TYPES.map((dayType) => {
      const version = group.versions.find((shift) => shift.dayType === dayType);
      return [dayType, version ? { startTime: clock(version.startSecond), endTime: clock(version.endSecond) } : null];
    })) as Record<HrDayType, TimeDraft>,
  }));
}

function sameTimes(row: ShiftRowDraft, group: ShiftGroup) {
  return HR_DAY_TYPES.every((dayType) => {
    const draft = row.times[dayType];
    const version = group.versions.find((shift) => shift.dayType === dayType);
    if (!draft || !version) return !draft && !version;
    return draft.startTime === clock(version.startSecond) && draft.endTime === clock(version.endSecond);
  });
}

function rowChanged(row: ShiftRowDraft) {
  if (!row.original) return true;
  if (row.original.weekday.endDayOffset) return false;
  return row.name.trim() !== row.original.name || !sameTimes(row, row.original);
}

function timesPayload(row: ShiftRowDraft) {
  return HR_DAY_TYPES.flatMap((dayType) => {
    const draft = row.times[dayType];
    return draft ? [{ dayType, startTime: draft.startTime, endTime: draft.endTime }] : [];
  });
}

/**
 * 一家店的班別，全部在同一個視窗裡完成。
 *
 * 每列都是可直接編輯的草稿；新增、修改與刪除一起在右下角「儲存」時送出，
 * 和敘薪的項目編輯保持同一種操作節奏，不需要先找一顆編輯按鈕再跳到另一張表單。
 *
 * 平日那一格永遠顯示，週末與國定假日預設是一句「同平日」加一顆新增鈕——多數班別
 * 週末跟平日一樣，一開始就擺三排空欄位會讓人以為非填不可，然後隨便填一組進去。
 */
function StoreShiftsDialog({ scope, groups, canWrite, onClose, onSaved }: { scope: ScheduleScope; groups: ShiftGroup[]; canWrite: boolean; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [rows, setRows] = useState(() => rowsFromGroups(groups));
  const [removedRows, setRemovedRows] = useState<ShiftGroup[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const save = useHrWrite();
  const toast = useToast();
  const hasChanges = removedRows.length > 0 || rows.length !== groups.length || rows.some(rowChanged);

  const updateRow = (key: string, patch: Partial<Pick<ShiftRowDraft, "name">>) => {
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
    setMessage(null);
  };

  const updateTime = (key: string, dayType: HrDayType, patch: Partial<{ startTime: string; endTime: string }> | null) => {
    setRows((current) => current.map((row) => {
      if (row.key !== key) return row;
      const base = row.times[dayType] ?? { startTime: row.times.weekday?.startTime ?? "09:00", endTime: row.times.weekday?.endTime ?? "18:00" };
      return { ...row, times: { ...row.times, [dayType]: patch === null ? null : { ...base, ...patch } } };
    }));
    setMessage(null);
  };

  const addNewRow = () => {
    setRows((current) => [...current, { key: `new-${crypto.randomUUID()}`, original: null, name: "", times: { weekday: { startTime: "09:00", endTime: "18:00" }, weekend: null, holiday: null } }]);
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
      if (row.original?.weekday.endDayOffset) continue;
      for (const dayType of HR_DAY_TYPES) {
        const draft = row.times[dayType];
        if (!draft) continue;
        const label = HR_DAY_TYPE_LABELS[dayType];
        if (!draft.startTime || !draft.endTime) { setMessage(`「${name}」的${label}時間請填寫開始與結束。`); return; }
        if (draft.endTime <= draft.startTime) { setMessage(`「${name}」的${label}結束時間必須晚於開始時間。`); return; }
      }
    }

    try {
      for (const row of removedRows) {
        await save.mutateAsync({ path: `/shift-templates/${encodeURIComponent(row.templateId)}`, method: "DELETE", values: { scopeId: scope.id, revision: row.revision } });
      }
      for (const row of rows) {
        const name = row.name.trim();
        if (row.original) {
          if (!rowChanged(row)) continue;
          await save.mutateAsync({ path: `/shift-templates/${encodeURIComponent(row.original.templateId)}`, method: "PATCH", values: { scopeId: scope.id, name, times: timesPayload(row), revision: row.original.revision } });
        } else {
          await save.mutateAsync({ path: "/shift-templates", method: "POST", values: { scopeId: scope.id, name, times: timesPayload(row) } });
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
      {rows.map((row) => {
        const legacyOvernight = Boolean(row.original?.weekday.endDayOffset);
        const disabled = !canWrite || legacyOvernight || save.isPending;
        return <div key={row.key} className={`shift-group${row.original ? "" : " shift-group-draft"}`}>
          <div className="shift-group-head">
            <TextField label="班別名稱" aria-label={`${row.name || "班別"}名稱`} required maxLength={100} placeholder="例如：早班" value={row.name} disabled={disabled} onChange={(event) => updateRow(row.key, { name: event.target.value })} />
            {canWrite ? <Tooltip label={`刪除${row.name ? ` ${row.name}` : "這個班別"}`} focusable={false}>
              <Button variant="icon" icon="trash" className="danger" aria-label={`刪除${row.name || "這個班別"}`} disabled={save.isPending} onClick={() => removeRow(row)} />
            </Tooltip> : <span className="shift-item-spacer" aria-hidden="true" />}
          </div>
          {HR_DAY_TYPES.map((dayType) => {
            const draft = row.times[dayType];
            const label = HR_DAY_TYPE_LABELS[dayType];
            if (!draft) return <div className="shift-day-row shift-day-row-empty" key={dayType}>
              <span className="shift-day-label">{label}</span>
              <span className="muted">同平日</span>
              {canWrite ? <Button variant="secondary" icon="plus" disabled={disabled} onClick={() => updateTime(row.key, dayType, {})}>設定{label}時間</Button> : null}
            </div>;
            return <div className="shift-day-row" key={dayType}>
              <span className="shift-day-label">{label}</span>
              <TextField label="開始時間" aria-label={`${row.name || "班別"}${label}開始時間`} type="time" required value={draft.startTime} disabled={disabled} onChange={(event) => updateTime(row.key, dayType, { startTime: event.target.value })} />
              <TextField label="結束時間" aria-label={`${row.name || "班別"}${label}結束時間`} type="time" required value={draft.endTime} disabled={disabled} onChange={(event) => updateTime(row.key, dayType, { endTime: event.target.value })} />
              {/* 平日是其他日型的退路，拿掉就沒有東西可退；所以只有另外兩個日型能取消。 */}
              {canWrite && dayType !== "weekday" ? <Tooltip label={`改回同平日`} focusable={false}>
                <Button variant="icon" icon="close" aria-label={`${label}改回同平日`} disabled={disabled} onClick={() => updateTime(row.key, dayType, null)} />
              </Tooltip> : <span className="shift-item-spacer" aria-hidden="true" />}
            </div>;
          })}
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

/** 表格那一欄的摘要：只設平日就寫時間，有其他日型才點出來，不然每家店都拖成三行。 */
function groupSummary(group: ShiftGroup) {
  const extras = group.versions.filter((shift) => shift.dayType !== "weekday");
  return `${group.name} ${shiftTimeRange(group.weekday)}${extras.length ? `（另設${extras.map((shift) => HR_DAY_TYPE_LABELS[shift.dayType]).join("、")}）` : ""}`;
}

export function HrShifts() {
  usePageTitle("班別管理");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:schedule:read");
  const canWrite = permissions.has("hr:schedule:write");
  const shifts = useHrQuery<HrShiftsResponse>("/shift-templates", canRead);
  const [openScopeId, setOpenScopeId] = useState<string | null>(null);
  const data = shifts.data;

  const groupsByScope = useMemo(() => {
    const byScope = new Map<string, ScheduleShift[]>();
    for (const shift of data?.shifts ?? []) byScope.set(shift.scopeId, [...(byScope.get(shift.scopeId) ?? []), shift]);
    const grouped = new Map<string, ShiftGroup[]>();
    for (const [scopeId, list] of byScope) grouped.set(scopeId, toGroups(list).sort(byStartTime));
    return grouped;
  }, [data?.shifts]);

  if (!canRead) return <Alert tone="danger">你沒有檢視班別的權限。</Alert>;
  if (shifts.isPending) return <HrPageSkeleton variant="table" />;
  if (shifts.error || !data) return <div className="page"><Alert tone="danger">{shifts.error?.message ?? "班別資料載入失敗。"}</Alert></div>;

  const openScope = data.scopes.find((scope) => scope.id === openScopeId);
  return <div className="page fills">
    <PageHeader title="班別管理" description="每個班別可分別設定平日、週末與國定假日的時間；沒設定的日型會沿用平日。" />
    <Panel className="grows">
      <div className="table-scroll"><table className="data-table"><thead><tr>
        <th>營運據點</th><th className="numeric">班別數</th><th>班別</th>
      </tr></thead><tbody>
        {data.scopes.map((scope) => {
          const list = groupsByScope.get(scope.id) ?? [];
          return <tr key={scope.id} className="clickable-row" role="button" tabIndex={0} aria-haspopup="dialog" onClick={() => setOpenScopeId(scope.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpenScopeId(scope.id); } }}>
            <td data-label="營運據點"><span className="cell-strong">{scope.name}</span></td>
            <td data-label="班別數" className="numeric">{list.length}</td>
            {/* 沒有班別的店在排班月曆選不到任何班，所以要一眼看得出來，不是留一格空白。 */}
            <td data-label="班別">{list.length ? list.map(groupSummary).join("、") : <span className="muted">尚未設定</span>}</td>
          </tr>;
        })}
      </tbody></table></div>
      {!data.scopes.length ? <p className="muted table-note">目前沒有啟用中的營運據點。</p> : null}
    </Panel>
    {openScope ? <StoreShiftsDialog
      scope={openScope}
      groups={groupsByScope.get(openScope.id) ?? []}
      canWrite={canWrite}
      onClose={() => setOpenScopeId(null)}
      onSaved={() => shifts.refetch()}
    /> : null}
  </div>;
}
