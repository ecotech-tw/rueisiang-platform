import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useSession } from "../../auth/session.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, SelectField, StatusBadge, TextField } from "../../ui/index.js";
import { groupShiftsByTemplate, pickShiftForDay, shiftTimeRange, useHrQuery, useHrWrite, HR_DAY_TYPES, HR_DAY_TYPE_LABELS, type HrCalendarDay, type HrDayType, type HrScheduleResponse, type ScheduleEntry, type ScheduleShift } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";
import { useConfirmLeave, useUnsavedChanges } from "../../shell/UnsavedChanges.js";

function taipeiMonthStart() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const year = Number(parts.find((item) => item.type === "year")?.value);
  const month = Number(parts.find((item) => item.type === "month")?.value);
  return new Date(Date.UTC(year, month - 1, 1));
}
/** 今天（台北）。en-CA 排出來就是 YYYY-MM-DD，跟月曆格的日期字串同一種格式。 */
function taipeiToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date()); }
function periodKey(date: Date) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }
function daysInMonth(date: Date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate(); }
function weekday(date: Date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).getUTCDay(); }
function dateAt(month: Date, day: number) { return `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`; }
// 計薪時數就是班別長度，時段本身已經說完了，不必再括號補一次「計薪 8.0 小時」。
function shiftLabel(shift: ScheduleShift) { return `${shift.name}（${shiftTimeRange(shift)}）`; }

/**
 * 一次排班的四個條件。快速排班把它固定住，之後每點一天就套用同一組。
 *
 * 這裡記的是**班別**而不是某一組時間：同一個「早班」在平日與國定假日是兩個版本 ID，
 * 記版本的話一路點下去會把假日那幾天也排成平日的時間，而畫面上選的明明是同一個早班。
 * 真正要寫進班表的版本由 makeEntry 依那天的日型挑。
 */
interface QuickPick { personKind: "employee" | "worker"; personId: string; scopeId: string; shiftTemplateId: string }

/**
 * 把「人＋據點＋班別＋日期」組成月曆上的一筆排班。
 *
 * 對話框與快速排班都要產同一種東西，寫兩份的話遲早只改到一邊——那種 bug 會長成
 * 「用對話框加的會顯示班別名稱，用快速排班加的空白」。
 */
function makeEntry(data: HrScheduleResponse, pick: QuickPick, workDate: string, dayType: HrDayType): ScheduleEntry | null {
  const shift = pickShiftForDay(data.shifts.filter((item) => item.templateId === pick.shiftTemplateId && item.scopeId === pick.scopeId), dayType);
  if (!shift || !pick.personId) return null;
  const employee = data.employees.find((item) => item.employmentId === pick.personId);
  const worker = data.workers.find((item) => item.id === pick.personId);
  return {
    id: `local-${crypto.randomUUID()}`, scheduleVersionId: data.version?.id ?? "", personKind: pick.personKind,
    employmentId: pick.personKind === "employee" ? pick.personId : null, workerId: pick.personKind === "worker" ? pick.personId : null,
    scopeId: pick.scopeId, shiftVersionId: shift.versionId, workDate, startsAt: "", endsAt: "", standardMinutes: shift.standardMinutes, breakMinutes: shift.breakMinutes,
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
 *
 * 比的是班別而不是版本 ID：平日排的早班與假日排的早班版本不同，比版本的話假日那天
 * 會被當成別的班，快速排班再點一次取消不掉。
 */
function samePick(entry: ScheduleEntry, pick: QuickPick, templateOf: (versionId: string) => string | undefined) {
  return entry.scopeId === pick.scopeId && templateOf(entry.shiftVersionId) === pick.shiftTemplateId
    && (pick.personKind === "employee" ? entry.employmentId === pick.personId : entry.workerId === pick.personId);
}

/**
 * 一筆排班在業務上的身分：人＋據點＋班別＋日期。
 *
 * id 與 personName 這類顯示欄位不算——草稿的 id 是本機產生的 UUID，拿去跟已發布的比對
 * 永遠不相等，那樣「有沒有變更」會一直是 true，儲存鈕永遠亮著。
 */
function entrySignature(entry: ScheduleEntry) {
  return [entry.personKind, entry.employmentId ?? "", entry.workerId ?? "", entry.scopeId, entry.shiftVersionId, entry.workDate].join("|");
}
/**
 * 草稿跟已發布差在哪。狀態列要講「按下儲存會發生什麼事」，只說「有變更」等於沒說。
 *
 * 用加減計數而不是 JSON 字串比對：移掉一筆再加回來，字串比對會因為陣列順序不同而
 * 誤判成有變更，讓使用者存一次沒有任何差異的版本。
 */
function diffEntries(draft: ScheduleEntry[], saved: ScheduleEntry[]) {
  const counts = new Map<string, number>();
  for (const entry of draft) counts.set(entrySignature(entry), (counts.get(entrySignature(entry)) ?? 0) + 1);
  for (const entry of saved) counts.set(entrySignature(entry), (counts.get(entrySignature(entry)) ?? 0) - 1);
  let added = 0;
  let removed = 0;
  for (const count of counts.values()) if (count > 0) added += count; else removed -= count;
  return { added, removed, changed: added > 0 || removed > 0 };
}

/**
 * 單日新增排班。班別選的是班別本身，帶出來的時間依當天日型而定。
 *
 * 使用者仍然改得動：在國定假日排一個平日時間的班是合理的需求，
 * 系統不該因為那天被標成假日就不給選。
 */
function ScheduleEntryDialog({ data, day, dayType, defaultScopeId, onAdd, onClose }: { data: HrScheduleResponse; day: string; dayType: HrDayType; defaultScopeId: string; onAdd: (entry: ScheduleEntry) => void; onClose: () => void }) {
  const [personKind, setPersonKind] = useState<"employee" | "worker">("employee");
  const [scopeId, setScopeId] = useState(defaultScopeId);
  const [personId, setPersonId] = useState(data.employees[0]?.employmentId ?? data.workers[0]?.id ?? "");
  const [shiftVersionId, setShiftVersionId] = useState("");
  const shifts = useMemo(() => data.shifts.filter((shift) => shift.scopeId === scopeId), [data.shifts, scopeId]);
  const templates = useMemo(() => [...groupShiftsByTemplate(shifts).values()], [shifts]);
  useEffect(() => {
    const first = templates[0];
    setShiftVersionId(first ? pickShiftForDay(first, dayType)?.versionId ?? "" : "");
  }, [templates, dayType]);
  useEffect(() => { setPersonId(personKind === "employee" ? data.employees[0]?.employmentId ?? "" : data.workers[0]?.id ?? ""); }, [personKind, data.employees, data.workers]);
  const selectedShift = shifts.find((shift) => shift.versionId === shiftVersionId);
  return <Dialog title={`${day} 新增排班`} onClose={onClose} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    if (!selectedShift) return;
    const entry = makeEntry(data, { personKind, personId, scopeId, shiftTemplateId: selectedShift.templateId }, day, selectedShift.dayType);
    if (!entry) return;
    onAdd(entry);
    onClose();
  } }} actions={<Button type="submit" icon="check" disabled={!selectedShift || !personId}>加入排班</Button>}>
    <SelectField label="人員類型" value={personKind} options={[{ value: "employee", label: "正式員工" }, { value: "worker", label: "臨時支援（納入日薪）" }]} onChange={(event) => setPersonKind(event.target.value as "employee" | "worker")} />
    <SelectField label="人員" value={personId} options={personKind === "employee" ? data.employees.map((employee) => ({ value: employee.employmentId, label: `${employee.employeeNumber} ${employee.name}` })) : data.workers.map((worker) => ({ value: worker.id, label: worker.name }))} onChange={(event) => setPersonId(event.target.value)} />
    <SelectField label="營運據點" value={scopeId} options={data.scopes.map((scope) => ({ value: scope.id, label: scope.name }))} onChange={(event) => setScopeId(event.target.value)} />
    {/* 一個班別一個選項，label 直接寫出那天會用到的時間，使用者不必自己推今天算哪一型。 */}
    <SelectField label="班別" value={shiftVersionId} options={templates.flatMap((versions) => {
      const shift = pickShiftForDay(versions, dayType);
      return shift ? [{ value: shift.versionId, label: shiftLabel(shift) }] : [];
    })} onChange={(event) => setShiftVersionId(event.target.value)} />
    {selectedShift && selectedShift.dayType !== "weekday" ? <p className="muted field-note">這天是{HR_DAY_TYPE_LABELS[dayType]}，已套用{HR_DAY_TYPE_LABELS[selectedShift.dayType]}時間。</p> : null}
    {!shifts.length ? <Alert tone="info">這個營運據點尚未設定班別，請先到 <Link to="/hr/scheduling/shifts">班別管理</Link> 新增。</Alert> : null}
  </Dialog>;
}

/**
 * 一個月的行事曆。只有被標成跟預設值不同的日子會存下來，其餘由星期幾推算。
 *
 * 放在排班月曆而不是另開一頁：會想到要標國定假日的時機，就是正在排那個月的班的時候。
 */
function CalendarDialog({ periodKey: key, days: initial, canWrite, onClose, onSaved }: { periodKey: string; days: HrCalendarDay[]; canWrite: boolean; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [days, setDays] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const save = useHrWrite();
  const toast = useToast();
  const changed = days.some((day, index) => day.dayType !== initial[index]?.dayType || day.name !== initial[index]?.name);
  const update = (date: string, patch: Partial<HrCalendarDay>) => {
    setDays((current) => current.map((day) => day.date === date ? { ...day, ...patch } : day));
    setMessage(null);
  };
  const submit = async () => {
    try {
      await save.mutateAsync({ path: `/calendar/${key}`, method: "PUT", values: { days: days.map(({ date, dayType, name }) => ({ date, dayType, name })), knownDates: initial.filter((day) => day.overridden).map((day) => day.date) } });
      await onSaved();
      toast.show("行事曆已儲存。");
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "行事曆儲存失敗，請稍後再試。");
    }
  };
  return <Dialog
    title={`${key} 行事曆`}
    onClose={onClose}
    closeDisabled={save.isPending}
    actions={canWrite ? <Button loading={save.isPending} disabled={!changed} onClick={() => { void submit(); }}>儲存</Button> : undefined}
  >
    <p className="muted field-note">週六日預設就是週末，不用特別標。這裡只需要標出國定假日與補班日。</p>
    <div className="hr-calendar-editor">
      {days.map((day) => <div className={`hr-calendar-editor-row day-${day.dayType}`} key={day.date}>
        <span className="hr-calendar-editor-date">{Number(day.date.slice(8))}<small>{["日", "一", "二", "三", "四", "五", "六"][new Date(`${day.date}T00:00:00Z`).getUTCDay()]}</small></span>
        <SelectField aria-label={`${day.date} 日期類型`} value={day.dayType} disabled={!canWrite || save.isPending} options={HR_DAY_TYPES.map((dayType) => ({ value: dayType, label: HR_DAY_TYPE_LABELS[dayType] }))} onChange={(event) => update(day.date, { dayType: event.target.value as HrDayType })} />
        <TextField aria-label={`${day.date} 名稱`} maxLength={100} placeholder="例如：中秋節、補班日" value={day.name} disabled={!canWrite || save.isPending} onChange={(event) => update(day.date, { name: event.target.value })} />
      </div>)}
    </div>
    {message || save.error ? <Alert tone="danger">{message ?? save.error?.message}</Alert> : null}
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
  const [editingCalendar, setEditingCalendar] = useState(false);
  const toast = useToast();
  const confirmLeave = useConfirmLeave();
  const save = useHrWrite();
  const lock = useHrWrite();
  const data = schedule.data;

  /*
   * 只在「換了月份」或「排班版本真的動了」時才用伺服器版本重設草稿。
   *
   * 依賴一度掛的是 data.entries 這個陣列本身，於是任何一次 refetch 都會把未儲存的草稿
   * 蓋掉。行事曆就是踩到這個：在排班頁標一個國定假日會 invalidate 整個 hr query，
   * 回來的新陣列直接吃掉剛排好、還沒按儲存的那二十天，而且畫面上不會有任何提示。
   * 存排班時 revision 一定會 +1，所以該更新的情境靠 revision 就夠。
   */
  useEffect(() => { if (data) setDraftEntries(data.entries); }, [data?.periodKey, data?.version?.id, data?.version?.revision]);
  // 換月份時的選擇留著只會誤導：日期格換了一批，畫面上的「已選 N 天」卻還是上個月的數字。
  useEffect(() => { setQuick(null); }, [key]);
  // 鎖定之後點日期不會有反應，快速排班條留在畫面上等於擺一個按了沒用的東西。
  useEffect(() => { if (data?.version?.locked) setQuick(null); }, [data?.version?.locked]);
  useEffect(() => { if (scopeId !== "all" && !data?.scopes.some((scope) => scope.id === scopeId)) setScopeId("all"); }, [data?.scopes, scopeId]);
  const visibleEntries = useMemo(() => scopeId === "all" ? draftEntries : draftEntries.filter((entry) => entry.scopeId === scopeId), [draftEntries, scopeId]);
  /*
   * 日型跟班別版本的對照表。兩張都由後端的回應直接產生：
   * 日型不在這裡再推一次星期幾，否則補班日這種算不出來的日子會跟後端對不起來。
   */
  const dayTypeByDate = useMemo(() => new Map((data?.calendar ?? []).map((day) => [day.date, day])), [data?.calendar]);
  const templateByVersion = useMemo(() => new Map((data?.shifts ?? []).map((shift) => [shift.versionId, shift.templateId])), [data?.shifts]);
  const dayTypeOf = (date: string): HrDayType => dayTypeByDate.get(date)?.dayType ?? "weekday";
  const templateOf = (versionId: string) => templateByVersion.get(versionId);
  const dates = Array.from({ length: daysInMonth(month) }, (_, index) => dateAt(month, index + 1));
  const entriesOn = (day: string) => visibleEntries.filter((entry) => entry.workDate === day);
  /*
   * 差異與「未儲存」的註冊都要在下面那幾個 early return 之前算完。
   *
   * 放在 return 之後的話，資料還在載入的那次 render 根本跑不到這個 hook，下一次 render
   * hook 數量就對不上，React 直接拋。所以這裡用 data?.entries ?? [] 而不是 data.entries。
   */
  const { added, removed, changed } = diffEntries(draftEntries, data?.entries ?? []);
  const switchMonth = async (delta: number) => {
    if (!(await confirmLeave())) return;
    setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + delta, 1)));
  };
  /*
   * 排一個月的班可能累積上百筆，所以訊息要把增減筆數講出來，不是只說「有變更」。
   *
   * 月份取自 data 而不是 key：key 跟著月份箭頭當下就變，但草稿仍然屬於上一個月，
   * 中間那一段會說成「2026-10 新增 2 筆」而那 2 筆其實是 2026-09 的。
   */
  useUnsavedChanges(changed, `${data?.periodKey ?? key} 的排班還沒儲存${added ? `，新增 ${added} 筆` : ""}${removed ? `，移除 ${removed} 筆` : ""}。`);

  if (!canRead) return <Alert tone="danger">你沒有檢視排班的權限。</Alert>;
  if (schedule.isPending) return <HrPageSkeleton variant="calendar" />;
  if (schedule.error || !data) return <div className="page"><Alert tone="danger">{schedule.error?.message ?? "排班資料載入失敗。"}</Alert></div>;
  const version = data.version;
  const defaultScope = scopeId === "all" ? data.scopes[0]?.id ?? "" : scopeId;
  // 換月份時 data 仍是上個月的，version 跟 key 對不上；這時點日期或按鎖定都會寫到錯的月份。
  const loading = schedule.isPlaceholderData;
  const canEdit = canWrite && !version?.locked && !loading;
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
  const quickTemplates = quick ? [...groupShiftsByTemplate(data.shifts.filter((shift) => shift.scopeId === quick.scopeId)).values()] : [];
  const quickDays = quick ? new Set(draftEntries.filter((entry) => samePick(entry, quick, templateOf)).map((entry) => entry.workDate)).size : 0;
  // 正在排的那個人的月休進度直接放在快速排班條上；否則要回頭在月休統計那一排裡找名字。
  const quickRest = quick?.personKind === "employee" ? restSummaries.find((summary) => summary.employee.employmentId === quick.personId) : undefined;
  const quickPicked = (day: string) => Boolean(quick && draftEntries.some((entry) => entry.workDate === day && samePick(entry, quick, templateOf)));
  const firstTemplateId = (forScopeId: string) => data.shifts.find((shift) => shift.scopeId === forScopeId)?.templateId ?? "";
  /*
   * 據點只有上方篩選器這一個來源。快速排班自己再放一個下拉的話，兩邊會各自記一個值：
   * 篩選器切到 B 店、月曆顯示 B 店，點下去的排班卻還是寫進 A 店，而且因為篩選器已經
   * 切走，那筆錯的排班在畫面上看不到，按儲存就發布到錯的店別。
   */
  const pickScope = (nextScopeId: string) => {
    setScopeId(nextScopeId);
    if (quick) setQuick({ ...quick, scopeId: nextScopeId, shiftTemplateId: firstTemplateId(nextScopeId) });
  };
  const openQuick = () => {
    const scope = defaultScope;
    setScopeId(scope);
    setQuick({ personKind: "employee", personId: data.employees[0]?.employmentId ?? "", scopeId: scope, shiftTemplateId: firstTemplateId(scope) });
  };
  const toggleQuickDay = (day: string) => {
    // 鎖定的月份不能改草稿：畫面說已鎖定，草稿卻默默變了，解鎖後一按儲存就發布出去。
    if (!quick || !canEdit) return;
    setDraftEntries((current) => {
      const match = current.find((entry) => entry.workDate === day && samePick(entry, quick, templateOf));
      if (match) return current.filter((entry) => entry.id !== match.id);
      const entry = makeEntry(data, quick, day, dayTypeOf(day));
      return entry ? [...current, entry] : current;
    });
  };
  /*
   * 排班沒有草稿與送審：按下儲存就是發布，發布之後隨時可以再改。狀態列就是在講這件事——
   * 只看「儲存」鈕是亮是灰的話，使用者不知道這個月到底發布出去了沒有。
   */
  const status = loading
    ? { tone: "neutral" as const, label: "載入中", detail: "" }
    : version?.locked
    ? { tone: "neutral" as const, label: "已鎖定", detail: "先按「開鎖」才能修改，系統會留下操作紀錄。" }
    : changed
      ? { tone: "warning" as const, label: "尚未儲存", detail: `按「儲存」即發布${added ? `，新增 ${added} 筆` : ""}${removed ? `，移除 ${removed} 筆` : ""}。` }
      : version
        ? { tone: "success" as const, label: "已發布", detail: `共 ${data.entries.length} 筆排班，隨時可以再調整。` }
        : { tone: "neutral" as const, label: "尚未排班", detail: "排好之後按「儲存」即發布。" };
  const today = taipeiToday();

  return <div className="page fills hr-schedule-page">
    <PageHeader title="排班月曆" description="正式員工依排班出勤；臨時支援排班會納入日薪，且不套用獎金。" actions={canWrite ? <div className="button-row">{quick ? null : <Button variant="secondary" disabled={!canEdit || !defaultScope} onClick={openQuick}>快速排班</Button>}<Button variant="secondary" disabled={loading} onClick={() => setEditingCalendar(true)}>行事曆</Button>{version ?<Button variant="secondary" disabled={loading} onClick={() => lock.mutate({ path: `/schedules/${key}/lock`, method: "POST", values: { revision: version.revision, locked: !version.locked } })}>{version.locked ? "開鎖" : "鎖定排班"}</Button> : null}<Button loading={save.isPending} disabled={!changed || Boolean(version?.locked) || loading} onClick={() => save.mutate({ path: "/schedules", method: "POST", values: { periodKey: key, ...(version ? { scheduleVersionId: version.id, revision: version.revision } : {}), entries: draftEntries.map((entry) => ({ personKind: entry.personKind, employmentId: entry.employmentId, workerId: entry.workerId, scopeId: entry.scopeId, shiftVersionId: entry.shiftVersionId, workDate: entry.workDate })) } }, { onSuccess: () => toast.show(`排班已儲存，共 ${draftEntries.length} 筆。`) })}>儲存</Button></div> : undefined} />
    {restSummaries.length ? <div className="hr-schedule-rest-summary" aria-label="月休統計"><strong>月休統計</strong><div>{restSummaries.map(({ employee, activeDays, scheduledDays, restDays, matches }) => <span className={matches ? "ok" : "warning"} key={employee.employmentId}><b>{employee.name}</b> 休 {restDays}／約定 {employee.monthlyRestDays} 天<span className="muted">（{scheduledDays}／{activeDays} 日）</span></span>)}</div></div> : null}
    {save.error || lock.error ? <Alert tone="danger">{save.error?.message ?? lock.error?.message}</Alert> : null}
    <Panel className="grows hr-calendar-panel">
      <div className="hr-calendar-head">
        <div className="hr-schedule-month">
          {/*
            * 換月份也要先問：它不經過導覽，但新資料一到就會把草稿洗掉，結果一樣是
            * 白做工，而且箭頭就在月曆正上方，比側邊選單更容易誤觸。
            */}
          <Button variant="icon" icon="chevronLeft" aria-label="上個月" onClick={() => void switchMonth(-1)} />
          <strong>{month.getUTCFullYear()} 年 {month.getUTCMonth() + 1} 月</strong>
          <Button variant="icon" icon="chevronRight" aria-label="下個月" onClick={() => void switchMonth(1)} />
        </div>
        <SelectField aria-label="營運據點" value={scopeId} options={[...(quick ? [] : [{ value: "all", label: "全部營運據點" }]), ...data.scopes.map((scope) => ({ value: scope.id, label: scope.name }))]} onChange={(event) => pickScope(event.target.value)} />
        {/* 不掛 role="status"：快速排班每點一天就會改「新增 N 筆」，做成 live region 等於整月被念一遍。 */}
        <p className="hr-schedule-status"><StatusBadge tone={status.tone}>{status.label}</StatusBadge><span>{status.detail}</span></p>
      </div>
      {quick ? <div className="hr-quick-bar">
        <strong>快速排班</strong>
        <SelectField aria-label="人員類型" value={quick.personKind} options={[{ value: "employee", label: "正式員工" }, { value: "worker", label: "臨時支援（納入日薪）" }]} onChange={(event) => {
          const personKind = event.target.value as "employee" | "worker";
          setQuick({ ...quick, personKind, personId: (personKind === "employee" ? data.employees[0]?.employmentId : data.workers[0]?.id) ?? "" });
        }} />
        <SelectField aria-label="人員" value={quick.personId} options={quick.personKind === "employee" ? data.employees.map((employee) => ({ value: employee.employmentId, label: `${employee.name} ${employee.employeeNumber}` })) : data.workers.map((worker) => ({ value: worker.id, label: worker.name }))} onChange={(event) => setQuick({ ...quick, personId: event.target.value })} />
        {/*
          * 選班別而不是選某一組時間：點到哪一天就用那天的日型挑。所以 label
          * 只寫平日的時間做代表，後面再註明還有哪些日型有自己的時間。
          */}
        {quickTemplates.length
          ? <SelectField aria-label="班別" value={quick.shiftTemplateId} options={quickTemplates.flatMap((versions) => {
              const weekday = pickShiftForDay(versions, "weekday");
              if (!weekday) return [];
              const extras = versions.filter((shift) => shift.dayType !== "weekday").map((shift) => HR_DAY_TYPE_LABELS[shift.dayType]);
              return [{ value: weekday.templateId, label: `${shiftLabel(weekday)}${extras.length ? ` 另設${extras.join("、")}` : ""}` }];
            })} onChange={(event) => setQuick({ ...quick, shiftTemplateId: event.target.value })} />
          : <span className="hr-quick-bar-empty">這個據點還沒有班別，<Link to="/hr/scheduling/shifts">前往班別管理</Link></span>}
        <span className="hr-quick-bar-hint">點日期排入或取消</span>
        <span className="hr-quick-bar-count">已選 <b>{quickDays}</b> 天</span>
        {quickRest ? <span className={`hr-quick-bar-rest ${quickRest.matches ? "ok" : "warning"}`}>休 {quickRest.restDays}／約定 {quickRest.employee.monthlyRestDays} 天</span> : null}
        <Button variant="secondary" onClick={() => setQuick(null)}>結束</Button>
      </div> : null}
      <div className="hr-calendar weekdays">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <strong key={day}>{day}</strong>)}</div>
      <div className={`hr-calendar-scroll${loading ? " is-refreshing" : ""}`}>
      <div className={`hr-calendar${quick ? " quick" : ""}`}>
        {Array.from({ length: weekday(month) }, (_, index) => <div className="hr-calendar-cell empty" key={`empty-${index}`} />)}
        {dates.map((day, index) => <div
          className={`hr-calendar-cell day-${dayTypeOf(day)}${quick && quickPicked(day) ? " picked" : ""}${day === today ? " today" : ""}`}
          key={day}
          /*
           * 整格可點，但格子本身不是 <button>：裡面已經有每筆排班的「×」與日期鍵，
           * 巢狀按鈕在鍵盤與讀螢幕上都是壞的。改成點空白處才 toggle，按鈕留給自己的動作，
           * 鍵盤仍然走日期鍵那顆真的 button。既有排班那一塊也要排除——只是想看清楚
           * 別人排了什麼，不該把目前編排的人加進來或移掉。
           */
          onClick={quick ? (event) => { if (!(event.target as HTMLElement).closest("button, .hr-calendar-entry")) toggleQuickDay(day); } : undefined}
        >
          {/* aria-current 讓讀螢幕也聽得到今天；視覺上是日期數字那顆實心膠囊。 */}
          {/*
            * 假日名稱是文字，不是只用底色：顏色一旦成為唯一的訊號，色弱的人就看不出
            * 這天跟旁邊差在哪裡，而「今天是不是國定假日」正是排班時最需要看清楚的事。
            */}
          {dayTypeByDate.get(day)?.name ? <span className="hr-calendar-holiday">{dayTypeByDate.get(day)!.name}</span> : null}
          <div className="hr-calendar-date" {...(day === today ? { "aria-current": "date" as const } : {})}>{quick
            ? <button type="button" className="hr-quick-day" aria-pressed={quickPicked(day)} disabled={!canEdit || !quick.shiftTemplateId || !quick.personId} onClick={() => toggleQuickDay(day)}>{index + 1}</button>
            : <><strong>{index + 1}</strong>{canEdit ? <button type="button" aria-label={`${day} 新增排班`} onClick={() => setAddingDay(day)}>＋</button> : null}</>}</div>
          <div className="hr-calendar-entries">{entriesOn(day).map((entry) => <div className={`hr-calendar-entry ${entry.personKind}${quick && samePick(entry, quick, templateOf) ? " current" : ""}`} key={entry.id}><span>{entry.personName}</span><small>{entry.shiftName} · {entry.scopeName}</small>{canEdit ? <button type="button" aria-label={`移除 ${entry.personName}`} onClick={() => setDraftEntries((current) => current.filter((candidate) => candidate.id !== entry.id))}>×</button> : null}</div>)}</div>
        </div>)}
      </div>
      </div>
    </Panel>
    {addingDay && defaultScope ? <ScheduleEntryDialog data={data} day={addingDay} dayType={dayTypeOf(addingDay)} defaultScopeId={defaultScope} onAdd={(entry) => setDraftEntries((current) => [...current, entry])} onClose={() => setAddingDay(null)} /> : null}
    {editingCalendar ? <CalendarDialog periodKey={key} days={data.calendar} canWrite={canWrite} onClose={() => setEditingCalendar(false)} onSaved={() => schedule.refetch()} /> : null}
  </div>;
}
