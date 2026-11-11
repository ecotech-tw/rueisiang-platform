import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, EmptyState, Page, Panel, SelectField } from "../../ui/index.js";
import { useHrQuery } from "./api.js";
import { HrBackBar } from "./HrBackBar.js";

type PersonalSchedule = {
  periodKey: string;
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

export function HrMySchedule() {
  usePageTitle("我的排班");
  const navigate = useNavigate();
  const { user } = useSession();
  const worker = user?.hrSelfServiceKind === "worker";
  const [month, setMonth] = useState(taipeiMonth);
  const [scopeId, setScopeId] = useState("all");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [showAllShifts, setShowAllShifts] = useState(false);
  const query = useHrQuery<PersonalSchedule>(`/me/my-schedules?periodKey=${month}&scopeId=${encodeURIComponent(scopeId)}`);
  const data = query.data;
  const days = data?.calendar ?? [];
  const entries = data?.entries ?? [];
  const ownEntries = entries.filter((entry) => entry.isMine).sort((left, right) => left.workDate.localeCompare(right.workDate) || left.startsAt.localeCompare(right.startsAt));
  const visibleOwnEntries = showAllShifts ? ownEntries : ownEntries.slice(0, 4);
  const selectedEntries = selectedDate ? entries.filter((entry) => entry.workDate === selectedDate) : [];
  const selectedCalendarDay = days.find((day) => day.date === selectedDate);
  const offset = days.length ? new Date(`${days[0]!.date}T00:00:00Z`).getUTCDay() : 0;
  const managerByScope = new Map((data?.scheduleManagers ?? []).map((manager) => [manager.scopeId, manager.name]));
  useEffect(() => { setShowAllShifts(false); }, [month, scopeId]);

  return <Page className="grid min-w-0 content-start gap-3 [&>*+*]:!mt-0">
    <HrBackBar label={worker ? "返回打卡" : "返回工作"} onBack={() => navigate(worker ? "/clock" : "/work")} />
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(120px,220px)] items-center gap-3">
      <h1 className="m-0 text-xl">我的排班</h1>
      <SelectField aria-label="據點範圍" value={scopeId} disabled={!data?.scopes.length} options={[{ value: "all", label: "全部據點" }, ...(data?.scopes ?? []).map((scope) => ({ value: scope.id, label: scope.name }))]} onChange={(event) => setScopeId(event.target.value)} />
    </div>
    <Panel density="compact" className="grid gap-2">
      <div className="flex items-center gap-1" aria-label="排班月份">
        <Button variant="icon" icon="chevronLeft" aria-label="上個月" onClick={() => setMonth((value) => shiftMonth(value, -1))} />
        <strong className="flex-1 text-center text-sm tabular-nums">{month.slice(0, 4)} 年 {Number(month.slice(5))} 月</strong>
        <Button variant="icon" icon="chevronRight" aria-label="下個月" onClick={() => setMonth((value) => shiftMonth(value, 1))} />
      </div>
    </Panel>
    {query.isPending ? <Panel aria-busy="true"><p className="m-0 text-sm text-muted">載入本人排班中…</p></Panel> : null}
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    {data ? <>
      {data.scopes.length === 0 ? <EmptyState>目前沒有可查看的所屬據點或排班。</EmptyState> : <Panel density="compact">
        <div className="grid grid-cols-7 text-center text-xs text-muted" aria-hidden="true">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span key={day}>{day}</span>)}</div>
        <div className="mt-1 grid grid-cols-7 gap-0.5">
          {Array.from({ length: offset }, (_, index) => <div aria-hidden="true" key={`empty-${index}`} />)}
          {days.map((day) => {
            const dateEntries = entries.filter((entry) => entry.workDate === day.date);
            const mine = dateEntries.filter((entry) => entry.isMine);
            const aria = `${day.date}，${mine.length ? `本人 ${mine.map((entry) => `${entry.scopeName} ${entry.shiftName} ${timeOnly(entry.startsAt)}`).join("、")}` : "本人未排班"}，當日共 ${dateEntries.length} 人次`;
            return <button key={day.date} type="button" aria-label={aria} aria-pressed={selectedDate === day.date} onClick={() => setSelectedDate(day.date)} className={`grid min-h-14 min-w-0 content-start justify-items-start gap-0.5 rounded-field border border-transparent p-1 text-left text-xs transition-[background-color,border-color] duration-150 ease-out hover:bg-brand/7 focus-visible:outline-2 focus-visible:outline-secondary motion-reduce:transition-none ${mine.length ? "bg-brand-soft text-brand-dark" : "bg-canvas text-ink"} ${selectedDate === day.date ? "border-brand-dark" : ""}`}>
              <span className="font-semibold tabular-nums">{Number(day.date.slice(8))}</span>
              {mine.slice(0, 1).map((entry, index) => <span key={`${entry.scopeId}-${entry.shiftName}-${index}`} className="w-full truncate text-[10px] font-medium">本人・{entry.shiftName}</span>)}
              {mine.length > 1 ? <span className="text-[10px]">另 {mine.length - 1} 班</span> : null}
              {dateEntries.length ? <span className="text-[10px] text-muted">{dateEntries.length} 人次</span> : null}
            </button>;
          })}
        </div>
      </Panel>}
      <section aria-labelledby="my-schedule-list-title" className="grid gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 id="my-schedule-list-title" className="m-0 text-base font-semibold">本人班表</h2>
          <span className="text-xs text-muted">本月 {ownEntries.length} 班</span>
        </div>
        {ownEntries.length ? <Panel density="compact"><ul className="m-0 grid list-none divide-y divide-soft-line p-0">
          {visibleOwnEntries.map((entry, index) => <li key={`${entry.workDate}-${entry.scopeId}-${entry.shiftName}-${index}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0">
            <strong className="row-span-2 min-w-[58px] text-sm tabular-nums">{Number(entry.workDate.slice(5, 7))}/{Number(entry.workDate.slice(8))}</strong>
            <span className="min-w-0 text-sm font-medium">{entry.scopeName}・{entry.shiftName}</span>
            <span className="col-start-2 text-xs text-muted">{timeOnly(entry.startsAt)}–{timeOnly(entry.endsAt)}</span>
          </li>)}
        </ul></Panel> : <EmptyState>這個月尚無本人排班。</EmptyState>}
        {ownEntries.length > 4 ? <Button variant="secondary" aria-expanded={showAllShifts} onClick={() => setShowAllShifts((value) => !value)}>{showAllShifts ? "收合班表" : `顯示全部 ${ownEntries.length} 班`}</Button> : null}
      </section>
    </> : null}
    {selectedCalendarDay ? <Dialog title={`${selectedCalendarDay.date} 值班人員`} titleMeta={selectedCalendarDay.name || undefined} onClose={() => setSelectedDate(null)} actions={<Button size="lg" onClick={() => setSelectedDate(null)}>關閉</Button>}>
      {selectedEntries.length ? <div className="grid divide-y divide-soft-line">
        {selectedEntries.map((entry, index) => <div key={`${entry.scopeId}-${entry.personName}-${entry.shiftName}-${index}`} className={`grid gap-1 py-3 first:pt-0 last:pb-0 ${entry.isMine ? "rounded-field bg-brand-soft px-3" : ""}`}>
          <strong className="text-sm">{entry.personName}{entry.isMine ? "（本人）" : ""}</strong>
          <span className="text-xs text-muted">{entry.scopeName}・{entry.shiftName}・{timeOnly(entry.startsAt)}–{timeOnly(entry.endsAt)}</span>
        </div>)}
      </div> : <EmptyState>當天沒有排班。</EmptyState>}
      <div className="mt-3 grid gap-1 border-t border-soft-line pt-3 text-xs text-muted">
        <strong className="font-medium text-ink">排班負責人</strong>
        {[...new Set(selectedEntries.map((entry) => entry.scopeId))].map((id) => <span key={id}>{selectedEntries.find((entry) => entry.scopeId === id)?.scopeName}：{managerByScope.get(id) ?? "未指定"}</span>)}
      </div>
    </Dialog> : null}
  </Page>;
}
