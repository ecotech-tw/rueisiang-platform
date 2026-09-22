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
 * 存一整個月的行事曆。送進來的是該月的完整清單，這裡只把「和預設值不同的」寫成列。
 *
 * 跟預設值一樣而且沒有名稱的日子會被刪掉，不是寫一列 weekday 進去。行事曆只存例外是這張表
 * 的前提（見 schema 的註解）：一旦開始存「跟預設一樣」的列，之後就再也分不出哪些是人排定的、
 * 哪些只是被順手存進來的，補班日與一般星期六就長得一模一樣。
 */
export async function saveHrCalendarMonth(db: Database, period: { start: string; end: string }, days: HrCalendarDayInput[], actor: HrActor) {
  if (days.length > 31) throw new HrError(400, "行事曆一次只能儲存一個月。 ");
  const seen = new Set<string>();
  const overrides: HrCalendarDayInput[] = [];
  for (const day of days) {
    if (!LOCAL_DATE.test(day.date) || day.date < period.start || day.date >= period.end) throw new HrError(400, "行事曆日期必須位於指定月份。 ");
    if (seen.has(day.date)) throw new HrError(400, "行事曆有重複的日期。 ");
    seen.add(day.date);
    if (!isHrDayType(day.dayType)) throw new HrError(400, "行事曆的日期類型不正確。 ");
    const name = day.name.trim();
    if (name.length > 100) throw new HrError(400, "行事曆的名稱過長。 ");
    if (day.dayType === defaultDayType(day.date) && !name) continue;
    overrides.push({ ...day, name });
  }
  const row = activityRow({ entityType: "hr_schedule", entityId: period.start, source: "hr", eventType: "calendar_saved", summary: `${period.start.slice(0, 7)} 行事曆已更新`, actor, payload: { days: overrides.length } });
  const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
  const statements = [
    sql`DELETE FROM hr_calendar_days WHERE date >= ${period.start} AND date < ${period.end}`,
    ...overrides.map((day) => sql`INSERT INTO hr_calendar_days (date, day_type, name, updated_by) VALUES (${day.date}, ${day.dayType}, ${day.name}, ${actor.id})`),
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email, payload_json)
      VALUES (${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail}, ${row.payloadJson})`,
  ].map((statement) => dialect.sqlToQuery(statement));
  await db.$client.batch(statements.map((compiled) => db.$client.prepare(compiled.sql).bind(...compiled.params)));
  return { periodStart: period.start, days: overrides.length };
}
