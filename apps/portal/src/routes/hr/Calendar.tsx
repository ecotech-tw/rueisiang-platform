import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../auth/session.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, DropdownSelect, PageHeader, Panel, SelectField, StatusBadge, TextField, Tooltip } from "../../ui/index.js";
import { useHrQuery, useHrWrite, HR_CALENDAR_SPECIAL_KINDS, HR_CALENDAR_SPECIAL_KIND_LABELS, HR_DAY_TYPES, HR_DAY_TYPE_LABELS, type HrCalendarDay, type HrCalendarResponse, type HrCalendarSpecialKind, type HrDayType, type ScheduleScope } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";
import { useConfirmLeave, useUnsavedChanges } from "../../shell/UnsavedChanges.js";

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"] as const;

function weekdayOf(date: string) { return WEEKDAY_LABELS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? ""; }
function isWeekendDate(date: string) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}
function taipeiYear() { return Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric" }).format(new Date())); }

/**
 * 一列在說什麼事。行事曆只存例外，所以每一列都是「跟星期幾算出來的不一樣」的某一天，
 * 但不一樣的方式有兩種，混在一起看不出差別。
 */
function rowKind(day: HrCalendarDay): { tone: "warning" | "neutral"; label: string } {
  if (day.specialKind === "typhoon_stop") return { tone: "warning", label: "災防停班" };
  return day.dayType === "weekday" && isWeekendDate(day.date)
    ? { tone: "warning", label: "補班日" }
    : { tone: "neutral", label: HR_DAY_TYPE_LABELS[day.dayType] };
}

function sortByDate(days: HrCalendarDay[]) {
  return [...days].sort((a, b) => a.date.localeCompare(b.date));
}

function sameDays(a: HrCalendarDay[], b: HrCalendarDay[]) {
  if (a.length !== b.length) return false;
  return a.every((day, index) => day.date === b[index]?.date && day.dayType === b[index]?.dayType && day.name === b[index]?.name && day.specialKind === b[index]?.specialKind && (day.specialScopeIds ?? []).join(",") === (b[index]?.specialScopeIds ?? []).join(","));
}

function scopeLabel(scopeId: string, scopes: ScheduleScope[]) {
  return scopes.find((scope) => scope.id === scopeId)?.name ?? `${scopeId}（已停用）`;
}

/** 空清單是「全部門市／地區」；有值才顯示可逐一調整的 scope。 */
export function CalendarScopePicker({ scopeIds, scopes, disabled, onChange }: { scopeIds: string[]; scopes: ScheduleScope[]; disabled?: boolean; onChange: (scopeIds: string[]) => void }) {
  const addScope = () => {
    const next = scopes.find((scope) => !scopeIds.includes(scope.id));
    if (next) onChange([...scopeIds, next.id]);
  };
  const updateScope = (index: number, value: string) => onChange(scopeIds.map((scopeId, currentIndex) => currentIndex === index ? value : scopeId));
  return <div className="hr-calendar-scope-picker">
    {scopeIds.length === 0
      ? <span className="muted">全部門市／地區</span>
      : scopeIds.map((scopeId, index) => <div className="hr-calendar-scope-row" key={`${scopeId}-${index}`}><DropdownSelect value={scopeId} aria-label={`適用門市／地區 ${index + 1}`} disabled={disabled} options={[
        ...scopes.map((scope) => ({ value: scope.id, label: scope.name, disabled: scopeIds.includes(scope.id) && scope.id !== scopeId })),
        ...(scopes.some((scope) => scope.id === scopeId) ? [] : [{ value: scopeId, label: scopeLabel(scopeId, scopes), disabled: true }]),
      ]} onChange={(event) => updateScope(index, event.target.value)} /><Button type="button" variant="icon" icon="trash" aria-label={`移除適用門市 ${scopeLabel(scopeId, scopes)}`} title="移除適用門市／地區" disabled={disabled} onClick={() => onChange(scopeIds.filter((_, currentIndex) => currentIndex !== index))} /></div>)}
    <Button type="button" variant="chip-action" icon="plus" disabled={disabled || scopeIds.length >= scopes.length} onClick={addScope}>{scopeIds.length ? "新增門市／地區" : "指定門市／地區"}</Button>
  </div>;
}

/**
 * 新增一天。日期與類型都自己選，所以補班日就是「選一個星期六、類型選平日」。
 *
 * 沒有另外做一顆「新增補班日」的按鈕：那會變成第二條寫入路徑，而它做的事跟這裡
 * 完全一樣，只是先幫你把類型填成平日。選錯類型是看得見也改得回來的。
 */
function AddDayDialog({ year, existing, scopes, onAdd, onClose }: { year: number; existing: HrCalendarDay[]; scopes: ScheduleScope[]; onAdd: (day: HrCalendarDay) => void; onClose: () => void }) {
  const [date, setDate] = useState(`${year}-01-01`);
  const [dayType, setDayType] = useState<HrDayType>("holiday");
  const [specialKind, setSpecialKind] = useState<HrCalendarSpecialKind>("none");
  const [specialScopeIds, setSpecialScopeIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const closeRequestRef = useRef<(() => void) | null>(null);
  const setSelectedDayType = (value: HrDayType) => {
    setDayType(value);
    if (value !== "weekday") {
      setSpecialKind("none");
      setSpecialScopeIds([]);
      setName((current) => current.trim() === "災防停班" ? "" : current);
    }
  };
  // 選到星期六日時預設改成「平日」；災防停班只允許套用在平日。
  useEffect(() => { setSelectedDayType(isWeekendDate(date) ? "weekday" : "holiday"); }, [date]);
  return <Dialog title={`${year} 年新增日期`} onClose={onClose} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    if (!date.startsWith(`${year}-`)) { setMessage(`請選擇 ${year} 年之內的日期。`); return; }
    if (existing.some((day) => day.date === date)) { setMessage("這一天已經在清單裡了，請直接修改那一列。"); return; }
    const effectiveSpecialKind = dayType === "weekday" ? specialKind : "none";
    onAdd({ date, dayType, name: name.trim() || (effectiveSpecialKind === "typhoon_stop" ? "災防停班" : ""), specialKind: effectiveSpecialKind, specialScopeIds: effectiveSpecialKind === "typhoon_stop" ? specialScopeIds : [], overridden: true });
    (closeRequestRef.current ?? onClose)();
  } }} closeRequestRef={closeRequestRef} actions={<Button type="submit" icon="check">加入</Button>}>
    <TextField label="日期" type="date" required min={`${year}-01-01`} max={`${year}-12-31`} value={date} onChange={(event) => setDate(event.target.value)} />
    <SelectField label="類型" value={dayType} options={HR_DAY_TYPES.map((item) => ({ value: item, label: HR_DAY_TYPE_LABELS[item] }))} onChange={(event) => setSelectedDayType(event.target.value as HrDayType)} />
    {dayType === "weekday" ? <SelectField label="災防標記" value={specialKind} options={HR_CALENDAR_SPECIAL_KINDS.map((item) => ({ value: item, label: HR_CALENDAR_SPECIAL_KIND_LABELS[item] }))} onChange={(event) => { const value = event.target.value as HrCalendarSpecialKind; setSpecialKind(value); if (value !== "typhoon_stop") setSpecialScopeIds([]); if (value === "typhoon_stop" && !name.trim()) setName("災防停班"); if (value !== "typhoon_stop" && name.trim() === "災防停班") setName(""); }} /> : null}
    {dayType === "weekday" && specialKind === "typhoon_stop" ? <div className="field"><span>適用門市／地區</span><small>不指定就是全部門市／地區；指定後只有該範圍的原排班照薪。</small><CalendarScopePicker scopeIds={specialScopeIds} scopes={scopes} onChange={setSpecialScopeIds} /></div> : null}
    <TextField label="備註／名稱" maxLength={100} placeholder="例如：中秋節、補行上班；災防停班可填公告名稱" value={name} onChange={(event) => setName(event.target.value)} />
    {dayType === "weekday" && specialKind === "typhoon_stop" ? <p className="muted field-note">不會刪除原排班；薪資結算會將適用範圍內有排班的人列為「災防停班給薪」。</p> : null}
    {isWeekendDate(date) && dayType === "weekday" ? <p className="muted field-note">這是星期{weekdayOf(date)}，設成平日之後當天沒打卡會算缺勤。</p> : null}
    {!isWeekendDate(date) && dayType === "weekend" ? <p className="muted field-note">這是星期{weekdayOf(date)}，設成週末之後當天不排班也不會算缺勤。</p> : null}
    {message ? <Alert tone="danger">{message}</Alert> : null}
  </Dialog>;
}

function ImportDialog({ year, currentCount, onClose, onDone }: { year: number; currentCount: number; onClose: () => void; onDone: () => Promise<unknown> }) {
  const [message, setMessage] = useState<string | null>(null);
  const run = useHrWrite<{ days: number; holidays: number; makeupWorkdays: number }>();
  const toast = useToast();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const submit = async () => {
    try {
      const result = await run.mutateAsync({ path: `/calendar/years/${year}/import`, method: "POST", values: {} });
      await onDone();
      toast.show(`${year} 年已匯入 ${result.holidays} 天假日、${result.makeupWorkdays} 天補班日。`);
      (closeRequestRef.current ?? onClose)();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "匯入失敗，請稍後再試。");
    }
  };
  return <Dialog
    title={`匯入 ${year} 年行事曆`}
    onClose={onClose}
    closeRequestRef={closeRequestRef}
    closeDisabled={run.isPending}
    actions={<Button loading={run.isPending} onClick={() => { void submit(); }}>開始匯入</Button>}
  >
    <p>會依政府公告的辦公日曆表，把 {year} 年的國定假日與補班日一次帶進來。</p>
    {/* 蓋掉現有資料是不可逆的，所以在按下去之前就要講，而不是成功之後才顯示「已覆蓋」。 */}
    {currentCount > 0
      ? <Alert tone="warning">目前 {year} 年已經有 {currentCount} 筆設定，匯入會全部換掉，包含手動加過的日子。</Alert>
      : null}
    {message ? <Alert tone="danger">{message}</Alert> : null}
  </Dialog>;
}

export function HrCalendar() {
  usePageTitle("行事曆");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:schedule:read");
  const canWrite = permissions.has("hr:schedule:write");
  const [year, setYear] = useState(taipeiYear);
  const [draft, setDraft] = useState<HrCalendarDay[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const calendar = useHrQuery<HrCalendarResponse>(`/calendar/years/${year}`, canRead);
  const save = useHrWrite();
  const toast = useToast();
  const confirmLeave = useConfirmLeave();
  const saved = useMemo(() => sortByDate(calendar.data?.days ?? []), [calendar.data?.days]);
  /*
   * 切年份時留著上一年的資料——但要標成 loading，不能當成新年份的。
   *
   * 不用 keepPreviousData: false 把資料清掉：那會讓 isPending 變回 true，整頁換成
   * skeleton。切一次年份就閃掉整個版面，連年份切換鈕自己都跟著消失，想連按兩下
   * 往回翻根本按不到。改成版面留著、表格淡化並停用（.is-refreshing），跟排班月曆
   * 換月份同一種手感；這段期間會讀錯的數字與按鈕全部擋掉。
   */
  const loading = calendar.isPlaceholderData;

  // 換年份時丟掉草稿：留著的話下一年的畫面會顯示上一年的假日，按儲存就寫到錯的年份。
  useEffect(() => { setDraft(null); setMessage(null); }, [year]);
  useEffect(() => { setDraft(null); }, [calendar.data?.days]);

  const days = draft ?? saved;
  const changed = draft !== null && !sameDays(draft, saved);
  // 講得出「哪一年、現在有幾天」，使用者才知道按下「離開並捨棄」會丟掉什麼。
  useUnsavedChanges(changed, `${year} 年的行事曆改過了還沒儲存，目前有 ${days.length} 天登記。`);
  const update = (date: string, patch: Partial<HrCalendarDay>) => {
    setDraft(sortByDate((draft ?? saved).map((day) => day.date === date ? { ...day, ...patch } : day)));
    setMessage(null);
  };
  const updateDayType = (day: HrCalendarDay, dayType: HrDayType) => {
    update(day.date, dayType === "weekday"
      ? { dayType }
      : { dayType, specialKind: "none", specialScopeIds: [], ...(day.name.trim() === "災防停班" ? { name: "" } : {}) });
  };
  const remove = (date: string) => {
    setDraft(sortByDate((draft ?? saved).filter((day) => day.date !== date)));
    setMessage(null);
  };
  const switchYear = async (delta: number) => {
    if (!(await confirmLeave())) return;
    setYear((current) => current + delta);
  };
  const submit = async () => {
    try {
      // knownDates 是這次載入時伺服器給的那幾天；中間有人改過就會擋下來，不會把對方的修改沖掉。
      await save.mutateAsync({ path: `/calendar/years/${year}`, method: "PUT", values: { days: days.map(({ date, dayType, name, specialKind, specialScopeIds }) => ({ date, dayType, name, specialKind, specialScopeIds })), knownDates: saved.map((day) => day.date) } });
      await calendar.refetch();
      setDraft(null);
      toast.show(`${year} 年行事曆已儲存。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "行事曆儲存失敗，請稍後再試。");
    }
  };

  if (!canRead) return <Alert tone="danger">你沒有檢視行事曆的權限。</Alert>;
  if (calendar.isPending) return <HrPageSkeleton variant="table" />;
  if (calendar.error) return <div className="page"><Alert tone="danger">{calendar.error.message}</Alert></div>;

  const holidays = days.filter((day) => day.dayType === "holiday").length;
  const makeups = days.filter((day) => day.dayType === "weekday" && isWeekendDate(day.date)).length;
  const typhoonStops = days.filter((day) => day.dayType === "weekday" && day.specialKind === "typhoon_stop").length;
  return <div className="page fills">
    <PageHeader
      title="行事曆"
      description="設定國定假日、補班日與災防停班。災防停班只適用平日，不刪除原排班，薪資結算會依原排班保留給薪紀錄；其他未登記日子照星期幾計算。"
      /* 還在載入新年份時一律停用：這三顆的行為都依賴 saved，而 saved 還是上一年的。 */
      actions={canWrite ? <div className="button-row">
        <Button variant="secondary" icon="cloudSync" disabled={save.isPending || loading} onClick={() => setImporting(true)}>匯入政府行事曆</Button>
        <Button variant="secondary" icon="plus" disabled={save.isPending || loading} onClick={() => setAdding(true)}>新增日期</Button>
        <Button loading={save.isPending} disabled={!changed || loading} onClick={() => { void submit(); }}>儲存</Button>
      </div> : undefined}
    />
    <Panel className="grows">
      <div className="hr-calendar-year-bar">
        <div className="hr-schedule-month">
          {/* 換年份跟換月份一樣要先問：草稿會被新資料洗掉，而切換鈕就在清單正上方。 */}
          <Button variant="icon" icon="chevronLeft" aria-label="上一年" onClick={() => void switchYear(-1)} />
          <strong>{year} 年</strong>
          <Button variant="icon" icon="chevronRight" aria-label="下一年" onClick={() => void switchYear(1)} />
        </div>
        {/*
          * 兩個數字分開講：假日有幾天是常識，補班日有沒有漏登才是每年真正會出錯的地方。
          * 載入中時改成破折號而不是繼續顯示舊數字：位置跟寬度都在，版面不會跳，
          * 但不會把上一年的 16 天講成這一年的。
          */}
        <p className="hr-calendar-year-count">國定假日 <strong>{loading ? "—" : holidays}</strong> 天 · 補班日 <strong>{loading ? "—" : makeups}</strong> 天 · 災防停班 <strong>{loading ? "—" : typhoonStops}</strong> 天</p>
        {changed ? <p className="hr-schedule-status"><StatusBadge tone="warning">尚未儲存</StatusBadge><span>按「儲存」才會生效。</span></p> : null}
      </div>
      {message || save.error ? <Alert tone="danger">{message ?? save.error?.message}</Alert> : null}
      <div className={`table-scroll${loading ? " is-refreshing" : ""}`}><table className="data-table"><thead><tr>
        <th>日期</th><th>星期</th><th>日型／災防</th><th>適用門市／地區</th><th>備註／名稱</th><th className="numeric">操作</th>
      </tr></thead><tbody>
        {days.map((day) => {
          const kind = rowKind(day);
          const disasterPrevention = day.dayType === "weekday" && day.specialKind === "typhoon_stop";
          return <tr key={day.date}>
            <td data-label="日期"><span className="cell-strong numeric">{day.date}</span></td>
            <td data-label="星期">{weekdayOf(day.date)}</td>
            <td data-label="日型／災防">
              {canWrite
                ? <div className="hr-calendar-type-fields">
                  <SelectField aria-label={`${day.date} 類型`} value={day.dayType} disabled={save.isPending || loading} options={HR_DAY_TYPES.map((item) => ({ value: item, label: HR_DAY_TYPE_LABELS[item] }))} onChange={(event) => updateDayType(day, event.target.value as HrDayType)} />
                  {day.dayType === "weekday" ? <SelectField aria-label={`${day.date} 災防標記`} value={day.specialKind} disabled={save.isPending || loading} options={HR_CALENDAR_SPECIAL_KINDS.map((item) => ({ value: item, label: HR_CALENDAR_SPECIAL_KIND_LABELS[item] }))} onChange={(event) => { const value = event.target.value as HrCalendarSpecialKind; update(day.date, { specialKind: value, specialScopeIds: value === "typhoon_stop" ? (day.specialScopeIds ?? []) : [], ...(value === "typhoon_stop" && !day.name.trim() ? { name: "災防停班" } : {}), ...(value !== "typhoon_stop" && day.name.trim() === "災防停班" ? { name: "" } : {}) }); }} /> : null}
                </div>
                : <StatusBadge tone={kind.tone}>{kind.label}</StatusBadge>}
              {canWrite && kind.label === "補班日" ? <StatusBadge tone="warning">補班日</StatusBadge> : null}
            </td>
            <td data-label="適用門市／地區">
              {disasterPrevention
                ? canWrite
                  ? <CalendarScopePicker scopeIds={day.specialScopeIds ?? []} scopes={calendar.data?.scopes ?? []} disabled={save.isPending || loading} onChange={(specialScopeIds) => update(day.date, { specialScopeIds })} />
                  : (day.specialScopeIds?.length ? day.specialScopeIds.map((scopeId) => scopeLabel(scopeId, calendar.data?.scopes ?? [])).join("、") : "全部門市／地區")
                : <span className="muted">—</span>}
            </td>
            <td data-label="備註／名稱">
              {canWrite
                ? <TextField aria-label={`${day.date} 名稱`} maxLength={100} placeholder="未命名" value={day.name} disabled={save.isPending || loading} onChange={(event) => update(day.date, { name: event.target.value })} />
                : day.name || <span className="muted">未命名</span>}
            </td>
            <td data-label="操作" className="numeric">
              {canWrite ? <Tooltip label={`移除 ${day.date}`} focusable={false}>
                <Button variant="icon" icon="trash" className="danger" aria-label={`移除 ${day.date}`} disabled={save.isPending || loading} onClick={() => remove(day.date)} />
              </Tooltip> : null}
            </td>
          </tr>;
        })}
      </tbody></table></div>
      {!days.length && !loading ? <p className="muted table-note">{year} 年還沒有登記任何特殊日期。可以按「匯入政府行事曆」一次帶進來，再手動標記災防停班。</p> : null}
    </Panel>
    {adding ? <AddDayDialog year={year} existing={days} scopes={calendar.data?.scopes ?? []} onAdd={(day) => setDraft(sortByDate([...days, day]))} onClose={() => setAdding(false)} /> : null}
    {importing ? <ImportDialog year={year} currentCount={saved.length} onClose={() => setImporting(false)} onDone={() => calendar.refetch()} /> : null}
  </div>;
}
