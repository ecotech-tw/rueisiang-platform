import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, EmptyState, Page, Panel, SegmentedControl, SelectField } from "../../ui/index.js";
import { useHrQuery } from "./api.js";
import { HrBackBar } from "./HrBackBar.js";
import { SchedulePersonRow } from "./SchedulePersonRow.js";

type PersonalSchedule = {
  periodKey: string;
  attendanceMode: "general" | "scheduled";
  monthlyRestDays: number | null;
  scopes: Array<{ id: string; name: string }>;
  calendar: Array<{ date: string; dayType: "weekday" | "weekend" | "holiday"; name: string }>;
  scheduleManagers: Array<{ scopeId: string; name: string | null }>;
  entries: Array<{ workDate: string; scopeId: string; scopeName: string; personKind: "employee" | "worker"; personName: string; shiftName: string; startsAt: string; endsAt: string; isMine: boolean }>;
};

function taipeiMonth() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}`;
}

function shiftMonth(periodKey: string, amount: number) {
  const [year = 0, month = 1] = periodKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function timeOnly(value: string) {
  return value.slice(11, 16);
}

function dayTypeLabel(dayType: PersonalSchedule["calendar"][number]["dayType"]) {
  return dayType === "holiday" ? "國定假日" : dayType === "weekend" ? "週末" : "平日";
}

const VIEW_OPTIONS = [
  { value: "calendar", label: "月曆檢視", icon: "grid" },
  { value: "summary", label: "班表摘要", icon: "list" },
] as const;

export function HrMySchedule() {
  usePageTitle("我的排班");
  const navigate = useNavigate();
  const { user } = useSession();
  const worker = user?.hrSelfServiceKind === "worker";
  const [month, setMonth] = useState(taipeiMonth);
  const [monthDirection, setMonthDirection] = useState<-1 | 0 | 1>(0);
  const [monthEntered, setMonthEntered] = useState(true);
  const [scopeId, setScopeId] = useState("all");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [view, setView] = useState<"calendar" | "summary">("calendar");
  const query = useHrQuery<PersonalSchedule>(`/me/my-schedules?periodKey=${month}&scopeId=${encodeURIComponent(scopeId)}`, true, true);
  const data = query.data;
  const days = data?.calendar ?? [];
  const entries = data?.entries ?? [];
  const ownEntries = entries.filter((entry) => entry.isMine).sort((left, right) => left.workDate.localeCompare(right.workDate) || left.startsAt.localeCompare(right.startsAt));
  const selectedEntries = selectedDate ? entries.filter((entry) => entry.workDate === selectedDate) : [];
  const selectedCalendarDay = days.find((day) => day.date === selectedDate);
  const offset = days.length ? new Date(`${days[0]!.date}T00:00:00Z`).getUTCDay() : 0;
  const managerByScope = new Map((data?.scheduleManagers ?? []).map((manager) => [manager.scopeId, manager.name]));
  useEffect(() => {
    if (monthDirection === 0) { setMonthEntered(true); return; }
    setMonthEntered(false);
    const frame = requestAnimationFrame(() => setMonthEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [month, monthDirection]);

  return <Page layout="fills" className="min-w-0 gap-3 [&>*+*]:!mt-0">
    <HrBackBar label={worker ? "返回打卡" : "返回工作"} onBack={() => navigate(worker ? "/clock" : "/work")} />
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(120px,220px)] items-center gap-3">
      <h1 className="m-0 text-xl">我的排班</h1>
      <SelectField aria-label="據點範圍" value={scopeId} disabled={!data?.scopes.length} options={[{ value: "all", label: "全部據點" }, ...(data?.scopes ?? []).map((scope) => ({ value: scope.id, label: scope.name }))]} onChange={(event) => setScopeId(event.target.value)} />
    </div>
    <Panel density="compact" className="grid gap-2">
      <div className="flex items-center gap-1" aria-label="排班月份">
        <Button variant="icon" icon="chevronLeft" aria-label="上個月" onClick={() => { setMonthDirection(-1); setMonth((value) => shiftMonth(value, -1)); }} />
        <strong className="flex-1 text-center text-sm tabular-nums">{month.slice(0, 4)} 年 {Number(month.slice(5))} 月</strong>
        <Button variant="icon" icon="chevronRight" aria-label="下個月" onClick={() => { setMonthDirection(1); setMonth((value) => shiftMonth(value, 1)); }} />
        <SegmentedControl aria-label="班表檢視方式" skin="outlined" iconOnly options={VIEW_OPTIONS} value={view} onChange={(value) => { if (value === "calendar" || value === "summary") setView(value); }} className="shrink-0" />
      </div>
    </Panel>
    {query.isPending ? <Panel aria-busy="true"><p className="m-0 text-sm text-muted">載入本人排班中…</p></Panel> : null}
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    {data ? <div className={`flex min-h-0 min-w-0 flex-1 flex-col transition-[opacity,translate] duration-150 ease-out motion-reduce:transition-none ${monthEntered ? "translate-x-0 opacity-100" : `${monthDirection > 0 ? "translate-x-2" : "-translate-x-2"} opacity-0`}`}>
      {data.scopes.length === 0 ? <EmptyState>目前沒有可查看的所屬據點或排班。</EmptyState> : view === "calendar" ? <Panel density="compact">
        <div className="grid grid-cols-7 text-center text-xs text-muted" aria-hidden="true">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}</div>
        <div className="mt-1 grid grid-cols-7 gap-0.5">
          {Array.from({ length: offset }, (_, index) => <div aria-hidden="true" key={`empty-${index}`} />)}
          {days.map((day) => {
            const dateEntries = entries.filter((entry) => entry.workDate === day.date);
            const mine = dateEntries.filter((entry) => entry.isMine);
            const aria = `${day.date}，${mine.length ? `本人 ${mine.map((entry) => `${entry.scopeName} ${entry.shiftName} ${timeOnly(entry.startsAt)}`).join("、")}` : "本人未排班"}，當日共 ${dateEntries.length} 人次，點擊查看值班人員`;
            const background = mine.length ? "bg-brand-soft ring-1 ring-inset ring-brand-dark" : dateEntries.length ? "bg-tone-peach/15" : day.dayType !== "weekday" ? "bg-canvas" : "";
            return <div key={day.date} className="relative min-w-0 border-t border-soft-line">
              <button type="button" aria-label={aria} aria-pressed={selectedDate === day.date} onClick={() => setSelectedDate(day.date)} className={`relative grid min-h-11 w-full min-w-0 place-items-center rounded-field border-0 text-sm font-semibold tabular-nums transition-[background-color,color,scale] duration-150 ease-out enabled:hover:bg-brand/7 enabled:active:scale-[.96] focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-secondary motion-reduce:transition-none motion-reduce:enabled:active:scale-100 ${background} ${day.dayType === "weekday" ? "text-ink" : "text-brand-dark"} ${selectedDate === day.date ? "ring-1 ring-inset ring-brand-dark" : ""}`}>
                {Number(day.date.slice(8))}
                {dateEntries.length ? <span aria-hidden="true" className="absolute bottom-0 right-0 rounded-full bg-brand-soft px-1 text-[9px] font-semibold leading-3 text-brand-dark">{dateEntries.length}</span> : null}
              </button>
            </div>;
          })}
        </div>
      </Panel> : <section aria-labelledby="my-schedule-list-title" className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 id="my-schedule-list-title" className="m-0 text-base font-semibold">本人班表</h2>
          <span className="text-xs text-muted">本月 {ownEntries.length} 班{data.attendanceMode === "scheduled" && data.monthlyRestDays !== null ? `・約定月休 ${data.monthlyRestDays} 天` : ""}</span>
        </div>
        {ownEntries.length ? <Panel density="compact" className="flex min-h-0 flex-1 flex-col overflow-hidden"><ul className="m-0 grid min-h-0 flex-1 list-none divide-y divide-soft-line overflow-y-auto overscroll-contain p-0">
          {ownEntries.map((entry, index) => <li key={`${entry.workDate}-${entry.scopeId}-${entry.shiftName}-${index}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0">
            <strong className="row-span-2 min-w-[58px] text-sm tabular-nums">{Number(entry.workDate.slice(5, 7))}/{Number(entry.workDate.slice(8))}</strong>
            <span className="min-w-0 text-sm font-medium">{entry.scopeName}・{entry.shiftName}</span>
            <span className="col-start-2 text-xs text-muted">{timeOnly(entry.startsAt)}–{timeOnly(entry.endsAt)}</span>
          </li>)}
        </ul></Panel> : <EmptyState>{data.attendanceMode === "general" ? "本月尚無本人排班；未列排班不代表休假，請依一般出勤規則出勤。" : "這個月尚無本人排班。"}</EmptyState>}
      </section>}
    </div> : null}
    {selectedCalendarDay ? <Dialog title={`${selectedCalendarDay.date} 值班人員`} titleMeta={selectedCalendarDay.name || dayTypeLabel(selectedCalendarDay.dayType)} bodyLayout="grid gap-2 px-6 pb-2" onClose={() => setSelectedDate(null)} actions={<Button size="lg" onClick={() => setSelectedDate(null)}>關閉</Button>}>
      {selectedEntries.length ? <div className="grid divide-y divide-soft-line">
        {selectedEntries.map((entry, index) => <SchedulePersonRow key={`${entry.scopeId}-${entry.personName}-${entry.shiftName}-${index}`}
          title={entry.personName}
          details={`${entry.scopeName}・${entry.shiftName}・${timeOnly(entry.startsAt)}–${timeOnly(entry.endsAt)}`}
          highlighted={entry.isMine}
          trailing={entry.isMine ? <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand-dark">本人</span> : undefined}
        />)}
      </div> : <EmptyState className="mt-[18px]">當天沒有排班。</EmptyState>}
      {selectedEntries.length ? <div className="grid gap-1 border-t border-soft-line pt-3 text-xs text-muted">
        <strong className="font-medium text-ink">排班負責人</strong>
        {[...new Set(selectedEntries.map((entry) => entry.scopeId))].map((id) => <span key={id}>{selectedEntries.find((entry) => entry.scopeId === id)?.scopeName}：{managerByScope.get(id) ?? "未指定"}</span>)}
      </div> : null}
    </Dialog> : null}
  </Page>;
}
