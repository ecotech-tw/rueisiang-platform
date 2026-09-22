import { useEffect, useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, SelectField, StatusBadge, TextField, Tooltip } from "../../ui/index.js";
import { useHrQuery, useHrWrite, HR_DAY_TYPES, HR_DAY_TYPE_LABELS, type HrCalendarDay, type HrCalendarResponse, type HrDayType } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

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
  return day.dayType === "weekday" && isWeekendDate(day.date)
    ? { tone: "warning", label: "補班日" }
    : { tone: "neutral", label: HR_DAY_TYPE_LABELS[day.dayType] };
}

function sortByDate(days: HrCalendarDay[]) {
  return [...days].sort((a, b) => a.date.localeCompare(b.date));
}

function sameDays(a: HrCalendarDay[], b: HrCalendarDay[]) {
  if (a.length !== b.length) return false;
  return a.every((day, index) => day.date === b[index]?.date && day.dayType === b[index]?.dayType && day.name === b[index]?.name);
}

/**
 * 新增一天。日期與類型都自己選，所以補班日就是「選一個星期六、類型選平日」。
 *
 * 沒有另外做一顆「新增補班日」的按鈕：那會變成第二條寫入路徑，而它做的事跟這裡
 * 完全一樣，只是先幫你把類型填成平日。選錯類型是看得見也改得回來的。
 */
function AddDayDialog({ year, existing, onAdd, onClose }: { year: number; existing: HrCalendarDay[]; onAdd: (day: HrCalendarDay) => void; onClose: () => void }) {
  const [date, setDate] = useState(`${year}-01-01`);
  const [dayType, setDayType] = useState<HrDayType>("holiday");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  // 選到星期六日時預設改成「平日」，因為在週末新增一天，想做的幾乎一定是補班。
  useEffect(() => { setDayType(isWeekendDate(date) ? "weekday" : "holiday"); }, [date]);
  return <Dialog title={`${year} 年新增日期`} onClose={onClose} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    if (!date.startsWith(`${year}-`)) { setMessage(`請選擇 ${year} 年之內的日期。`); return; }
    if (existing.some((day) => day.date === date)) { setMessage("這一天已經在清單裡了，請直接修改那一列。"); return; }
    onAdd({ date, dayType, name: name.trim(), overridden: true });
    onClose();
  } }} actions={<Button type="submit" icon="check">加入</Button>}>
    <TextField label="日期" type="date" required min={`${year}-01-01`} max={`${year}-12-31`} value={date} onChange={(event) => setDate(event.target.value)} />
    <SelectField label="這天算哪一種" value={dayType} options={HR_DAY_TYPES.map((item) => ({ value: item, label: HR_DAY_TYPE_LABELS[item] }))} onChange={(event) => setDayType(event.target.value as HrDayType)} />
    <TextField label="名稱" maxLength={100} placeholder="例如：中秋節、補行上班" value={name} onChange={(event) => setName(event.target.value)} />
    {isWeekendDate(date) && dayType === "weekday" ? <p className="muted field-note">這是星期{weekdayOf(date)}，設成平日之後當天沒打卡會算缺勤。</p> : null}
    {!isWeekendDate(date) && dayType === "weekend" ? <p className="muted field-note">這是星期{weekdayOf(date)}，設成週末之後當天不排班也不會算缺勤。</p> : null}
    {message ? <Alert tone="danger">{message}</Alert> : null}
  </Dialog>;
}

function ImportDialog({ year, currentCount, onClose, onDone }: { year: number; currentCount: number; onClose: () => void; onDone: () => Promise<unknown> }) {
  const [message, setMessage] = useState<string | null>(null);
  const run = useHrWrite<{ days: number; holidays: number; makeupWorkdays: number }>();
  const toast = useToast();
  const submit = async () => {
    try {
      const result = await run.mutateAsync({ path: `/calendar/years/${year}/import`, method: "POST", values: {} });
      await onDone();
      toast.show(`${year} 年已匯入 ${result.holidays} 天假日、${result.makeupWorkdays} 天補班日。`);
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "匯入失敗，請稍後再試。");
    }
  };
  return <Dialog
    title={`匯入 ${year} 年行事曆`}
    onClose={onClose}
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
  /*
   * keepPreviousData: false——切年份時留著上一年的資料，畫面會在「2026 年」的標題底下
   * 顯示 2025 的假日，連帶統計、重複檢查與匯入警告全是錯的。api.ts 的註解本來就寫了
   * 「查的是某一筆紀錄時要傳 false」，一個年份就是那種查詢。
   */
  const calendar = useHrQuery<HrCalendarResponse>(`/calendar/years/${year}`, canRead, { keepPreviousData: false });
  const save = useHrWrite();
  const toast = useToast();
  const saved = useMemo(() => sortByDate(calendar.data?.days ?? []), [calendar.data?.days]);

  // 換年份時丟掉草稿：留著的話下一年的畫面會顯示上一年的假日，按儲存就寫到錯的年份。
  useEffect(() => { setDraft(null); setMessage(null); }, [year]);
  useEffect(() => { setDraft(null); }, [calendar.data?.days]);

  const days = draft ?? saved;
  const changed = draft !== null && !sameDays(draft, saved);
  const update = (date: string, patch: Partial<HrCalendarDay>) => {
    setDraft(sortByDate((draft ?? saved).map((day) => day.date === date ? { ...day, ...patch } : day)));
    setMessage(null);
  };
  const remove = (date: string) => {
    setDraft(sortByDate((draft ?? saved).filter((day) => day.date !== date)));
    setMessage(null);
  };
  const submit = async () => {
    try {
      // knownDates 是這次載入時伺服器給的那幾天；中間有人改過就會擋下來，不會把對方的修改沖掉。
      await save.mutateAsync({ path: `/calendar/years/${year}`, method: "PUT", values: { days: days.map(({ date, dayType, name }) => ({ date, dayType, name })), knownDates: saved.map((day) => day.date) } });
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
  return <div className="page fills">
    <PageHeader
      title="行事曆"
      description="只需要登記國定假日與補班日。沒有登記的日子一律照星期幾算：週六日休息、其他上班。"
      actions={canWrite ? <div className="button-row">
        <Button variant="secondary" icon="cloudSync" disabled={save.isPending} onClick={() => setImporting(true)}>匯入政府行事曆</Button>
        <Button variant="secondary" icon="plus" disabled={save.isPending} onClick={() => setAdding(true)}>新增日期</Button>
        <Button loading={save.isPending} disabled={!changed} onClick={() => { void submit(); }}>儲存</Button>
      </div> : undefined}
    />
    <Panel className="grows">
      <div className="hr-calendar-year-bar">
        <div className="hr-schedule-month">
          <Button variant="icon" icon="chevronLeft" aria-label="上一年" onClick={() => setYear((current) => current - 1)} />
          <strong>{year} 年</strong>
          <Button variant="icon" icon="chevronRight" aria-label="下一年" onClick={() => setYear((current) => current + 1)} />
        </div>
        {/* 兩個數字分開講：假日有幾天是常識，補班日有沒有漏登才是每年真正會出錯的地方。 */}
        <p className="hr-calendar-year-count">國定假日 <strong>{holidays}</strong> 天 · 補班日 <strong>{makeups}</strong> 天</p>
        {changed ? <p className="hr-schedule-status"><StatusBadge tone="warning">尚未儲存</StatusBadge><span>按「儲存」才會生效。</span></p> : null}
      </div>
      {message || save.error ? <Alert tone="danger">{message ?? save.error?.message}</Alert> : null}
      <div className="table-scroll"><table className="data-table"><thead><tr>
        <th>日期</th><th>星期</th><th>算哪一種</th><th>名稱</th><th className="numeric">操作</th>
      </tr></thead><tbody>
        {days.map((day) => {
          const kind = rowKind(day);
          return <tr key={day.date}>
            <td data-label="日期"><span className="cell-strong numeric">{day.date}</span></td>
            <td data-label="星期">{weekdayOf(day.date)}</td>
            <td data-label="算哪一種">
              {canWrite
                ? <SelectField aria-label={`${day.date} 算哪一種`} value={day.dayType} disabled={save.isPending} options={HR_DAY_TYPES.map((item) => ({ value: item, label: HR_DAY_TYPE_LABELS[item] }))} onChange={(event) => update(day.date, { dayType: event.target.value as HrDayType })} />
                : <StatusBadge tone={kind.tone}>{kind.label}</StatusBadge>}
              {canWrite && kind.label === "補班日" ? <StatusBadge tone="warning">補班日</StatusBadge> : null}
            </td>
            <td data-label="名稱">
              {canWrite
                ? <TextField aria-label={`${day.date} 名稱`} maxLength={100} placeholder="未命名" value={day.name} disabled={save.isPending} onChange={(event) => update(day.date, { name: event.target.value })} />
                : day.name || <span className="muted">未命名</span>}
            </td>
            <td data-label="操作" className="numeric">
              {canWrite ? <Tooltip label={`移除 ${day.date}`} focusable={false}>
                <Button variant="icon" icon="trash" className="danger" aria-label={`移除 ${day.date}`} disabled={save.isPending} onClick={() => remove(day.date)} />
              </Tooltip> : null}
            </td>
          </tr>;
        })}
      </tbody></table></div>
      {!days.length ? <p className="muted table-note">{year} 年還沒有登記任何假日。可以按「匯入政府行事曆」一次帶進來。</p> : null}
    </Panel>
    {adding ? <AddDayDialog year={year} existing={days} onAdd={(day) => setDraft(sortByDate([...days, day]))} onClose={() => setAdding(false)} /> : null}
    {importing ? <ImportDialog year={year} currentCount={saved.length} onClose={() => setImporting(false)} onDone={() => calendar.refetch()} /> : null}
  </div>;
}
