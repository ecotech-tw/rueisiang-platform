import { can } from "@rueisiang/auth";
import {
  HrError, HrInsuranceRateError, HR_EMPLOYEE_PAGE_SIZES, assignHrEmployee, checkHrClockLocation, createHrAssignment, createHrAttendanceLocation, createHrAttendanceLocationAssignment, createHrClockEvent,
  createHrCompensationVersion, createHrEmployment, createHrFormRequest, createHrInsuranceVersion, endHrAssignment, endHrAttendanceLocationAssignment, endHrEmployment, getHrAttendanceLocation, getHrClockCalendar, getHrClockMapCenters,
  fetchHrInsuranceBrackets, getHrClockStatus, getHrEmployee, getHrFormRequest, getHrSelf, setHrAttendanceLocationPrimary,
  isHrAdministrator,
  listHrAttendanceLocations, listHrCandidates, listHrEmployees, listHrFormApprovers, listHrFormRequests,
  listHrScopes, listHrSupervisorCandidates, reviewHrFormRequest,
  assignHrBonusPolicyMember, calculateHrBonusPool, calculateHrPayroll, createHrBonusPerformanceSnapshot, createHrBonusPolicy, deleteHrBonusPolicy, getHrBonusPool, HR_BONUS_POLICY_PAGE_SIZES, updateHrBonusPolicy, getHrPayrollRun, listHrBonusAssignments, listHrBonusPerformanceSnapshots, listHrBonusPolicies, listHrBonusPools, listHrPayrollRuns,
  submitHrFormRequest, updateHrAttendanceLocation, updateHrEmployee,
  updateHrEmployeeSupervisor, updateHrEmploymentAttendanceMode, updateHrFormRequest,
} from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { GoogleMapsSearchError, searchGooglePlaces } from "../google-maps.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
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
  const parsed = new Date(`${correctionDate}T${requestedTime}:00+08:00`);
  if (Number.isNaN(parsed.getTime())) throw new HTTPException(400, { message: "補打卡日期與時間不正確。" });
  return { correctionDate, requestedAt: parsed.toISOString().slice(0, 19).replace("T", " ") };
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
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
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
  if (!Array.isArray(input.employeeUserIds) || input.employeeUserIds.some((value) => typeof value !== "string" || value.trim() === "" || value.length > 200)) throw new HTTPException(400, { message: "指派員工格式不正確。" });
  return input.employeeUserIds as string[];
}
function noteValue(input: Record<string, unknown>) {
  return input.note === undefined || input.note === null ? "" : text(input, "note", "備註", 1000);
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

export const hr = new Hono<AppEnv>()
  .use("*", requireAuth)
  .onError((error, c) => {
    if (error instanceof HrError || error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    throw error;
  })
  // 本人資格來自員工關聯而不是手動授權；requireAuth 仍每次檢查帳號是否啟用。
  .get("/me", async (c) => c.json({ profile: await getHrSelf(c.get("db"), c.get("user").id) }))
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
  .get("/attendance-settings/locations", requirePermission("hr:office:read"), async (c) => c.json(await listHrAttendanceLocations(c.get("db"))))
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
  .get("/insurance-brackets", requirePermission("hr:employee:read"), async (c) => {
    const fallback = currentTaipeiYearMonth().year;
    const year = calendarNumber(c.req.query("year"), fallback, "年份", 1900, 9999);
    try {
      return c.json({ tables: await fetchHrInsuranceBrackets(year) });
    } catch (error) {
      if (error instanceof HrInsuranceRateError) throw new HTTPException(502, { message: error.message });
      throw error;
    }
  })
  .get("/payroll/runs", requirePermission("hr:payroll:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    return c.json({ runs: await listHrPayrollRuns(c.get("db")) });
  })
  .get("/payroll/runs/:id", requirePermission("hr:payroll:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    return c.json({ run: await getHrPayrollRun(c.get("db"), c.req.param("id")) });
  })
  .post("/payroll/calculate", requirePermission("hr:payroll:calculate"), async (c) => {
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
      bonusPoolId: input.bonusPoolId === undefined ? undefined : text(input, "bonusPoolId", "獎金池"),
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
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !HR_BONUS_POLICY_PAGE_SIZES.includes(pageSize as (typeof HR_BONUS_POLICY_PAGE_SIZES)[number]) || search.length > 100) throw new HTTPException(400, { message: "獎金政策查詢條件不正確。" });
    if (rawBonusKind !== "all" && rawBonusKind !== "team_performance" && rawBonusKind !== "individual_performance") throw new HTTPException(400, { message: "績效歸屬篩選條件不正確。" });
    if (rawPerformancePeriod !== "all" && rawPerformancePeriod !== "current_month" && rawPerformancePeriod !== "previous_month") throw new HTTPException(400, { message: "業績期間篩選條件不正確。" });
    return c.json(await listHrBonusPolicies(c.get("db"), { page, pageSize, search, scopeId, bonusKind: rawBonusKind, performancePeriod: rawPerformancePeriod }));
  })
  .post("/bonus/policies", requirePermission("hr:bonus:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    return c.json(await createHrBonusPolicy(c.get("db"), {
      name: text(input, "name", "政策名稱", 100), scopeId: text(input, "scopeId", "適用通路"),
      bonusKind: bonusKind(input), performancePeriod: performancePeriod(input), ratePpm: integerValue(input, "ratePpm", "獎金比例（ppm）", 0, 1_000_000), guaranteeMinor: integerValue(input, "guaranteeMinor", "保底金額（分）", 0, Number.MAX_SAFE_INTEGER), employeeUserIds: employeeUserIds(input), assignmentValidFrom: input.assignmentValidFrom === undefined ? undefined : date(input, "assignmentValidFrom")!,
    }, c.get("user")), 201);
  })
  .patch("/bonus/policies/:versionId", requirePermission("hr:bonus:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    return c.json(await updateHrBonusPolicy(c.get("db"), {
      policyVersionId: c.req.param("versionId"), name: text(input, "name", "政策名稱", 100), scopeId: text(input, "scopeId", "適用通路"),
      bonusKind: bonusKind(input), performancePeriod: performancePeriod(input), ratePpm: integerValue(input, "ratePpm", "獎金比例（ppm）", 0, 1_000_000), guaranteeMinor: integerValue(input, "guaranteeMinor", "保底金額（分）", 0, Number.MAX_SAFE_INTEGER), validFrom: date(input, "validFrom")!, employeeUserIds: employeeUserIds(input), assignmentValidFrom: input.assignmentValidFrom === undefined ? undefined : date(input, "assignmentValidFrom")!,
    }, c.get("user")));
  })
  .delete("/bonus/policies/:versionId", requirePermission("hr:bonus:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    return c.json(await deleteHrBonusPolicy(c.get("db"), c.req.param("versionId"), c.get("user")));
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
  .get("/bonus/performance", requirePermission("hr:bonus:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const raw = c.req.query("periodKey");
    if (raw !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) throw new HTTPException(400, { message: "業績月份必須是 YYYY-MM。" });
    return c.json({ snapshots: await listHrBonusPerformanceSnapshots(c.get("db"), raw) });
  })
  .post("/bonus/performance", requirePermission("hr:bonus:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    const sourceKind = input.sourceKind === undefined || input.sourceKind === "manual" || input.sourceKind === "report" ? input.sourceKind ?? "manual" : null;
    if (!sourceKind) throw new HTTPException(400, { message: "業績來源不正確。" });
    return c.json(await createHrBonusPerformanceSnapshot(c.get("db"), {
      scopeId: text(input, "scopeId", "適用通路"), employeeUserId: nullableText(input, "employeeUserId", "個人員工"), periodKey: periodKey(input), amountMinor: integerValue(input, "amountMinor", "業績金額（分）", 0, Number.MAX_SAFE_INTEGER), sourceKind, sourceRef: input.sourceRef === undefined ? "" : text(input, "sourceRef", "來源識別碼", 200),
    }, c.get("user")), 201);
  })
  .get("/bonus/pools", requirePermission("hr:bonus:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const raw = c.req.query("periodKey");
    if (raw !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) throw new HTTPException(400, { message: "計算月份必須是 YYYY-MM。" });
    return c.json({ pools: await listHrBonusPools(c.get("db"), raw) });
  })
  .get("/bonus/pools/:id", requirePermission("hr:bonus:read"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    return c.json({ pool: await getHrBonusPool(c.get("db"), c.req.param("id")) });
  })
  .post("/bonus/pools/calculate", requirePermission("hr:bonus:calculate"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw hrAdminMessage();
    const input = await body(c);
    if (!Array.isArray(input.revenue) || input.revenue.length > 366) throw new HTTPException(400, { message: "請提供指定月份的每日核准業績快照。" });
    const revenue = input.revenue.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HTTPException(400, { message: `第 ${index + 1} 筆業績格式不正確。` });
      const item = raw as Record<string, unknown>;
      const sourceKind = item.sourceKind === undefined || item.sourceKind === "manual" || item.sourceKind === "report" ? item.sourceKind : null;
      if (sourceKind === null) throw new HTTPException(400, { message: `第 ${index + 1} 筆業績來源不正確。` });
      const provenance = item.provenance && typeof item.provenance === "object" && !Array.isArray(item.provenance) ? item.provenance as Record<string, unknown> : {};
      return {
        businessDate: date(item, "businessDate")!, amountMinor: integerValue(item, "amountMinor", "業績金額（分）", 0, Number.MAX_SAFE_INTEGER),
        sourceKind, sourceRef: item.sourceRef === undefined ? undefined : text(item, "sourceRef", "來源識別碼", 200), provenance,
      } as const;
    });
    return c.json({ pool: await calculateHrBonusPool(c.get("db"), { policyVersionId: text(input, "policyVersionId", "獎金政策版本"), periodKey: periodKey(input), revenue }, c.get("user")) }, 201);
  })
  .get("/employees", requirePermission("hr:employee:read"), async (c) => {
    const page = calendarNumber(c.req.query("page"), 1, "頁碼", 1, 10000);
    const rawPageSize = c.req.query("pageSize");
    const pageSize = rawPageSize === undefined ? 25 : Number(rawPageSize);
    if (!HR_EMPLOYEE_PAGE_SIZES.includes(pageSize as (typeof HR_EMPLOYEE_PAGE_SIZES)[number])) throw new HTTPException(400, { message: "每頁筆數不正確。" });
    const status = c.req.query("status") ?? "all";
    if (status !== "all" && status !== "active" && status !== "invited" && status !== "disabled") throw new HTTPException(400, { message: "員工狀態不正確。" });
    const sortField = c.req.query("sortField") ?? "employeeNumber";
    if (sortField !== "employeeNumber" && sortField !== "name" && sortField !== "email" && sortField !== "status") throw new HTTPException(400, { message: "排序欄位不正確。" });
    const sortDirection = c.req.query("sortDirection") === "desc" ? "desc" : "asc";
    const search = c.req.query("search")?.trim() ?? "";
    if (search.length > 100) throw new HTTPException(400, { message: "搜尋條件不正確。" });
    return c.json(await listHrEmployees(c.get("db"), { page, pageSize, search, status, sortField, sortDirection }));
  })
  .get("/supervisor-candidates", requirePermission("hr:employee:write"), async (c) => c.json({ users: await listHrSupervisorCandidates(c.get("db"), c.req.query("exclude") ?? c.get("user").id) }))
  .get("/employees/:id", requirePermission("hr:employee:read"), async (c) => {
    const fullAccess = await isHrAdministrator(c.get("db"), c.get("user").id);
    return c.json(await getHrEmployee(c.get("db"), c.req.param("id"), {
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
      baseAmountMinor: integerValue(input, "baseAmountMinor", "薪資金額（分）", 0, Number.MAX_SAFE_INTEGER), note: noteValue(input),
    }, c.get("user")), 201);
  })
  .post("/employments/:id/insurance", requirePermission("hr:employee:write"), async (c) => {
    if (!await isHrAdministrator(c.get("db"), c.get("user").id)) throw new HTTPException(403, { message: "只有全平台 HR 管理者可以管理勞健保資料。" });
    const input = await body(c);
    const scheme = insuranceScheme(input);
    const status = insuranceStatus(input);
    const validFrom = date(input, "validFrom")!;
    const validTo = date(input, "validTo", true);
    period(validFrom, validTo);
    const sourceKind = input.sourceKind === "manual" ? "manual" : input.sourceKind === "official" ? "official" : null;
    if (!sourceKind) throw new HTTPException(400, { message: "級距來源不正確。" });
    const dependentCount = scheme === "health" ? integerValue(input, "dependentCount", "眷屬人數", 0, 3) : 0;
    return c.json(await createHrInsuranceVersion(c.get("db"), {
      employmentId: c.req.param("id"), scheme, status, validFrom, validTo,
      insuredAmountMinor: status === "withdrawn" ? 0 : integerValue(input, "insuredAmountMinor", "投保金額（分）", 0, Number.MAX_SAFE_INTEGER),
      dependentCount, rateYear: integerValue(input, "rateYear", "級距年度", 1900, 9999), sourceKind,
      sourceUrl: input.sourceUrl === undefined || input.sourceUrl === null ? "" : text(input, "sourceUrl", "資料來源", 500), note: noteValue(input),
    }, c.get("user")), 201);
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
    return c.json(await updateHrEmploymentAttendanceMode(c.get("db"), c.req.param("id"), { attendanceMode: attendanceMode(input), revision: revision(input) }, c.get("user")));
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
