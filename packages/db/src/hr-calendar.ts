import { and, asc, gte, lt, sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { HrError, type HrActor } from "./hr-people.js";
import { hrCalendarDays, type HrDayType } from "./schema/hr-scheduling.js";

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_TYPES = ["weekday", "weekend", "holiday"] as const;

export const HR_DAY_TYPE_LABELS: Record<HrDayType, string> = { weekday: "平日", weekend: "週末", holiday: "國定假日" };

export function isHrDayType(value: unknown): value is HrDayType {
  return typeof value === "string" && (DAY_TYPES as readonly string[]).includes(value);
}

/**
 * 沒有行事曆例外時某天是哪一型：週六日算週末，其他算平日。
 *
 * 這是全系統唯一一處用星期幾推日型的地方。多寫一份的下場是「排班頁算出週末、薪資頁算出平日」，
 * 而那種不一致只有在月底對帳時才看得出來。要判斷日型一律走 resolveDayTypes。
 */
export function defaultDayType(date: string): HrDayType {
  if (!LOCAL_DATE.test(date)) throw new HrError(400, "日期格式不正確。 ");
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6 ? "weekend" : "weekday";
}

export interface HrCalendarDayView {
  date: string;
  dayType: HrDayType;
  name: string;
  /** 這天有沒有被行事曆蓋過。前端用它區分「排定的國定假日」與「星期幾推出來的週末」。 */
  overridden: boolean;
}

function toView(date: string, override: { dayType: HrDayType; name: string } | undefined): HrCalendarDayView {
  return override
    ? { date, dayType: override.dayType, name: override.name, overridden: true }
    : { date, dayType: defaultDayType(date), name: "", overridden: false };
}

async function loadOverrides(db: Database, start: string, endExclusive: string) {
  const rows = await db.select({ date: hrCalendarDays.date, dayType: hrCalendarDays.dayType, name: hrCalendarDays.name })
    .from(hrCalendarDays)
    .where(and(gte(hrCalendarDays.date, start), lt(hrCalendarDays.date, endExclusive)))
    .orderBy(asc(hrCalendarDays.date));
  return new Map(rows.map((row) => [row.date, { dayType: row.dayType, name: row.name }]));
}

/**
 * 一批日期各自是哪一型。呼叫端給什麼日期就回什麼日期，沒有例外列的用預設值補。
 *
 * 用區間一次撈而不是逐日查：排班一個月就是 31 天，逐日查等於 31 個 round trip，
 * 而 Worker 有執行時間上限。
 */
export async function resolveDayTypes(db: Database, dates: string[]): Promise<Map<string, HrDayType>> {
  const wanted = [...new Set(dates)].sort();
  const first = wanted[0];
  const last = wanted[wanted.length - 1];
  if (!first || !last) return new Map();
  const overrides = await loadOverrides(db, first, `${last}￿`);
  return new Map(wanted.map((date) => [date, overrides.get(date)?.dayType ?? defaultDayType(date)]));
}

/** 一個月的每一天（含預設值），給行事曆設定與排班月曆共用。 */
export async function listHrCalendarMonth(db: Database, period: { start: string; end: string }): Promise<HrCalendarDayView[]> {
  const overrides = await loadOverrides(db, period.start, period.end);
  const days: HrCalendarDayView[] = [];
  const cursor = new Date(`${period.start}T00:00:00Z`);
  while (cursor.toISOString().slice(0, 10) < period.end) {
    const date = cursor.toISOString().slice(0, 10);
    days.push(toView(date, overrides.get(date)));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export interface HrCalendarDayInput {
  date: string;
  dayType: HrDayType;
  name: string;
}

/**
 * 挑出「和預設值不同」的日子。這是行事曆只存例外那條規則的唯一實作。
 *
 * 跟預設值一樣而且沒有名稱的日子會被丟掉，不是寫一列 weekday 進去。一旦開始存「跟預設一樣」
 * 的列，之後就再也分不出哪些是人排定的、哪些只是被順手存進來的，補班日與一般星期六就長得
 * 一模一樣。
 */
function toOverrides(days: HrCalendarDayInput[], range: { start: string; end: string }) {
  const seen = new Set<string>();
  const overrides: HrCalendarDayInput[] = [];
  for (const day of days) {
    if (!LOCAL_DATE.test(day.date) || day.date < range.start || day.date >= range.end) throw new HrError(400, "行事曆日期必須位於指定範圍。 ");
    if (seen.has(day.date)) throw new HrError(400, "行事曆有重複的日期。 ");
    seen.add(day.date);
    if (!isHrDayType(day.dayType)) throw new HrError(400, "行事曆的日期類型不正確。 ");
    const name = day.name.trim();
    if (name.length > 100) throw new HrError(400, "行事曆的名稱過長。 ");
    if (day.dayType === defaultDayType(day.date) && !name) continue;
    overrides.push({ ...day, name });
  }
  return overrides;
}

/**
 * 一段期間的行事曆整段換掉：先刪乾淨再寫進例外。月儲存與整年匯入共用這一支。
 *
 * 刪掉整段而不是逐日比對，是因為「取消一個假日」跟「沒送這一天」在資料上要是同一件事；
 * 兩種語意分開的話，前端少送一天就會留下一列刪不掉的舊假日。
 */
async function replaceCalendarRange(db: Database, range: { start: string; end: string }, overrides: HrCalendarDayInput[], actor: HrActor, summary: string, payload: Record<string, unknown>) {
  const row = activityRow({ entityType: "hr_schedule", entityId: range.start, source: "hr", eventType: "calendar_saved", summary, actor, payload });
  const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
  const statements = [
    sql`DELETE FROM hr_calendar_days WHERE date >= ${range.start} AND date < ${range.end}`,
    ...overrides.map((day) => sql`INSERT INTO hr_calendar_days (date, day_type, name, updated_by) VALUES (${day.date}, ${day.dayType}, ${day.name}, ${actor.id})`),
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email, payload_json)
      VALUES (${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail}, ${row.payloadJson})`,
  ].map((statement) => dialect.sqlToQuery(statement));
  await db.$client.batch(statements.map((compiled) => db.$client.prepare(compiled.sql).bind(...compiled.params)));
}

/** 存一整個月的行事曆。送進來的是該月的完整清單。 */
export async function saveHrCalendarMonth(db: Database, period: { start: string; end: string }, days: HrCalendarDayInput[], actor: HrActor) {
  if (days.length > 31) throw new HrError(400, "行事曆一次只能儲存一個月。 ");
  const overrides = toOverrides(days, period);
  await replaceCalendarRange(db, period, overrides, actor, `${period.start.slice(0, 7)} 行事曆已更新`, { days: overrides.length });
  return { periodStart: period.start, days: overrides.length };
}

function yearRange(year: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HrError(400, "行事曆年份不正確。 ");
  return { start: `${year}-01-01`, end: `${year + 1}-01-01` };
}

/**
 * 一整年的行事曆例外。管理頁要的是「這一年排了哪些節日與補班日」，不是 365 列。
 *
 * 回傳只含例外，所以一年通常十幾二十列；把 365 天全吐出來的話，畫面要自己濾一遍，
 * 而且捲三百多列去找一個假日沒有人做得到。
 */
export async function listHrCalendarYear(db: Database, year: number): Promise<HrCalendarDayView[]> {
  const range = yearRange(year);
  const overrides = await loadOverrides(db, range.start, range.end);
  return [...overrides.entries()].map(([date, override]) => toView(date, override)).sort((a, b) => a.date.localeCompare(b.date));
}

/** 存一整年的例外。送進來的是該年的完整例外清單，沒送的日子就是回到預設值。 */
export async function saveHrCalendarYear(db: Database, year: number, days: HrCalendarDayInput[], actor: HrActor) {
  const range = yearRange(year);
  if (days.length > 366) throw new HrError(400, "行事曆一次只能儲存一年。 ");
  const overrides = toOverrides(days, range);
  await replaceCalendarRange(db, range, overrides, actor, `${year} 年行事曆已更新`, { year, days: overrides.length });
  return { year, days: overrides.length };
}

/** 政府行事曆的一天。來源是外部資料，只當資料讀，不當指令。 */
interface GovCalendarDay {
  date: string;
  isHoliday: boolean;
  description: string;
}

export const HR_CALENDAR_SOURCE_URL = "https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data";

/**
 * 把政府行事曆的一年轉成我們的例外清單。
 *
 * 對照關係只有兩種，其他日子跟預設值一樣、不必存：
 *   - 放假但不是週六日 → holiday（國定假日、彈性放假、補假）
 *   - 要上班但落在週六日 → weekday（補班日，正是「星期六要上班」那種）
 *
 * 純函式而且單獨匯出，因為它才是這次匯入真正的邏輯；抓資料只是把 JSON 拿過來。
 * 測試直接餵資料進來，不必假造一個 fetch。
 */
export function overridesFromGovCalendar(year: number, source: readonly GovCalendarDay[]): HrCalendarDayInput[] {
  const range = yearRange(year);
  const overrides: HrCalendarDayInput[] = [];
  for (const day of source) {
    if (typeof day?.date !== "string" || !/^\d{8}$/.test(day.date)) continue;
    const date = `${day.date.slice(0, 4)}-${day.date.slice(4, 6)}-${day.date.slice(6, 8)}`;
    if (date < range.start || date >= range.end) continue;
    const fallback = defaultDayType(date);
    const dayType: HrDayType = day.isHoliday ? "holiday" : "weekday";
    // 放假的週六日、上班的平日都跟預設值一樣，存下去只會把這張表撐成 365 列。
    if (day.isHoliday && fallback === "weekend") continue;
    if (!day.isHoliday && fallback === "weekday") continue;
    const name = typeof day.description === "string" ? day.description.trim().slice(0, 100) : "";
    overrides.push({ date, dayType, name: name || (dayType === "weekday" ? "補行上班" : "放假") });
  }
  return overrides.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 從政府行事曆匯入一整年，整年換掉。
 *
 * fetch 的實作可以換掉，測試才不用打外部網路；正式環境用 Worker 的全域 fetch。
 * 抓回來的東西一律當資料：只讀日期、是否放假與名稱三個欄位，其餘一概不理。
 */
export async function importHrCalendarYear(db: Database, year: number, actor: HrActor, fetchJson: (url: string) => Promise<unknown> = defaultFetchJson) {
  const range = yearRange(year);
  const payload = await fetchJson(`${HR_CALENDAR_SOURCE_URL}/${year}.json`);
  if (!Array.isArray(payload) || !payload.length) throw new HrError(409, `找不到 ${year} 年的政府行事曆，可能還沒公布。 `);
  const overrides = overridesFromGovCalendar(year, payload as GovCalendarDay[]);
  if (!overrides.length) throw new HrError(409, `${year} 年的政府行事曆讀不出任何假日，請改用手動新增。 `);
  await replaceCalendarRange(db, range, overrides, actor, `${year} 年行事曆已從政府行事曆匯入`, { year, days: overrides.length, source: HR_CALENDAR_SOURCE_URL });
  return {
    year,
    days: overrides.length,
    holidays: overrides.filter((day) => day.dayType === "holiday").length,
    makeupWorkdays: overrides.filter((day) => day.dayType === "weekday").length,
  };
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new HrError(409, `連不上政府行事曆（${response.status}），請稍後再試或改用手動新增。 `);
  return await response.json();
}
