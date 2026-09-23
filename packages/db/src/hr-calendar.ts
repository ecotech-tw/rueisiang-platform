import { and, asc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { HrError, type HrActor } from "./hr-people.js";
import { hrCalendarDayScopes, hrCalendarDays, HR_CALENDAR_SPECIAL_KINDS, type HrCalendarSpecialKind, type HrDayType } from "./schema/hr-scheduling.js";
import { scopes } from "./schema/reports.js";

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_TYPES = ["weekday", "weekend", "holiday"] as const;

export const HR_DAY_TYPE_LABELS: Record<HrDayType, string> = { weekday: "平日", weekend: "週末", holiday: "國定假日" };

export function isHrDayType(value: unknown): value is HrDayType {
  return typeof value === "string" && (DAY_TYPES as readonly string[]).includes(value);
}

export function isHrCalendarSpecialKind(value: unknown): value is HrCalendarSpecialKind {
  return typeof value === "string" && (HR_CALENDAR_SPECIAL_KINDS as readonly string[]).includes(value);
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
  specialKind: HrCalendarSpecialKind;
  /** 空陣列代表所有門市／地區；有值時只套用到指定 scope。 */
  specialScopeIds: string[];
  /** 這天有沒有被行事曆蓋過。前端用它區分「排定的國定假日」與「星期幾推出來的週末」。 */
  overridden: boolean;
}

function toView(date: string, override: { dayType: HrDayType; name: string; specialKind: HrCalendarSpecialKind; specialScopeIds: string[] } | undefined): HrCalendarDayView {
  return override
    ? { date, dayType: override.dayType, name: override.name, specialKind: override.specialKind, specialScopeIds: override.specialScopeIds, overridden: true }
    : { date, dayType: defaultDayType(date), name: "", specialKind: "none", specialScopeIds: [], overridden: false };
}

/** 半開區間 [start, endExclusive)，與 periodFromKey 的期間定義一致。 */
async function loadOverrides(db: Database, start: string, endExclusive: string) {
  return selectOverrides(db, and(gte(hrCalendarDays.date, start), lt(hrCalendarDays.date, endExclusive)));
}

/** 閉區間 [first, last]，給「這幾天各是什麼」這種問法用。 */
async function loadOverridesInclusive(db: Database, first: string, last: string) {
  return selectOverrides(db, and(gte(hrCalendarDays.date, first), lte(hrCalendarDays.date, last)));
}

async function selectOverrides(db: Database, where: ReturnType<typeof and>) {
  const rows = await db.select({ date: hrCalendarDays.date, dayType: hrCalendarDays.dayType, name: hrCalendarDays.name, specialKind: hrCalendarDays.specialKind })
    .from(hrCalendarDays)
    .where(where)
    .orderBy(asc(hrCalendarDays.date));
  const scopeRows = rows.length
    ? await db.select({ date: hrCalendarDayScopes.date, scopeId: hrCalendarDayScopes.scopeId })
      .from(hrCalendarDayScopes)
      .where(inArray(hrCalendarDayScopes.date, rows.map((row) => row.date)))
      .orderBy(asc(hrCalendarDayScopes.date), asc(hrCalendarDayScopes.scopeId))
    : [];
  const scopeIdsByDate = new Map<string, string[]>();
  for (const row of scopeRows) scopeIdsByDate.set(row.date, [...(scopeIdsByDate.get(row.date) ?? []), row.scopeId]);
  return new Map(rows.map((row) => [row.date, { dayType: row.dayType, name: row.name, specialKind: row.specialKind, specialScopeIds: scopeIdsByDate.get(row.date) ?? [] }]));
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
  const overrides = await loadOverridesInclusive(db, first, last);
  return new Map(wanted.map((date) => [date, overrides.get(date)?.dayType ?? defaultDayType(date)]));
}

/** 颱風停班是行事曆的薪資標記，不改變「這天是平日／週末／國定假日」的日型。 */
export interface HrCalendarSpecial {
  kind: HrCalendarSpecialKind;
  /** 空陣列代表全域；有值時只適用指定門市／地區。 */
  scopeIds: string[];
}

export async function resolveCalendarSpecials(db: Database, dates: string[]): Promise<Map<string, HrCalendarSpecial>> {
  const wanted = [...new Set(dates)].sort();
  const first = wanted[0];
  const last = wanted[wanted.length - 1];
  if (!first || !last) return new Map();
  const overrides = await loadOverridesInclusive(db, first, last);
  return new Map(wanted.map((date) => [date, {
    kind: overrides.get(date)?.specialKind ?? "none",
    scopeIds: overrides.get(date)?.specialScopeIds ?? [],
  }]));
}

export async function resolveCalendarSpecialKinds(db: Database, dates: string[]): Promise<Map<string, HrCalendarSpecialKind>> {
  const specials = await resolveCalendarSpecials(db, dates);
  return new Map([...specials].map(([date, special]) => [date, special.kind]));
}

export function calendarSpecialAppliesToScope(special: HrCalendarSpecial | undefined, scopeId: string | null | undefined) {
  return special?.kind === "typhoon_stop" && (special.scopeIds.length === 0 || (scopeId !== null && scopeId !== undefined && special.scopeIds.includes(scopeId)));
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
  specialKind?: HrCalendarSpecialKind;
  specialScopeIds?: string[];
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
    const specialKind = day.specialKind ?? "none";
    if (!isHrCalendarSpecialKind(specialKind)) throw new HrError(400, "行事曆的特殊標記不正確。 ");
    const rawSpecialScopeIds = day.specialScopeIds ?? [];
    if (!Array.isArray(rawSpecialScopeIds)) throw new HrError(400, "颱風停班的適用門市／地區不正確。 ");
    const specialScopeIds = [...new Set(rawSpecialScopeIds)].sort();
    if (specialScopeIds.length > 100 || specialScopeIds.some((scopeId) => typeof scopeId !== "string" || scopeId.trim() === "" || scopeId.length > 200)) throw new HrError(400, "颱風停班的適用門市／地區不正確。 ");
    if (specialKind !== "typhoon_stop" && specialScopeIds.length) throw new HrError(400, "適用門市／地區只能套用於颱風停班。 ");
    const name = day.name.trim();
    if (name.length > 100) throw new HrError(400, "行事曆的名稱過長。 ");
    if (day.dayType === defaultDayType(day.date) && !name && specialKind === "none") continue;
    overrides.push({ ...day, name, specialKind, specialScopeIds });
  }
  return overrides;
}

/**
 * 儲存前先確認這段期間還是呼叫端當初讀到的樣子。
 *
 * 這張表沒有單一一列可以掛 revision，所以拿「例外日期的清單」當版本：前端讀到哪幾天，
 * 存的時候就把那幾天送回來。清單對不上就代表中間有人改過。
 *
 * 需要這道關卡是因為這裡的語意是「刪掉整段再寫回去」——lost update 賠掉的不是一個欄位
 * 而是一整年：A 打開 2026 加了三天，B 拿著舊的清單刪掉一天後才存，A 那三天會無聲消失。
 * 沒送 knownDates 的呼叫端（匯入）本來就打算整段換掉，不套用這個檢查。
 */
async function assertCalendarUnchanged(db: Database, range: { start: string; end: string }, knownDates?: string[]) {
  if (!knownDates) return;
  const current = [...(await loadOverrides(db, range.start, range.end)).keys()].sort();
  const known = [...new Set(knownDates)].sort();
  if (current.length !== known.length || current.some((date, index) => date !== known[index])) {
    throw new HrError(409, "行事曆已被其他人修改，請重新整理後再存。 ");
  }
}

/**
 * 一段期間的行事曆整段換掉：先刪乾淨再寫進例外。月儲存與整年匯入共用這一支。
 *
 * 刪掉整段而不是逐日比對，是因為「取消一個假日」跟「沒送這一天」在資料上要是同一件事；
 * 兩種語意分開的話，前端少送一天就會留下一列刪不掉的舊假日。
 */
async function assertCalendarScopesExist(db: Database, overrides: HrCalendarDayInput[]) {
  const scopeIds = [...new Set(overrides.flatMap((day) => day.specialScopeIds ?? []))];
  if (!scopeIds.length) return;
  const existing = await db.select({ id: scopes.id }).from(scopes).where(and(inArray(scopes.id, scopeIds), eq(scopes.scopeKind, "store")));
  if (existing.length !== scopeIds.length) throw new HrError(400, "颱風停班的適用門市／地區不存在。 ");
}

async function replaceCalendarRange(db: Database, range: { start: string; end: string }, overrides: HrCalendarDayInput[], actor: HrActor, summary: string, payload: Record<string, unknown>, knownDates?: string[]) {
  await assertCalendarUnchanged(db, range, knownDates);
  await assertCalendarScopesExist(db, overrides);
  const row = activityRow({ entityType: "hr_schedule", entityId: range.start, source: "hr", eventType: "calendar_saved", summary, actor, payload });
  const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
  const statements = [
    sql`DELETE FROM hr_calendar_day_scopes WHERE date >= ${range.start} AND date < ${range.end}`,
    sql`DELETE FROM hr_calendar_days WHERE date >= ${range.start} AND date < ${range.end}`,
    ...overrides.map((day) => sql`INSERT INTO hr_calendar_days (date, day_type, name, special_kind, updated_by) VALUES (${day.date}, ${day.dayType}, ${day.name}, ${day.specialKind ?? "none"}, ${actor.id})`),
    ...overrides.flatMap((day) => (day.specialScopeIds ?? []).map((scopeId) => sql`INSERT INTO hr_calendar_day_scopes (date, scope_id) VALUES (${day.date}, ${scopeId})`)),
    sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email, payload_json)
      VALUES (${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail}, ${row.payloadJson})`,
  ].map((statement) => dialect.sqlToQuery(statement));
  await db.$client.batch(statements.map((compiled) => db.$client.prepare(compiled.sql).bind(...compiled.params)));
}

/** 存一整個月的行事曆。送進來的是該月的完整清單。 */
export async function saveHrCalendarMonth(db: Database, period: { start: string; end: string }, days: HrCalendarDayInput[], knownDates: string[] | undefined, actor: HrActor) {
  if (days.length > 31) throw new HrError(400, "行事曆一次只能儲存一個月。 ");
  const overrides = toOverrides(days, period);
  await replaceCalendarRange(db, period, overrides, actor, `${period.start.slice(0, 7)} 行事曆已更新`, { days: overrides.length }, knownDates);
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
export async function saveHrCalendarYear(db: Database, year: number, days: HrCalendarDayInput[], knownDates: string[] | undefined, actor: HrActor) {
  const range = yearRange(year);
  if (days.length > 366) throw new HrError(400, "行事曆一次只能儲存一年。 ");
  const overrides = toOverrides(days, range);
  await replaceCalendarRange(db, range, overrides, actor, `${year} 年行事曆已更新`, { year, days: overrides.length }, knownDates);
  return { year, days: overrides.length };
}

/** 政府行事曆的一天。來源是外部資料，只當資料讀，不當指令。 */
interface GovCalendarDay {
  date: string;
  isHoliday: boolean;
  description: string;
}

export const HR_CALENDAR_SOURCE_URL = "https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data";

const GOV_CALENDAR_GENERIC_DESCRIPTIONS = new Set(["補假", "放假", "調整放假", "補行上班", "調整上班"]);
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function addDays(date: string, amount: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function dateDistance(first: string, second: string) {
  return Math.abs(Date.parse(`${first}T00:00:00Z`) - Date.parse(`${second}T00:00:00Z`)) / MILLISECONDS_PER_DAY;
}

/**
 * 政府資料把補假原因獨立寫成「補假」，但同一段連假裡的週末節日才是原本的假日。
 * 先找有名稱的週末節日，再退回最近的有名稱假日，才能處理連假中間隔著其他假日的情況。
 */
function govHolidayReason(date: string, source: ReadonlyMap<string, GovCalendarDay>) {
  const nearby: Array<{ date: string; description: string }> = [];
  for (const direction of [-1, 1]) {
    let cursor = addDays(date, direction);
    while (source.get(cursor)?.isHoliday) {
      const rawDescription = source.get(cursor)?.description;
      const description = typeof rawDescription === "string" ? rawDescription.trim() : "";
      if (description && !GOV_CALENDAR_GENERIC_DESCRIPTIONS.has(description)) nearby.push({ date: cursor, description });
      cursor = addDays(cursor, direction);
    }
  }
  const weekendHolidays = nearby.filter((day) => defaultDayType(day.date) === "weekend");
  const candidates = weekendHolidays.length ? weekendHolidays : nearby;
  candidates.sort((a, b) => dateDistance(a.date, date) - dateDistance(b.date, date) || a.date.localeCompare(b.date));
  return candidates[0]?.description;
}

function normalizedGovCalendar(year: number, source: readonly GovCalendarDay[]) {
  const range = yearRange(year);
  const days = new Map<string, GovCalendarDay>();
  for (const day of source) {
    /*
     * isHoliday 也要驗型別，不能只看 truthiness。來源是第三方鏡像，萬一哪天變成字串
     * "false"，每一天都 truthy，整年非週末的日子全會被寫成國定假日（約 250 列）——
     * 之後全公司整年的出勤讀成「休息」、日支項目整年不發，而且哪裡都不會報錯。
     */
    if (typeof day?.date !== "string" || !/^\d{8}$/.test(day.date)) continue;
    if (typeof day.isHoliday !== "boolean") continue;
    const date = `${day.date.slice(0, 4)}-${day.date.slice(4, 6)}-${day.date.slice(6, 8)}`;
    if (date < range.start || date >= range.end || days.has(date)) continue;
    days.set(date, day);
  }
  return days;
}

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
  const sourceDays = normalizedGovCalendar(year, source);
  const overrides: HrCalendarDayInput[] = [];
  for (const [date, day] of sourceDays) {
    const fallback = defaultDayType(date);
    const dayType: HrDayType = day.isHoliday ? "holiday" : "weekday";
    // 放假的週六日、上班的平日都跟預設值一樣，存下去只會把這張表撐成 365 列。
    if (day.isHoliday && fallback === "weekend") continue;
    if (!day.isHoliday && fallback === "weekday") continue;
    const description = typeof day.description === "string" ? day.description.trim().slice(0, 100) : "";
    const reason = description === "補假" ? govHolidayReason(date, sourceDays) : undefined;
    const name = reason ? `${reason}補假`.slice(0, 100) : description;
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
