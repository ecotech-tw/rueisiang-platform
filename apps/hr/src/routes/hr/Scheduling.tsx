import { useEffect, useState } from "react";
import { Link, useBlocker } from "react-router";
import { outdatedScheduleIds, pickShiftForDay, scheduleChanges, shiftTimeRange, type HrScheduleResponse, type ScheduleEntry, type ScheduleScope } from "@rueisiang/db/schedule-draft";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, EmptyState, PageHeader, Panel, SelectField } from "../../ui/index.js";
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

function ScheduleEditor({ data, onReload, onChangeState }: { data: HrScheduleResponse; onReload: () => Promise<HrScheduleResponse | undefined>; onChangeState: (dirty: boolean, pending: boolean) => void }) {
  const [baseline, setBaseline] = useState(data);
  const [draft, setDraft] = useState(data.entries);
  const [kind, setKind] = useState<"employee" | "worker">("employee");
  const [personId, setPersonId] = useState(data.employees[0]?.employmentId ?? "");
  const [templateId, setTemplateId] = useState(data.shifts[0]?.templateId ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [savedNeedsReload, setSavedNeedsReload] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const save = useHrWrite<{ id: string; revision: number }>({ invalidate: false });
  const changes = scheduleChanges(draft, baseline.entries, outdatedScheduleIds(draft, data.shifts, data.calendar));
  const dirty = changes.entries.length > 0 || changes.removedIds.length > 0;
  const stale = (data.version?.revision ?? 0) !== (baseline.version?.revision ?? 0);
  const disabled = save.isPending || savedNeedsReload || reloadRequired || Boolean(data.version?.locked) || stale;
  useEffect(() => { onChangeState(dirty && !savedNeedsReload, save.isPending); }, [dirty, savedNeedsReload, save.isPending, onChangeState]);
  // 背景重抓不能吃掉草稿；保留舊 revision，讓 API 拒絕覆蓋他人的變更。
  useEffect(() => {
    if (!dirty && !save.isPending) { setBaseline(data); setDraft(data.entries); }
  }, [data, dirty, save.isPending]);
  const shifts = [...new Map(data.shifts.map((shift) => [shift.templateId, shift])).values()];
  const matchesPerson = (entry: ScheduleEntry) => entry.personKind === kind && (kind === "employee" ? entry.employmentId : entry.workerId) === personId;
  const templateOf = (entry: ScheduleEntry) => data.shifts.find((shift) => shift.versionId === entry.shiftVersionId)?.templateId;
  const selectedEntry = (date: string) => draft.find((entry) => !entry.archivedAt && entry.workDate === date && matchesPerson(entry) && templateOf(entry) === templateId);
  const picked = (date: string) => Boolean(selectedEntry(date));
  const toggle = (date: string) => {
    if (disabled || !personId || !templateId) return;
    const existing = selectedEntry(date);
    if (existing?.attendanceStatus !== undefined && existing.attendanceStatus !== "scheduled") return;
    if (existing) { setDraft((entries) => entries.filter((entry) => entry.id !== existing.id)); setMessage(null); return; }
    const day = data.calendar.find((day) => day.date === date);
    const shift = day && pickShiftForDay(data.shifts.filter((shift) => shift.templateId === templateId), day.dayType);
    if (!shift) return;
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
  const submit = async () => {
    setMessage(null);
    try {
      await save.mutateAsync({ path: "/me/schedules", method: "PATCH", values: { scopeId: data.scopes[0]!.id, periodKey: data.periodKey, revision: baseline.version?.revision ?? 0, ...changes } });
      setSavedNeedsReload(true);
      setMessage("排班已儲存並生效，不需送審。");
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "排班儲存失敗，草稿仍保留。");
      setReloadRequired(true);
      // 失敗後重抓只更新讀取資料，不接受新基準；有草稿時仍要明確確認後才能放棄。
      const fresh = await onReload();
      if (fresh) setReloadRequired(false);
    }
  };
  const employee = kind === "employee" ? data.employees.find((employee) => employee.employmentId === personId) : undefined;
  const selectedDays = new Set(draft.filter(matchesPerson).map((entry) => entry.workDate)).size;
  return <>
    {reloadRequired && !stale ? <Alert tone="warning">載入最新班表失敗，草稿仍保留。<Button variant="secondary" onClick={() => { if (!dirty || window.confirm("重新載入會放棄尚未儲存的排班，確定繼續？")) void reload(); }}>重新載入</Button></Alert> : null}
    {data.version?.locked ? <Alert>這個月份已鎖定，請聯絡 HR 開鎖後再調整。</Alert> : null}
    {stale ? <Alert tone="warning">排班已被其他人修改，草稿仍保留。請重新載入後再安排。<Button variant="secondary" onClick={() => { if (!dirty || window.confirm("重新載入會放棄尚未儲存的排班，確定繼續？")) void reload(); }}>重新載入</Button></Alert> : null}
    <Panel className="hr-front-schedule-tools">
      <SelectField label="人員類型" value={kind} disabled={disabled} options={[{ value: "employee", label: "正式員工" }, { value: "worker", label: "支援人員" }]} onChange={(event) => { const next = event.target.value as "employee" | "worker"; setKind(next); setPersonId(next === "employee" ? data.employees[0]?.employmentId ?? "" : data.workers[0]?.id ?? ""); }} />
      <SelectField label="人員" searchable value={personId} disabled={disabled} options={kind === "employee" ? data.employees.map((employee) => ({ value: employee.employmentId, label: `${employee.employeeNumber}・${employee.name}` })) : data.workers.map((worker) => ({ value: worker.id, label: worker.name }))} onChange={(event) => setPersonId(event.target.value)} />
      <SelectField label="班別" value={templateId} disabled={disabled} options={shifts.map((shift) => { const weekday = pickShiftForDay(data.shifts.filter((item) => item.templateId === shift.templateId), "weekday") ?? shift; return { value: shift.templateId, label: `${shift.name} ${shiftTimeRange(weekday)}` }; })} onChange={(event) => setTemplateId(event.target.value)} />
      <p className="muted">選好人員與班別，點日期排入；再點一次取消。週末及國定假日由系統套用對應班別時間。</p>
      <p>本據點已排 {selectedDays} 天{employee?.monthlyRestDays != null ? `；約定月休 ${employee.monthlyRestDays} 天（不含其他據點排班）` : ""}</p>
      {!shifts.length ? <Alert>這個據點尚未設定班別，請聯絡 HR。</Alert> : null}
      <div className="button-row"><Button loading={save.isPending} disabled={disabled || !dirty && !changes.refreshIds.length} onClick={() => void submit()}>儲存</Button><span>{dirty ? `尚未儲存：新增 ${changes.entries.length} 筆、移除 ${changes.removedIds.length} 筆` : "沒有未儲存變更"}</span></div>
      {changes.refreshIds.length ? <Alert tone="warning">有 {changes.refreshIds.length} 筆班別設定已變更，儲存會重新套用目前的日型、時間與需求人力。</Alert> : null}
      {message ? <Alert tone={save.error ? "danger" : "info"}>{message}</Alert> : null}
      {savedNeedsReload ? <Button variant="secondary" onClick={() => void reload()}>已儲存，重新載入班表</Button> : null}
    </Panel>
    <Panel className="hr-front-schedule-calendar">
      <div className="hr-front-schedule-grid weekdays" aria-hidden="true">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <strong key={day}>{day}</strong>)}</div>
      <div className="hr-front-schedule-grid">
        {Array.from({ length: new Date(`${data.periodKey}-01T00:00:00Z`).getUTCDay() }, (_, index) => <div key={`empty-${index}`} />)}
        {data.calendar.map((day) => <div key={day.date} className={`hr-front-schedule-day day-${day.dayType}${picked(day.date) ? " picked" : ""}`}>
          <button type="button" className="hr-front-schedule-date" aria-label={`${day.date} 排班`} aria-pressed={picked(day.date)} disabled={disabled || !personId || !templateId || Boolean(selectedEntry(day.date) && selectedEntry(day.date)!.attendanceStatus !== "scheduled")} onClick={() => toggle(day.date)}>{Number(day.date.slice(8))}</button>
          {day.name ? <small>{day.name}</small> : null}
          {draft.filter((entry) => entry.workDate === day.date).map((entry) => <div className={`hr-front-schedule-entry${matchesPerson(entry) ? " current" : ""}`} key={entry.id}><span>{entry.personName}{entry.archivedAt ? "（已封存）" : ""}</span><small>{entry.shiftName}{entry.personKind === "worker" ? "・支援" : ""}{entry.attendanceStatus !== "scheduled" ? "・出勤已確認" : ""}</small>{!entry.archivedAt && entry.attendanceStatus === "scheduled" ? <button type="button" aria-label={`移除 ${day.date} ${entry.personName} ${entry.shiftName}`} disabled={disabled} onClick={() => setDraft((entries) => entries.filter((other) => other.id !== entry.id))}>×</button> : null}</div>)}
        </div>)}
      </div>
    </Panel>
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
  return <div className="page hr-front-schedule-page">
    <PageHeader title="據點排班" description="只管理你負責的營運據點；儲存直接發布，不需送審。" actions={<Link className="button secondary" to="/profile">個人中心</Link>} />
    {scopes.error ? <Alert tone="danger">{scopes.error.message}</Alert> : null}
    {scopes.isPending ? <p>載入據點中…</p> : null}
    {scopes.data && !scopes.data.scopes.length ? <EmptyState>目前沒有負責的排班據點，請聯絡 HR 指派。</EmptyState> : null}
    {selectedScopeId ? <Panel><SelectField label="營運據點" value={selectedScopeId} disabled={editState.pending} options={(scopes.data?.scopes ?? []).map((scope) => ({ value: scope.id, label: scope.name }))} onChange={(event) => { if (confirmLeave()) { setScopeId(event.target.value); setEditState({ dirty: false, pending: false }); } }} /><div className="button-row"><Button variant="icon" icon="chevronLeft" aria-label="上個月" disabled={editState.pending} onClick={() => { if (confirmLeave()) { setMonth(nextMonth(month, -1)); setEditState({ dirty: false, pending: false }); } }} /><strong>{month}</strong><Button variant="icon" icon="chevronRight" aria-label="下個月" disabled={editState.pending} onClick={() => { if (confirmLeave()) { setMonth(nextMonth(month, 1)); setEditState({ dirty: false, pending: false }); } }} /></div></Panel> : null}
    {selectedScopeId && schedule.isPending ? <p>載入班表中…</p> : null}
    {schedule.error ? <Alert tone="danger">{schedule.error.message}</Alert> : null}
    {selectedScopeId && schedule.data ? <ScheduleEditor key={`${month}:${selectedScopeId}`} data={schedule.data} onChangeState={(dirty, pending) => setEditState((current) => current.dirty === dirty && current.pending === pending ? current : { dirty, pending })} onReload={async () => { const result = await schedule.refetch(); return result.isError ? undefined : result.data; }} /> : null}
  </div>;
}
