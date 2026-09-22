import { DEVICE_SESSION_COOKIE, SESSION_COOKIE, can, clearCookie, readCookie } from "@rueisiang/auth";
import {
  HrError, HrInsuranceRateError, HR_ATTENDANCE_LOCATION_PAGE_SIZES, HR_EMPLOYEE_PAGE_SIZES, assignHrEmployee, checkHrClockLocation, createHrAssignment, createHrAttendanceLocation, createHrAttendanceLocationAssignment, createHrClockEvent,
  createHrCompensationVersion, voidHrCompensationVersion, createHrEmployment, createHrFormRequest, createHrInsuranceVersions, endHrAssignment, endHrAttendanceLocationAssignment, endHrEmployment, getHrAttendanceLocation, getHrClockCalendar, getHrClockMapCenters, getHrOverview,
  createHrInsuranceContributionRule, createHrManualInsuranceRateTable, deleteHrInsuranceRateTable, estimateHrInsuranceContributions, fetchHrInsuranceBrackets, getHrClockStatus, getHrEmployee, getHrFormRequest, getHrSelf, listHrInsuranceContributionRules, listHrInsuranceRateTables, syncHrInsuranceRateTables, updateHrInsuranceRateTable, activateHrInsuranceRateTable, setHrAttendanceLocationPrimary, HR_ATTENDANCE_EVENT_PAGE_SIZES, listHrAttendanceEvents,
  isHrAdministrator,
  listHrAttendanceLocations, listHrCandidates, listHrEmployees, listHrFormApprovers, listHrFormRequests,
  listHrScopes, listHrSupervisorCandidates, reviewHrFormRequest,
  assignHrBonusPolicyMember, calculateHrPayroll, closeHrPayrollRun, createHrBonusPolicy, deleteHrBonusPolicy, HR_BONUS_POLICY_PAGE_SIZES, updateHrBonusPolicy, voidHrBonusPolicyVersion, getHrPayrollRun, listHrBonusAssignments, listHrBonusPolicies, listHrPayrollRuns,
  submitHrFormRequest, updateHrAttendanceLocation, updateHrEmployee,
  updateHrEmployeeSupervisor, updateHrEmploymentAttendanceMode, updateHrFormRequest, updateHrAttendanceScope,
  createHrScheduleWorker, createHrShift, deleteHrShift, listHrShifts, updateHrShift, createHrWorkerCompensation, getHrSchedule, HR_SCHEDULE_WORKER_PAGE_SIZES, listHrScheduleWorkers, listHrScheduleWorkersPage, saveHrSchedule, setHrScheduleLock, updateHrScheduleWorker,
  isHrDayType, listHrCalendarMonth, periodFromKey, saveHrCalendarMonth, type HrCalendarDayInput, type HrShiftTime,
  assignHrSpecialWorkdays, createHrSpecialWorkdayRule, createHrSpecialWorkdayRuleVersion, listHrSpecialWorkdayAssignments, listHrSpecialWorkdayRules, setHrSpecialWorkdayRuleActive, voidHrSpecialWorkdayRuleVersion,
  createHrOvertimeRequest, listHrOvertimeRequests, reviewHrOvertimeRequest,
  createHrLeaveType, createHrMonthlyHourly, createHrMonthlyLeave, createHrPayrollAdjustment, listHrLeaveTypes, listHrMonthlyData, listHrPayrollAdjustments, updateHrMonthlyHourly, updateHrMonthlyLeave, updateHrPayrollAdjustment,
  formatTaipeiDate, taipeiWallClockToUtc,
  createDeviceSession, revokeDeviceSession,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { GoogleMapsSearchError, searchGooglePlaces } from "../google-maps.js";
import { DEVICE_COOKIE_PATH, clearDeviceCookie, deviceCookie, requireAnyPermission, requireAuth, requirePermission, requireSelfAuth } from "../middleware/auth.js";
import { sessionUserPayload } from "./auth.js";
import { body, requireString } from "../request.js";

function text(input: Record<string, unknown>, key: string, label: string, max = 100) {
  const value = requireString(input, key, label);
  if (value.length > max) throw new HTTPException(400, { message: `${label}最多 ${max} 字。` });
  return value;
}
function date(input: Record<string, unknown>, key: string, nullable = false): string | null {
  if (nullable && (input[key] === null || input[key] === undefined || input[key] === "")) return null;
  const value = text(input, key, "日期", 10);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" || value > "9999-12-31" || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HTTPException(400, { message: "日期必須是有效的 YYYY-MM-DD。" });
  }
  return value;
}
function period(start: string, end: string | null) {
  if (end && end <= start) throw new HTTPException(400, { message: "結束日（不含）必須晚於開始日。" });
}
function revision(input: Record<string, unknown>) {
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1) throw new HTTPException(400, { message: "請提供有效版本，並重新整理後操作。" });
  return input.revision as number;
}
function booleanValue(input: Record<string, unknown>, key: string, label: string, fallback?: boolean) {
  const value = input[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new HTTPException(400, { message: `${label}格式不正確。` });
}
function integerValue(input: Record<string, unknown>, key: string, label: string, min: number, max: number) {
  const raw = input[key];
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new HTTPException(400, { message: `${label}必須是 ${min}～${max} 的整數。` });
  return value;
}
function coordinate(input: Record<string, unknown>, key: string, label: string, max: number) {
  const raw = input[key];
  if (raw === null || raw === undefined || raw === "") return null;
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < -max || value > max) throw new HTTPException(400, { message: `${label}必須在有效地理座標範圍內。` });
  return Math.round(value * 10_000_000);
}
function attendanceLocation(input: Record<string, unknown>) {
  const geolocationRequired = booleanValue(input, "geolocationRequired", "定位判斷", true);
  const latitudeE7 = coordinate(input, "latitude", "緯度", 90);
  const longitudeE7 = coordinate(input, "longitude", "經度", 180);
  if ((latitudeE7 === null) !== (longitudeE7 === null)) throw new HTTPException(400, { message: "緯度與經度必須同時填寫。" });
  if (geolocationRequired && (latitudeE7 === null || longitudeE7 === null)) throw new HTTPException(400, { message: "啟用定位判斷時必須選擇 Google Maps 地點。" });
  return {
    name: text(input, "name", "辦公位置", 100),
    // 舊資料可暫時未對應；HR 新建時建議指定營運據點。
    scopeId: nullableText(input, "scopeId", "營運據點"),
    geolocationRequired,
    latitudeE7,
    longitudeE7,
    radiusMeters: integerValue(input, "radiusMeters", "出勤判斷半徑", 1, 10000),
  };
}
function nullableText(input: Record<string, unknown>, key: string, label: string, max = 100) {
  if (input[key] === null || input[key] === undefined || input[key] === "") return null;
  return text(input, key, label, max);
}
function requestedAt(input: Record<string, unknown>) {
  const correctionDate = date(input, "correctionDate")!;
  const requestedTime = text(input, "requestedTime", "補打卡時間", 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(requestedTime)) throw new HTTPException(400, { message: "補打卡時間必須是有效的 HH:mm。" });
  const normalized = `${correctionDate} ${requestedTime}:00`;
  try {
    return { correctionDate, requestedAt: taipeiWallClockToUtc(normalized) };
  } catch {
    throw new HTTPException(400, { message: "補打卡日期與時間不正確。" });
  }
}
function formRequestInput(input: Record<string, unknown>, employeeUserId: string) {
  const { correctionDate, requestedAt: at } = requestedAt(input);
  const requestedEventKind = input.requestedEventKind === "clock_out" ? "clock_out" : input.requestedEventKind === "clock_in" ? "clock_in" : null;
  if (!requestedEventKind) throw new HTTPException(400, { message: "請選擇上班或下班補打卡。" });
  return {
    employeeUserId,
    correctionDate,
    requestedEventKind,
    requestedAt: at,
    reason: text(input, "reason", "申請原因", 1000),
    approverUserId: nullableText(input, "approverUserId", "審核者"),
  } as const;
}
function currentTaipeiYearMonth() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const year = Number(parts.find((item) => item.type === "year")?.value);
  const month = Number(parts.find((item) => item.type === "month")?.value);
  return { year, month };
}
function calendarNumber(raw: string | undefined, fallback: number, label: string, min: number, max: number) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new HTTPException(400, { message: `${label}不正確。` });
  return value;
}
function attendanceMode(input: Record<string, unknown>, optional = false): "general" | "scheduled" {
  const value = input.attendanceMode;
  if (value === undefined && optional) return "general";
  if (value === "general" || value === "scheduled") return value;
  throw new HTTPException(400, { message: "出勤方式只能是一般辦公或排班。" });
}
function payBasis(input: Record<string, unknown>): "monthly" | "daily" | "hourly" {
  if (input.payBasis === "monthly" || input.payBasis === "daily" || input.payBasis === "hourly") return input.payBasis;
  throw new HTTPException(400, { message: "薪資計算方式不正確。" });
}
function insuranceScheme(input: Record<string, unknown>): "labor" | "health" {
  if (input.scheme === "labor" || input.scheme === "health") return input.scheme;
  throw new HTTPException(400, { message: "保險種類不正確。" });
}
function insuranceRateSource(input: Record<string, unknown>) {
  const value = input.sourceUrl;
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 500) throw new HTTPException(400, { message: "級距來源最多 500 字。" });
  return value.trim();
}
function insuranceRateBrackets(input: Record<string, unknown>) {
  const raw = input.brackets;
  if (!Array.isArray(raw) || raw.length > 500) throw new HTTPException(400, { message: "級距清單格式不正確。" });
  return raw.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new HTTPException(400, { message: `第 ${index + 1} 筆級距格式不正確。` });
    const bracket = value as Record<string, unknown>;
    const upperRaw = bracket.upperSalary;
    const upperSalary = upperRaw === undefined || upperRaw === null || upperRaw === "" ? null : integerValue(bracket, "upperSalary", "級距上限", 0, Number.MAX_SAFE_INTEGER);
    return {
      level: integerValue(bracket, "level", "級距序號", 1, 1_000_000),
      lowerSalary: integerValue(bracket, "lowerSalary", "級距下限", 0, Number.MAX_SAFE_INTEGER),
      upperSalary,
      insuredAmount: integerValue(bracket, "insuredAmount", "投保金額", 1, Number.MAX_SAFE_INTEGER),
    };
  });
}
function expectedRateContentHash(input: Record<string, unknown>) {
  const value = input.contentHash ?? input.expectedContentHash;
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) throw new HTTPException(400, { message: "級距版本識別碼不正確，請重新整理後再試。" });
  return value;
}
function insuranceStatus(input: Record<string, unknown>): "enrolled" | "withdrawn" {
  if (input.status === "enrolled" || input.status === "withdrawn") return input.status;
  throw new HTTPException(400, { message: "加退保狀態不正確。" });
}
function bonusKind(input: Record<string, unknown>): "team_performance" | "individual_performance" {
  if (input.bonusKind === "team_performance" || input.bonusKind === "individual_performance") return input.bonusKind;
  throw new HTTPException(400, { message: "績效歸屬只能是團體績效或個人績效。" });
}
function performancePeriod(input: Record<string, unknown>): "current_month" | "previous_month" {
  if (input.performancePeriod === "current_month" || input.performancePeriod === "previous_month") return input.performancePeriod;
  throw new HTTPException(400, { message: "業績期間只能是當月或前月。" });
}
function employeeUserIds(input: Record<string, unknown>): string[] | undefined {
  if (input.employeeUserIds === undefined) return undefined;
  if (!Array.isArray(input.employeeUserIds) || input.employeeUserIds.length > 80 || input.employeeUserIds.some((value) => typeof value !== "string" || value.trim() === "" || value.length > 200) || new Set(input.employeeUserIds).size !== input.employeeUserIds.length) throw new HTTPException(400, { message: "指派員工格式不正確。" });
  return input.employeeUserIds as string[];
}
function bonusEmployeeAssignments(input: Record<string, unknown>): Array<{ employeeUserId: string; weightUnits: number }> | undefined {
  if (input.employeeAssignments === undefined) return undefined;
  if (!Array.isArray(input.employeeAssignments) || input.employeeAssignments.length > 80) throw new HTTPException(400, { message: "指派員工格式不正確。" });
  const assignments = input.employeeAssignments.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HTTPException(400, { message: `第 ${index + 1} 位指派員工格式不正確。` });
    const assignment = raw as Record<string, unknown>;
    return { employeeUserId: text(assignment, "employeeUserId", "員工", 200), weightUnits: integerValue(assignment, "weightUnits", "權重", 1, 1000) };
  });
  if (new Set(assignments.map((assignment) => assignment.employeeUserId)).size !== assignments.length) throw new HTTPException(400, { message: "指派員工不可重複。" });
  return assignments;
}
function bonusScopeIds(input: Record<string, unknown>): string[] | undefined {
  if (input.scopeIds === undefined) return undefined;
  if (!Array.isArray(input.scopeIds) || input.scopeIds.length > 100 || input.scopeIds.some((value) => typeof value !== "string" || value.trim() === "" || value.length > 200) || new Set(input.scopeIds).size !== input.scopeIds.length) throw new HTTPException(400, { message: "適用 Scope 格式不正確。" });
  return input.scopeIds as string[];
}
function noteValue(input: Record<string, unknown>) {
  // 表單的空欄位送出來是 ""；text() 會把空字串當成沒填而擋下，選填的備註要跟 undefined 一樣放行。
  return nullableText(input, "note", "備註", 1000) ?? "";
}
function compensationItems(input: Record<string, unknown>) {
  if (input.items === undefined) return undefined;
  if (!Array.isArray(input.items) || input.items.length > 50) throw new HTTPException(400, { message: "薪資項目格式不正確。" });
  return input.items.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HTTPException(400, { message: `第 ${index + 1} 筆薪資項目格式不正確。` });
    const item = raw as Record<string, unknown>;
    const itemKind: "fixed" | "variable" | null = item.itemKind === "fixed" || item.itemKind === "variable" ? item.itemKind : null;
    if (!itemKind) throw new HTTPException(400, { message: `第 ${index + 1} 筆薪資項目類型不正確。` });
    // 沒送 amountBasis 就當成月給：舊的呼叫端與大多數津貼都是月給。
    const amountBasis = item.amountBasis === "daily" ? "daily" as const
      : item.amountBasis === "hourly" ? "hourly" as const
      : item.amountBasis === undefined || item.amountBasis === null || item.amountBasis === "monthly" ? "monthly" as const
      : null;
    if (!amountBasis) throw new HTTPException(400, { message: `第 ${index + 1} 筆薪資項目的計算單位不正確。` });
    return { itemName: text(item, "itemName", "薪資項目", 100), amountMinor: integerValue(item, "amountMinor", "薪資項目金額（分）", 0, Number.MAX_SAFE_INTEGER), itemKind, amountBasis, includeOvertime: booleanValue(item, "includeOvertime", "是否納入加班費計算", false), includeInsurance: booleanValue(item, "includeInsurance", "是否納入勞健保", false), includeTax: booleanValue(item, "includeTax", "是否計入應稅所得", true) };
  });
}
function adjustmentItems(input: Record<string, unknown>) {
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) throw new HTTPException(400, { message: "薪資調整項目格式不正確。" });
  return input.items.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HTTPException(400, { message: `第 ${index + 1} 筆薪資調整格式不正確。` });
    const item = raw as Record<string, unknown>;
    const rawAmount = item.amountMinor;
    const amountMinor = typeof rawAmount === "number" ? rawAmount : typeof rawAmount === "string" ? Number(rawAmount) : NaN;
    if (!Number.isSafeInteger(amountMinor)) throw new HTTPException(400, { message: `第 ${index + 1} 筆薪資調整金額不正確。` });
    return { itemName: text(item, "itemName", "調整項目", 100), amountMinor };
  });
}
function periodKey(input: Record<string, unknown>) {
  const value = text(input, "periodKey", "計算月份", 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new HTTPException(400, { message: "計算月份必須是 YYYY-MM。" });
  return value;
}
function optionalInteger(input: Record<string, unknown>, key: string, label: string, min: number, max: number) {
  return input[key] === undefined ? undefined : integerValue(input, key, label, min, max);
}
function hrAdminMessage() {
  return new HTTPException(403, { message: "只有全平台 HR 管理者可以檢視或計算薪資與獎金。" });
}
function scheduleEntries(input: Record<string, unknown>) {
  if (!Array.isArray(input.entries) || input.entries.length > 1000) throw new HTTPException(400, { message: "排班清單格式不正確。" });
  return input.entries.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HTTPException(400, { message: `第 ${index + 1} 筆排班格式不正確。` });
    const value = raw as Record<string, unknown>;
    const personKind = value.personKind === "employee" || value.personKind === "worker" ? value.personKind : null;
    if (!personKind) throw new HTTPException(400, { message: `第 ${index + 1} 筆排班人員類型不正確。` });
    const workDate = date(value, "workDate")!;
    const employmentId = personKind === "employee" ? text(value, "employmentId", "員工任職") : undefined;
    const workerId = personKind === "worker" ? text(value, "workerId", "支援人員") : undefined;
    return { personKind, employmentId, workerId, scopeId: text(value, "scopeId", "營運據點"), shiftVersionId: text(value, "shiftVersionId", "班別版本"), workDate } as const;
  });
}
function specialWorkdayOvertimeRules(input: Record<string, unknown>) {
  const rawRules = input.overtimeRules;
  if (rawRules === undefined) return [];
  if (!Array.isArray(rawRules) || rawRules.length > 50) throw new HTTPException(400, { message: "特殊上班日加班規則格式不正確。" });
  return rawRules.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HTTPException(400, { message: `第 ${index + 1} 筆特殊上班日加班規則格式不正確。` });
    const item = raw as Record<string, unknown>;
    const rateKind = item.rateKind === "fixed_hourly" || item.rateKind === "multiplier" ? item.rateKind : null;
    if (!rateKind) throw new HTTPException(400, { message: `第 ${index + 1} 筆特殊上班日加班計算方式不正確。` });
    const toHalfHours = item.toHalfHours === undefined || item.toHalfHours === null || item.toHalfHours === "" ? null : integerValue(item, "toHalfHours", "加班級距迄（半小時單位索引）", 1, 20_000);
    return {
      fromHalfHours: integerValue(item, "fromHalfHours", "加班級距起（半小時單位索引）", 1, 20_000),
      toHalfHours,
      rateKind,
      fixedAmountMinor: rateKind === "fixed_hourly" ? integerValue(item, "fixedAmountMinor", "固定加班時薪（分）", 0, Number.MAX_SAFE_INTEGER) : null,
      multiplierPpm: rateKind === "multiplier" ? integerValue(item, "multiplierPpm", "加班倍率（ppm）", 0, 10_000_000) : null,
    } as const;
  });
}
function specialWorkdayRule(input: Record<string, unknown>) {
  const wageKind = input.wageKind === "fixed_hourly" || input.wageKind === "multiplier" ? input.wageKind : null;
  if (!wageKind) throw new HTTPException(400, { message: "特殊上班日薪資方式不正確。" });
  const rawAllowances = input.allowances;
  if (!Array.isArray(rawAllowances) || rawAllowances.length > 50) throw new HTTPException(400, { message: "補貼項目格式不正確。" });
  const allowances = rawAllowances.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HTTPException(400, { message: `第 ${index + 1} 筆補貼格式不正確。` });
    const item = raw as Record<string, unknown>;
    return { itemName: text(item, "itemName", "補貼項目", 100), unitAmountMinor: integerValue(item, "unitAmountMinor", "補貼單價（分）", 0, Number.MAX_SAFE_INTEGER) };
  });
  if (input.workSource !== undefined) throw new HTTPException(400, { message: "特殊上班日工時來源由系統依人員類型決定，不可由請求指定。" });
  return { name: text(input, "name", "規則名稱", 100), validFrom: date(input, "validFrom")!, validTo: date(input, "validTo", true), wageKind, fixedAmountMinor: wageKind === "fixed_hourly" ? integerValue(input, "fixedAmountMinor", "固定每小時金額（分）", 0, Number.MAX_SAFE_INTEGER) : null, multiplierPpm: wageKind === "multiplier" ? integerValue(input, "multiplierPpm", "薪資倍率（ppm）", 0, 10_000_000) : null, note: noteValue(input), allowances, overtimeRules: specialWorkdayOvertimeRules(input) } as const;
}
function specialAssignments(input: Record<string, unknown>) {
  if (!Array.isArray(input.assignments) || !input.assignments.length || input.assignments.length > 1000) throw new HTTPException(400, { message: "特殊上班日套用清單格式不正確。" });
  return input.assignments.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HTTPException(400, { message: `第 ${index + 1} 筆套用資料不正確。` });
    const item = raw as Record<string, unknown>;
    const targetCount = [item.employmentId, item.workerId].filter((value) => typeof value === "string" && value.length > 0).length;
    if (targetCount !== 1) throw new HTTPException(400, { message: `第 ${index + 1} 筆必須指定一位員工或支援人員。` });
    return { employmentId: typeof item.employmentId === "string" ? item.employmentId : undefined, workerId: typeof item.workerId === "string" ? item.workerId : undefined, workDate: date(item, "workDate")!, allowanceQuantity: integerValue(item, "allowanceQuantity", "補貼數量", 0, Number.MAX_SAFE_INTEGER) };
  });
}
function dateTimeValue(input: Record<string, unknown>, key: string, label: string) {
  const value = text(input, key, label, 19);
  if (!/^\d{4}-\d{2}-\d{2}(?: |T)\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new HTTPException(400, { message: `${label}格式必須是台北時間 YYYY-MM-DD HH:mm[:ss]。` });
  const normalized = value.replace("T", " ").length === 16 ? `${value.replace("T", " ")}:00` : value.replace("T", " ");
  try {
    return taipeiWallClockToUtc(normalized);
  } catch {
    throw new HTTPException(400, { message: `${label}不是有效的台北時間。` });
  }
}
function optionalDateTimeValue(input: Record<string, unknown>, key: string, label: string) {
  if (input[key] === undefined || input[key] === null || input[key] === "") return undefined;
  return dateTimeValue(input, key, label);
}
function overtimeInput(input: Record<string, unknown>, employeeUserId: string) {
  const settlementKind = input.settlementKind === "pay" || input.settlementKind === "compensatory" ? input.settlementKind : null;
  if (!settlementKind) throw new HTTPException(400, { message: "加班結算方式不正確。" });
  return { employeeUserId, scopeId: nullableText(input, "scopeId", "營運據點"), requestedStart: dateTimeValue(input, "requestedStart", "加班開始"), requestedEnd: dateTimeValue(input, "requestedEnd", "加班結束"), settlementKind, ratePpm: input.ratePpm === undefined ? undefined : integerValue(input, "ratePpm", "已確認加班倍率（ppm）", 0, 10_000_000), reason: text(input, "reason", "加班原因", 1000) } as const;
}
function secondsFromTime(input: Record<string, unknown>, key: string) {
  const value = text(input, key, key === "startTime" ? "開始時間" : "結束時間", 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new HTTPException(400, { message: "班別時間必須是有效的 HH:mm。" });
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(3, 5));
  return hour * 3600 + minute * 60;
}
/** 班別的計薪工時就是它的長度，休息一律 0；這裡是唯一的來源。 */
function defaultShiftMinutes(input: Record<string, unknown>) {
  const start = secondsFromTime(input, "startTime");
  const end = secondsFromTime(input, "endTime");
  return { start, end, standardMinutes: (end - start) / 60, breakMinutes: 0 };
}
/** 一個班別的平日／週末／國定假日三組時間；值域與「平日必填」由 packages/db 的 assertShiftTimes 把關。 */
function shiftTimes(input: Record<string, unknown>): HrShiftTime[] {
  const value = input.times;
  if (!Array.isArray(value) || !value.length || value.length > 3) throw new HTTPException(400, { message: "班別時間格式不正確。" });
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new HTTPException(400, { message: "班別時間格式不正確。" });
    const entry = item as Record<string, unknown>;
    if (!isHrDayType(entry.dayType)) throw new HTTPException(400, { message: "班別的日期類型不正確。" });
    const defaults = defaultShiftMinutes(entry);
    return { dayType: entry.dayType, startSecond: defaults.start, endSecond: defaults.end, standardMinutes: defaults.standardMinutes, breakMinutes: defaults.breakMinutes };
  });
}
/** 行事曆送上來的是一整個月的日子；這裡只檢查形狀，哪些要寫成列由 saveHrCalendarMonth 決定。 */
function calendarDays(input: Record<string, unknown>): HrCalendarDayInput[] {
  const value = input.days;
  if (!Array.isArray(value) || value.length > 31) throw new HTTPException(400, { message: "行事曆格式不正確。" });
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new HTTPException(400, { message: "行事曆格式不正確。" });
    const entry = item as Record<string, unknown>;
    if (!isHrDayType(entry.dayType)) throw new HTTPException(400, { message: "行事曆的日期類型不正確。" });
    if (typeof entry.date !== "string" || typeof entry.name !== "string") throw new HTTPException(400, { message: "行事曆格式不正確。" });
    return { date: entry.date, dayType: entry.dayType, name: entry.name };
  });
}
function stringArray(input: Record<string, unknown>, key: string, label: string, maxItems = 100) {
  const value = input[key];
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 100)) throw new HTTPException(400, { message: `${label}格式不正確。` });
  return value as string[];
}
function attendanceAssignmentsToEnd(input: Record<string, unknown>) {
  const value = input.assignmentsToEnd;
  if (!Array.isArray(value) || value.length > 100) throw new HTTPException(400, { message: "要結束的辦公位置指派格式不正確。" });
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new HTTPException(400, { message: "要結束的辦公位置指派格式不正確。" });
    const assignment = item as Record<string, unknown>;
    return { id: text(assignment, "id", "辦公位置指派"), revision: integerValue(assignment, "revision", "版本", 1, Number.MAX_SAFE_INTEGER) };
  });
}
function nextTaipeiDate(value: string) {
  return formatTaipeiDate(new Date(`${value}T00:00:00.000Z`).getTime() + 86_400_000);
}

function isSelfServicePath(path: string) {
  return path === DEVICE_COOKIE_PATH || path.startsWith(`${DEVICE_COOKIE_PATH}/`);
}

export const hr = new Hono<AppEnv>()
  // 本人入口也認「記住這台手機」；其餘管理路由一律要 12 小時 session。
  .use("*", (c, next) => isSelfServicePath(c.req.path) ? requireSelfAuth(c, next) : requireAuth(c, next))
  .onError((error, c) => {
    if (error instanceof HrError || error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    throw error;
  })
  .get("/me/session", async (c) => c.json({ ...await sessionUserPayload(c.get("db"), c.get("user")), deviceRemembered: c.get("deviceSession") }))
  /*
   * 記住這台手機。只接受 12 小時 session 發：裝置 cookie 能自己再發一台的話，
   * 被偷的那台撤銷之後，它早先替自己發出去的另一台還活著。
   */
  .post("/me/device", async (c) => {
    if (c.get("deviceSession")) return c.json({ ok: true });
    const token = await createDeviceSession(c.get("db"), c.get("user").id, c.req.header("User-Agent") ?? "");
    c.header("Set-Cookie", deviceCookie(token), { append: true });
    return c.json({ ok: true }, 201);
  })
  /** HR app 的登出：撤銷這台，並一起清掉 session，不然下一次打開又會被自動記住。 */
  .delete("/me/device", async (c) => {
    await revokeDeviceSession(c.get("db"), readCookie(c.req.header("Cookie"), DEVICE_SESSION_COOKIE));
    c.header("Set-Cookie", clearDeviceCookie(), { append: true });
    c.header("Set-Cookie", clearCookie(SESSION_COOKIE, "/", c.env.AUTH_COOKIE_DOMAIN), { append: true });
    return c.json({ ok: true });
  })
  // 本人資格來自員工關聯而不是手動授權；requireAuth 仍每次檢查帳號是否啟用。
  .get("/me", async (c) => c.json({ profile: await getHrSelf(c.get("db"), c.get("user").id) }))
  .get("/overview", async (c) => {
    const user = c.get("user");
    const canViewOverview = (["hr:employee:read", "hr:office:read", "hr:schedule:read", "hr:payroll:read", "hr:bonus:read"] as const).some((permission) => can(user, permission));
    if (!canViewOverview || !await isHrAdministrator(c.get("db"), user.id)) throw new HTTPException(403, { message: "只有全平台 HR 管理者可以檢視 HRIS 概覽。" });
    return c.json(await getHrOverview(c.get("db")));
  })
  .get("/me/clock-events", async (c) => c.json(await getHrClockStatus(c.get("db"), c.get("user").id)))
  .get("/me/attendance-calendar", async (c) => {
    const fallback = currentTaipeiYearMonth();
    const year = calendarNumber(c.req.query("year"), fallback.year, "年份", 1900, 9999);
    const month = calendarNumber(c.req.query("month"), fallback.month, "月份", 1, 12);
    return c.json(await getHrClockCalendar(c.get("db"), c.get("user").id, year, month));
  })
  .post("/me/attendance-location/check", async (c) => {
    const input = await body(c);
    const latitudeE7 = coordinate(input, "latitude", "緯度", 90);
    const longitudeE7 = coordinate(input, "longitude", "經度", 180);
    if (latitudeE7 === null || longitudeE7 === null) throw new HTTPException(400, { message: "請先取得完整的目前定位。" });
    return c.json(await checkHrClockLocation(c.get("db"), c.get("user").id, latitudeE7, longitudeE7));
  })
  .get("/me/attendance-map/locations", async (c) => c.json({ locations: await getHrClockMapCenters(c.get("db"), c.get("user").id) }))
  .get("/me/attendance-map", async (c) => {
    const apiKey = c.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) throw new HTTPException(503, { message: "尚未設定 Google Maps 地圖服務，請聯絡管理者。" });
    const centers = await getHrClockMapCenters(c.get("db"), c.get("user").id);
    if (!centers.length) throw new HTTPException(404, { message: "目前沒有可顯示的辦公位置地圖。" });
    const mapUrl = new URL("https://maps.googleapis.com/maps/api/staticmap");
    const center = centers[0]!;
    mapUrl.searchParams.set("center", `${center.latitude},${center.longitude}`);
    mapUrl.searchParams.set("zoom", centers.length === 1 ? "16" : "12");
    mapUrl.searchParams.set("size", "640x320");
    mapUrl.searchParams.set("scale", "2");
    mapUrl.searchParams.set("maptype", "roadmap");
    for (const location of centers) mapUrl.searchParams.append("markers", `color:red|${location.latitude},${location.longitude}`);
    mapUrl.searchParams.set("key", apiKey);
    const response = await fetch(mapUrl);
    if (!response.ok) throw new HTTPException(502, { message: "Google Maps 地圖服務暫時無法使用。" });
    return new Response(response.body, { headers: { "Content-Type": response.headers.get("content-type") ?? "image/png", "Cache-Control": "private, max-age=300" } });
  })
  .post("/me/clock-events", async (c) => {
    const input = await body(c);
    const latitudeE7 = coordinate(input, "latitude", "緯度", 90);
    const longitudeE7 = coordinate(input, "longitude", "經度", 180);
    if ((latitudeE7 === null) !== (longitudeE7 === null)) throw new HTTPException(400, { message: "定位座標格式不完整，請重新定位。" });
    const result = await createHrClockEvent(c.get("db"), {
      userId: c.get("user").id,
      idempotencyKey: text(input, "idempotencyKey", "請求識別碼", 200),
      latitudeE7,
      longitudeE7,
    }, c.get("user"));
    return c.json(result, result.idempotent ? 200 : 201);
  })
  .get("/me/overtime", async (c) => c.json({ requests: await listHrOvertimeRequests(c.get("db"), c.get("user").id) }))
  .post("/me/overtime", async (c) => c.json(await createHrOvertimeRequest(c.get("db"), overtimeInput(await body(c), c.get("user").id), c.get("user")), 201))
  .get("/overtime", requirePermission("hr:request:review"), async (c) => c.json({ requests: await listHrOvertimeRequests(c.get("db")) }))
  .post("/overtime/:id/review", requirePermission("hr:request:review"), async (c) => {
    const input = await body(c);
    const decision = input.decision === "approved" || input.decision === "rejected" || input.decision === "cancelled" ? input.decision : null;
    if (!decision) throw new HTTPException(400, { message: "加班審核結果不正確。" });
    const comment = input.comment ? text(input, "comment", "審核意見", 1000) : "";
    const actualStart = optionalDateTimeValue(input, "actualStart", "實際加班開始");
    const actualEnd = optionalDateTimeValue(input, "actualEnd", "實際加班結束");
    if ((actualStart === undefined) !== (actualEnd === undefined)) throw new HTTPException(400, { message: "實際加班開始與結束時間必須一起填寫。" });
    return c.json(await reviewHrOvertimeRequest(c.get("db"), c.req.param("id"), decision, comment, c.get("user"), actualStart && actualEnd ? { start: actualStart, end: actualEnd } : undefined));
  })
  .get("/me/form-approvers", async (c) => c.json(await listHrFormApprovers(c.get("db"), c.get("user").id)))
  .get("/me/form-requests", async (c) => c.json(await listHrFormRequests(c.get("db"), c.get("user").id, can(c.get("user"), "hr:request:review"))))
  .get("/me/form-requests/:id", async (c) => c.json({ request: await getHrFormRequest(c.get("db"), c.req.param("id"), c.get("user").id, can(c.get("user"), "hr:request:review")) }))
  .post("/me/form-requests", async (c) => {
    const input = formRequestInput(await body(c), c.get("user").id);
    return c.json(await createHrFormRequest(c.get("db"), input, c.get("user")), 201);
  })
  .patch("/me/form-requests/:id", async (c) => {
    const input = formRequestInput(await body(c), c.get("user").id);
    return c.json(await updateHrFormRequest(c.get("db"), c.req.param("id"), c.get("user").id, input, c.get("user")));
  })
  .post("/me/form-requests/:id/submit", async (c) => c.json(await submitHrFormRequest(c.get("db"), c.req.param("id"), c.get("user").id, c.get("user"))))
  .post("/me/form-requests/:id/review", async (c) => {
    const input = await body(c);
    const decision = input.decision === "approved" || input.decision === "rejected" ? input.decision : null;
    if (!decision) throw new HTTPException(400, { message: "審核結果不正確。" });
    const comment = input.comment === undefined || input.comment === null || input.comment === "" ? "" : text(input, "comment", "審核意見", 1000);
    if (decision === "rejected" && !comment.trim()) throw new HTTPException(400, { message: "駁回時請填寫審核意見。" });
    return c.json(await reviewHrFormRequest(c.get("db"), c.req.param("id"), c.get("user").id, decision, comment, can(c.get("user"), "hr:request:review"), c.get("user")));
  })
  .get("/candidates", requirePermission("hr:employee:write"), async (c) => {
    const page = Number(c.req.query("page") ?? "1");
    const search = c.req.query("search")?.trim() ?? "";
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || search.length > 100) throw new HTTPException(400, { message: "查詢條件不正確。" });
    return c.json(await listHrCandidates(c.get("db"), { page, search, userId: c.req.query("userId") }));
  })
  .get("/scopes", requirePermission("hr:employee:read"), async (c) => c.json({ scopes: await listHrScopes(c.get("db")) }))
  .get("/attendance-settings/places", requirePermission("hr:office:write"), async (c) => {
    const query = c.req.query("query")?.trim() ?? "";
    if (!query || query.length > 100) throw new HTTPException(400, { message: "請輸入 1～100 字的地點搜尋關鍵字。" });
    const apiKey = c.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) throw new HTTPException(503, { message: "尚未設定 Google Maps 搜尋服務，請聯絡管理者。" });
    try {
      return c.json({ places: await searchGooglePlaces(query, apiKey) });
    } catch (error) {
      if (error instanceof GoogleMapsSearchError) throw new HTTPException(502, { message: error.message });
      throw error;
    }
  })
  .get("/attendance-settings/locations", requirePermission("hr:office:read"), async (c) => {
    const rawPage = c.req.query("page");
    if (rawPage === undefined && !c.req.query("search") && !c.req.query("scopeId") && !c.req.query("sortField")) return c.json(await listHrAttendanceLocations(c.get("db"), undefined, { activeOnly: c.req.query("active") === "1" }));
    const page = calendarNumber(rawPage, 1, "頁碼", 1, 10000);
    const rawPageSize = c.req.query("pageSize");
    const pageSize = rawPageSize === undefined ? 25 : Number(rawPageSize);
    if (!HR_ATTENDANCE_LOCATION_PAGE_SIZES.includes(pageSize as (typeof HR_ATTENDANCE_LOCATION_PAGE_SIZES)[number])) throw new HTTPException(400, { message: "每頁筆數不正確。" });
    const search = c.req.query("search")?.trim() ?? "";
    if (search.length > 100) throw new HTTPException(400, { message: "搜尋條件不正確。" });
    const sortField = c.req.query("sortField") ?? "name";
    if (sortField !== "name" && sortField !== "scope" && sortField !== "radius") throw new HTTPException(400, { message: "排序欄位不正確。" });
    const sortDirection = c.req.query("sortDirection") === "desc" ? "desc" : "asc";
    return c.json(await listHrAttendanceLocations(c.get("db"), { page, pageSize, search, scopeId: c.req.query("scopeId") ?? "all", sortField, sortDirection }));
  })
  .get("/attendance-settings/locations/:id", requirePermission("hr:office:write"), async (c) => c.json(await getHrAttendanceLocation(c.get("db"), c.req.param("id"))))
  .post("/attendance-settings/locations", requirePermission("hr:office:write"), async (c) => {
    const input = attendanceLocation(await body(c));
    return c.json(await createHrAttendanceLocation(c.get("db"), input, c.get("user")), 201);
  })
  .patch("/attendance-settings/locations/:id", requirePermission("hr:office:write"), async (c) => {
    const raw = await body(c);
    const input = attendanceLocation(raw);
    return c.json(await updateHrAttendanceLocation(c.get("db"), c.req.param("id"), { ...input, revision: revision(raw) }, c.get("user")));
  })
  .get("/attendance-events", requirePermission("hr:office:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const page = calendarNumber(c.req.query("page"), 1, "頁碼", 1, 10000);
    const rawPageSize = c.req.query("pageSize");
    const pageSize = rawPageSize === undefined ? 25 : Number(rawPageSize);
    if (!HR_ATTENDANCE_EVENT_PAGE_SIZES.includes(pageSize as (typeof HR_ATTENDANCE_EVENT_PAGE_SIZES)[number])) throw new HTTPException(400, { message: "每頁筆數不正確。" });
    const search = c.req.query("search")?.trim() ?? "";
    const eventKind = c.req.query("eventKind") ?? "all";
    const sourceKind = c.req.query("sourceKind") ?? "all";
    const startDate = c.req.query("startDate") ? date({ value: c.req.query("startDate") }, "value") : null;
    const endDate = c.req.query("endDate") ? date({ value: c.req.query("endDate") }, "value") : null;
    if (endDate && startDate && endDate <= startDate) throw new HTTPException(400, { message: "結束日期必須晚於開始日期。" });
    const sortField = c.req.query("sortField") ?? "occurredAt";
    const sortDirection = c.req.query("sortDirection") === "asc" ? "asc" : "desc";
    if (search.length > 100 || !["all", "clock_in", "clock_out"].includes(eventKind) || !["all", "portal", "manual", "rfid", "line"].includes(sourceKind) || !["occurredAt", "employee", "source"].includes(sortField)) throw new HTTPException(400, { message: "出勤紀錄查詢條件不正確。" });
    return c.json(await listHrAttendanceEvents(c.get("db"), { page, pageSize, search, eventKind: eventKind as "all" | "clock_in" | "clock_out", sourceKind: sourceKind as "all" | "portal" | "manual" | "rfid" | "line", startDate, endDate, sortField: sortField as "occurredAt" | "employee" | "source", sortDirection }));
  })
  .get("/special-workdays/rules", requirePermission("hr:office:read"), async (c) => c.json({ rules: await listHrSpecialWorkdayRules(c.get("db")) }))
  .post("/special-workdays/rules", requirePermission("hr:office:write"), async (c) => c.json(await createHrSpecialWorkdayRule(c.get("db"), specialWorkdayRule(await body(c)), c.get("user")), 201))
  .post("/special-workdays/rules/:id/versions", requirePermission("hr:office:write"), async (c) => c.json(await createHrSpecialWorkdayRuleVersion(c.get("db"), c.req.param("id"), specialWorkdayRule(await body(c)), c.get("user")), 201))
  .post("/special-workdays/rules/:id/versions/:versionId/void", requirePermission("hr:office:write"), async (c) => c.json(await voidHrSpecialWorkdayRuleVersion(c.get("db"), c.req.param("id"), c.req.param("versionId"), c.get("user"))))
  .post("/special-workdays/rules/:id/status", requirePermission("hr:office:write"), async (c) => { const input = await body(c); return c.json(await setHrSpecialWorkdayRuleActive(c.get("db"), c.req.param("id"), booleanValue(input, "active", "啟用狀態"), c.get("user"))); })
  .get("/special-workdays/assignments", requirePermission("hr:office:read"), async (c) => { const start = c.req.query("start"); const end = c.req.query("end"); if (start) date({ date: start }, "date"); if (end) date({ date: end }, "date"); if (start && end && end <= start) throw new HTTPException(400, { message: "查詢迄日必須晚於開始日。" }); return c.json({ assignments: await listHrSpecialWorkdayAssignments(c.get("db"), start, end) }); })
  .post("/special-workdays/assignments", requirePermission("hr:office:write"), async (c) => { const input = await body(c); return c.json(await assignHrSpecialWorkdays(c.get("db"), { ruleVersionId: text(input, "ruleVersionId", "規則版本"), assignments: specialAssignments(input) }, c.get("user")), 201); })
  .get("/schedules", requirePermission("hr:schedule:read"), async (c) => {
    const rawPeriod = c.req.query("periodKey");
    if (!rawPeriod || !/^\d{4}-(0[1-9]|1[0-2])$/.test(rawPeriod)) throw new HTTPException(400, { message: "排班月份必須是 YYYY-MM。" });
    const scopeId = c.req.query("scopeId");
    return c.json(await getHrSchedule(c.get("db"), rawPeriod, scopeId));
  })
  .post("/schedules", requirePermission("hr:schedule:write"), async (c) => {
    const input = await body(c);
    const scheduleVersionId = input.scheduleVersionId === undefined ? undefined : text(input, "scheduleVersionId", "排班版本");
    const expectedRevision = input.revision === undefined ? undefined : revision(input);
    return c.json(await saveHrSchedule(c.get("db"), { periodKey: periodKey(input), scheduleVersionId, revision: expectedRevision, entries: scheduleEntries(input) }, c.get("user")));
  })
  .post("/schedules/:periodKey/lock", requirePermission("hr:schedule:write"), async (c) => {
    const raw = await body(c);
    const key = c.req.param("periodKey");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) throw new HTTPException(400, { message: "排班月份必須是 YYYY-MM。" });
    return c.json(await setHrScheduleLock(c.get("db"), key, { revision: revision(raw), locked: booleanValue(raw, "locked", "鎖定狀態") }, c.get("user")));
  })
  .get("/schedule-workers", requirePermission("hr:schedule:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    return c.json({ workers: await listHrScheduleWorkers(c.get("db")) });
  })
  .get("/schedule-workers/management", requirePermission("hr:schedule:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const page = calendarNumber(c.req.query("page"), 1, "頁碼", 1, 10000);
    const rawPageSize = c.req.query("pageSize");
    const pageSize = rawPageSize === undefined ? 25 : Number(rawPageSize);
    if (!HR_SCHEDULE_WORKER_PAGE_SIZES.includes(pageSize as (typeof HR_SCHEDULE_WORKER_PAGE_SIZES)[number])) throw new HTTPException(400, { message: "每頁筆數不正確。" });
    const status = c.req.query("status") ?? "all";
    if (status !== "all" && status !== "active" && status !== "inactive") throw new HTTPException(400, { message: "支援人員狀態不正確。" });
    const sortField = c.req.query("sortField") ?? "name";
    if (sortField !== "name" && sortField !== "status") throw new HTTPException(400, { message: "排序欄位不正確。" });
    const sortDirection = c.req.query("sortDirection") === "desc" ? "desc" : "asc";
    const search = c.req.query("search")?.trim() ?? "";
    if (search.length > 100) throw new HTTPException(400, { message: "搜尋條件不正確。" });
    return c.json(await listHrScheduleWorkersPage(c.get("db"), { page, pageSize, search, status, sortField, sortDirection }));
  })
  .post("/schedule-workers", requirePermission("hr:schedule:write"), async (c) => c.json(await createHrScheduleWorker(c.get("db"), { displayName: text(await body(c), "displayName", "姓名", 100) }, c.get("user")), 201))
  .patch("/schedule-workers/:id", requirePermission("hr:schedule:write"), async (c) => {
    const input = await body(c);
    return c.json(await updateHrScheduleWorker(c.get("db"), c.req.param("id"), { displayName: text(input, "displayName", "姓名", 100), active: booleanValue(input, "active", "啟用狀態"), revision: revision(input) }, c.get("user")));
  })
  .post("/schedule-workers/:id/compensation", requirePermission("hr:employee:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw new HTTPException(403, { message: "只有全平台 HR 管理者可以管理薪資資料。" });
    const input = await body(c);
    const validFrom = date(input, "validFrom")!;
    const validTo = date(input, "validTo", true);
    period(validFrom, validTo);
    return c.json(await createHrWorkerCompensation(c.get("db"), { workerId: c.req.param("id"), validFrom, validTo, payBasis: payBasis(input), baseAmountMinor: integerValue(input, "baseAmountMinor", "薪資金額（分）", 0, Number.MAX_SAFE_INTEGER), note: noteValue(input) }, c.get("user")), 201);
  })
  .get("/calendar/:periodKey", requirePermission("hr:schedule:read"), async (c) => c.json({ days: await listHrCalendarMonth(c.get("db"), periodFromKey(c.req.param("periodKey"))) }))
  .put("/calendar/:periodKey", requirePermission("hr:schedule:write"), async (c) => {
    const input = await body(c);
    return c.json(await saveHrCalendarMonth(c.get("db"), periodFromKey(c.req.param("periodKey")), calendarDays(input), c.get("user")));
  })
  .get("/shift-templates", requirePermission("hr:schedule:read"), async (c) => c.json(await listHrShifts(c.get("db"))))
  .patch("/shift-templates/:id", requirePermission("hr:schedule:write"), async (c) => {
    const input = await body(c);
    return c.json(await updateHrShift(c.get("db"), c.req.param("id"), { scopeId: text(input, "scopeId", "營運據點"), name: text(input, "name", "班別名稱", 100), times: shiftTimes(input), revision: integerValue(input, "revision", "版本", 1, Number.MAX_SAFE_INTEGER) }, c.get("user")));
  })
  .delete("/shift-templates/:id", requirePermission("hr:schedule:write"), async (c) => {
    const input = await body(c);
    return c.json(await deleteHrShift(c.get("db"), c.req.param("id"), { scopeId: text(input, "scopeId", "營運據點"), revision: integerValue(input, "revision", "版本", 1, Number.MAX_SAFE_INTEGER) }, c.get("user")));
  })
  .post("/shift-templates", requirePermission("hr:schedule:write"), async (c) => {
    const input = await body(c);
    return c.json(await createHrShift(c.get("db"), { scopeId: text(input, "scopeId", "營運據點"), name: text(input, "name", "班別名稱", 100), times: shiftTimes(input) }, c.get("user")), 201);
  })
  .patch("/employments/:id/attendance-scope", requirePermission("hr:office:write"), async (c) => {
    const input = await body(c);
    const selectedMode = attendanceMode(input);
    const monthlyRestDays = selectedMode === "scheduled" ? integerValue(input, "monthlyRestDays", "每月休假天數", 0, 31) : null;
    const validFrom = formatTaipeiDate(new Date());
    const validTo = nextTaipeiDate(validFrom);
    const locationIds = stringArray(input, "locationIds", "新增辦公位置");
    if (new Set(locationIds).size !== locationIds.length) throw new HTTPException(400, { message: "新增辦公位置不可重複。" });
    return c.json(await updateHrAttendanceScope(c.get("db"), {
      employmentId: c.req.param("id"), attendanceMode: selectedMode, monthlyRestDays, revision: revision(input), validFrom, validTo,
      locationIds, assignmentsToEnd: attendanceAssignmentsToEnd(input),
    }, c.get("user")));
  })
  .post("/employments/:id/attendance-location", requirePermission("hr:office:write"), async (c) => {
    const input = await body(c);
    const validFrom = date(input, "validFrom")!;
    const validTo = date(input, "validTo", true);
    period(validFrom, validTo);
    return c.json(await createHrAttendanceLocationAssignment(c.get("db"), { employmentId: c.req.param("id"), locationId: text(input, "locationId", "辦公位置"), validFrom, validTo }, c.get("user")), 201);
  })
  .post("/attendance-location-assignments/:id/primary", requirePermission("hr:office:write"), async (c) => {
    return c.json(await setHrAttendanceLocationPrimary(c.get("db"), c.req.param("id"), c.get("user")));
  })
  .patch("/attendance-location-assignments/:id/end", requirePermission("hr:office:write"), async (c) => {
    const input = await body(c);
    return c.json(await endHrAttendanceLocationAssignment(c.get("db"), c.req.param("id"), { validTo: date(input, "validTo")!, revision: revision(input) }, c.get("user")));
  })
  .get("/insurance-contribution-rules", requirePermission("hr:employee:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    return c.json({ rules: await listHrInsuranceContributionRules(c.get("db")) });
  })
  .post("/insurance-contribution-rules", requirePermission("hr:employee:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw new HTTPException(403, { message: "只有全平台 HR 管理者可以管理保險負擔規則。" });
    const input = await body(c); const validFrom = date(input, "validFrom")!; const validTo = date(input, "validTo", true);
    return c.json(await createHrInsuranceContributionRule(c.get("db"), { scheme: insuranceScheme(input), validFrom, validTo, employeeRatePpm: integerValue(input, "employeeRatePpm", "員工負擔費率（ppm）", 0, 1_000_000), employerRatePpm: integerValue(input, "employerRatePpm", "雇主負擔費率（ppm）", 0, 1_000_000), dependentRatePpm: integerValue(input, "dependentRatePpm", "眷屬倍率（ppm）", 0, 1_000_000), sourceKind: input.sourceKind === "official" ? "official" : "manual", note: noteValue(input) }, c.get("user")), 201);
  })
  .get("/insurance-rates", requirePermission("hr:employee:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const rawYear = c.req.query("year"); const year = rawYear ? Number(rawYear) : undefined;
    if (year !== undefined && (!Number.isSafeInteger(year) || year < 1900 || year > 9999)) throw new HTTPException(400, { message: "費率年度不正確。" });
    return c.json({ tables: await listHrInsuranceRateTables(c.get("db"), year) });
  })
  .post("/insurance-rates", requirePermission("hr:employee:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw new HTTPException(403, { message: "只有全平台 HR 管理者可以維護級距。" });
    const input = await body(c);
    return c.json(await createHrManualInsuranceRateTable(c.get("db"), {
      scheme: insuranceScheme(input), year: integerValue(input, "year", "費率年度", 1900, 9999), sourceUrl: insuranceRateSource(input), note: noteValue(input), brackets: insuranceRateBrackets(input),
    }, c.get("user")), 201);
  })
  .post("/insurance-rates/sync", requirePermission("hr:employee:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw new HTTPException(403, { message: "只有全平台 HR 管理者可以取得官方級距。" });
    const input = await body(c); const year = integerValue(input, "year", "費率年度", 1900, 9999);
    try {
      return c.json({ tables: await syncHrInsuranceRateTables(c.get("db"), year, c.get("user")) }, 201);
    } catch (error) {
      if (error instanceof HrInsuranceRateError) throw new HTTPException(502, { message: error.message });
      throw error;
    }
  })
  .patch("/insurance-rates/:id", requirePermission("hr:employee:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw new HTTPException(403, { message: "只有全平台 HR 管理者可以維護級距。" });
    const input = await body(c);
    return c.json(await updateHrInsuranceRateTable(c.get("db"), c.req.param("id"), {
      sourceUrl: insuranceRateSource(input), note: noteValue(input), brackets: insuranceRateBrackets(input), expectedContentHash: expectedRateContentHash(input),
    }, c.get("user")));
  })
  .delete("/insurance-rates/:id", requirePermission("hr:employee:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw new HTTPException(403, { message: "只有全平台 HR 管理者可以維護級距。" });
    const input = await body(c);
    return c.json(await deleteHrInsuranceRateTable(c.get("db"), c.req.param("id"), c.get("user"), expectedRateContentHash(input)));
  })
  .post("/insurance-rates/:id/activate", requirePermission("hr:employee:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw new HTTPException(403, { message: "只有全平台 HR 管理者可以啟用級距。" });
    const input = await body(c);
    return c.json(await activateHrInsuranceRateTable(c.get("db"), c.req.param("id"), c.get("user"), expectedRateContentHash(input)));
  })
  .get("/insurance-brackets", requirePermission("hr:employee:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const fallback = currentTaipeiYearMonth().year;
    const year = calendarNumber(c.req.query("year"), fallback, "年份", 1900, 9999);
    try {
      return c.json({ tables: await fetchHrInsuranceBrackets(year) });
    } catch (error) {
      if (error instanceof HrInsuranceRateError) throw new HTTPException(502, { message: error.message });
      throw error;
    }
  })
  .get("/payroll/monthly-data/leave-types", requirePermission("hr:payroll:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    return c.json({ leaveTypes: await listHrLeaveTypes(c.get("db")) });
  })
  .post("/payroll/monthly-data/leave-types", requirePermission("hr:payroll:calculate"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    return c.json(await createHrLeaveType(c.get("db"), { name: text(input, "name", "假別名稱", 80), defaultPayRatePpm: integerValue(input, "defaultPayRatePpm", "預設給薪比例（ppm）", 0, 1_000_000) }, c.get("user")), 201);
  })
  .get("/payroll/monthly-data", requirePermission("hr:payroll:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    return c.json(await listHrMonthlyData(c.get("db"), periodKey({ periodKey: c.req.query("periodKey") ?? "" }), c.req.query("employeeUserId")));
  })
  .post("/payroll/monthly-data/leave", requirePermission("hr:payroll:calculate"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    return c.json(await createHrMonthlyLeave(c.get("db"), {
      employmentId: text(input, "employmentId", "員工任職"), leaveTypeId: text(input, "leaveTypeId", "假別"), leaveDate: date(input, "leaveDate")!,
      hoursHalfUnits: integerValue(input, "hoursHalfUnits", "假勤時數（半小時）", 1, 48), payRatePpm: integerValue(input, "payRatePpm", "給薪比例（ppm）", 0, 1_000_000),
      deductionAmount: integerValue(input, "deductionAmount", "扣款金額（元）", 0, Number.MAX_SAFE_INTEGER), note: noteValue(input),
    }, c.get("user")), 201);
  })
  .patch("/payroll/monthly-data/leave/:id", requirePermission("hr:payroll:calculate"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    return c.json(await updateHrMonthlyLeave(c.get("db"), c.req.param("id"), {
      employmentId: text(input, "employmentId", "員工任職"), leaveTypeId: text(input, "leaveTypeId", "假別"), leaveDate: date(input, "leaveDate")!,
      hoursHalfUnits: integerValue(input, "hoursHalfUnits", "假勤時數（半小時）", 1, 48), payRatePpm: integerValue(input, "payRatePpm", "給薪比例（ppm）", 0, 1_000_000),
      deductionAmount: integerValue(input, "deductionAmount", "扣款金額（元）", 0, Number.MAX_SAFE_INTEGER), note: noteValue(input), revision: revision(input),
    }, c.get("user")));
  })
  .post("/payroll/monthly-data/hourly", requirePermission("hr:payroll:calculate"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    const noWork = booleanValue(input, "noWork", "本期無工時", false);
    return c.json(await createHrMonthlyHourly(c.get("db"), {
      employmentId: text(input, "employmentId", "員工任職"), workDate: date(input, "workDate")!, hoursHalfUnits: integerValue(input, "hoursHalfUnits", "工時（半小時）", 0, 48), noWork, note: noteValue(input),
    }, c.get("user")), 201);
  })
  .patch("/payroll/monthly-data/hourly/:id", requirePermission("hr:payroll:calculate"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    const noWork = booleanValue(input, "noWork", "本期無工時", false);
    return c.json(await updateHrMonthlyHourly(c.get("db"), c.req.param("id"), {
      employmentId: text(input, "employmentId", "員工任職"), workDate: date(input, "workDate")!, hoursHalfUnits: integerValue(input, "hoursHalfUnits", "工時（半小時）", 0, 48), noWork, note: noteValue(input), revision: revision(input),
    }, c.get("user")));
  })
  .get("/payroll/adjustments", requirePermission("hr:payroll:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const effectivePeriodKey = c.req.query("effectivePeriodKey");
    const rows = await listHrPayrollAdjustments(c.get("db"), effectivePeriodKey);
    return c.json({ adjustments: rows.map((row) => ({ ...row.adjustment, employeeName: row.employeeName, items: row.items })) });
  })
  .post("/payroll/adjustments", requirePermission("hr:payroll:calculate"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    return c.json(await createHrPayrollAdjustment(c.get("db"), { employmentId: text(input, "employmentId", "員工任職"), sourcePeriodKey: text(input, "sourcePeriodKey", "原薪資月份", 7), effectivePeriodKey: text(input, "effectivePeriodKey", "生效薪資月份", 7), reason: text(input, "reason", "調整原因", 1000), items: adjustmentItems(input) }, c.get("user")), 201);
  })
  .patch("/payroll/adjustments/:id", requirePermission("hr:payroll:calculate"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    return c.json(await updateHrPayrollAdjustment(c.get("db"), c.req.param("id"), { employmentId: text(input, "employmentId", "員工任職"), sourcePeriodKey: text(input, "sourcePeriodKey", "原薪資月份", 7), effectivePeriodKey: text(input, "effectivePeriodKey", "生效薪資月份", 7), reason: text(input, "reason", "調整原因", 1000), items: adjustmentItems(input), revision: revision(input) }, c.get("user")));
  })
  .get("/payroll/runs", requirePermission("hr:payroll:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    return c.json({ runs: await listHrPayrollRuns(c.get("db")) });
  })
  .get("/payroll/runs/:id", requirePermission("hr:payroll:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    return c.json({ run: await getHrPayrollRun(c.get("db"), c.req.param("id")) });
  })
  .post("/payroll/runs/:id/close", requirePermission("hr:payroll:calculate"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    return c.json({ run: await closeHrPayrollRun(c.get("db"), c.req.param("id"), c.get("user")) });
  })
  .post("/payroll/calculate",  requirePermission("hr:payroll:calculate"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    const selectedUsers = input.employeeUserIds === undefined ? undefined : input.employeeUserIds;
    if (selectedUsers !== undefined && (!Array.isArray(selectedUsers) || selectedUsers.length > 100 || selectedUsers.some((id) => typeof id !== "string" || !id))) {
      throw new HTTPException(400, { message: "指定員工清單不正確。" });
    }
    const mode = input.attendanceMode === undefined || input.attendanceMode === "all" || input.attendanceMode === "general" || input.attendanceMode === "scheduled" ? input.attendanceMode : null;
    if (mode === null) throw new HTTPException(400, { message: "員工出勤方式篩選不正確。" });
    const payDate = input.payDate === undefined ? undefined : date(input, "payDate");
    return c.json({ run: await calculateHrPayroll(c.get("db"), {
      periodKey: periodKey(input), payDate: payDate ?? undefined, employeeUserIds: selectedUsers as string[] | undefined,
      attendanceMode: mode, requestId: input.requestId === undefined ? undefined : text(input, "requestId", "請求識別碼", 200),
      monthlyDivisorDays: optionalInteger(input, "monthlyDivisorDays", "月薪除數", 1, 366),
      standardDailyHours: input.standardDailyHours === undefined ? undefined : Number(input.standardDailyHours),
    }, c.get("user")) });
  })
  .get("/bonus/policies", requirePermission("hr:bonus:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const page = Number(c.req.query("page") ?? 1);
    const pageSize = Number(c.req.query("pageSize") ?? 25);
    const search = c.req.query("search")?.trim() ?? "";
    const scopeId = c.req.query("scopeId") ?? "all";
    const rawBonusKind = c.req.query("bonusKind") ?? "all";
    const rawPerformancePeriod = c.req.query("performancePeriod") ?? "all";
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !HR_BONUS_POLICY_PAGE_SIZES.includes(pageSize as (typeof HR_BONUS_POLICY_PAGE_SIZES)[number]) || search.length > 100) throw new HTTPException(400, { message: "獎金查詢條件不正確。" });
    if (rawBonusKind !== "all" && rawBonusKind !== "team_performance" && rawBonusKind !== "individual_performance") throw new HTTPException(400, { message: "績效歸屬篩選條件不正確。" });
    if (rawPerformancePeriod !== "all" && rawPerformancePeriod !== "current_month" && rawPerformancePeriod !== "previous_month") throw new HTTPException(400, { message: "業績期間篩選條件不正確。" });
    return c.json(await listHrBonusPolicies(c.get("db"), { page, pageSize, search, scopeId, bonusKind: rawBonusKind, performancePeriod: rawPerformancePeriod }));
  })
  .post("/bonus/policies", requirePermission("hr:bonus:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    return c.json(await createHrBonusPolicy(c.get("db"), {
      name: text(input, "name", "獎金名稱", 100), scopeId: input.scopeId === undefined ? undefined : text(input, "scopeId", "適用通路"), scopeIds: bonusScopeIds(input),
      bonusKind: bonusKind(input), performancePeriod: performancePeriod(input), ratePpm: integerValue(input, "ratePpm", "獎金比例（ppm）", 0, 1_000_000), guaranteeMinor: integerValue(input, "guaranteeMinor", "保底金額（分）", 0, Number.MAX_SAFE_INTEGER), employeeUserIds: employeeUserIds(input), employeeAssignments: bonusEmployeeAssignments(input), assignmentValidFrom: input.assignmentValidFrom === undefined ? undefined : date(input, "assignmentValidFrom")!,
    }, c.get("user")), 201);
  })
  .patch("/bonus/policies/:versionId", requirePermission("hr:bonus:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    return c.json(await updateHrBonusPolicy(c.get("db"), {
      policyVersionId: c.req.param("versionId"), name: text(input, "name", "獎金名稱", 100), scopeId: input.scopeId === undefined ? undefined : text(input, "scopeId", "適用通路"), scopeIds: bonusScopeIds(input),
      bonusKind: bonusKind(input), performancePeriod: performancePeriod(input), ratePpm: integerValue(input, "ratePpm", "獎金比例（ppm）", 0, 1_000_000), guaranteeMinor: integerValue(input, "guaranteeMinor", "保底金額（分）", 0, Number.MAX_SAFE_INTEGER), validFrom: date(input, "validFrom")!, employeeUserIds: employeeUserIds(input), employeeAssignments: bonusEmployeeAssignments(input), assignmentValidFrom: input.assignmentValidFrom === undefined ? undefined : date(input, "assignmentValidFrom")!,
    }, c.get("user")));
  })
  .delete("/bonus/policies/:versionId", requirePermission("hr:bonus:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    return c.json(await deleteHrBonusPolicy(c.get("db"), c.req.param("versionId"), c.get("user")));
  })
  .post("/bonus/policies/:versionId/void", requirePermission("hr:bonus:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    return c.json(await voidHrBonusPolicyVersion(c.get("db"), c.req.param("versionId"), c.get("user")));
  })
  .get("/bonus/assignments", requirePermission("hr:bonus:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    return c.json({ assignments: await listHrBonusAssignments(c.get("db")) });
  })
  .post("/bonus/policies/:versionId/members", requirePermission("hr:bonus:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    return c.json(await assignHrBonusPolicyMember(c.get("db"), {
      policyVersionId: c.req.param("versionId"), employeeUserId: text(input, "employeeUserId", "員工"), validFrom: date(input, "validFrom")!, validTo: date(input, "validTo", true), weightUnits: input.weightUnits === undefined ? undefined : integerValue(input, "weightUnits", "權重", 1, 1000),
    }, c.get("user")), 201);
  })
  .get("/employees", requireAnyPermission("hr:employee:read", "hr:office:read"), async (c) => {
    const page = calendarNumber(c.req.query("page"), 1, "頁碼", 1, 10000);
    const rawPageSize = c.req.query("pageSize");
    const pageSize = rawPageSize === undefined ? 25 : Number(rawPageSize);
    if (!HR_EMPLOYEE_PAGE_SIZES.includes(pageSize as (typeof HR_EMPLOYEE_PAGE_SIZES)[number])) throw new HTTPException(400, { message: "每頁筆數不正確。" });
    const status = c.req.query("status") ?? "all";
    if (status !== "all" && status !== "employable" && status !== "active" && status !== "invited" && status !== "disabled") throw new HTTPException(400, { message: "員工狀態不正確。" });
    const sortField = c.req.query("sortField") ?? "employeeNumber";
    if (sortField !== "employeeNumber" && sortField !== "name" && sortField !== "email" && sortField !== "status") throw new HTTPException(400, { message: "排序欄位不正確。" });
    const sortDirection = c.req.query("sortDirection") === "desc" ? "desc" : "asc";
    const search = c.req.query("search")?.trim() ?? "";
    if (search.length > 100) throw new HTTPException(400, { message: "搜尋條件不正確。" });
    return c.json(await listHrEmployees(c.get("db"), { page, pageSize, search, status, sortField, sortDirection }));
  })
  .get("/supervisor-candidates", requirePermission("hr:employee:write"), async (c) => c.json({ users: await listHrSupervisorCandidates(c.get("db"), c.req.query("exclude") ?? c.get("user").id) }))
  .get("/employees/:id", requireAnyPermission("hr:employee:read", "hr:office:read"), async (c) => {
    const fullAccess = await isHrAdministrator(c.get("db"), c.get("user").id);
    return c.json(await getHrEmployee(c.get("db"), c.req.param("id"), {
      // 只靠 hr:office:read 進來的人只拿員工、任職與出勤設定，營運 scope 歷史不給。
      includeScopeAssignments: can(c.get("user"), "hr:employee:read"),
      includeCompensation: fullAccess, includeInsurance: fullAccess, includeLeave: fullAccess, includeAttendanceEvents: fullAccess,
    }));
  })
  .post("/employees", requirePermission("hr:employee:write"), async (c) => {
    const input = await body(c);
    const hiredOn = date(input, "hiredOn")!;
    const seniorityStartOn = date(input, "seniorityStartOn")!;
    if (seniorityStartOn > hiredOn) throw new HTTPException(400, { message: "年資認列日起不得晚於到職日。" });
    return c.json(await assignHrEmployee(c.get("db"), { userId: text(input, "userId", "使用者"), employeeNumber: text(input, "employeeNumber", "員工編號", 40), hiredOn, seniorityStartOn, attendanceMode: attendanceMode(input, true) }, c.get("user")), 201);
  })
  .patch("/employees/:id", requirePermission("hr:employee:write"), async (c) => {
    const input = await body(c);
    return c.json(await updateHrEmployee(c.get("db"), c.req.param("id"), { employeeNumber: text(input, "employeeNumber", "員工編號", 40), revision: revision(input) }, c.get("user")));
  })
  .patch("/employees/:id/supervisor", requirePermission("hr:employee:write"), async (c) => {
    const input = await body(c);
    return c.json(await updateHrEmployeeSupervisor(c.get("db"), c.req.param("id"), { supervisorUserId: nullableText(input, "supervisorUserId", "主管"), revision: revision(input) }, c.get("user")));
  })
  .post("/employments/:id/compensation", requirePermission("hr:employee:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw new HTTPException(403, { message: "只有全平台 HR 管理者可以管理薪資資料。" });
    const input = await body(c);
    const validFrom = date(input, "validFrom")!;
    const validTo = date(input, "validTo", true);
    period(validFrom, validTo);
    return c.json(await createHrCompensationVersion(c.get("db"), {
      employmentId: c.req.param("id"), validFrom, validTo, payBasis: payBasis(input),
      baseAmountMinor: integerValue(input, "baseAmountMinor", "薪資金額（分）", 0, Number.MAX_SAFE_INTEGER), note: noteValue(input), items: compensationItems(input),
    }, c.get("user")), 201);
  })
  .post("/employments/:id/compensation/:versionId/void", requirePermission("hr:employee:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw new HTTPException(403, { message: "只有全平台 HR 管理者可以管理薪資資料。" });
    return c.json(await voidHrCompensationVersion(c.get("db"), c.req.param("id"), c.req.param("versionId"), c.get("user")));
  })
  .post("/employments/:id/insurance/estimate", requirePermission("hr:employee:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw new HTTPException(403, { message: "只有全平台 HR 管理者可以試算勞健保金額。" });
    const input = await body(c);
    const validFrom = date(input, "validFrom")!;
    if (!Array.isArray(input.versions) || input.versions.length < 1 || input.versions.length > 2) throw new HTTPException(400, { message: "試算投保版本格式不正確。" });
    const versions = input.versions.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HTTPException(400, { message: `第 ${index + 1} 筆試算投保版本格式不正確。` });
      const item = raw as Record<string, unknown>;
      const scheme = insuranceScheme(item);
      const status = insuranceStatus(item);
      return {
        scheme, status,
        insuredAmountMinor: status === "withdrawn" ? 0 : integerValue(item, "insuredAmountMinor", "投保金額（分）", 0, Number.MAX_SAFE_INTEGER),
        dependentCount: scheme === "health" ? integerValue(item, "dependentCount", "眷屬人數", 0, 3) : 0,
      };
    });
    return c.json({ estimates: await estimateHrInsuranceContributions(c.get("db"), { validFrom, versions }) });
  })
  .post("/employments/:id/insurance", requirePermission("hr:employee:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw new HTTPException(403, { message: "只有全平台 HR 管理者可以管理勞健保資料。" });
    const input = await body(c);
    // 勞保與健保在同一個 Dialog 編輯，一次送進來才能在同一個 batch 裡要嘛都寫、要嘛都不寫。
    if (!Array.isArray(input.versions) || input.versions.length < 1 || input.versions.length > 2) throw new HTTPException(400, { message: "投保版本格式不正確。" });
    const versions = input.versions.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HTTPException(400, { message: `第 ${index + 1} 筆投保版本格式不正確。` });
      const item = raw as Record<string, unknown>;
      const scheme = insuranceScheme(item);
      const status = insuranceStatus(item);
      const validFrom = date(item, "validFrom")!;
      const validTo = date(item, "validTo", true);
      period(validFrom, validTo);
      const sourceKind: "manual" | "official" | null = item.sourceKind === "manual" ? "manual" : item.sourceKind === "official" ? "official" : null;
      if (!sourceKind) throw new HTTPException(400, { message: "級距來源不正確。" });
      return {
        employmentId: c.req.param("id"), scheme, status, validFrom, validTo,
        insuredAmountMinor: status === "withdrawn" ? 0 : integerValue(item, "insuredAmountMinor", "投保金額（分）", 0, Number.MAX_SAFE_INTEGER),
        dependentCount: scheme === "health" ? integerValue(item, "dependentCount", "眷屬人數", 0, 3) : 0,
        rateYear: integerValue(item, "rateYear", "級距年度", 1900, 9999), sourceKind,
        // 人工覆寫與退保沒有官方來源，Dialog 送 ""；官方來源必填由 db 層檢查。
        sourceUrl: nullableText(item, "sourceUrl", "資料來源", 500) ?? "", note: noteValue(item),
      };
    });
    return c.json(await createHrInsuranceVersions(c.get("db"), versions, c.get("user")), 201);
  })
  .post("/employments", requirePermission("hr:employee:write"), async (c) => {
    const input = await body(c);
    const hiredOn = date(input, "hiredOn")!;
    const endedOn = date(input, "endedOn", true);
    const seniorityStartOn = date(input, "seniorityStartOn")!;
    period(hiredOn, endedOn);
    if (seniorityStartOn > hiredOn) throw new HTTPException(400, { message: "年資認列日起不得晚於到職日。" });
    return c.json(await createHrEmployment(c.get("db"), { userId: text(input, "userId", "員工"), hiredOn, endedOn, seniorityStartOn, attendanceMode: attendanceMode(input, true) }, c.get("user")), 201);
  })
  .patch("/employments/:id/attendance-mode", requirePermission("hr:office:write"), async (c) => {
    const input = await body(c);
    const selectedMode = attendanceMode(input);
    // 沒帶 monthlyRestDays 的舊呼叫只改出勤方式，保留原本的休假天數；清成 NULL 會讓排班發布的休假檢查整個跳過。
    const monthlyRestDays = selectedMode === "general" ? null : input.monthlyRestDays === undefined ? undefined : integerValue(input, "monthlyRestDays", "每月休假天數", 0, 31);
    return c.json(await updateHrEmploymentAttendanceMode(c.get("db"), c.req.param("id"), { attendanceMode: selectedMode, monthlyRestDays, revision: revision(input) }, c.get("user")));
  })
  .patch("/employments/:id/end", requirePermission("hr:employee:write"), async (c) => {
    const input = await body(c);
    return c.json(await endHrEmployment(c.get("db"), c.req.param("id"), { endedOn: date(input, "endedOn")!, revision: revision(input) }, c.get("user")));
  })
  .post("/assignments", requirePermission("hr:employee:write"), async (c) => {
    const input = await body(c);
    const validFrom = date(input, "validFrom")!;
    const validTo = date(input, "validTo", true);
    period(validFrom, validTo);
    return c.json(await createHrAssignment(c.get("db"), { employmentId: text(input, "employmentId", "任職紀錄"), scopeId: text(input, "scopeId", "櫃點"), validFrom, validTo }, c.get("user")), 201);
  })
  .patch("/assignments/:id/end", requirePermission("hr:employee:write"), async (c) => {
    const input = await body(c);
    return c.json(await endHrAssignment(c.get("db"), c.req.param("id"), { validTo: date(input, "validTo")!, revision: revision(input) }, c.get("user")));
  });
