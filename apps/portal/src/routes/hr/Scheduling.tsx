import { useEffect, useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { Icon } from "../../shell/icons.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type HrScheduleResponse, type ScheduleEntry, type ScheduleShift } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

function taipeiMonthStart() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const year = Number(parts.find((item) => item.type === "year")?.value);
  const month = Number(parts.find((item) => item.type === "month")?.value);
  return new Date(Date.UTC(year, month - 1, 1));
}
function periodKey(date: Date) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }
function daysInMonth(date: Date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate(); }
function weekday(date: Date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).getUTCDay(); }
function dateAt(month: Date, day: number) { return `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`; }
function timeOf(seconds: number) { return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}`; }
function shiftLabel(shift: ScheduleShift) { return `${shift.name}（${timeOf(shift.startSecond)}–${timeOf(shift.endSecond)}${shift.endDayOffset ? " 次日" : ""}）`; }

/** 一次排班的四個條件。快速排班把它固定住，之後每點一天就套用同一組。 */
interface QuickPick { personKind: "employee" | "worker"; personId: string; scopeId: string; shiftVersionId: string }

/**
 * 把「人＋據點＋班別＋日期」組成月曆上的一筆排班。
 *
 * 對話框與快速排班都要產同一種東西，寫兩份的話遲早只改到一邊——那種 bug 會長成
 * 「用對話框加的會顯示班別名稱，用快速排班加的空白」。
 */
function makeEntry(data: HrScheduleResponse, pick: QuickPick, workDate: string): ScheduleEntry | null {
  const shift = data.shifts.find((item) => item.versionId === pick.shiftVersionId && item.scopeId === pick.scopeId);
  if (!shift || !pick.personId) return null;
  const employee = data.employees.find((item) => item.employmentId === pick.personId);
  const worker = data.workers.find((item) => item.id === pick.personId);
  return {
    id: `local-${crypto.randomUUID()}`, scheduleVersionId: data.version?.id ?? "", personKind: pick.personKind,
    employmentId: pick.personKind === "employee" ? pick.personId : null, workerId: pick.personKind === "worker" ? pick.personId : null,
    scopeId: pick.scopeId, shiftVersionId: pick.shiftVersionId, workDate, startsAt: "", endsAt: "",
    employeeNumber: pick.personKind === "employee" ? employee?.employeeNumber ?? null : null,
    personName: pick.personKind === "employee" ? employee?.name ?? "" : worker?.name ?? "",
    scopeName: data.scopes.find((scope) => scope.id === pick.scopeId)?.name ?? "", shiftName: shift.name,
  };
}

/**
 * 這筆排班是不是「同一人、同一據點、同一班別」。
 *
 * 班別也要比對，否則早班已排的人再點一次要排晚班時會被當成重複而被取消掉——
 * 早晚班本來就不重疊，兩筆同時存在是合法的。
 */
function samePick(entry: ScheduleEntry, pick: QuickPick) {
  return entry.scopeId === pick.scopeId && entry.shiftVersionId === pick.shiftVersionId
    && (pick.personKind === "employee" ? entry.employmentId === pick.personId : entry.workerId === pick.personId);
}

function ShiftDialog({ scopeId, onClose }: { scopeId: string; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00");
  const [endDayOffset, setEndDayOffset] = useState("0");
  const save = useHrWrite();
  return <Dialog title="新增班別" onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    save.mutate({ path: "/shift-templates", method: "POST", values: { scopeId, code, name, startTime, endTime, endDayOffset: Number(endDayOffset) } }, { onSuccess: onClose });
  } }} actions={<Button type="submit" loading={save.isPending}>建立班別</Button>}>
    <TextField label="班別代碼" required maxLength={40} value={code} onChange={(event) => setCode(event.target.value)} />
    <TextField label="班別名稱" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
    <div className="form-grid two"><TextField label="開始時間" type="time" required value={startTime} onChange={(event) => setStartTime(event.target.value)} /><TextField label="結束時間" type="time" required value={endTime} onChange={(event) => setEndTime(event.target.value)} /></div>
    <SelectField label="結束日" value={endDayOffset} options={[{ value: "0", label: "同日" }, { value: "1", label: "次日（跨午夜）" }]} onChange={(event) => setEndDayOffset(event.target.value)} />
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
  </Dialog>;
}

function ScheduleEntryDialog({ data, day, defaultScopeId, onAdd, onClose }: { data: HrScheduleResponse; day: string; defaultScopeId: string; onAdd: (entry: ScheduleEntry) => void; onClose: () => void }) {
  const [personKind, setPersonKind] = useState<"employee" | "worker">("employee");
  const [scopeId, setScopeId] = useState(defaultScopeId);
  const [personId, setPersonId] = useState(data.employees[0]?.employmentId ?? data.workers[0]?.id ?? "");
  const [shiftVersionId, setShiftVersionId] = useState("");
  const shifts = data.shifts.filter((shift) => shift.scopeId === scopeId);
  useEffect(() => { setShiftVersionId(shifts[0]?.versionId ?? ""); }, [scopeId, data.shifts]);
  useEffect(() => { setPersonId(personKind === "employee" ? data.employees[0]?.employmentId ?? "" : data.workers[0]?.id ?? ""); }, [personKind, data.employees, data.workers]);
  const selectedShift = shifts.find((shift) => shift.versionId === shiftVersionId);
  const save = useHrWrite();
  return <Dialog title={`${day} 新增排班`} onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    const entry = makeEntry(data, { personKind, personId, scopeId, shiftVersionId }, day);
    if (!entry) return;
    onAdd(entry);
    onClose();
  } }} actions={<Button type="submit" disabled={!selectedShift || !personId}>加入排班</Button>}>
    <SelectField label="人員類型" value={personKind} options={[{ value: "employee", label: "正式員工" }, { value: "worker", label: "臨時支援（納入日薪）" }]} onChange={(event) => setPersonKind(event.target.value as "employee" | "worker")} />
    <SelectField label="人員" value={personId} options={personKind === "employee" ? data.employees.map((employee) => ({ value: employee.employmentId, label: `${employee.employeeNumber} ${employee.name}` })) : data.workers.map((worker) => ({ value: worker.id, label: worker.name }))} onChange={(event) => setPersonId(event.target.value)} />
    <SelectField label="營運據點" value={scopeId} options={data.scopes.map((scope) => ({ value: scope.id, label: scope.name }))} onChange={(event) => setScopeId(event.target.value)} />
    <SelectField label="班別" value={shiftVersionId} options={shifts.map((shift) => ({ value: shift.versionId, label: shiftLabel(shift) }))} onChange={(event) => setShiftVersionId(event.target.value)} />
    {!shifts.length ? <Alert tone="info">這個營運據點尚未設定班別，請先新增班別。</Alert> : null}
  </Dialog>;
}

export function HrScheduling() {
  usePageTitle("排班月曆");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:schedule:read");
  const canWrite = permissions.has("hr:schedule:write");
  const [month, setMonth] = useState(taipeiMonthStart);
  const key = periodKey(month);
  const schedule = useHrQuery<HrScheduleResponse>(`/schedules?periodKey=${key}`, canRead);
  const [scopeId, setScopeId] = useState("all");
  const [draftEntries, setDraftEntries] = useState<ScheduleEntry[]>([]);
  const [addingDay, setAddingDay] = useState<string | null>(null);
  const [newShift, setNewShift] = useState(false);
  const [quick, setQuick] = useState<QuickPick | null>(null);
  const toast = useToast();
  const save = useHrWrite();
  const lock = useHrWrite();
  const data = schedule.data;

  useEffect(() => { if (data) setDraftEntries(data.entries); }, [data?.version?.revision, data?.entries]);
  // 換月份時的選擇留著只會誤導：日期格換了一批，畫面上的「已選 N 天」卻還是上個月的數字。
  useEffect(() => { setQuick(null); }, [key]);
  useEffect(() => { if (scopeId !== "all" && !data?.scopes.some((scope) => scope.id === scopeId)) setScopeId("all"); }, [data?.scopes, scopeId]);
  const visibleEntries = useMemo(() => scopeId === "all" ? draftEntries : draftEntries.filter((entry) => entry.scopeId === scopeId), [draftEntries, scopeId]);
  const dates = Array.from({ length: daysInMonth(month) }, (_, index) => dateAt(month, index + 1));
  const entriesOn = (day: string) => visibleEntries.filter((entry) => entry.workDate === day);

  if (!canRead) return <Alert tone="danger">你沒有檢視排班的權限。</Alert>;
  if (schedule.isPending) return <HrPageSkeleton variant="calendar" />;
  if (schedule.error || !data) return <div className="page"><Alert tone="danger">{schedule.error?.message ?? "排班資料載入失敗。"}</Alert></div>;
  const version = data.version;
  const defaultScope = scopeId === "all" ? data.scopes[0]?.id ?? "" : scopeId;
  const canEdit = canWrite && !version?.locked;
  const quickShifts = quick ? data.shifts.filter((shift) => shift.scopeId === quick.scopeId) : [];
  const quickDays = quick ? draftEntries.filter((entry) => samePick(entry, quick)).length : 0;
  const quickPicked = (day: string) => Boolean(quick && draftEntries.some((entry) => entry.workDate === day && samePick(entry, quick)));
  // 快速排班的據點跟著篩選器走，否則排到 A 店卻停在只看 B 店的畫面，點下去什麼都不會出現。
  const updateQuick = (next: QuickPick) => { setQuick(next); setScopeId(next.scopeId); };
  const openQuick = () => {
    const scope = defaultScope;
    updateQuick({ personKind: "employee", personId: data.employees[0]?.employmentId ?? "", scopeId: scope, shiftVersionId: data.shifts.find((shift) => shift.scopeId === scope)?.versionId ?? "" });
  };
  const toggleQuickDay = (day: string) => {
    if (!quick) return;
    setDraftEntries((current) => {
      const match = current.find((entry) => entry.workDate === day && samePick(entry, quick));
      if (match) return current.filter((entry) => entry.id !== match.id);
      const entry = makeEntry(data, quick, day);
      return entry ? [...current, entry] : current;
    });
  };
  const changed = JSON.stringify(draftEntries.map(({ id, scheduleVersionId, startsAt, endsAt, employeeNumber, personName, scopeName, shiftName, ...entry }) => entry)) !== JSON.stringify(data.entries.map(({ id, scheduleVersionId, startsAt, endsAt, employeeNumber, personName, scopeName, shiftName, ...entry }) => entry));

  return <div className="page fills hr-schedule-page">
    <PageHeader title="排班月曆" description="排班儲存即直接發布；鎖定只禁止修改，不使用草稿或送審流程。正式員工依排班出勤，臨時支援排班會納入日薪且不套用獎金。" actions={canWrite ? <div className="button-row"><Button variant="secondary" disabled={!defaultScope} onClick={() => setNewShift(true)}>新增班別</Button><Button variant="secondary" disabled={!canEdit || !defaultScope} onClick={() => quick ? setQuick(null) : openQuick()}>{quick ? "結束快速排班" : "快速排班"}</Button>{version ?<Button variant="secondary" onClick={() => lock.mutate({ path: `/schedules/${key}/lock`, method: "POST", values: { revision: version.revision, locked: !version.locked } })}>{version.locked ? "開鎖" : "鎖定排班"}</Button> : null}<Button loading={save.isPending} disabled={!changed || Boolean(version?.locked)} onClick={() => save.mutate({ path: "/schedules", method: "POST", values: { periodKey: key, ...(version ? { scheduleVersionId: version.id, revision: version.revision } : {}), entries: draftEntries.map((entry) => ({ personKind: entry.personKind, employmentId: entry.employmentId, workerId: entry.workerId, scopeId: entry.scopeId, shiftVersionId: entry.shiftVersionId, workDate: entry.workDate })) } }, { onSuccess: () => toast.show(`排班已儲存，共 ${draftEntries.length} 筆。`) })}>儲存並發布</Button></div> : undefined} />
    <div className="hr-schedule-toolbar"><Button variant="secondary" onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)))}>上個月</Button><strong>{month.getUTCFullYear()} 年 {month.getUTCMonth() + 1} 月</strong><Button variant="secondary" onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1)))}>下個月</Button><SelectField label="營運據點" value={scopeId} options={[{ value: "all", label: "全部營運據點" }, ...data.scopes.map((scope) => ({ value: scope.id, label: scope.name }))]} onChange={(event) => setScopeId(event.target.value)} /></div>
    {quick ? <div className="hr-quick-bar">
      <SelectField label="人員類型" value={quick.personKind} options={[{ value: "employee", label: "正式員工" }, { value: "worker", label: "臨時支援（納入日薪）" }]} onChange={(event) => {
        const personKind = event.target.value as "employee" | "worker";
        updateQuick({ ...quick, personKind, personId: (personKind === "employee" ? data.employees[0]?.employmentId : data.workers[0]?.id) ?? "" });
      }} />
      <SelectField label="人員" value={quick.personId} options={quick.personKind === "employee" ? data.employees.map((employee) => ({ value: employee.employmentId, label: `${employee.employeeNumber} ${employee.name}` })) : data.workers.map((worker) => ({ value: worker.id, label: worker.name }))} onChange={(event) => updateQuick({ ...quick, personId: event.target.value })} />
      <SelectField label="營運據點" value={quick.scopeId} options={data.scopes.map((scope) => ({ value: scope.id, label: scope.name }))} onChange={(event) => {
        const nextScope = event.target.value;
        updateQuick({ ...quick, scopeId: nextScope, shiftVersionId: data.shifts.find((shift) => shift.scopeId === nextScope)?.versionId ?? "" });
      }} />
      <SelectField label="班別" value={quick.shiftVersionId} options={quickShifts.map((shift) => ({ value: shift.versionId, label: shiftLabel(shift) }))} onChange={(event) => updateQuick({ ...quick, shiftVersionId: event.target.value })} />
      <p className="muted hr-quick-hint">{quickShifts.length ? `點日期加入，再點一次取消。已選 ${quickDays} 天，記得按「儲存並發布」。` : "這個營運據點尚未設定班別，請先按「新增班別」建立早班或晚班。"}</p>
    </div> : null}
    {data.version?.locked ? <Alert tone="info">此月份已鎖定；如需調整，先按「開鎖」，系統會留下操作紀錄。</Alert> : null}
    {save.error || lock.error ? <Alert tone="danger">{save.error?.message ?? lock.error?.message}</Alert> : null}
    <Panel className="grows">
      <div className="panel-head"><div><h2>排班月曆</h2><p className="muted">點選日期快速加入人員與班別；同一人員重疊時後端會拒絕儲存。</p></div></div>
      <div className="hr-calendar weekdays">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <strong key={day}>{day}</strong>)}</div>
      <div className="hr-calendar">
        {Array.from({ length: weekday(month) }, (_, index) => <div className="hr-calendar-cell empty" key={`empty-${index}`} />)}
        {dates.map((day, index) => <div className={`hr-calendar-cell${quick && quickPicked(day) ? " picked" : ""}`} key={day}>
          <div className="hr-calendar-date">{quick
            ? <button type="button" className="hr-quick-day" aria-pressed={quickPicked(day)} disabled={!quick.shiftVersionId || !quick.personId} onClick={() => toggleQuickDay(day)}><span>{index + 1}</span><Icon name={quickPicked(day) ? "check" : "plus"} /></button>
            : <><strong>{index + 1}</strong>{canEdit ? <button type="button" onClick={() => setAddingDay(day)}>＋</button> : null}</>}</div>
          <div className="hr-calendar-entries">{entriesOn(day).map((entry) => <div className={`hr-calendar-entry ${entry.personKind}`} key={entry.id}><span>{entry.personName}</span><small>{entry.shiftName} · {entry.scopeName}</small>{canEdit ? <button type="button" aria-label={`移除 ${entry.personName}`} onClick={() => setDraftEntries((current) => current.filter((candidate) => candidate.id !== entry.id))}>×</button> : null}</div>)}</div>
        </div>)}
      </div>
    </Panel>
    {addingDay && defaultScope ? <ScheduleEntryDialog data={data} day={addingDay} defaultScopeId={defaultScope} onAdd={(entry) => setDraftEntries((current) => [...current, entry])} onClose={() => setAddingDay(null)} /> : null}
    {newShift && defaultScope ? <ShiftDialog scopeId={defaultScope} onClose={() => { setNewShift(false); void schedule.refetch(); }} /> : null}
  </div>;
}
