import { useMemo, useRef, useState } from "react";
import { useSession } from "../../auth/session.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, Page, PageHeader, Panel, SelectField, TableNote, TextField, Tooltip } from "../../ui/index.js";
import { groupShiftsByTemplate, shiftTimeRange, useHrQuery, useHrWrite, HR_SHIFT_DAY_TYPES, HR_SHIFT_DAY_LABELS, HR_SHIFT_OVERRIDE_TYPES, type HrShiftsResponse, type ScheduleScope, type ScheduleShift } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";
import { ShiftTimeField } from "./ShiftTimeField.js";

/** 同一家店依平日的上班時間排：早班在晚班前面，讀起來才像一天的順序。 */
function byStartTime(a: ShiftGroup, b: ShiftGroup) {
  return a.weekday.startSecond - b.weekday.startSecond || a.weekday.endSecond - b.weekday.endSecond || a.name.localeCompare(b.name, "zh-TW");
}

/** 表頭與日別列共用同一組欄寬，表頭的字才會對到下面的欄位。 */
const SHIFT_DAY_COLUMNS = "grid grid-cols-[minmax(112px,140px)_minmax(118px,1fr)_minmax(118px,1fr)_minmax(72px,1fr)_minmax(76px,90px)_44px] items-center gap-2";
/** 依對話框內容區（@container）的可用寬度換成兩欄，不依螢幕寬度猜測欄位是否放得下。 */
const SHIFT_DAY_STACKED = "@max-[640px]:items-start @max-[640px]:gap-x-2 @max-[640px]:gap-y-1.5";
const SHIFT_OVERRIDE_ROW = `${ SHIFT_DAY_STACKED } @max-[640px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_44px] @max-[640px]:[&>[data-field]]:col-end-3`;
const SHIFT_DAY_LABEL = "pl-1 text-[12px] font-medium text-muted @max-[640px]:row-start-1 @max-[640px]:pl-0.5";

function clock(seconds: number) {
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}`;
}

/** 一個班別的共用時間與個別星期覆蓋。 */
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
  for (const versions of groupShiftsByTemplate(shifts.filter((shift) => HR_SHIFT_DAY_TYPES.includes(shift.dayType))).values()) {
    const weekday = versions.find((shift) => shift.dayType === "weekday") ?? versions[0];
    if (!weekday) continue;
    groups.push({ templateId: weekday.templateId, name: weekday.name, revision: weekday.revision, scopeId: weekday.scopeId, weekday, versions });
  }
  return groups;
}

/** 草稿裡未設定的星期以 null 表示；送出時省略，後端會移除該覆蓋。 */
type TimeDraft = { startTime: string; endTime: string; breakMinutes: number; requiredHeadcount: number } | null;

type ShiftOverrideType = (typeof HR_SHIFT_OVERRIDE_TYPES)[number];
interface ShiftOverrideDraft { key: string; dayType: ShiftOverrideType | "" }

interface ShiftRowDraft {
  key: string;
  original: ShiftGroup | null;
  name: string;
  times: Record<ScheduleShift["dayType"], TimeDraft>;
  overrides: ShiftOverrideDraft[];
  allowedPersonIds: string[] | null;
}

function rowsFromGroups(groups: ShiftGroup[]): ShiftRowDraft[] {
  return groups.map((group) => ({
    key: group.templateId,
    original: group,
    name: group.name,
    allowedPersonIds: group.weekday.allowedPersonIds ?? null,
    overrides: group.versions.filter((shift) => HR_SHIFT_OVERRIDE_TYPES.includes(shift.dayType as ShiftOverrideType)).map((shift) => ({ key: shift.dayType, dayType: shift.dayType as ShiftOverrideType })),
    times: Object.fromEntries(HR_SHIFT_DAY_TYPES.map((dayType) => {
      const version = group.versions.find((shift) => shift.dayType === dayType);
      return [dayType, version ? { startTime: clock(version.startSecond), endTime: clock(version.endSecond), breakMinutes: version.breakMinutes, requiredHeadcount: version.requiredHeadcount } : null];
    })) as Record<ScheduleShift["dayType"], TimeDraft>,
  }));
}

function sameTimes(row: ShiftRowDraft, group: ShiftGroup) {
  return HR_SHIFT_DAY_TYPES.every((dayType) => {
    const draft = row.times[dayType];
    const version = group.versions.find((shift) => shift.dayType === dayType);
    if (!draft || !version) return !draft && !version;
    return draft.startTime === clock(version.startSecond) && draft.endTime === clock(version.endSecond) && draft.breakMinutes === version.breakMinutes && draft.requiredHeadcount === version.requiredHeadcount;
  });
}

function rowChanged(row: ShiftRowDraft) {
  if (!row.original) return true;
  if (row.original.weekday.endDayOffset) return false;
  return row.overrides.some((override) => !override.dayType) || row.name.trim() !== row.original.name || !sameTimes(row, row.original) || JSON.stringify(row.allowedPersonIds?.slice().sort() ?? null) !== JSON.stringify(row.original.weekday.allowedPersonIds?.slice().sort() ?? null);
}

function timesPayload(row: ShiftRowDraft) {
  return HR_SHIFT_DAY_TYPES.flatMap((dayType) => {
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
 * 一開始只顯示共用時間；需要個別星期或國定假日時，新增覆蓋列並選擇覆蓋日別，未設定的日期沿用共用時間。
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

  const updateTime = (key: string, dayType: ScheduleShift["dayType"], patch: Partial<Omit<NonNullable<TimeDraft>, "requiredHeadcount">> | null) => {
    setRows((current) => current.map((row) => {
      if (row.key !== key) return row;
      const weekday = row.times.weekday ?? { startTime: "09:00", endTime: "18:00", breakMinutes: 60, requiredHeadcount: 1 };
      const base = row.times[dayType] ?? { ...weekday };
      return { ...row, times: { ...row.times, [dayType]: patch === null ? null : { ...base, ...patch } } };
    }));
    setMessage(null);
  };

  const updateHeadcount = (key: string, dayType: ScheduleShift["dayType"], requiredHeadcount: number) => {
    setRows((current) => current.map((row) => {
      if (row.key !== key) return row;
      const weekday = row.times.weekday ?? { startTime: "09:00", endTime: "18:00", breakMinutes: 60, requiredHeadcount: 1 };
      const base = row.times[dayType] ?? { ...weekday };
      return { ...row, times: { ...row.times, [dayType]: { ...base, requiredHeadcount } } };
    }));
    setMessage(null);
  };

  const updateOverrideType = (key: string, overrideKey: string, dayType: ShiftOverrideType | "") => {
    setRows((current) => current.map((row) => {
      if (row.key !== key) return row;
      const override = row.overrides.find((item) => item.key === overrideKey);
      if (!override || (dayType && row.overrides.some((item) => item.key !== overrideKey && item.dayType === dayType))) return row;
      const times = { ...row.times };
      if (override.dayType) times[override.dayType] = null;
      if (dayType) times[dayType] = { ...(row.times["weekday"] ?? { startTime: "09:00", endTime: "18:00", breakMinutes: 60, requiredHeadcount: 1 }) };
      return { ...row, times, overrides: row.overrides.map((item) => item.key === overrideKey ? { ...item, dayType } : item) };
    }));
    setMessage(null);
  };

  const addOverride = (key: string) => {
    setRows((current) => current.map((row) => {
      if (row.key !== key || row.overrides.some((override) => !override.dayType)) return row;
      const used = new Set(row.overrides.map((override) => override.dayType));
      if (HR_SHIFT_OVERRIDE_TYPES.every((dayType) => used.has(dayType))) return row;
      return { ...row, overrides: [...row.overrides, { key: `override-${crypto.randomUUID()}`, dayType: "" }] };
    }));
    setMessage(null);
  };

  const removeOverride = (key: string, overrideKey: string) => {
    setRows((current) => current.map((row) => {
      if (row.key !== key) return row;
      const override = row.overrides.find((item) => item.key === overrideKey);
      const times = { ...row.times };
      if (override?.dayType) times[override.dayType] = null;
      return { ...row, times, overrides: row.overrides.filter((item) => item.key !== overrideKey) };
    }));
    setMessage(null);
  };

  const addNewRow = () => {
    setRows((current) => [...current, { key: `new-${crypto.randomUUID()}`, original: null, name: "", allowedPersonIds: [], overrides: [], times: Object.fromEntries(HR_SHIFT_DAY_TYPES.map((dayType) => [dayType, dayType === "weekday" ? { startTime: "09:00", endTime: "18:00", breakMinutes: 60, requiredHeadcount: 1 } : null])) as Record<ScheduleShift["dayType"], TimeDraft> }]);
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
      if (row.overrides.some((override) => !override.dayType)) { setMessage(`「${name || "未命名班別"}」有尚未選擇日期的覆蓋列，請選擇星期／國定假日或移除該列。`); return; }
      if (!name) { setMessage("每個班別都要有名稱，未完成的列請先刪除。"); return; }
      if (names.has(name)) { setMessage(`班別名稱「${name}」重複了，請改成不同名稱。`); return; }
      names.add(name);
      if (row.original?.weekday.endDayOffset) continue;
      for (const dayType of HR_SHIFT_DAY_TYPES) {
        const draft = row.times[dayType];
        if (!draft) continue;
        const label = HR_SHIFT_DAY_LABELS[dayType];
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
    width={760}
    onClose={onClose}
    closeRequestRef={closeRequestRef}
    closeDisabled={save.isPending}
    actions={canWrite ? <Button loading={save.isPending} disabled={!hasChanges} onClick={() => { void saveAll(); }}>儲存</Button> : undefined}
  >
    <div className="grid gap-2.5 @container">
      {canWrite ? <><SelectField label="排班負責人" aria-label="排班負責人" searchable value={managerUserId} disabled={save.isPending} options={[{ value: "", label: "不指定" }, ...(manager.userId && !candidates.some((person) => person.userId === manager.userId) ? [{ value: manager.userId, label: "原負責人（已停用或封存）" }] : []), ...candidates.map((person) => ({ value: person.userId, label: `${person.employeeNumber}・${person.name}${person.userStatus === "invited" ? "（尚未啟用）" : person.userStatus === "disabled" ? "（帳號停用）" : ""}` }))]} onChange={(event) => { setManagerUserId(event.target.value); setMessage(null); }} /></> : <div><span className="text-[13px] font-semibold text-ink">排班負責人</span><p>{candidates.find((person) => person.userId === manager.userId)?.name ?? (manager.userId ? "已停用或封存" : "尚未指定")}</p></div>}
      <span className="text-[13px] font-semibold text-ink">班別時段</span>
      {rows.map((row, rowIndex) => {
        const legacyOvernight = Boolean(row.original?.weekday.endDayOffset);
        const disabled = !canWrite || legacyOvernight || save.isPending;
        return <div key={row.key} className={`grid gap-3 p-0${rowIndex > 0 ? " mt-3 border-t border-soft-line pt-6" : ""}`}>
          <div className="grid grid-cols-[minmax(0,1fr)_44px] items-end gap-2">
            <TextField className="min-w-0" label="班別名稱" aria-label={`${row.name || "班別"}名稱`} required maxLength={100} placeholder="例如：早班" value={row.name} disabled={disabled} onChange={(event) => updateRow(row.key, { name: event.target.value })} />
            {canWrite ? <Tooltip className="self-end mb-0.5" label={`刪除${row.name ? ` ${row.name}` : "這個班別"}`} focusable={false}>
              <Button className="self-center" variant="icon" icon="trash" tone="danger" aria-label={`刪除${row.name || "這個班別"}`} disabled={save.isPending} onClick={() => removeRow(row)} />
            </Tooltip> : <span className="block" aria-hidden="true" />}
          </div>
          <div className="grid gap-2 px-1 py-1.5">
            <SelectField className="min-w-0" label="排班人員" aria-label={`${row.name || "班別"}排班人員`} multiple searchable value={row.allowedPersonIds ?? people.map((person) => person.id)} disabled={disabled} options={[...people.map((person) => ({ value: person.id, label: `${person.employeeNumber}・${person.name}${person.personKind === "worker" ? "（支援）" : ""}` })), ...(row.allowedPersonIds ?? []).filter((id) => !people.some((person) => person.id === id)).map((id) => ({ value: id, label: "已封存人員" }))]} onValueChange={(allowedPersonIds: string[]) => updateRow(row.key, { allowedPersonIds })} />
          </div>
          <div className={`${ SHIFT_DAY_COLUMNS } px-1 text-[12px] font-semibold text-muted [&>span:not(:first-child):not(:last-child)]:text-center @max-[640px]:hidden`} aria-hidden="true">
            <span>共用／覆蓋日別</span><span>開始</span><span>結束</span><span>休息（分）</span><span>需求人力</span><span />
          </div>
          {(() => {
            const dayType = "weekday" as const;
            const draft = row.times.weekday!;
            const label = HR_SHIFT_DAY_LABELS.weekday;
            return <div className={`${ SHIFT_DAY_COLUMNS } ${ SHIFT_DAY_STACKED } @max-[640px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]`} key="weekday">
              <span className={`${ SHIFT_DAY_LABEL } @max-[640px]:col-start-1`}>{label}</span>
              <ShiftTimeField className="min-w-0 @max-[640px]:col-start-1 @max-[640px]:row-start-2" stackedLabel="container" label="開始時間" ariaLabel={`${row.name || "班別"}${label}開始時間`} value={draft.startTime} disabled={disabled} onChange={(startTime) => updateTime(row.key, dayType, { startTime })} />
              <ShiftTimeField className="min-w-0 @max-[640px]:col-start-2 @max-[640px]:row-start-2" stackedLabel="container" label="結束時間" ariaLabel={`${row.name || "班別"}${label}結束時間`} value={draft.endTime} disabled={disabled} onChange={(endTime) => updateTime(row.key, dayType, { endTime })} />
              <TextField className="min-w-0 @max-[640px]:col-start-1 @max-[640px]:row-start-3" stackedLabel="container" label="休息分鐘" aria-label={`${row.name || "班別"}${label}休息分鐘`} type="number" min="0" step="30" value={draft.breakMinutes} disabled={disabled} onChange={(event) => updateTime(row.key, dayType, { breakMinutes: Number(event.target.value) })} />
              <TextField className="min-w-0 @max-[640px]:col-start-2 @max-[640px]:row-start-3" stackedLabel="container" label="需求人力" aria-label={`${row.name || "班別"}${label}需求人力`} type="number" min="1" max="100" step="1" required value={draft.requiredHeadcount} disabled={disabled} onChange={(event) => updateHeadcount(row.key, dayType, Number(event.target.value))} />
              <span className="block" aria-hidden="true" />
            </div>;
          })()}
          {row.overrides.map((override, overrideIndex) => {
            const availableTypes = HR_SHIFT_OVERRIDE_TYPES.filter((dayType) => dayType === override.dayType || !row.overrides.some((other) => other.key !== override.key && other.dayType === dayType));
            const options = [{ value: "", label: "選擇日別" }, ...availableTypes.map((dayType) => ({ value: dayType, label: HR_SHIFT_DAY_LABELS[dayType] }))];
            const selector = canWrite
              ? <SelectField className="min-w-0 @max-[640px]:col-start-1 @max-[640px]:row-start-1" label="覆蓋日別" aria-label={`${row.name || "班別"}第${overrideIndex + 1}列覆蓋日別`} stackedLabel="container" value={override.dayType} disabled={disabled} options={options} onChange={(event) => updateOverrideType(row.key, override.key, event.target.value as ShiftOverrideType | "")} />
              : <span className={`${ SHIFT_DAY_LABEL } ${ override.dayType ? "@max-[640px]:col-start-1" : "@max-[640px]:col-span-full" }`}>{override.dayType ? HR_SHIFT_DAY_LABELS[override.dayType] : "尚未選擇"}</span>;
            if (!override.dayType) return <div className={`grid grid-cols-[minmax(112px,140px)_minmax(0,1fr)_44px] items-center gap-2 ${ SHIFT_OVERRIDE_ROW }`} key={override.key}>
              {selector}
              <span className="muted min-w-0 @max-[640px]:col-span-full @max-[640px]:row-start-2 @max-[400px]:col-span-full">選擇星期或國定假日後設定時間。</span>
              {canWrite ? <Tooltip label="移除此列" focusable={false} className="self-center">
                <Button className="@max-[640px]:col-start-3 @max-[640px]:row-start-1" variant="icon" icon="close" aria-label={`${row.name || "班別"}移除未選擇的覆蓋列`} disabled={save.isPending} onClick={() => removeOverride(row.key, override.key)} />
              </Tooltip> : <span className="block @max-[640px]:col-start-2 @max-[640px]:row-start-2 @max-[640px]:justify-self-end" aria-hidden="true" />}
            </div>;
            const dayType = override.dayType;
            const draft = row.times[dayType]!;
            const label = HR_SHIFT_DAY_LABELS[dayType];
            return <div className={`${ SHIFT_DAY_COLUMNS } ${ SHIFT_OVERRIDE_ROW }`} key={override.key}>
              {selector}
              <ShiftTimeField className="min-w-0 @max-[640px]:col-start-1 @max-[640px]:row-start-2" stackedLabel="container" label="開始時間" ariaLabel={`${row.name || "班別"}${label}開始時間`} value={draft.startTime} disabled={disabled} onChange={(startTime) => updateTime(row.key, dayType, { startTime })} />
              <ShiftTimeField className="min-w-0 @max-[640px]:col-start-2 @max-[640px]:row-start-2" stackedLabel="container" label="結束時間" ariaLabel={`${row.name || "班別"}${label}結束時間`} value={draft.endTime} disabled={disabled} onChange={(endTime) => updateTime(row.key, dayType, { endTime })} />
              <TextField className="min-w-0 @max-[640px]:col-start-1 @max-[640px]:row-start-3" stackedLabel="container" label="休息分鐘" aria-label={`${row.name || "班別"}${label}休息分鐘`} type="number" min="0" step="30" value={draft.breakMinutes} disabled={disabled} onChange={(event) => updateTime(row.key, dayType, { breakMinutes: Number(event.target.value) })} />
              <TextField className="min-w-0 @max-[640px]:col-start-2 @max-[640px]:row-start-3" stackedLabel="container" label="需求人力" aria-label={`${row.name || "班別"}${label}需求人力`} type="number" min="1" max="100" step="1" required value={draft.requiredHeadcount} disabled={disabled} onChange={(event) => updateHeadcount(row.key, dayType, Number(event.target.value))} />
              {canWrite ? <Tooltip label={`${label}改回共用時間`} focusable={false} className="@max-[640px]:col-start-3 @max-[640px]:row-start-1 @max-[640px]:[justify-self:end]">
                <Button className="self-center" variant="icon" icon="close" aria-label={`${label}改回共用時間`} disabled={disabled} onClick={() => removeOverride(row.key, override.key)} />
              </Tooltip> : <span className="block" aria-hidden="true" />}
            </div>;
          })}
          {canWrite ? <Button variant="secondary" icon="plus" tone="success" className="justify-self-start" disabled={disabled || row.overrides.length >= HR_SHIFT_OVERRIDE_TYPES.length || row.overrides.some((override) => !override.dayType)} onClick={() => addOverride(row.key)}>新增星期／國定假日覆蓋</Button> : null}
          <p className="muted m-0 text-xs">未設定覆蓋的日期沿用共用時間與需求人力。</p>
          {legacyOvernight ? <small className="col-span-full -mt-1 text-[12px] text-muted">跨午夜的舊班別，請刪除後重新建立。</small> : null}
        </div>;
      })}
      {!rows.length ? <p className="muted col-span-full my-0.5 rounded-field bg-canvas px-3.5 py-3">尚未設定班別，按下「新增班別」後會直接出現可編輯的列。</p> : null}
      {message || save.error ? <Alert tone="danger">{message ?? save.error?.message}</Alert> : null}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-t-soft-line pt-3">
        {canWrite ? <Button variant="secondary" icon="plus" tone="success" disabled={save.isPending} onClick={addNewRow}>新增班別</Button> : <span />}
        <p className="m-0 text-[13px] text-muted">共 <strong className="text-[15px] tabular-nums text-ink">{rows.length}</strong> 個班別</p>
      </div>
    </div>
  </Dialog>;
}

/** 表格摘要以共用時間為主，有星期覆蓋時再列出覆蓋日。 */
function groupSummary(group: ShiftGroup) {
  const extras = group.versions.filter((shift) => shift.dayType !== "weekday");
  const headcountOverrides = extras.filter((shift) => shift.requiredHeadcount !== group.weekday.requiredHeadcount);
  const overrideDayTypes = new Set(headcountOverrides.map((shift) => shift.dayType));
  const timeOnlyExtras = extras.filter((shift) => !overrideDayTypes.has(shift.dayType));
  const headcount = headcountOverrides.length
    ? `需求共用 ${group.weekday.requiredHeadcount} 人；${headcountOverrides.map((shift) => `${HR_SHIFT_DAY_LABELS[shift.dayType]} ${shift.requiredHeadcount} 人`).join("、")}`
    : `需求 ${group.weekday.requiredHeadcount} 人`;
  return `${group.name} ${shiftTimeRange(group.weekday)} · ${headcount}${timeOnlyExtras.length ? `（另設${timeOnlyExtras.map((shift) => HR_SHIFT_DAY_LABELS[shift.dayType]).join("、")}）` : ""}`;
}

function schedulablePeople(group: ShiftGroup, people: NonNullable<HrShiftsResponse["people"]>) {
  const allowedPersonIds = group.weekday.allowedPersonIds;
  return people.filter((person) => allowedPersonIds == null || allowedPersonIds.includes(person.id));
}

interface ScheduleManagersResponse { scopes: Array<ScheduleScope & { userId: string | null; revision: number }>; candidates: Array<{ userId: string; name: string; employeeNumber: string; userStatus?: "invited" | "active" | "disabled" }> }

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
  if (shifts.error || !data) return <Page><Alert tone="danger">{shifts.error?.message ?? "班別資料載入失敗。"}</Alert></Page>;

  const openScope = data.scopes.find((scope) => scope.id === openScopeId);
  return <Page layout="fills">
    <PageHeader title="班別管理" description="每個班別設定一組共用時間，再按需要新增星期或國定假日覆蓋；未覆蓋的日期沿用共用設定。需求人力同時是薪資單位池上限；待確認與已出勤人員計入、明確未出勤排除，超額排班時由有效人員平均分配。" />
    <Panel grows>
      <DataTable><thead><tr>
        <th>營運據點</th><th className="numeric">班別數</th><th>班別與可排人員</th><th>排班負責人</th>{canWrite ? <th>操作</th> : null}
      </tr></thead><tbody>
        {data.scopes.map((scope) => {
          const list = groupsByScope.get(scope.id) ?? [];
          const manager = managers.data?.scopes.find((item) => item.id === scope.id);
          const managerName = managers.data?.candidates.find((person) => person.userId === manager?.userId)?.name;
          return <tr key={scope.id}>
            <td data-label="營運據點"><span className="font-bold">{scope.name}</span></td>
            <td data-label="班別數" className="numeric">{list.length}</td>
            {/* 沒有班別的店在排班月曆選不到任何班，所以要一眼看得出來，不是留一格空白。 */}
            <td data-label="班別與可排人員">{list.length ? <div className="grid gap-3">{list.map((group) => {
              const people = schedulablePeople(group, data.people ?? []);
              const names = people.map((person) => `${person.employeeNumber}・${person.name}${person.personKind === "worker" ? "（支援）" : ""}`).join("、");
              return <div className="grid gap-1" key={group.templateId}>
                <span className="font-medium text-ink">{groupSummary(group)}</span>
                <p className="m-0 text-sm text-muted"><span className="font-medium text-ink">可排人員：</span>{names || "無可排人員"}</p>
              </div>;
            })}</div> : <span className="muted">尚未設定</span>}</td>
            <td data-label="排班負責人">{managerName ?? (manager?.userId ? "已停用或封存" : managers.isPending ? "載入中…" : "尚未指定")}</td>
            {canWrite ? <td data-label="操作"><Button variant="icon" icon="edit" tone="info" aria-label={`編輯 ${scope.name} 的班別與排班負責人`} disabled={!manager || !managers.data} onClick={() => setOpenScopeId(scope.id)} /></td> : null}
          </tr>;
        })}
      </tbody></DataTable>
      {!data.scopes.length ? <TableNote>目前沒有啟用中的營運據點。</TableNote> : null}
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
  </Page>;
}
