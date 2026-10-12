import { useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router";
import { canSchedulePerson, outdatedScheduleIds, pickShiftForDay, resolveSchedulePerson, scheduleChanges, schedulePersonOptions, shiftTimeRange, type HrScheduleResponse, type ScheduleEntry, type ScheduleScope } from "@rueisiang/db/schedule-draft";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, EmptyState, Panel, SelectField } from "../../ui/index.js";
import type { DialogCloseRef } from "../../ui/dialog-context.js";
import { useHrQuery, useHrWrite } from "./api.js";

function currentMonth() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}`;
}

function nextMonth(key: string, delta: number) {
  const [year = 0, month = 1] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function useMobileScheduleView() {
  const [isMobile, setIsMobile] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return isMobile;
}

function dayTypeLabel(dayType: HrScheduleResponse["calendar"][number]["dayType"]) {
  return dayType === "holiday" ? "國定假日" : dayType === "weekend" ? "週末" : "平日";
}

const dateClass = "relative grid min-h-11 w-full min-w-0 place-items-center rounded-field border-0 text-sm font-semibold tabular-nums transition-[background-color,color,scale] duration-150 ease-out enabled:hover:bg-brand/7 enabled:active:scale-[.96] focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-secondary disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:enabled:active:scale-100";

function ScheduleEditor({ data, onReload, onChangeState }: { data: HrScheduleResponse; onReload: () => Promise<HrScheduleResponse | undefined>; onChangeState: (dirty: boolean, pending: boolean) => void }) {
  const [baseline, setBaseline] = useState(data);
  const [draft, setDraft] = useState(data.entries);
  const [selectedPersonValue, setPersonValue] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState(data.shifts[0]?.templateId ?? "");
  const [detailsDate, setDetailsDate] = useState<string | null>(null);
  const [quick, setQuick] = useState(false);
  const closeRequestRef: DialogCloseRef = useRef(null);
  const isMobile = useMobileScheduleView();
  const [message, setMessage] = useState<string | null>(null);
  const [savedNeedsReload, setSavedNeedsReload] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const save = useHrWrite<{ id: string; revision: number }>({ invalidate: false });
  const changes = scheduleChanges(draft, baseline.entries, outdatedScheduleIds(draft, data.shifts, data.calendar));
  const dirty = changes.entries.length > 0 || changes.removedIds.length > 0;
  const stale = (data.version?.revision ?? 0) !== (baseline.version?.revision ?? 0);
  const disabled = save.isPending || savedNeedsReload || reloadRequired || Boolean(data.version?.locked) || stale;
  const canSave = !disabled && (dirty || changes.refreshIds.length > 0);
  useEffect(() => { onChangeState(dirty && !savedNeedsReload, save.isPending); }, [dirty, savedNeedsReload, save.isPending, onChangeState]);
  // 背景重抓不能吃掉草稿；保留舊 revision，讓 API 拒絕覆蓋他人的變更。
  useEffect(() => {
    if (!dirty && !save.isPending) { setBaseline(data); setDraft(data.entries); }
  }, [data, dirty, save.isPending]);
  const shifts = [...new Map(data.shifts.map((shift) => [shift.templateId, shift])).values()];
  const selectedShift = shifts.find((shift) => shift.templateId === templateId);
  const people = schedulePersonOptions(data, selectedShift);
  const person = resolveSchedulePerson(people, selectedPersonValue);
  const personValue = person?.value ?? (selectedPersonValue === "" ? "" : null);
  if (selectedPersonValue !== personValue) setPersonValue(personValue);
  const kind = person?.personKind ?? "employee";
  const personId = person?.personId ?? "";
  const matchesPerson = (entry: ScheduleEntry) => entry.personKind === kind && (kind === "employee" ? entry.employmentId : entry.workerId) === personId;
  const templateOf = (entry: ScheduleEntry) => data.shifts.find((shift) => shift.versionId === entry.shiftVersionId)?.templateId;
  const selectedEntry = (date: string) => draft.find((entry) => !entry.archivedAt && entry.workDate === date && matchesPerson(entry) && templateOf(entry) === templateId);
  const picked = (date: string) => Boolean(selectedEntry(date));
  const toggleDisabled = (date: string) => {
    const entry = selectedEntry(date);
    return disabled || !personId || !templateId || Boolean(entry && entry.attendanceStatus !== "scheduled");
  };
  const toggle = (date: string) => {
    if (toggleDisabled(date)) return;
    const existing = selectedEntry(date);
    if (existing) { setDraft((entries) => entries.filter((entry) => entry.id !== existing.id)); setMessage(null); return; }
    const day = data.calendar.find((day) => day.date === date);
    const shift = day && pickShiftForDay(data.shifts.filter((shift) => shift.templateId === templateId), day.dayType);
    if (!shift || !canSchedulePerson(shift, personId)) return;
    const employee = data.employees.find((employee) => employee.employmentId === personId);
    const worker = data.workers.find((worker) => worker.id === personId);
    setDraft((entries) => [...entries, {
      id: `local-${crypto.randomUUID()}`, scheduleVersionId: baseline.version?.id ?? "", personKind: kind,
      employmentId: kind === "employee" ? personId : null, workerId: kind === "worker" ? personId : null,
      scopeId: data.scopes[0]!.id, shiftVersionId: shift.versionId, shiftGroupId: null, workDate: date,
      startsAt: "", endsAt: "", standardMinutes: shift.standardMinutes, breakMinutes: shift.breakMinutes, requiredHeadcount: shift.requiredHeadcount, attendanceStatus: "scheduled",
      employeeNumber: employee?.employeeNumber ?? null, personName: kind === "employee" ? employee?.name ?? "" : worker?.name ?? "", archivedAt: null,
      scopeName: data.scopes[0]!.name, shiftName: shift.name,
    }]);
    setMessage(null);
  };
  const reload = async () => {
    const fresh = await onReload();
    if (fresh) { setBaseline(fresh); setDraft(fresh.entries); setSavedNeedsReload(false); setReloadRequired(false); }
  };
  const closeDialog = () => { setDetailsDate(null); setQuick(false); };
  const submit = async () => {
    if (!canSave) return;
    setMessage(null);
    try {
      await save.mutateAsync({ path: "/me/schedules", method: "PATCH", values: { scopeId: data.scopes[0]!.id, periodKey: data.periodKey, revision: baseline.version?.revision ?? 0, ...changes } });
      setSavedNeedsReload(true);
      setMessage("排班已儲存並生效，不需送審。");
      await reload();
      closeRequestRef.current?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "排班儲存失敗，草稿仍保留。");
      setReloadRequired(true);
      // 失敗後重抓只更新讀取資料，不接受新基準；有草稿時仍要明確確認後才能放棄。
      const fresh = await onReload();
      if (fresh) setReloadRequired(false);
    }
  };
  const employee = kind === "employee" ? data.employees.find((employee) => employee.employmentId === personId) : undefined;
  const selectedDays = new Set(draft.filter((entry) => !entry.archivedAt && matchesPerson(entry)).map((entry) => entry.workDate)).size;
  const focusedDay = detailsDate ? data.calendar.find((day) => day.date === detailsDate) : undefined;
  const focusedEntries = detailsDate ? draft.filter((entry) => entry.workDate === detailsDate) : [];
  const offset = new Date(`${data.periodKey}-01T00:00:00Z`).getUTCDay();
  const summary = dirty ? `尚未儲存：新增 ${changes.entries.length} 筆、移除 ${changes.removedIds.length} 筆` : "沒有未儲存變更";
  const fields = <div className="grid grid-cols-2 gap-2">
    <SelectField label="人員" aria-label="人員" searchable value={personValue ?? ""} placeholder="請選擇人員" disabled={disabled || !shifts.length} options={people} onChange={(event) => setPersonValue(event.target.value)} />
    <SelectField label="班別" aria-label="班別" value={templateId} disabled={disabled || !shifts.length} options={shifts.map((shift) => { const weekday = pickShiftForDay(data.shifts.filter((item) => item.templateId === shift.templateId), "weekday") ?? shift; return { value: shift.templateId, label: `${weekday.name} ${shiftTimeRange(weekday)}` }; })} onChange={(event) => setTemplateId(event.target.value)} />
  </div>;
  const availability = !shifts.length ? <Alert>這個據點尚未設定班別，請聯絡 HR。</Alert> : !people.length ? <Alert>這個班別尚未納入可排人員，請聯絡 HR 設定。</Alert> : null;
  const alerts = <>
    {reloadRequired && !stale ? <Alert tone="warning">載入最新班表失敗，草稿仍保留。<Button variant="secondary" onClick={() => { if (!dirty || window.confirm("重新載入會放棄尚未儲存的排班，確定繼續？")) void reload(); }}>重新載入</Button></Alert> : null}
    {data.version?.locked ? <Alert>這個月份已鎖定，請聯絡 HR 開鎖後再調整。</Alert> : null}
    {stale ? <Alert tone="warning">排班已被其他人修改，草稿仍保留。請重新載入後再安排。<Button variant="secondary" onClick={() => { if (!dirty || window.confirm("重新載入會放棄尚未儲存的排班，確定繼續？")) void reload(); }}>重新載入</Button></Alert> : null}
    {message ? <Alert tone={save.error ? "danger" : "info"}>{message}</Alert> : null}
    {savedNeedsReload ? <Button variant="secondary" onClick={() => void reload()}>已儲存，重新載入班表</Button> : null}
  </>;
  const weekdays = <div className="grid grid-cols-7 text-center text-xs text-muted" aria-hidden="true">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}</div>;
  return <>
    {!isMobile ? <Panel>{fields}<p className="mt-2 text-sm text-muted">選好人員與班別，點日期排入；再點一次取消。</p>{availability}</Panel> : null}
    <Panel density={isMobile ? "compact" : "default"} className="min-w-0">
      <div className="grid gap-1" aria-label="據點月曆">
        <p className="m-0 text-xs text-muted">{isMobile ? "點日期查看排班・數字為排班筆數" : "週末與假日套用對應班別時間"}</p>
        {weekdays}
        <div className={`grid grid-cols-7 ${isMobile ? "" : "gap-1"}`}>
          {Array.from({ length: offset }, (_, index) => <div aria-hidden="true" key={`empty-${index}`} />)}
          {data.calendar.map((day) => {
            const entries = draft.filter((entry) => !entry.archivedAt && entry.workDate === day.date);
            const description = `${day.name || dayTypeLabel(day.dayType)}・${entries.length} 筆排班`;
            return <div key={day.date} className={`relative min-w-0 border-t border-soft-line ${!isMobile ? "min-h-32 p-1" : ""} ${day.dayType !== "weekday" ? "bg-canvas" : ""}`}>
              <button type="button" className={`${dateClass} ${!isMobile && picked(day.date) ? "bg-brand-soft text-brand-dark" : "text-ink"}`} aria-label={`${day.date} 排班`} aria-description={description} aria-pressed={!isMobile ? picked(day.date) : undefined} disabled={!isMobile && toggleDisabled(day.date)} onClick={() => isMobile ? setDetailsDate(day.date) : toggle(day.date)}>
                {Number(day.date.slice(8))}
                {isMobile && entries.length ? <span className="absolute bottom-0 right-0 rounded-full bg-brand-soft px-1 text-[9px] leading-3 text-brand-dark" aria-hidden="true">{entries.length}</span> : null}
                {isMobile && day.name ? <span className="absolute left-1 top-1 size-1 rounded-full bg-warn" aria-hidden="true" /> : null}
              </button>
              {!isMobile ? <>
                {day.name ? <small className="block text-xs text-muted">{day.name}</small> : null}
                {draft.filter((entry) => entry.workDate === day.date).map((entry) => <div className={`mt-1 grid gap-0.5 rounded-field p-1 text-xs ${matchesPerson(entry) ? "bg-brand-soft text-brand-dark" : "bg-canvas"}`} key={entry.id}>
                  <span>{entry.personName}{entry.archivedAt ? "（已封存）" : ""}</span><small>{entry.shiftName}{entry.personKind === "worker" ? "・支援" : ""}{entry.attendanceStatus !== "scheduled" ? "・出勤已確認" : ""}</small>
                  {!entry.archivedAt && entry.attendanceStatus === "scheduled" ? <Button variant="icon" icon="close" aria-label={`移除 ${day.date} ${entry.personName} ${entry.shiftName}`} disabled={disabled} className="justify-self-end" onClick={() => setDraft((current) => current.filter((other) => other.id !== entry.id))} /> : null}
                </div>)}
              </> : null}
            </div>;
          })}
        </div>
      </div>
    </Panel>
    {changes.refreshIds.length ? <Alert tone="warning">有 {changes.refreshIds.length} 筆班別設定已變更，儲存會重新套用目前的日型、時間與需求人力。</Alert> : null}
    {alerts}
    <div className="flex flex-wrap items-center gap-2">
      {isMobile ? <Button variant="secondary" size="lg" disabled={disabled || !shifts.length} onClick={() => setQuick(true)}>快速排班</Button> : null}
      <Button size="lg" loading={save.isPending} disabled={!canSave} onClick={() => void submit()}>儲存</Button>
      <span className="text-xs text-muted">{summary}</span>
    </div>
    {quick || focusedDay ? <Dialog title={quick ? "快速排班" : `${detailsDate} 排班`} titleMeta={quick ? `${data.scopes[0]?.name}・${data.periodKey}` : focusedDay?.name || (focusedDay && dayTypeLabel(focusedDay.dayType))} onClose={closeDialog} closeDisabled={save.isPending} closeRequestRef={closeRequestRef} bodyClassName="gap-2" actions={<>
      <Button variant="secondary" size="lg" disabled={save.isPending} onClick={closeDialog}>返回月曆</Button>
      {quick ? <Button size="lg" loading={save.isPending} disabled={!canSave} onClick={() => void submit()}>儲存排班</Button> : <Button size="lg" disabled={disabled || !shifts.length} onClick={() => setQuick(true)}>快速排班</Button>}
    </>}>
      {quick ? <>
        {fields}
        {availability}
        <p className="m-0 text-xs text-muted">點日期排入，再點取消；週末與假日自動套用時段。</p>
        <div className="grid gap-1" aria-label="快速排班日期">
          {weekdays}
          <div className="grid grid-cols-7 gap-0.5">
            {Array.from({ length: offset }, (_, index) => <div aria-hidden="true" key={`empty-${index}`} />)}
            {data.calendar.map((day) => <button key={day.date} type="button" className={`${dateClass} ${picked(day.date) ? "bg-brand-soft text-brand-dark ring-1 ring-inset ring-brand-dark" : day.dayType !== "weekday" ? "bg-canvas text-ink" : "text-ink"}`} aria-label={`${day.date} 快速排班`} aria-description={day.name || dayTypeLabel(day.dayType)} aria-pressed={picked(day.date)} disabled={toggleDisabled(day.date)} onClick={() => toggle(day.date)}>{Number(day.date.slice(8))}{day.name ? <span className="absolute left-1 top-1 size-1 rounded-full bg-warn" aria-hidden="true" /> : null}</button>)}
          </div>
        </div>
        <p className="m-0 text-xs text-muted">本據點已排 {selectedDays} 天{employee?.monthlyRestDays != null ? `・約定月休 ${employee.monthlyRestDays} 天` : ""}。{summary}</p>
        {alerts}
      </> : <>
        {focusedEntries.length ? <div className="grid divide-y divide-soft-line">{focusedEntries.map((entry) => <div className="flex min-w-0 items-center justify-between gap-2 py-2" key={entry.id}>
          <div className="grid min-w-0 gap-0.5"><strong className="break-words">{entry.employeeNumber ? `${entry.employeeNumber}・` : ""}{entry.personName}{entry.archivedAt ? "（已封存）" : ""}</strong><small className="text-muted">{entry.shiftName}{entry.personKind === "worker" ? "・支援" : ""}{entry.attendanceStatus !== "scheduled" ? "・出勤已確認" : ""}</small></div>
          {!entry.archivedAt && entry.attendanceStatus === "scheduled" ? <Button variant="icon" icon="trash" aria-label={`移除 ${detailsDate} ${entry.personName} ${entry.shiftName}`} disabled={disabled} className="shrink-0" onClick={() => setDraft((current) => current.filter((other) => other.id !== entry.id))} /> : <span className="shrink-0 text-xs text-muted">{entry.archivedAt ? "已封存" : "已確認"}</span>}
        </div>)}</div> : <EmptyState>這一天尚無排班。</EmptyState>}
        <p className="m-0 text-xs text-muted">移除後需按「儲存」才會生效。快速排班可一次安排多個日期。</p>
        {alerts}
      </>}
    </Dialog> : null}
  </>;
}

export function HrScheduling() {
  usePageTitle("據點排班");
  const scopes = useHrQuery<{ scopes: ScheduleScope[] }>("/me/schedule-scopes");
  const [scopeId, setScopeId] = useState("");
  const [month, setMonth] = useState(currentMonth);
  const [editState, setEditState] = useState({ dirty: false, pending: false });
  const selectedScopeId = scopeId || scopes.data?.scopes[0]?.id || "";
  const schedule = useHrQuery<HrScheduleResponse>(`/me/schedules?periodKey=${month}&scopeId=${encodeURIComponent(selectedScopeId)}`, Boolean(selectedScopeId));
  const confirmLeave = () => !editState.pending && (!editState.dirty || window.confirm("排班還沒儲存，確定要放棄變更？"));
  const blocker = useBlocker(editState.dirty || editState.pending);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (!editState.pending && (!editState.dirty || window.confirm("排班還沒儲存，確定要放棄變更？"))) blocker.proceed();
    else blocker.reset();
  }, [blocker, editState]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (editState.dirty || editState.pending) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [editState]);
  return <div className="page hr-front-schedule-page grid min-w-0 content-start gap-2 [&>*+*]:!mt-0">
    <h1 className="m-0 text-xl">排班</h1>
    {scopes.error ? <Alert tone="danger">{scopes.error.message}</Alert> : null}
    {scopes.isPending ? <p>載入據點中…</p> : null}
    {scopes.data && !scopes.data.scopes.length ? <EmptyState>目前沒有負責的排班據點，請聯絡 HR 指派。</EmptyState> : null}
    {selectedScopeId ? <Panel density="compact" className="grid gap-1">
      <SelectField label="營運據點" aria-label="營運據點" value={selectedScopeId} disabled={editState.pending} options={(scopes.data?.scopes ?? []).map((scope) => ({ value: scope.id, label: scope.name }))} onChange={(event) => { if (confirmLeave()) { setScopeId(event.target.value); setEditState({ dirty: false, pending: false }); } }} />
      <div className="flex items-center justify-between" aria-label="排班月份"><Button variant="icon" icon="chevronLeft" aria-label="上個月" disabled={editState.pending} onClick={() => { if (confirmLeave()) { setMonth(nextMonth(month, -1)); setEditState({ dirty: false, pending: false }); } }} /><strong className="text-sm tabular-nums">{month.slice(0, 4)} 年 {Number(month.slice(5))} 月</strong><Button variant="icon" icon="chevronRight" aria-label="下個月" disabled={editState.pending} onClick={() => { if (confirmLeave()) { setMonth(nextMonth(month, 1)); setEditState({ dirty: false, pending: false }); } }} /></div>
    </Panel> : null}
    {selectedScopeId && schedule.isPending ? <p>載入班表中…</p> : null}
    {schedule.error ? <Alert tone="danger">{schedule.error.message}</Alert> : null}
    {selectedScopeId && schedule.data ? <ScheduleEditor key={`${month}:${selectedScopeId}`} data={schedule.data} onChangeState={(dirty, pending) => setEditState((current) => current.dirty === dirty && current.pending === pending ? current : { dirty, pending })} onReload={async () => { const result = await schedule.refetch(); return result.isError ? undefined : result.data; }} /> : null}
  </div>;
}
