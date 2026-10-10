import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, hrEmployeeName, isHrAdministrator, writeHrMutation, type HrActor } from "./hr-people.js";
import { insertHrNotification } from "./hr-notifications.js";
import { allocateHrAnnualLeave, listHrAnnualLeaveEntitlements } from "./hr-annual-leave.js";
import { hrAnnualLeaveEntitlements, hrAnnualLeaveLedger, hrLeaveRequests, hrLeaveTypes } from "./schema/hr-payroll.js";
import { hrEmployments } from "./schema/hr-people.js";
import { hrEmploymentAttendanceSettings } from "./schema/hr-attendance.js";
import { hrScheduleEntries, hrScheduleVersions } from "./schema/hr-scheduling.js";
import { formatTaipeiDate, taipeiWallClockToUtc } from "./taipei-time.js";
import { users } from "./schema/auth.js";

const HALF_HOUR_MINUTES = 30;
const MAX_LEAVE_MINUTES = 44_640;
const STANDARD_WORKDAY_START = "09:00:00";
const STANDARD_WORKDAY_END = "18:00:00";
const STANDARD_LUNCH_START = "12:00:00";
const STANDARD_LUNCH_END = "13:00:00";
const displayName = hrEmployeeName;

export interface HrLeaveDurationInput {
  employeeUserId: string;
  /** API 已將使用者選的台北時間轉成 canonical UTC wall-clock。 */
  startsAt: string;
  endsAt: string;
}

export interface HrLeaveRequestInput extends HrLeaveDurationInput {
  leaveTypeId: string;
  reason: string;
  /** 修改待審申請時使用，避免覆寫較新的版本。 */
  revision?: number;
}

export interface HrLeaveRequestCreateOptions {
  /** 後台代登目前直接核准；本人入口省略此選項則保留待審核狀態。 */
  autoApprove?: boolean;
}

interface NormalizedLeaveInterval {
  startsAt: string;
  endsAt: string;
  startsOn: string;
  endsOn: string;
  durationMinutes: number;
}

const requestFields = {
  request: hrLeaveRequests,
  employeeUserId: hrEmployments.employeeUserId,
  employeeNumber: hrEmployments.employeeNumber,
  employeeName: displayName,
  leaveTypeKind: hrLeaveTypes.leaveKind,
};

export interface HrLeaveCredit {
  entitlementId: string;
  periodStart: string;
  periodEnd: string;
  entitledHalfHours: number;
  balanceHalfHours: number;
}

export interface HrSelfLeaveTypeOption {
  id: string;
  name: string;
  leaveKind: "annual" | "other";
  defaultPayRatePpm: number;
  credits: HrLeaveCredit[];
}

function stamp(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new HrError(400, `${label}格式不正確。 `);
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19).replace("T", " ") !== value) throw new HrError(400, `${label}不是有效時間。 `);
  return parsed.getTime();
}

function shiftTaipeiDate(value: string, amount: number) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return formatTaipeiDate(parsed.getTime());
}

function nextTaipeiDate(value: string) {
  return shiftTaipeiDate(value, 1);
}

export function datesBetween(startsOn: string, endsOn: string) {
  const dates: string[] = [];
  for (let date = startsOn; date < endsOn; date = nextTaipeiDate(date)) dates.push(date);
  return dates;
}

function canonicalTaipeiTime(date: string, time: string, label: string) {
  try {
    return stamp(taipeiWallClockToUtc(`${date} ${time}`), label);
  } catch {
    throw new HrError(409, `${label}不正確，請先確認工作時間設定。 `);
  }
}

function canonicalStoredTaipeiTime(value: string, label: string) {
  const [date, time] = value.split(" ");
  if (!date || !time) throw new HrError(409, `${label}不正確，請先確認排班資料。 `);
  return canonicalTaipeiTime(date, time, label);
}

function overlapMinutes(startsAt: number, endsAt: number, rangeStart: number, rangeEnd: number) {
  const start = Math.max(startsAt, rangeStart);
  const end = Math.min(endsAt, rangeEnd);
  return end > start ? (end - start) / 60_000 : 0;
}

export interface HrLeaveWorkdayBreakdown {
  workMinutes: number;
  standardMinutes: number;
}

/** 一般辦公沒有逐日班表時，以公司標準工作時段計算。 */
function calculateStandardWorkdayBreakdown(startsAt: number, endsAt: number, startsOn: string, endsOn: string) {
  const breakdown = new Map<string, HrLeaveWorkdayBreakdown>();
  for (const date of datesBetween(startsOn, endsOn)) {
    const workStart = canonicalTaipeiTime(date, STANDARD_WORKDAY_START, "一般辦公開始時間");
    const workEnd = canonicalTaipeiTime(date, STANDARD_WORKDAY_END, "一般辦公結束時間");
    const lunchStart = canonicalTaipeiTime(date, STANDARD_LUNCH_START, "一般辦公午休開始時間");
    const lunchEnd = canonicalTaipeiTime(date, STANDARD_LUNCH_END, "一般辦公午休結束時間");
    const standardMinutes = overlapMinutes(workStart, workEnd, workStart, workEnd) - overlapMinutes(workStart, workEnd, lunchStart, lunchEnd);
    breakdown.set(date, {
      workMinutes: overlapMinutes(startsAt, endsAt, workStart, workEnd) - overlapMinutes(startsAt, endsAt, lunchStart, lunchEnd),
      standardMinutes,
    });
  }
  return breakdown;
}

type LeaveScheduleRow = {
  periodStart: string;
  periodEnd: string;
  versionNumber: number;
  workDate: string;
  startsAt: string;
  endsAt: string;
  standardMinutes: number;
  breakMinutes: number;
};

async function listPublishedLeaveSchedules(db: Database, employmentId: string, startsOn: string, endsOn: string) {
  const rows = await db.select({
    periodStart: hrScheduleVersions.periodStart,
    periodEnd: hrScheduleVersions.periodEnd,
    versionNumber: hrScheduleVersions.versionNumber,
    workDate: hrScheduleEntries.workDate,
    startsAt: hrScheduleEntries.startsAt,
    endsAt: hrScheduleEntries.endsAt,
    standardMinutes: hrScheduleEntries.standardMinutes,
    breakMinutes: hrScheduleEntries.breakMinutes,
  }).from(hrScheduleEntries)
    .innerJoin(hrScheduleVersions, eq(hrScheduleVersions.id, hrScheduleEntries.scheduleVersionId))
    .where(and(
      eq(hrScheduleEntries.employmentId, employmentId),
      eq(hrScheduleVersions.status, "published"),
      sql`${hrScheduleEntries.workDate} >= ${shiftTaipeiDate(startsOn, -1)}`,
      sql`${hrScheduleEntries.workDate} <= ${endsOn}`,
    ));
  const latestVersion = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.periodStart}:${row.periodEnd}`;
    latestVersion.set(key, Math.max(latestVersion.get(key) ?? 0, row.versionNumber));
  }
  return rows.filter((row) => latestVersion.get(`${row.periodStart}:${row.periodEnd}`) === row.versionNumber) as LeaveScheduleRow[];
}

function scheduleWindow(row: LeaveScheduleRow) {
  const scheduleStart = canonicalStoredTaipeiTime(row.startsAt, "排班開始時間");
  const scheduleEnd = canonicalStoredTaipeiTime(row.endsAt, "排班結束時間");
  if (scheduleEnd <= scheduleStart) throw new HrError(409, "排班結束時間必須晚於開始時間。 ");
  const spanMinutes = (scheduleEnd - scheduleStart) / 60_000;
  const standardMinutes = Math.max(0, Math.min(spanMinutes, row.standardMinutes));
  const breakMinutes = Math.max(0, Math.min(spanMinutes, row.breakMinutes));
  const unpaidMinutes = Math.max(breakMinutes, spanMinutes - standardMinutes);
  let unpaidStart = scheduleStart + ((spanMinutes - unpaidMinutes) * 60_000) / 2;
  if (unpaidMinutes > 0) {
    const [workDate] = row.startsAt.split(" ");
    if (workDate) {
      const lunchStart = canonicalTaipeiTime(workDate, STANDARD_LUNCH_START, "排班午休開始時間");
      if (lunchStart >= scheduleStart && lunchStart + unpaidMinutes * 60_000 <= scheduleEnd) unpaidStart = lunchStart;
    }
  }
  return {
    scheduleStart,
    scheduleEnd,
    unpaidStart,
    unpaidEnd: unpaidStart + unpaidMinutes * 60_000,
    standardMinutes: Math.max(0, spanMinutes - unpaidMinutes),
  };
}

function calculateScheduledWorkdayBreakdown(rows: LeaveScheduleRow[], startsAt: number, endsAt: number) {
  const breakdown = new Map<string, HrLeaveWorkdayBreakdown>();
  for (const row of rows) {
    const window = scheduleWindow(row);
    const current = breakdown.get(row.workDate) ?? { workMinutes: 0, standardMinutes: 0 };
    current.workMinutes += overlapMinutes(startsAt, endsAt, window.scheduleStart, window.scheduleEnd)
      - overlapMinutes(startsAt, endsAt, window.unpaidStart, window.unpaidEnd);
    current.standardMinutes += window.standardMinutes;
    breakdown.set(row.workDate, current);
  }
  return breakdown;
}

async function loadWorkdaySchedules(db: Database, employmentId: string, startsOn: string, endsOn: string) {
  const [setting] = await db.select({ attendanceMode: hrEmploymentAttendanceSettings.attendanceMode })
    .from(hrEmploymentAttendanceSettings)
    .where(eq(hrEmploymentAttendanceSettings.employmentId, employmentId))
    .limit(1);
  const schedules = await listPublishedLeaveSchedules(db, employmentId, startsOn, endsOn);
  return { schedules, scheduled: schedules.length > 0 || setting?.attendanceMode === "scheduled" };
}

async function calculateLeaveWorkdayBreakdown(db: Database, employmentId: string, startsAt: number, endsAt: number, startsOn: string, endsOn: string) {
  const { schedules, scheduled } = await loadWorkdaySchedules(db, employmentId, startsOn, endsOn);
  if (scheduled) return calculateScheduledWorkdayBreakdown(schedules, startsAt, endsAt);
  return calculateStandardWorkdayBreakdown(startsAt, endsAt, startsOn, endsOn);
}

/**
 * 加班的預設起算點與請假時數讀同一份「當天排到幾點」，兩邊對班表的解讀才不會漂移。
 * 排班制沒有班次的日子不會出現在結果裡；一般辦公沒有逐日班表時沿用公司標準下班時間。
 */
export async function listHrWorkdayEnds(db: Database, employmentId: string, startsOn: string, endsOn: string) {
  const { schedules, scheduled } = await loadWorkdaySchedules(db, employmentId, startsOn, endsOn);
  const ends = new Map<string, number>();
  if (!scheduled) {
    for (const date of datesBetween(startsOn, endsOn)) ends.set(date, canonicalTaipeiTime(date, STANDARD_WORKDAY_END, "一般辦公結束時間"));
    return ends;
  }
  for (const row of schedules) {
    if (row.workDate < startsOn || row.workDate >= endsOn) continue;
    ends.set(row.workDate, Math.max(ends.get(row.workDate) ?? 0, scheduleWindow(row).scheduleEnd));
  }
  return ends;
}

export async function calculateHrLeaveWorkdayBreakdown(db: Database, input: { employmentId: string; startsAt: string; endsAt: string; startsOn: string; endsOn: string }) {
  return calculateLeaveWorkdayBreakdown(
    db,
    input.employmentId,
    stamp(input.startsAt, "請假開始時間"),
    stamp(input.endsAt, "請假結束時間"),
    input.startsOn,
    input.endsOn,
  );
}

async function calculateLeaveWorkMinutes(db: Database, employmentId: string, startsAt: number, endsAt: number, startsOn: string, endsOn: string) {
  const breakdown = await calculateLeaveWorkdayBreakdown(db, employmentId, startsAt, endsAt, startsOn, endsOn);
  return [...breakdown.values()].reduce((total, day) => total + day.workMinutes, 0);
}

function normalizeInterval(startsAt: string, endsAt: string): NormalizedLeaveInterval {
  const startMs = stamp(startsAt, "請假開始時間");
  const endMs = stamp(endsAt, "請假結束時間");
  if (endMs <= startMs) throw new HrError(400, "請假結束時間必須晚於開始時間。 ");
  const elapsedMs = endMs - startMs;
  const elapsedMinutes = elapsedMs / 60_000;
  if (!Number.isSafeInteger(elapsedMinutes) || elapsedMinutes > MAX_LEAVE_MINUTES) {
    throw new HrError(400, "請假期間不可超過 31 天。 ");
  }
  const startsOn = formatTaipeiDate(startMs);
  const lastDate = formatTaipeiDate(endMs - 1_000);
  return { startsAt, endsAt, startsOn, endsOn: nextTaipeiDate(lastDate), durationMinutes: elapsedMinutes };
}

async function ensureEmploymentForPeriod(db: Database, employeeUserId: string, _startsOn: string, _endsOn: string) {
  const [employment] = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(
    eq(hrEmployments.employeeUserId, employeeUserId),
    sql`${hrEmployments.archivedAt} IS NULL`,
  )).orderBy(desc(hrEmployments.updatedAt), desc(hrEmployments.id)).limit(1);
  if (!employment) throw new HrError(400, "請假日期不在有效任職期間內。 ");
  return employment.id;
}

async function resolveLeaveInterval(db: Database, input: HrLeaveDurationInput) {
  const normalized = normalizeInterval(input.startsAt, input.endsAt);
  const employmentId = await ensureEmploymentForPeriod(db, input.employeeUserId, normalized.startsOn, normalized.endsOn);
  const durationMinutes = await calculateLeaveWorkMinutes(db, employmentId, stamp(normalized.startsAt, "請假開始時間"), stamp(normalized.endsAt, "請假結束時間"), normalized.startsOn, normalized.endsOn);
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes < HALF_HOUR_MINUTES || durationMinutes % HALF_HOUR_MINUTES !== 0) {
    throw new HrError(400, "請假時數必須依工作日、班表與休息時間計算為 0.5 小時的倍數，且至少 0.5 小時。 ");
  }
  return { employmentId, interval: { ...normalized, durationMinutes } };
}

export async function calculateHrLeaveDuration(db: Database, input: HrLeaveDurationInput) {
  const { interval } = await resolveLeaveInterval(db, input);
  return {
    startsAt: interval.startsAt,
    endsAt: interval.endsAt,
    startsOn: interval.startsOn,
    endsOn: interval.endsOn,
    durationMinutes: interval.durationMinutes,
  };
}

/** 與上面兩個 breakdown 對班表的解讀一致：班次扣掉無薪休息、一般辦公扣掉午休。 */
function leaveWorkSegments(schedules: LeaveScheduleRow[], scheduled: boolean, startsOn: string, endsOn: string) {
  const segments: Array<[number, number]> = scheduled
    ? schedules.flatMap((row) => {
      const window = scheduleWindow(row);
      return [[window.scheduleStart, window.unpaidStart], [window.unpaidEnd, window.scheduleEnd]];
    })
    : datesBetween(startsOn, endsOn).flatMap((date) => [
      [canonicalTaipeiTime(date, STANDARD_WORKDAY_START, "一般辦公開始時間"), canonicalTaipeiTime(date, STANDARD_LUNCH_START, "一般辦公午休開始時間")],
      [canonicalTaipeiTime(date, STANDARD_LUNCH_END, "一般辦公午休結束時間"), canonicalTaipeiTime(date, STANDARD_WORKDAY_END, "一般辦公結束時間")],
    ]);
  return segments.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
}

export interface HrLeaveEndInput {
  employeeUserId: string;
  startsAt: string;
  durationMinutes: number;
}

/**
 * 「從幾點開始請幾小時」反推結束時間。請假時數只算工作時間，所以不能在前端用開始時間直接加：
 * 跨午休、跨班次或跨日時，結束時間會比「開始＋時數」晚。
 */
export async function calculateHrLeaveEnd(db: Database, input: HrLeaveEndInput) {
  if (!Number.isSafeInteger(input.durationMinutes) || input.durationMinutes < HALF_HOUR_MINUTES || input.durationMinutes % HALF_HOUR_MINUTES !== 0) {
    throw new HrError(400, "請假時數必須是 0.5 小時的倍數，且至少 0.5 小時。");
  }
  const startMs = stamp(input.startsAt, "請假開始時間");
  const limitMs = startMs + MAX_LEAVE_MINUTES * 60_000;
  const startsOn = formatTaipeiDate(startMs);
  const endsOn = nextTaipeiDate(formatTaipeiDate(limitMs));
  const employmentId = await ensureEmploymentForPeriod(db, input.employeeUserId, startsOn, endsOn);
  const { schedules, scheduled } = await loadWorkdaySchedules(db, employmentId, startsOn, endsOn);
  let remainingMs = input.durationMinutes * 60_000;
  for (const [segmentStart, segmentEnd] of leaveWorkSegments(schedules, scheduled, startsOn, endsOn)) {
    const from = Math.max(segmentStart, startMs);
    if (segmentEnd <= from) continue;
    const endMs = Math.min(segmentEnd, from + remainingMs);
    remainingMs -= endMs - from;
    if (remainingMs > 0) continue;
    if (endMs > limitMs) break;
    // 回頭用正向的算法再算一次：回傳的時數永遠是送出時會被採用的那個數字。
    return calculateHrLeaveDuration(db, { employeeUserId: input.employeeUserId, startsAt: input.startsAt, endsAt: new Date(endMs).toISOString().slice(0, 19).replace("T", " ") });
  }
  throw new HrError(400, "從這個開始時間起 31 天內的工作時間不足這個時數，請調整開始時間或時數。");
}

function leaveCredit(entitlement: { id: string; periodStart: string; periodEnd: string; entitledHalfHours: number; balanceHalfHours: number }): HrLeaveCredit {
  return {
    entitlementId: entitlement.id,
    periodStart: entitlement.periodStart,
    periodEnd: entitlement.periodEnd,
    entitledHalfHours: entitlement.entitledHalfHours,
    balanceHalfHours: entitlement.balanceHalfHours,
  };
}

export async function listHrSelfLeaveTypeOptions(db: Database, employeeUserId: string, asOfDate?: string): Promise<HrSelfLeaveTypeOption[]> {
  const leaveTypes = await db.select({
    id: hrLeaveTypes.id,
    name: hrLeaveTypes.name,
    leaveKind: hrLeaveTypes.leaveKind,
    defaultPayRatePpm: hrLeaveTypes.defaultPayRatePpm,
  }).from(hrLeaveTypes)
    .where(eq(hrLeaveTypes.active, 1))
    .orderBy(asc(hrLeaveTypes.name));
  if (!leaveTypes.some((leaveType) => leaveType.leaveKind === "annual")) {
    return leaveTypes.map((leaveType) => ({ ...leaveType, credits: [] }));
  }

  const entitlements = await listHrAnnualLeaveEntitlements(db, { employeeUserId, asOfDate });
  const credits = entitlements
    .filter((entitlement) => entitlement.status === "open")
    .map(leaveCredit);
  return leaveTypes.map((leaveType) => ({ ...leaveType, credits: leaveType.leaveKind === "annual" ? credits : [] }));
}

export interface HrSelfAnnualLeavePeriod extends HrLeaveCredit {
  /** 實際請掉的特休；人工調整不算在這裡。 */
  usedHalfHours: number;
  /** 這一期可用的總額度（含人工調整）；恆等於 usedHalfHours + balanceHalfHours。 */
  grantedHalfHours: number;
}

export interface HrSelfLeaveMonths {
  year: number;
  currentYear: number;
  /** 可切換的年份範圍：有已核准請假的最早與最晚年份，至少涵蓋今年。 */
  firstYear: number;
  lastYear: number;
  months: Array<{ month: string; totalMinutes: number; leaveTypes: Array<{ id: string; name: string; minutes: number }> }>;
}

/**
 * 本人「現在」能用的特休週期。請假單的選單是依請假日期找週期，會連尚未開始的下一期一起建出來，
 * 所以這裡要自己把還沒開始、以及已過期但尚未隨薪資結算的週期排除。
 */
export async function listHrSelfAnnualLeave(db: Database, employeeUserId: string, asOfDate = formatTaipeiDate(Date.now())): Promise<HrSelfAnnualLeavePeriod[]> {
  const entitlements = await listHrAnnualLeaveEntitlements(db, { employeeUserId, asOfDate });
  return entitlements
    .filter((entitlement) => entitlement.status === "open" && entitlement.periodStart <= asOfDate && entitlement.periodEnd > asOfDate)
    .map((entitlement) => ({
      ...leaveCredit(entitlement),
      usedHalfHours: entitlement.leaveHalfHours,
      grantedHalfHours: entitlement.balanceHalfHours + entitlement.leaveHalfHours,
    }));
}

type ApprovedLeaveSpan = { employmentId: string; startsAt: string; endsAt: string; startsOn: string; endsOn: string; durationMinutes: number };

/** 依權重把總量切成 unit 的整數倍，餘數給小數部分最大的幾份；總和一定等於 total，不會出現負值。 */
function splitByWeight(total: number, unit: number, weights: readonly number[]) {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map((weight) => total / unit * weight / weightSum);
  const shares = exact.map(Math.floor);
  let leftover = Math.round(total / unit) - shares.reduce((sum, share) => sum + share, 0);
  for (const index of [...exact.keys()].sort((left, right) => (exact[right]! - shares[right]!) - (exact[left]! - shares[left]!))) {
    if (leftover <= 0) break;
    shares[index]! += 1;
    leftover -= 1;
  }
  return shares.map((share) => share * unit);
}

/**
 * durationMinutes 是核准當下凍結的總時數；班表事後可能被改，所以跨月時只拿目前班表決定各月比例，
 * 總和仍等於凍結值。舊資料沒有 startsAt、班表已對不出工時、或日期與班表壞到無法解析時，整筆記在起始月——
 * 這是唯讀的統計，不能因為一筆舊請假的資料壞掉就整頁讀不出來。
 */
async function leaveMinutesByMonth(db: Database, leave: ApprovedLeaveSpan) {
  const firstMonth = leave.startsOn.slice(0, 7);
  const wholeInFirstMonth = new Map([[firstMonth, leave.durationMinutes]]);

  const workMinutes = new Map<string, number>();
  try {
    const lastDate = shiftTaipeiDate(leave.endsOn, -1);
    if (firstMonth === lastDate.slice(0, 7) || !leave.startsAt) return wholeInFirstMonth;
    const breakdown = await calculateLeaveWorkdayBreakdown(db, leave.employmentId, stamp(leave.startsAt, "請假開始時間"), stamp(leave.endsAt, "請假結束時間"), leave.startsOn, leave.endsOn);
    for (const [workDate, day] of breakdown) {
      if (day.workMinutes <= 0) continue;
      // 班表的 workDate 是班次起算日：跨夜班會落在請假開始的前一天，不夾回請假區間的話，
      // 那幾小時會被記到請假還沒開始的月份（跨年時則是哪一年都查不到）。
      const month = (workDate < leave.startsOn ? leave.startsOn : workDate > lastDate ? lastDate : workDate).slice(0, 7);
      workMinutes.set(month, (workMinutes.get(month) ?? 0) + day.workMinutes);
    }
  } catch (error) {
    // 壞掉的日期字串會讓 Intl 丟 RangeError，不是 HrError。
    if (!(error instanceof HrError || error instanceof RangeError)) throw error;
    return wholeInFirstMonth;
  }
  if (!workMinutes.size) return wholeInFirstMonth;

  const months = [...workMinutes.keys()].sort();
  const unit = leave.durationMinutes % HALF_HOUR_MINUTES === 0 ? HALF_HOUR_MINUTES : 1;
  const shares = splitByWeight(leave.durationMinutes, unit, months.map((month) => workMinutes.get(month)!));
  return new Map(months.map((month, index) => [month, shares[index]!] as const));
}

/** 本人指定年度（台北時間，預設今年）各月已核准的請假時數。 */
export async function getHrSelfLeaveMonths(db: Database, employeeUserId: string, options: { year?: number; asOfDate?: string } = {}): Promise<HrSelfLeaveMonths> {
  const currentYear = Number((options.asOfDate ?? formatTaipeiDate(Date.now())).slice(0, 4));
  const year = options.year ?? currentYear;
  const yearPrefix = String(year).padStart(4, "0");
  const ownApproved = and(eq(hrEmployments.employeeUserId, employeeUserId), eq(hrLeaveRequests.status, "approved"));

  const rangeQuery = db.select({
    first: sql<string | null>`min(${hrLeaveRequests.startsOn})`,
    // endsOn 不含當日；只差一天的跨年會多開放一個空年份，比漏掉跨年請假好。
    last: sql<string | null>`max(${hrLeaveRequests.endsOn})`,
  }).from(hrLeaveRequests)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
    .where(ownApproved);

  const leavesQuery = db.select({
    employmentId: hrLeaveRequests.employmentId,
    leaveTypeId: hrLeaveRequests.leaveTypeId,
    leaveTypeSnapshot: hrLeaveRequests.leaveType,
    leaveTypeName: hrLeaveTypes.name,
    startsAt: hrLeaveRequests.startsAt,
    endsAt: hrLeaveRequests.endsAt,
    startsOn: hrLeaveRequests.startsOn,
    endsOn: hrLeaveRequests.endsOn,
    durationMinutes: hrLeaveRequests.durationMinutes,
  }).from(hrLeaveRequests)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
    .leftJoin(hrLeaveTypes, eq(hrLeaveTypes.id, hrLeaveRequests.leaveTypeId))
    .where(and(
      ownApproved,
      // 用當年最後一天當上界，不組「下一年」的字串：9999 的下一年是五位數，字典序比較會反轉。
      sql`${hrLeaveRequests.startsOn} <= ${`${yearPrefix}-12-31`}`,
      sql`${hrLeaveRequests.endsOn} > ${`${yearPrefix}-01-01`}`,
    ));
  const [[range], leaves] = await Promise.all([rangeQuery, leavesQuery]);
  const monthsByLeave = await Promise.all(leaves.map((leave) => leaveMinutesByMonth(db, leave)));

  const byMonth = new Map<string, Map<string, { id: string; name: string; minutes: number }>>();
  for (const [index, leave] of leaves.entries()) {
    // 假別改名後同一個假別仍要算在同一列；只有沒有主檔關聯的舊資料才退回用名稱快照分組。
    const id = leave.leaveTypeId ?? `snapshot:${leave.leaveTypeSnapshot}`;
    for (const [month, minutes] of monthsByLeave[index]!) {
      if (!month.startsWith(yearPrefix) || minutes <= 0) continue;
      const leaveTypes = byMonth.get(month) ?? new Map<string, { id: string; name: string; minutes: number }>();
      const entry = leaveTypes.get(id) ?? { id, name: leave.leaveTypeName ?? leave.leaveTypeSnapshot, minutes: 0 };
      entry.minutes += minutes;
      leaveTypes.set(id, entry);
      byMonth.set(month, leaveTypes);
    }
  }
  const months = [...byMonth.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([month, leaveTypes]) => ({
      month,
      totalMinutes: [...leaveTypes.values()].reduce((sum, leaveType) => sum + leaveType.minutes, 0),
      leaveTypes: [...leaveTypes.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-Hant")),
    }));
  return {
    year,
    currentYear,
    firstYear: Math.min(currentYear, range?.first ? Number(range.first.slice(0, 4)) : currentYear),
    lastYear: Math.max(currentYear, range?.last ? Number(range.last.slice(0, 4)) : currentYear),
    months,
  };
}

export async function listHrLeaveRequests(db: Database, employeeUserId?: string) {
  return db.select(requestFields).from(hrLeaveRequests)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
    .leftJoin(hrLeaveTypes, eq(hrLeaveTypes.id, hrLeaveRequests.leaveTypeId))
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(employeeUserId ? eq(hrEmployments.employeeUserId, employeeUserId) : undefined)
    .orderBy(desc(hrLeaveRequests.startsAt), asc(hrLeaveRequests.createdAt));
}

/** 直屬主管只看到被指定給自己的待審申請；HR 管理者可用 allowAny 進入完整待審匣。 */
export async function listHrLeaveReviewRequests(db: Database, userId: string, allowAny = false) {
  return db.select(requestFields).from(hrLeaveRequests)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
    .leftJoin(hrLeaveTypes, eq(hrLeaveTypes.id, hrLeaveRequests.leaveTypeId))
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(and(eq(hrLeaveRequests.status, "pending"), ne(hrEmployments.employeeUserId, userId), allowAny ? undefined : eq(hrLeaveRequests.approverUserId, userId)))
    .orderBy(asc(hrLeaveRequests.createdAt));
}

async function requestApprover(db: Database, employmentId: string, employeeUserId: string) {
  const [employment] = await db.select({ supervisorUserId: hrEmployments.supervisorUserId }).from(hrEmployments)
    .where(and(eq(hrEmployments.id, employmentId), eq(hrEmployments.employeeUserId, employeeUserId), sql`${hrEmployments.archivedAt} IS NULL`)).limit(1);
  const supervisorUserId = employment?.supervisorUserId;
  if (supervisorUserId && supervisorUserId !== employeeUserId) {
    const [approver] = await db.select({ userId: hrEmployments.employeeUserId }).from(hrEmployments)
      .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
      .where(and(eq(hrEmployments.employeeUserId, supervisorUserId), sql`${hrEmployments.archivedAt} IS NULL`, eq(users.status, "active"))).limit(1);
    if (approver) return approver.userId;
  }
  // 沒有可用直屬主管時送到全平台 HR 管理者；其待審匣本來就可代審所有申請。
  const candidates = await db.select({ userId: users.id }).from(users).where(eq(users.status, "active")).orderBy(asc(users.email));
  for (const candidate of candidates) if (candidate.userId !== employeeUserId && await isHrAdministrator(db, candidate.userId)) return candidate.userId;
  throw new HrError(409, "目前找不到可用的申請審核者，請聯絡 HR 後再送出。");
}

export async function createHrLeaveRequest(db: Database, input: HrLeaveRequestInput, actor: HrActor, options: HrLeaveRequestCreateOptions = {}) {
  if (input.reason.length > 1000) throw new HrError(400, "請假原因不可超過 1000 字。 ");
  const { employmentId, interval } = await resolveLeaveInterval(db, input);
  const [leaveType] = await db.select({
    id: hrLeaveTypes.id,
    name: hrLeaveTypes.name,
    leaveKind: hrLeaveTypes.leaveKind,
    defaultPayRatePpm: hrLeaveTypes.defaultPayRatePpm,
  }).from(hrLeaveTypes).where(and(eq(hrLeaveTypes.id, input.leaveTypeId), eq(hrLeaveTypes.active, 1))).limit(1);
  if (!leaveType) throw new HrError(404, "找不到啟用中的假別。 ");
  const id = crypto.randomUUID();
  const autoApprove = options.autoApprove === true;
  if (autoApprove && input.employeeUserId === actor.id) throw new HrError(409, "申請人不可透過後台直接核准自己的請假申請。 ");
  const status = autoApprove ? "approved" : "pending";
  const payRatePpm = leaveType.defaultPayRatePpm;
  const reviewComment = autoApprove ? "HR 後台建立後直接核准" : null;
  const approverUserId = autoApprove ? null : await requestApprover(db, employmentId, input.employeeUserId);
  // 代登直接核准時，特休必須在同一個週期內有足夠額度；待審申請則在核准當下再檢查。
  const annualAllocation = autoApprove && leaveType.leaveKind === "annual"
    ? await allocateHrAnnualLeave(db, { employmentId, startsOn: interval.startsOn, endsOn: interval.endsOn, durationMinutes: interval.durationMinutes })
    : null;
  const requestStatement = sql`INSERT INTO hr_leave_requests
      (id, employment_id, leave_type_id, leave_type, status, approver_user_id, starts_at, ends_at, starts_on, ends_on, duration_minutes, pay_rate_ppm, reason, reviewed_by, reviewed_at, review_comment, created_by)
      SELECT ${id}, ${employmentId}, ${leaveType.id}, ${leaveType.name}, ${status}, ${approverUserId}, ${interval.startsAt}, ${interval.endsAt}, ${interval.startsOn}, ${interval.endsOn}, ${interval.durationMinutes}, ${payRatePpm}, ${input.reason.trim()}, ${autoApprove ? actor.id : null}, ${autoApprove ? sql`CURRENT_TIMESTAMP` : sql`NULL`}, ${reviewComment}, ${actor.id}
      WHERE EXISTS (
        SELECT 1 FROM hr_employments AS current_employment
        WHERE current_employment.id=${employmentId}
          AND current_employment.employee_user_id=${input.employeeUserId}
          AND current_employment.archived_at IS NULL
      )
        AND NOT EXISTS (
        SELECT 1 FROM hr_leave_requests AS existing_request
        WHERE existing_request.employment_id=${employmentId}
          AND existing_request.status IN ('pending', 'approved')
          AND (
            (existing_request.starts_at <> '' AND existing_request.starts_at < ${interval.endsAt} AND existing_request.ends_at > ${interval.startsAt})
            OR (existing_request.starts_at = '' AND existing_request.starts_on < ${interval.endsOn} AND existing_request.ends_on > ${interval.startsOn})
          )
      ) RETURNING id`;
  const statements = annualAllocation ? [requestStatement, sql`INSERT INTO hr_annual_leave_ledger
      (id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by)
      SELECT ${crypto.randomUUID()}, ${annualAllocation.entitlementId}, 'leave_request', ${-annualAllocation.durationHalfHours}, ${`leave-request:${id}`}, ${id}, '特休申請核准扣除', ${actor.id}
      WHERE EXISTS (SELECT 1 FROM hr_leave_requests WHERE id=${id} AND status='approved')
        AND coalesce((SELECT sum(delta_half_hours) FROM hr_annual_leave_ledger WHERE entitlement_id=${annualAllocation.entitlementId}), 0) >= ${annualAllocation.durationHalfHours}
      RETURNING id`] : requestStatement;
  const mutations = approverUserId && !autoApprove
    ? [...(Array.isArray(statements) ? statements : [statements]), insertHrNotification({
      userId: approverUserId, sourceKey: `leave-request:${id}:submitted`, kind: "request_submitted", entityKind: "leave", entityId: id,
      title: "有新的請假申請待審核", body: `請假期間：${interval.startsOn}～${interval.endsOn}，請開啟待審清單處理。`,
    })]
    : statements;
  try {
    return await writeHrMutation(db, mutations, id, actor, "leave_request_created", "相同員工已有重疊的請假時段、任職期間無效、特休額度不足或資料不合法。 ");
  } catch (error) {
    if (error instanceof HrError) throw error;
    if (error instanceof Error && /UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed/.test(error.message)) throw new HrError(409, "相同員工已有重疊的請假時段、任職期間無效、特休額度不足或資料不合法。 ");
    throw error;
  }
}

/** 待審請假可以由申請人修改；每次修改都會增加 revision，避免手機畫面覆蓋較新的資料。 */
export async function updateHrLeaveRequest(db: Database, id: string, input: HrLeaveRequestInput, actor: HrActor) {
  if (input.revision === undefined) throw new HrError(400, "請提供申請版本，並重新整理後操作。 ");
  if (input.reason.length > 1000) throw new HrError(400, "請假原因不可超過 1000 字。 ");
  const [current] = await db.select({
    employeeUserId: hrEmployments.employeeUserId,
    employmentId: hrLeaveRequests.employmentId,
    status: hrLeaveRequests.status,
    revision: hrLeaveRequests.revision,
    approverUserId: hrLeaveRequests.approverUserId,
    archivedAt: hrEmployments.archivedAt,
  }).from(hrLeaveRequests).innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId)).where(eq(hrLeaveRequests.id, id)).limit(1);
  if (!current) throw new HrError(404, "找不到請假申請。 ");
  if (current.employeeUserId !== actor.id) throw new HrError(404, "找不到可修改的請假申請。 ");
  if (current.status !== "pending") throw new HrError(409, "只有待審核的請假申請可以修改。 ");
  if (current.revision !== input.revision) throw new HrError(409, "請假申請不存在或版本已過期，請重新整理。 ");
  if (current.archivedAt) throw new HrError(409, "員工任職已結束，無法修改請假申請。 ");
  const resolved = await resolveLeaveInterval(db, { employeeUserId: actor.id, startsAt: input.startsAt, endsAt: input.endsAt });
  if (resolved.employmentId !== current.employmentId) throw new HrError(409, "請假日期不在原任職期間內，請重新整理後再試。 ");
  const [leaveType] = await db.select({ id: hrLeaveTypes.id, name: hrLeaveTypes.name, defaultPayRatePpm: hrLeaveTypes.defaultPayRatePpm })
    .from(hrLeaveTypes).where(and(eq(hrLeaveTypes.id, input.leaveTypeId), eq(hrLeaveTypes.active, 1))).limit(1);
  if (!leaveType) throw new HrError(404, "找不到啟用中的假別。 ");

  const nextRevision = current.revision + 1;
  const update = sql`UPDATE hr_leave_requests SET
    leave_type_id=${leaveType.id}, leave_type=${leaveType.name}, pay_rate_ppm=${leaveType.defaultPayRatePpm},
    starts_at=${resolved.interval.startsAt}, ends_at=${resolved.interval.endsAt}, starts_on=${resolved.interval.startsOn}, ends_on=${resolved.interval.endsOn},
    duration_minutes=${resolved.interval.durationMinutes}, reason=${input.reason.trim()},
    reviewed_by=NULL, reviewed_at=NULL, review_comment=NULL, revision=${nextRevision}
    WHERE id=${id} AND employment_id=${current.employmentId} AND status='pending' AND revision=${input.revision}
      AND NOT EXISTS (
        SELECT 1 FROM hr_leave_requests AS existing_request
        WHERE existing_request.id <> ${id}
          AND existing_request.employment_id=${current.employmentId}
          AND existing_request.status IN ('pending', 'approved')
          AND (
            (existing_request.starts_at <> '' AND existing_request.starts_at < ${resolved.interval.endsAt} AND existing_request.ends_at > ${resolved.interval.startsAt})
            OR (existing_request.starts_at = '' AND existing_request.starts_on < ${resolved.interval.endsOn} AND existing_request.ends_on > ${resolved.interval.startsOn})
          )
      ) RETURNING id`;
  const mutations = current.approverUserId ? [update, insertHrNotification({
    userId: current.approverUserId, sourceKey: `leave-request:${id}:updated:${nextRevision}`, kind: "request_submitted", entityKind: "leave", entityId: id,
    title: "請假申請已更新，請重新審核", body: `申請人已更新 ${resolved.interval.startsOn}～${resolved.interval.endsOn} 的請假申請。`,
  })] : update;
  return writeHrMutation(db, mutations, id, actor, "leave_request_updated", "請假申請已變更、時段重疊或資料不合法，請重新整理。 ");
}

export interface HrLeaveCancellationOptions {
  /** 管理端可代為取消；本人入口只能取消自己建立的申請。 */
  allowAny?: boolean;
}

export async function cancelHrLeaveRequest(db: Database, id: string, actor: HrActor, options: HrLeaveCancellationOptions = {}) {
  const [current] = await db.select({
    employeeUserId: hrEmployments.employeeUserId,
    status: hrLeaveRequests.status,
    approverUserId: hrLeaveRequests.approverUserId,
  }).from(hrLeaveRequests)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
    .where(eq(hrLeaveRequests.id, id)).limit(1);
  if (!current) throw new HrError(404, "找不到請假申請。 ");
  if (!options.allowAny && current.employeeUserId !== actor.id) throw new HrError(404, "找不到可取消的請假申請。 ");
  if (current.status !== "pending" && current.status !== "approved") throw new HrError(409, "請假申請不存在或已完成處理。 ");

  const update = sql`UPDATE hr_leave_requests SET
    status='cancelled', reviewed_by=${actor.id}, reviewed_at=CURRENT_TIMESTAMP, review_comment='申請已取消'
    WHERE id=${id} AND status=${current.status} RETURNING id`;
  if (current.status === "pending") {
    const mutations = current.approverUserId ? [update, insertHrNotification({
      userId: current.approverUserId, sourceKey: `leave-request:${id}:cancelled`, kind: "request_cancelled", entityKind: "leave", entityId: id,
      title: "請假申請已取消", body: "申請人已取消一筆待審請假申請。",
    })] : update;
    return writeHrMutation(db, mutations, id, actor, "leave_request_cancelled", "請假申請已變更或完成處理，請重新整理。 ");
  }

  const [usage] = await db.select({
    entitlementId: hrAnnualLeaveLedger.entitlementId,
    deltaHalfHours: hrAnnualLeaveLedger.deltaHalfHours,
    entitlementStatus: hrAnnualLeaveEntitlements.status,
  }).from(hrAnnualLeaveLedger)
    .innerJoin(hrAnnualLeaveEntitlements, eq(hrAnnualLeaveEntitlements.id, hrAnnualLeaveLedger.entitlementId))
    .where(and(
      eq(hrAnnualLeaveLedger.leaveRequestId, id),
      eq(hrAnnualLeaveLedger.entryKind, "leave_request"),
    )).limit(1);
  if (usage?.entitlementStatus === "settled") throw new HrError(409, "特休已隨薪資結算，請使用薪資調整處理取消或更正。 ");
  const [reversal] = await db.select({ id: hrAnnualLeaveLedger.id }).from(hrAnnualLeaveLedger)
    .where(eq(hrAnnualLeaveLedger.sourceKey, `leave-request-cancel:${id}`)).limit(1);
  if (!usage || reversal) return writeHrMutation(db, update, id, actor, "leave_request_cancelled", "請假申請已變更或完成處理，請重新整理。 ");

  return writeHrMutation(db, [update, sql`INSERT INTO hr_annual_leave_ledger
    (id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by)
    SELECT ${crypto.randomUUID()}, ${usage.entitlementId}, 'settlement_reversal', ${-usage.deltaHalfHours}, ${`leave-request-cancel:${id}`}, ${id}, '取消已核准特休，返還原扣除額度', ${actor.id}
    WHERE EXISTS (SELECT 1 FROM hr_leave_requests WHERE id=${id} AND status='cancelled')
      AND EXISTS (SELECT 1 FROM hr_annual_leave_entitlements WHERE id=${usage.entitlementId} AND status='open' AND settled_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM hr_annual_leave_ledger WHERE source_key=${`leave-request-cancel:${id}`})
    RETURNING id`], id, actor, "leave_request_cancelled", "請假申請已變更、額度反向紀錄已存在或無法取消，請重新整理。 ");
}

export async function reviewHrLeaveRequest(db: Database, id: string, decision: "approved" | "rejected" | "cancelled", comment: string, actor: HrActor, options: { allowAny?: boolean } = {}) {
  if (!comment.trim() && decision === "rejected") throw new HrError(400, "駁回請假申請時必須填寫審核意見。 ");
  if (comment.length > 1000) throw new HrError(400, "審核意見不可超過 1000 字。 ");
  const [current] = await db.select({
    employeeUserId: hrEmployments.employeeUserId,
    employmentId: hrLeaveRequests.employmentId,
    status: hrLeaveRequests.status,
    approverUserId: hrLeaveRequests.approverUserId,
    leaveKind: hrLeaveTypes.leaveKind,
    startsOn: hrLeaveRequests.startsOn,
    endsOn: hrLeaveRequests.endsOn,
    durationMinutes: hrLeaveRequests.durationMinutes,
  }).from(hrLeaveRequests)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrLeaveRequests.employmentId))
    .leftJoin(hrLeaveTypes, eq(hrLeaveTypes.id, hrLeaveRequests.leaveTypeId))
    .where(eq(hrLeaveRequests.id, id)).limit(1);
  if (!current) throw new HrError(404, "找不到請假申請。 ");
  if (current.employeeUserId === actor.id) throw new HrError(409, "申請人不可審核自己的請假申請。 ");
  if (!options.allowAny && current.approverUserId !== actor.id) throw new HrError(404, "找不到指定給你的待審請假申請。 ");
  if (current.status !== "pending") throw new HrError(409, "請假申請不存在或已完成處理。 ");
  if (decision === "approved") {
    if (!current.employeeUserId) throw new HrError(409, "支援人員不能使用正式員工請假流程。 ");
    await ensureEmploymentForPeriod(db, current.employeeUserId, current.startsOn, current.endsOn);
  }
  const annualAllocation = decision === "approved" && current.leaveKind === "annual"
    ? await allocateHrAnnualLeave(db, {
      employmentId: current.employmentId,
      startsOn: current.startsOn,
      endsOn: current.endsOn,
      durationMinutes: current.durationMinutes,
    })
    : null;
  const updateStatement = sql`UPDATE hr_leave_requests SET
    status=${decision}, reviewed_by=${actor.id}, reviewed_at=CURRENT_TIMESTAMP, review_comment=${comment.trim()}
    WHERE id=${id} AND status='pending'
      AND EXISTS (
        SELECT 1 FROM hr_employments
        WHERE id=hr_leave_requests.employment_id
          AND employee_user_id <> ${actor.id}
      )
    RETURNING id`;
  const statements = annualAllocation ? [sql`INSERT INTO hr_annual_leave_ledger
    (id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by)
    SELECT ${crypto.randomUUID()}, ${annualAllocation.entitlementId}, 'leave_request', ${-annualAllocation.durationHalfHours}, ${`leave-request:${id}`}, ${id}, '特休申請核准扣除', ${actor.id}
    WHERE EXISTS (
        SELECT 1 FROM hr_leave_requests AS request
        INNER JOIN hr_employments AS employment ON employment.id=request.employment_id
        WHERE request.id=${id}
          AND request.status='pending'
          AND employment.employee_user_id <> ${actor.id}
      )
      AND coalesce((SELECT sum(delta_half_hours) FROM hr_annual_leave_ledger WHERE entitlement_id=${annualAllocation.entitlementId}), 0) >= ${annualAllocation.durationHalfHours}
    RETURNING id`, updateStatement] : updateStatement;
  const mutations = current.employeeUserId
    ? [...(Array.isArray(statements) ? statements : [statements]), insertHrNotification({
      userId: current.employeeUserId, sourceKey: `leave-request:${id}:reviewed:${decision}`, kind: "request_reviewed", entityKind: "leave", entityId: id,
      title: decision === "approved" ? "請假申請已核准" : decision === "rejected" ? "請假申請已駁回" : "請假申請已取消",
      body: comment.trim() || (decision === "approved" ? "你的請假申請已完成核准。" : "請開啟申請紀錄查看處理結果。"),
    })]
    : Array.isArray(statements) ? statements : [statements];
  return writeHrMutation(db, mutations, id, actor, "leave_request_reviewed", "請假申請不存在、申請人不可自審、特休額度不足或已完成處理。 ");
}
