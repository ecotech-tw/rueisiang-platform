import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useSession } from "../../auth/session.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, SelectField } from "../../ui/index.js";
import { shiftTimeRange, useHrQuery, useHrWrite, type HrScheduleResponse, type ScheduleEntry, type ScheduleShift } from "./api.js";
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
function shiftLabel(shift: ScheduleShift) { return `${shift.name}（${shiftTimeRange(shift)}，計薪 ${(shift.standardMinutes / 60).toFixed(1)} 小時／休息 ${shift.breakMinutes} 分鐘）`; }

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
    scopeId: pick.scopeId, shiftVersionId: pick.shiftVersionId, workDate, startsAt: "", endsAt: "", standardMinutes: shift.standardMinutes, breakMinutes: shift.breakMinutes,
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

function ScheduleEntryDialog({ data, day, defaultScopeId, onAdd, onClose }: { data: HrScheduleResponse; day: string; defaultScopeId: string; onAdd: (entry: ScheduleEntry) => void; onClose: () => void }) {
  const [personKind, setPersonKind] = useState<"employee" | "worker">("employee");
  const [scopeId, setScopeId] = useState(defaultScopeId);
  const [personId, setPersonId] = useState(data.employees[0]?.employmentId ?? data.workers[0]?.id ?? "");
  const [shiftVersionId, setShiftVersionId] = useState("");
  const shifts = data.shifts.filter((shift) => shift.scopeId === scopeId);
  useEffect(() => { setShiftVersionId(shifts[0]?.versionId ?? ""); }, [scopeId, data.shifts]);
  useEffect(() => { setPersonId(personKind === "employee" ? data.employees[0]?.employmentId ?? "" : data.workers[0]?.id ?? ""); }, [personKind, data.employees, data.workers]);
  const selectedShift = shifts.find((shift) => shift.versionId === shiftVersionId);
  return <Dialog title={`${day} 新增排班`} onClose={onClose} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    const entry = makeEntry(data, { personKind, personId, scopeId, shiftVersionId }, day);
    if (!entry) return;
    onAdd(entry);
    onClose();
  } }} actions={<Button type="submit" icon="check" disabled={!selectedShift || !personId}>加入排班</Button>}>
    <SelectField label="人員類型" value={personKind} options={[{ value: "employee", label: "正式員工" }, { value: "worker", label: "臨時支援（納入日薪）" }]} onChange={(event) => setPersonKind(event.target.value as "employee" | "worker")} />
    <SelectField label="人員" value={personId} options={personKind === "employee" ? data.employees.map((employee) => ({ value: employee.employmentId, label: `${employee.employeeNumber} ${employee.name}` })) : data.workers.map((worker) => ({ value: worker.id, label: worker.name }))} onChange={(event) => setPersonId(event.target.value)} />
    <SelectField label="營運據點" value={scopeId} options={data.scopes.map((scope) => ({ value: scope.id, label: scope.name }))} onChange={(event) => setScopeId(event.target.value)} />
    <SelectField label="班別" value={shiftVersionId} options={shifts.map((shift) => ({ value: shift.versionId, label: shiftLabel(shift) }))} onChange={(event) => setShiftVersionId(event.target.value)} />
    {!shifts.length ? <Alert tone="info">這個營運據點尚未設定班別，請先到 <Link to="/hr/scheduling/shifts">班別管理</Link> 新增。</Alert> : null}
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
  const scheduledDatesByEmployment = new Map<string, Set<string>>();
  for (const entry of draftEntries) if (entry.personKind === "employee" && entry.employmentId) {
    const datesForEmployee = scheduledDatesByEmployment.get(entry.employmentId) ?? new Set<string>();
    datesForEmployee.add(entry.workDate);
    scheduledDatesByEmployment.set(entry.employmentId, datesForEmployee);
  }
  const restSummaries = data.employees.filter((employee) => employee.attendanceMode === "scheduled" && employee.monthlyRestDays !== null && employee.monthlyRestDays !== undefined).map((employee) => {
    const activeDays = dates.filter((day) => employee.hiredOn <= day && (!employee.endedOn || day < employee.endedOn)).length;
    const scheduledDays = scheduledDatesByEmployment.get(employee.employmentId)?.size ?? 0;
    const restDays = Math.max(0, activeDays - scheduledDays);
    return { employee, activeDays, scheduledDays, restDays, matches: restDays === Math.min(employee.monthlyRestDays!, activeDays) };
  });
  const quickShifts = quick ? data.shifts.filter((shift) => shift.scopeId === quick.scopeId) : [];
  const quickDays = quick ? new Set(draftEntries.filter((entry) => samePick(entry, quick)).map((entry) => entry.workDate)).size : 0;
  const quickEmployee = quick?.personKind === "employee" ? data.employees.find((employee) => employee.employmentId === quick.personId) : undefined;
  const quickPicked = (day: string) => Boolean(quick && draftEntries.some((entry) => entry.workDate === day && samePick(entry, quick)));
  /*
   * 據點只有上方篩選器這一個來源。快速排班自己再放一個下拉的話，兩邊會各自記一個值：
   * 篩選器切到 B 店、月曆顯示 B 店，點下去的排班卻還是寫進 A 店，而且因為篩選器已經
   * 切走，那筆錯的排班在畫面上看不到，按儲存就發布到錯的店別。
   */
  const pickScope = (nextScopeId: string) => {
    setScopeId(nextScopeId);
    if (quick) setQuick({ ...quick, scopeId: nextScopeId, shiftVersionId: data.shifts.find((shift) => shift.scopeId === nextScopeId)?.versionId ?? "" });
  };
  const openQuick = () => {
    const scope = defaultScope;
    setScopeId(scope);
    setQuick({ personKind: "employee", personId: data.employees[0]?.employmentId ?? "", scopeId: scope, shiftVersionId: data.shifts.find((shift) => shift.scopeId === scope)?.versionId ?? "" });
  };
  const toggleQuickDay = (day: string) => {
    // 鎖定的月份不能改草稿：畫面說已鎖定，草稿卻默默變了，解鎖後一按儲存就發布出去。
    if (!quick || !canEdit) return;
    setDraftEntries((current) => {
      const match = current.find((entry) => entry.workDate === day && samePick(entry, quick));
      if (match) return current.filter((entry) => entry.id !== match.id);
      const entry = makeEntry(data, quick, day);
      return entry ? [...current, entry] : current;
    });
  };
  const changed = JSON.stringify(draftEntries.map(({ id, scheduleVersionId, startsAt, endsAt, employeeNumber, personName, scopeName, shiftName, ...entry }) => entry)) !== JSON.stringify(data.entries.map(({ id, scheduleVersionId, startsAt, endsAt, employeeNumber, personName, scopeName, shiftName, ...entry }) => entry));

  return <div className="page fills hr-schedule-page">
    <PageHeader title="排班月曆" description="排班儲存即直接發布；鎖定只禁止修改，不使用草稿或送審流程。正式員工依排班出勤，臨時支援排班會納入日薪且不套用獎金。" actions={canWrite ? <div className="button-row"><Button variant="secondary" disabled={quick ? false : !canEdit || !defaultScope} onClick={() => quick ? setQuick(null) : openQuick()}>{quick ? "結束快速排班" : "快速排班"}</Button>{version ?<Button variant="secondary" onClick={() => lock.mutate({ path: `/schedules/${key}/lock`, method: "POST", values: { revision: version.revision, locked: !version.locked } })}>{version.locked ? "開鎖" : "鎖定排班"}</Button> : null}<Button loading={save.isPending} disabled={!changed || Boolean(version?.locked)} onClick={() => save.mutate({ path: "/schedules", method: "POST", values: { periodKey: key, ...(version ? { scheduleVersionId: version.id, revision: version.revision } : {}), entries: draftEntries.map((entry) => ({ personKind: entry.personKind, employmentId: entry.employmentId, workerId: entry.workerId, scopeId: entry.scopeId, shiftVersionId: entry.shiftVersionId, workDate: entry.workDate })) } }, { onSuccess: () => toast.show(`排班已儲存，共 ${draftEntries.length} 筆。`) })}>儲存</Button></div> : undefined} />
    <div className="hr-schedule-toolbar"><Button variant="secondary" onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)))}>上個月</Button><strong>{month.getUTCFullYear()} 年 {month.getUTCMonth() + 1} 月</strong><Button variant="secondary" onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1)))}>下個月</Button><SelectField label="營運據點" value={scopeId} options={[...(quick ? [] : [{ value: "all", label: "全部營運據點" }]), ...data.scopes.map((scope) => ({ value: scope.id, label: scope.name }))]} onChange={(event) => pickScope(event.target.value)} /></div>
    {restSummaries.length ? <div className="hr-schedule-rest-summary" aria-label="月休統計"><strong>月休統計</strong><div>{restSummaries.map(({ employee, activeDays, scheduledDays, restDays, matches }) => <span className={matches ? "ok" : "warning"} key={employee.employmentId}><b>{employee.name}</b> 休 {restDays}／約定 {employee.monthlyRestDays} 天<span className="muted">（{scheduledDays}／{activeDays} 日）</span></span>)}</div></div> : null}
    {quick ? <div className="hr-quick-bar">
      <SelectField label="人員類型" value={quick.personKind} options={[{ value: "employee", label: "正式員工" }, { value: "worker", label: "臨時支援（納入日薪）" }]} onChange={(event) => {
        const personKind = event.target.value as "employee" | "worker";
        setQuick({ ...quick, personKind, personId: (personKind === "employee" ? data.employees[0]?.employmentId : data.workers[0]?.id) ?? "" });
      }} />
      <SelectField label="人員" value={quick.personId} options={quick.personKind === "employee" ? data.employees.map((employee) => ({ value: employee.employmentId, label: `${employee.employeeNumber} ${employee.name}` })) : data.workers.map((worker) => ({ value: worker.id, label: worker.name }))} onChange={(event) => setQuick({ ...quick, personId: event.target.value })} />
      <SelectField label="班別" value={quick.shiftVersionId} options={quickShifts.map((shift) => ({ value: shift.versionId, label: shiftLabel(shift) }))} onChange={(event) => setQuick({ ...quick, shiftVersionId: event.target.value })} />
      <p className="muted hr-quick-hint">{quickShifts.length ? <>點日期加入，再點一次取消。已選 {quickDays} 個工作日{quickEmployee?.monthlyRestDays !== null && quickEmployee?.monthlyRestDays !== undefined ? `，本月約定休 ${quickEmployee.monthlyRestDays} 天` : ""}，記得按「儲存」。</> : <>這個營運據點尚未設定班別，請先到 <Link to="/hr/scheduling/shifts">班別管理</Link> 新增早班或晚班。</>}</p>
    </div> : null}
    {data.version?.locked ? <Alert tone="info">此月份已鎖定；如需調整，先按「開鎖」，系統會留下操作紀錄。</Alert> : null}
    {save.error || lock.error ? <Alert tone="danger">{save.error?.message ?? lock.error?.message}</Alert> : null}
    <Panel className="grows">
      <div className="hr-calendar weekdays">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <strong key={day}>{day}</strong>)}</div>
      <div className={`hr-calendar${quick ? " quick" : ""}`}>
        {Array.from({ length: weekday(month) }, (_, index) => <div className="hr-calendar-cell empty" key={`empty-${index}`} />)}
        {dates.map((day, index) => <div
          className={`hr-calendar-cell${quick && quickPicked(day) ? " picked" : ""}`}
          key={day}
          /*
           * 整格可點，但格子本身不是 <button>：裡面已經有每筆排班的「×」與日期鍵，
           * 巢狀按鈕在鍵盤與讀螢幕上都是壞的。改成點空白處才 toggle，按鈕留給自己的動作，
           * 鍵盤仍然走日期鍵那顆真的 button。既有排班那一塊也要排除——只是想看清楚
           * 別人排了什麼，不該把目前編排的人加進來或移掉。
           */
          onClick={quick ? (event) => { if (!(event.target as HTMLElement).closest("button, .hr-calendar-entry")) toggleQuickDay(day); } : undefined}
        >
          <div className="hr-calendar-date">{quick
            ? <button type="button" className="hr-quick-day" aria-pressed={quickPicked(day)} disabled={!canEdit || !quick.shiftVersionId || !quick.personId} onClick={() => toggleQuickDay(day)}>{index + 1}</button>
            : <><strong>{index + 1}</strong>{canEdit ? <button type="button" onClick={() => setAddingDay(day)}>＋</button> : null}</>}</div>
          <div className="hr-calendar-entries">{entriesOn(day).map((entry) => <div className={`hr-calendar-entry ${entry.personKind}${quick && samePick(entry, quick) ? " current" : ""}`} key={entry.id}><span>{entry.personName}</span><small>{entry.shiftName} · {entry.scopeName}</small>{canEdit ? <button type="button" aria-label={`移除 ${entry.personName}`} onClick={() => setDraftEntries((current) => current.filter((candidate) => candidate.id !== entry.id))}>×</button> : null}</div>)}</div>
        </div>)}
      </div>
    </Panel>
    {addingDay && defaultScope ? <ScheduleEntryDialog data={data} day={addingDay} defaultScopeId={defaultScope} onAdd={(entry) => setDraftEntries((current) => [...current, entry])} onClose={() => setAddingDay(null)} /> : null}
  </div>;
}
