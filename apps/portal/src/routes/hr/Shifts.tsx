import { useMemo, useRef, useState } from "react";
import { useSession } from "../../auth/session.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, PageHeader, Panel, SelectField, TextField, Tooltip } from "../../ui/index.js";
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
type TimeDraft = { startTime: string; endTime: string; breakMinutes: number; requiredHeadcount: number } | null;

interface ShiftRowDraft {
  key: string;
  original: ShiftGroup | null;
  name: string;
  times: Record<HrDayType, TimeDraft>;
  allowedPersonIds: string[] | null;
}

function rowsFromGroups(groups: ShiftGroup[]): ShiftRowDraft[] {
  return groups.map((group) => ({
    key: group.templateId,
    original: group,
    name: group.name,
    allowedPersonIds: group.weekday.allowedPersonIds ?? null,
    times: Object.fromEntries(HR_DAY_TYPES.map((dayType) => {
      const version = group.versions.find((shift) => shift.dayType === dayType);
      return [dayType, version ? { startTime: clock(version.startSecond), endTime: clock(version.endSecond), breakMinutes: version.breakMinutes, requiredHeadcount: version.requiredHeadcount } : null];
    })) as Record<HrDayType, TimeDraft>,
  }));
}

function sameTimes(row: ShiftRowDraft, group: ShiftGroup) {
  return HR_DAY_TYPES.every((dayType) => {
    const draft = row.times[dayType];
    const version = group.versions.find((shift) => shift.dayType === dayType);
    if (!draft || !version) return !draft && !version;
    return draft.startTime === clock(version.startSecond) && draft.endTime === clock(version.endSecond) && draft.breakMinutes === version.breakMinutes && draft.requiredHeadcount === version.requiredHeadcount;
  });
}

function rowChanged(row: ShiftRowDraft) {
  if (!row.original) return true;
  if (row.original.weekday.endDayOffset) return false;
  return row.name.trim() !== row.original.name || !sameTimes(row, row.original) || JSON.stringify(row.allowedPersonIds?.slice().sort() ?? null) !== JSON.stringify(row.original.weekday.allowedPersonIds?.slice().sort() ?? null);
}

function timesPayload(row: ShiftRowDraft) {
  return HR_DAY_TYPES.flatMap((dayType) => {
    const draft = row.times[dayType];
    return draft ? [{ dayType, startTime: draft.startTime, endTime: draft.endTime, breakMinutes: draft.breakMinutes, requiredHeadcount: draft.requiredHeadcount }] : [];
  });
}

/**
 * 一家店的班別，全部在同一個視窗裡完成。
 *
 * 每列都是可直接編輯的草稿；新增、修改與刪除一起在右下角「儲存」時送出，
 * 和敘薪的項目編輯保持同一種操作節奏，不需要先找一顆編輯按鈕再跳到另一張表單。
 *
 * 平日那一格永遠顯示，週末與國定假日預設沿用平日時段與需求人力；按下設定時間後，
 * 該日型才會變成獨立設定。這樣沿用狀態只有一個入口，也避免半列欄位無法對齊。
 */
function StoreShiftsDialog({ scope, groups, manager, candidates, people, canWrite, onClose, onSaved }: { scope: ScheduleScope; groups: ShiftGroup[]; people: NonNullable<HrShiftsResponse["people"]>; manager: ScheduleManagersResponse["scopes"][number]; candidates: ScheduleManagersResponse["candidates"]; canWrite: boolean; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [rows, setRows] = useState(() => rowsFromGroups(groups));
  const [managerUserId, setManagerUserId] = useState(manager.userId ?? "");
  const [removedRows, setRemovedRows] = useState<ShiftGroup[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const save = useHrWrite();
  const toast = useToast();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const hasChanges = removedRows.length > 0 || rows.length !== groups.length || rows.some(rowChanged) || managerUserId !== (manager.userId ?? "");

  const updateRow = (key: string, patch: Partial<Pick<ShiftRowDraft, "name" | "allowedPersonIds">>) => {
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
    setMessage(null);
  };

  const updateTime = (key: string, dayType: HrDayType, patch: Partial<Omit<NonNullable<TimeDraft>, "requiredHeadcount">> | null) => {
    setRows((current) => current.map((row) => {
      if (row.key !== key) return row;
      const weekday = row.times.weekday ?? { startTime: "09:00", endTime: "18:00", breakMinutes: 60, requiredHeadcount: 1 };
      const base = row.times[dayType] ?? { ...weekday };
      return { ...row, times: { ...row.times, [dayType]: patch === null ? null : { ...base, ...patch } } };
    }));
    setMessage(null);
  };

  const updateHeadcount = (key: string, dayType: HrDayType, requiredHeadcount: number) => {
    setRows((current) => current.map((row) => {
      if (row.key !== key) return row;
      const weekday = row.times.weekday ?? { startTime: "09:00", endTime: "18:00", breakMinutes: 60, requiredHeadcount: 1 };
      const base = row.times[dayType] ?? { ...weekday };
      return { ...row, times: { ...row.times, [dayType]: { ...base, requiredHeadcount } } };
    }));
    setMessage(null);
  };

  const addNewRow = () => {
    setRows((current) => [...current, { key: `new-${crypto.randomUUID()}`, original: null, name: "", allowedPersonIds: [], times: { weekday: { startTime: "09:00", endTime: "18:00", breakMinutes: 60, requiredHeadcount: 1 }, weekend: null, holiday: null } }]);
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
        if (!Number.isSafeInteger(draft.requiredHeadcount) || draft.requiredHeadcount < 1 || draft.requiredHeadcount > 100) { setMessage(`「${name}」的${label}需求人力必須是 1～100 人。`); return; }
        if (![draft.startTime, draft.endTime].every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))) { setMessage(`「${name}」的${label}時間請輸入有效的 HH:mm（例如 09:30）。`); return; }
        if (draft.endTime <= draft.startTime) { setMessage(`「${name}」的${label}結束時間必須晚於開始時間。`); return; }
        const [startHour = 0, startMinute = 0] = draft.startTime.split(":").map(Number);
        const [endHour = 0, endMinute = 0] = draft.endTime.split(":").map(Number);
        const durationMinutes = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
        if (!Number.isInteger(draft.breakMinutes) || draft.breakMinutes < 0 || draft.breakMinutes > durationMinutes) { setMessage(`「${name}」的${label}休息時間必須介於 0 與班別長度之間。`); return; }
      }
    }

    let persistedChanges = false;
    try {
      for (const row of removedRows) {
        await save.mutateAsync({ path: `/shift-templates/${encodeURIComponent(row.templateId)}`, method: "DELETE", values: { scopeId: scope.id, revision: row.revision } });
        persistedChanges = true;
      }
      for (const row of rows) {
        const name = row.name.trim();
        if (row.original) {
          if (!rowChanged(row)) continue;
          await save.mutateAsync({ path: `/shift-templates/${encodeURIComponent(row.original.templateId)}`, method: "PATCH", values: { scopeId: scope.id, name, allowedPersonIds: row.allowedPersonIds, requiredHeadcount: row.times.weekday?.requiredHeadcount, times: timesPayload(row), revision: row.original.revision } });
        } else {
          await save.mutateAsync({ path: "/shift-templates", method: "POST", values: { scopeId: scope.id, name, allowedPersonIds: row.allowedPersonIds, requiredHeadcount: row.times.weekday?.requiredHeadcount, times: timesPayload(row) } });
        }
        persistedChanges = true;
      }
      if (managerUserId !== (manager.userId ?? "")) {
        await save.mutateAsync({ path: `/schedule-managers/${encodeURIComponent(scope.id)}`, method: "PUT", values: { userId: managerUserId || null, revision: manager.revision } });
        persistedChanges = true;
      }
      await onSaved();
      toast.show("班別與排班負責人已儲存。");
      (closeRequestRef.current ?? onClose)();
    } catch (error) {
      if (persistedChanges) {
        await onSaved().catch(() => undefined);
        toast.show("部分設定已儲存。請重新開啟編輯視窗確認，再完成其他變更。", "danger");
        (closeRequestRef.current ?? onClose)();
        return;
      }
      setMessage(error instanceof Error ? error.message : "設定儲存失敗，請稍後再試。");
    }
  };

  return <Dialog
    title={scope.name}
    className="shift-settings-dialog"
    onClose={onClose}
    closeRequestRef={closeRequestRef}
    closeDisabled={save.isPending}
    actions={canWrite ? <Button loading={save.isPending} disabled={!hasChanges} onClick={() => { void saveAll(); }}>儲存</Button> : undefined}
  >
    <div className="shift-items">
      {canWrite ? <><SelectField label="排班負責人" searchable value={managerUserId} disabled={save.isPending} options={[{ value: "", label: "不指定" }, ...(manager.userId && !candidates.some((person) => person.userId === manager.userId) ? [{ value: manager.userId, label: "原負責人（已停用或封存）" }] : []), ...candidates.map((person) => ({ value: person.userId, label: `${person.employeeNumber}・${person.name}` }))]} onChange={(event) => { setManagerUserId(event.target.value); setMessage(null); }} /><p className="muted">每個據點指定一位在職員工，可從 HR 前台的個人中心進入快速排班；儲存直接生效。更換或移除負責人會立即撤銷原負責人的據點排班權限。</p></> : <div><span className="shift-items-label">排班負責人</span><p>{candidates.find((person) => person.userId === manager.userId)?.name ?? (manager.userId ? "已停用或封存" : "尚未指定")}</p></div>}
      <span className="shift-items-label">班別時段</span>
      <p className="muted">時間可直接輸入，格式為 HH:mm（例如 09:30）。</p>
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
          <div className="shift-members">
            <SelectField label="前台可排人員" aria-label={`${row.name || "班別"}前台人員範圍`} value={row.allowedPersonIds === null ? "all" : "selected"} disabled={disabled} options={[{ value: "selected", label: "僅指定人員" }, { value: "all", label: "不限制（所有人員）" }]} onChange={(event) => updateRow(row.key, { allowedPersonIds: event.target.value === "all" ? null : [] })} />
            {row.allowedPersonIds !== null ? <SelectField label="納入人員" aria-label={`${row.name || "班別"}納入人員`} multiple searchable value={row.allowedPersonIds} disabled={disabled} options={[...people.map((person) => ({ value: person.id, label: `${person.employeeNumber}・${person.name}${person.personKind === "worker" ? "（支援）" : ""}` })), ...row.allowedPersonIds.filter((id) => !people.some((person) => person.id === id)).map((id) => ({ value: id, label: "已封存人員" }))]} onValueChange={(allowedPersonIds: string[]) => updateRow(row.key, { allowedPersonIds })} hint="未選人員時，前台不能新增此班別排班。既有班表保留；HR 後台仍可安排跨櫃支援。" /> : null}
          </div>
          <div className="shift-day-head" aria-hidden="true">
            <span>日型</span><span>開始</span><span>結束</span><span>休息（分）</span><span>需求人力</span><span />
          </div>
          {HR_DAY_TYPES.map((dayType) => {
            const draft = row.times[dayType];
            const label = HR_DAY_TYPE_LABELS[dayType];
            if (!draft) return <div className="shift-day-row shift-day-row-empty" key={dayType}>
              <span className="shift-day-label">{label}</span>
              <span className="muted shift-day-inherited">沿用平日時段與需求人力（{row.times.weekday?.requiredHeadcount ?? 1} 人）</span>
              {canWrite ? <Button variant="secondary" icon="plus" className="add-action" disabled={disabled} onClick={() => updateTime(row.key, dayType, {})}>設定{label}時間</Button> : <span className="shift-item-spacer" aria-hidden="true" />}
            </div>;
            return <div className="shift-day-row" key={dayType}>
              <span className="shift-day-label">{label}</span>
              <TextField label="開始時間" aria-label={`${row.name || "班別"}${label}開始時間`} type="text" placeholder="09:30" maxLength={5} autoComplete="off" required value={draft.startTime} disabled={disabled} onChange={(event) => updateTime(row.key, dayType, { startTime: event.target.value })} />
              <TextField label="結束時間" aria-label={`${row.name || "班別"}${label}結束時間`} type="text" placeholder="18:30" maxLength={5} autoComplete="off" required value={draft.endTime} disabled={disabled} onChange={(event) => updateTime(row.key, dayType, { endTime: event.target.value })} />
              <TextField label="休息分鐘" aria-label={`${row.name || "班別"}${label}休息分鐘`} type="number" min="0" step="30" value={draft.breakMinutes} disabled={disabled} onChange={(event) => updateTime(row.key, dayType, { breakMinutes: Number(event.target.value) })} />
              <TextField label="需求人力" aria-label={`${row.name || "班別"}${label}需求人力`} type="number" min="1" max="100" step="1" required value={draft.requiredHeadcount} disabled={disabled} onChange={(event) => updateHeadcount(row.key, dayType, Number(event.target.value))} />
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
        {canWrite ? <Button variant="secondary" icon="plus" className="add-action" disabled={save.isPending} onClick={addNewRow}>新增班別</Button> : <span />}
        <p className="shift-items-total">共 <strong>{rows.length}</strong> 個班別</p>
      </div>
    </div>
  </Dialog>;
}

/** 表格那一欄的摘要：只設平日就寫時間，有其他日型才點出來，不然每家店都拖成三行。 */
function groupSummary(group: ShiftGroup) {
  const extras = group.versions.filter((shift) => shift.dayType !== "weekday");
  const headcountOverrides = extras.filter((shift) => shift.requiredHeadcount !== group.weekday.requiredHeadcount);
  const overrideDayTypes = new Set(headcountOverrides.map((shift) => shift.dayType));
  const timeOnlyExtras = extras.filter((shift) => !overrideDayTypes.has(shift.dayType));
  const headcount = headcountOverrides.length
    ? `需求平日 ${group.weekday.requiredHeadcount} 人；${headcountOverrides.map((shift) => `${HR_DAY_TYPE_LABELS[shift.dayType]} ${shift.requiredHeadcount} 人`).join("、")}`
    : `需求 ${group.weekday.requiredHeadcount} 人`;
  return `${group.name} ${shiftTimeRange(group.weekday)} · ${headcount}${timeOnlyExtras.length ? `（另設${timeOnlyExtras.map((shift) => HR_DAY_TYPE_LABELS[shift.dayType]).join("、")}）` : ""}`;
}

interface ScheduleManagersResponse { scopes: Array<ScheduleScope & { userId: string | null; revision: number }>; candidates: Array<{ userId: string; name: string; employeeNumber: string }> }

export function HrShifts() {
  usePageTitle("班別管理");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:schedule:read");
  const canWrite = permissions.has("hr:schedule:write");
  const shifts = useHrQuery<HrShiftsResponse>("/shift-templates", canRead);
  const [openScopeId, setOpenScopeId] = useState<string | null>(null);
  const data = shifts.data;
  const managers = useHrQuery<ScheduleManagersResponse>("/schedule-managers", canRead);

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
    <PageHeader title="班別管理" description="每個班別可分別設定平日、週末與國定假日的時間與需求人力；沒設定的日型會沿用平日時段與需求人力。需求人力同時是薪資單位池上限；待確認與已出勤人員計入、明確未出勤排除，超額排班時由有效人員平均分配。" />
    <Panel className="grows">
      <DataTable><thead><tr>
        <th>營運據點</th><th className="numeric">班別數</th><th>班別</th><th>排班負責人</th>{canWrite ? <th>操作</th> : null}
      </tr></thead><tbody>
        {data.scopes.map((scope) => {
          const list = groupsByScope.get(scope.id) ?? [];
          const manager = managers.data?.scopes.find((item) => item.id === scope.id);
          const managerName = managers.data?.candidates.find((person) => person.userId === manager?.userId)?.name;
          return <tr key={scope.id}>
            <td data-label="營運據點"><span className="cell-strong">{scope.name}</span></td>
            <td data-label="班別數" className="numeric">{list.length}</td>
            {/* 沒有班別的店在排班月曆選不到任何班，所以要一眼看得出來，不是留一格空白。 */}
            <td data-label="班別">{list.length ? list.map(groupSummary).join("、") : <span className="muted">尚未設定</span>}</td>
            <td data-label="排班負責人">{managerName ?? (manager?.userId ? "已停用或封存" : managers.isPending ? "載入中…" : "尚未指定")}</td>
            {canWrite ? <td data-label="操作"><Button variant="icon" icon="edit" className="compensation-action-update" aria-label={`編輯 ${scope.name} 的班別與排班負責人`} disabled={!manager || !managers.data} onClick={() => setOpenScopeId(scope.id)} /></td> : null}
          </tr>;
        })}
      </tbody></DataTable>
      {!data.scopes.length ? <p className="muted table-note">目前沒有啟用中的營運據點。</p> : null}
    </Panel>
    {managers.error ? <Alert tone="danger">{managers.error.message}</Alert> : null}
    {openScope && managers.data?.scopes.find((scope) => scope.id === openScope.id) ? <StoreShiftsDialog
      scope={openScope}
      groups={groupsByScope.get(openScope.id) ?? []}
      manager={managers.data.scopes.find((scope) => scope.id === openScope.id)!}
      candidates={managers.data.candidates}
      people={data.people ?? []}
      canWrite={canWrite}
      onClose={() => setOpenScopeId(null)}
      onSaved={() => Promise.all([shifts.refetch(), managers.refetch()])}
    /> : null}
  </div>;
}
