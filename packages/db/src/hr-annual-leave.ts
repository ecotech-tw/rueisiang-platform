import { and, asc, desc, eq, gt, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import { inJsonArray } from "./sql-lists.js";
import { HrError, hrEmployeeName, hrEmployeeNumberOrder, writeHrMutation, type HrActor } from "./hr-people.js";
import { hrEmploymentServicePeriods, hrEmployments } from "./schema/hr-people.js";
import { hrAnnualLeaveBrackets, hrAnnualLeaveEntitlements, hrAnnualLeaveLedger, hrAnnualLeavePolicyVersions, hrCompensationVersions, hrLeaveTypes } from "./schema/hr-payroll.js";
import { users } from "./schema/auth.js";

export const ANNUAL_LEAVE_HALF_HOUR_MINUTES = 30;
export const ANNUAL_LEAVE_POLICY_KEY = "annual_leave";

export interface HrAnnualLeaveBackfillOptions {
  /** 測試與批次回填可固定觀察日；正式呼叫預設採 UTC 日期。 */
  asOfDate?: string;
  createdBy?: string | null;
  /** 只補建這位員工的週期；查單一員工時不需要為了一次讀取掃過全公司。 */
  employeeUserId?: string;
}

export interface HrAnnualLeaveAllocationInput {
  employmentId: string;
  startsOn: string;
  endsOn: string;
  durationMinutes: number;
}

export interface HrAnnualLeaveAllocation {
  entitlementId: string;
  durationHalfHours: number;
  periodStart: string;
  periodEnd: string;
  balanceHalfHours: number;
}

export interface HrAnnualLeaveSettlementCandidate {
  entitlementId: string;
  employmentId: string;
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  settlementDate: string;
  settlementReason: "period_end" | "termination";
  unusedHalfHours: number;
  dailyMinutes: number;
  baseAmountMinor: number | null;
  compensationVersionId: string | null;
  amountMinor: number;
  sourceKey: string;
}

export interface HrAnnualLeaveAdjustmentInput {
  entitlementId: string;
  deltaHalfHours: number;
  reason: string;
}

const employeeName = hrEmployeeName;

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function assertDateOnly(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HrError(400, `${label}格式不正確。`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new HrError(400, `${label}不是有效日期。`);
}

function dateParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new HrError(400, "日期格式不正確。");
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function formatDate(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function previousDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function serviceStartOnExpression() {
  return sql<string>`coalesce(
    (SELECT service.service_start_on FROM hr_employment_service_periods AS service WHERE service.employment_id=${hrEmployments.id} LIMIT 1),
    substr(${hrEmployments.createdAt}, 1, 10)
  )`;
}

function monthlyCompensationStartOnExpression() {
  return sql<string | null>`(
    SELECT min(compensation.valid_from)
    FROM hr_compensation_versions AS compensation
    WHERE compensation.employment_id=${hrEmployments.id}
      AND compensation.pay_basis='monthly'
      AND compensation.voided_at IS NULL
  )`;
}

function annualLeaveStartOnExpression() {
  const serviceStartOn = serviceStartOnExpression();
  const monthlyStartOn = monthlyCompensationStartOnExpression();
  return sql<string | null>`CASE
    WHEN ${monthlyStartOn} IS NULL THEN NULL
    WHEN ${monthlyStartOn} > ${serviceStartOn} THEN ${monthlyStartOn}
    ELSE ${serviceStartOn}
  END`;
}

/** 舊版 migration 可能曾只用 serviceStartOn 產生額度；不符合月薪起算序列的舊列保留稽核資料，但不再提供使用。 */
function isAnnualLeavePeriod(row: { annualLeaveStartOn: string | null; periodStart: string; periodEnd: string; serviceMonths: number }) {
  return row.annualLeaveStartOn !== null
    && addCalendarMonths(row.annualLeaveStartOn, row.serviceMonths) === row.periodStart
    && addCalendarMonths(row.annualLeaveStartOn, nextServiceMonths(row.serviceMonths)) === row.periodEnd;
}

/** 日期加月數時保留週年日；2 月 29 日在非閏年落在 2 月最後一天。 */
export function addCalendarMonths(value: string, months: number) {
  const { year, month, day } = dateParts(value);
  const zeroBasedMonth = month - 1 + months;
  const targetYear = year + Math.floor(zeroBasedMonth / 12);
  const targetMonth = ((zeroBasedMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return formatDate(targetYear, targetMonth + 1, Math.min(day, lastDay));
}

function isBeforeOrEqual(left: string, right: string) {
  return left <= right;
}

function nextServiceMonths(serviceMonths: number) {
  return serviceMonths === 6 ? 12 : serviceMonths + 12;
}

async function findPolicyAt(db: Database, date: string) {
  const [policy] = await db.select().from(hrAnnualLeavePolicyVersions)
    .where(and(
      eq(hrAnnualLeavePolicyVersions.policyKey, ANNUAL_LEAVE_POLICY_KEY),
      lte(hrAnnualLeavePolicyVersions.validFrom, date),
      or(isNull(hrAnnualLeavePolicyVersions.validTo), gt(hrAnnualLeavePolicyVersions.validTo, date)),
    ))
    .orderBy(desc(hrAnnualLeavePolicyVersions.validFrom), desc(hrAnnualLeavePolicyVersions.versionNumber))
    .limit(1);
  return policy;
}

async function policyAt(db: Database, date: string) {
  const policy = await findPolicyAt(db, date);
  if (!policy) throw new HrError(409, `找不到 ${date} 適用的特休政策版本。`);
  return policy;
}

async function bracketsForPolicy(db: Database, policyVersionId: string) {
  return db.select().from(hrAnnualLeaveBrackets)
    .where(eq(hrAnnualLeaveBrackets.policyVersionId, policyVersionId))
    .orderBy(asc(hrAnnualLeaveBrackets.minServiceMonths));
}

function findBracket(brackets: Array<typeof hrAnnualLeaveBrackets.$inferSelect>, serviceMonths: number) {
  const bracket = brackets.find((candidate) => candidate.minServiceMonths <= serviceMonths && (candidate.maxServiceMonths === null || serviceMonths < candidate.maxServiceMonths));
  if (!bracket) throw new HrError(409, `特休政策缺少滿 ${serviceMonths} 個月的年資級距。`);
  return bracket;
}

/**
 * 依第一筆有效月薪敘薪的生效日補建週年額度；實際服務起算日只作為薪資在職日的下限。
 * INSERT 與 grant ledger 都使用可重跑的唯一鍵，因此可在部署後、查詢前或排程重複執行。
 */
export async function ensureHrAnnualLeaveEntitlements(db: Database, options: HrAnnualLeaveBackfillOptions = {}) {
  const asOfDate = options.asOfDate ?? todayUtc();
  assertDateOnly(asOfDate, "回填基準日");
  const serviceStartOn = serviceStartOnExpression();
  const monthlyStartOn = monthlyCompensationStartOnExpression();
  const employments = await db.select({
    id: hrEmployments.id,
    serviceStartOn,
    monthlyStartOn,
    archivedAt: hrEmployments.archivedAt,
  }).from(hrEmployments)
    .leftJoin(hrEmploymentServicePeriods, eq(hrEmploymentServicePeriods.employmentId, hrEmployments.id))
    .where(and(lte(serviceStartOn, asOfDate), options.employeeUserId ? eq(hrEmployments.employeeUserId, options.employeeUserId) : undefined));

  let created = 0;
  let grants = 0;
  let eligibleEmploymentCount = 0;
  for (const employment of employments) {
    if (!employment.monthlyStartOn) continue;
    eligibleEmploymentCount += 1;
    const annualLeaveStartOn = employment.monthlyStartOn > employment.serviceStartOn ? employment.monthlyStartOn : employment.serviceStartOn;
    let serviceMonths = 6;
    let periodStart = addCalendarMonths(annualLeaveStartOn, serviceMonths);
    const employmentEnd = employment.archivedAt?.slice(0, 10) ?? null;
    while (isBeforeOrEqual(periodStart, asOfDate) && (!employmentEnd || periodStart < employmentEnd)) {
      const nextMonths = nextServiceMonths(serviceMonths);
      const periodEnd = addCalendarMonths(annualLeaveStartOn, nextMonths);
      // 政策版本開始日前的歷史週期沒有可套用的法定資料；保留日期序列並跳過，讓
      // 年資很久的既有員工仍能從第一個可追溯政策版本開始正確回填目前週期。
      const policy = await findPolicyAt(db, periodStart);
      if (!policy) {
        serviceMonths = nextMonths;
        periodStart = periodEnd;
        continue;
      }
      const brackets = await bracketsForPolicy(db, policy.id);
      const bracket = findBracket(brackets, serviceMonths);
      const entitledHalfHours = bracket.entitledDays * (policy.dailyMinutes / ANNUAL_LEAVE_HALF_HOUR_MINUTES);
      const entitlementId = crypto.randomUUID();

      await db.insert(hrAnnualLeaveEntitlements).values({
        id: entitlementId,
        employmentId: employment.id,
        policyVersionId: policy.id,
        bracketId: bracket.id,
        serviceMonths,
        periodStart,
        periodEnd,
        entitledHalfHours,
        status: "open",
        createdBy: options.createdBy ?? null,
      }).onConflictDoNothing({ target: [
        hrAnnualLeaveEntitlements.employmentId,
        hrAnnualLeaveEntitlements.periodStart,
        hrAnnualLeaveEntitlements.serviceMonths,
        hrAnnualLeaveEntitlements.periodEnd,
      ] });

      const [entitlement] = await db.select({
        id: hrAnnualLeaveEntitlements.id,
        entitledHalfHours: hrAnnualLeaveEntitlements.entitledHalfHours,
      }).from(hrAnnualLeaveEntitlements).where(and(
        eq(hrAnnualLeaveEntitlements.employmentId, employment.id),
        eq(hrAnnualLeaveEntitlements.periodStart, periodStart),
        eq(hrAnnualLeaveEntitlements.serviceMonths, serviceMonths),
        eq(hrAnnualLeaveEntitlements.periodEnd, periodEnd),
      )).limit(1);
      if (!entitlement) throw new HrError(409, "特休額度建立失敗，請稍後重試。");
      if (entitlement.id === entitlementId) created += 1;

      // 舊版 grant key 只有 employment／periodStart；校正後可能同日並存兩個週期，改以完整週期組成新 key。
      const sourceKey = `annual-grant:${employment.id}:${periodStart}:${periodEnd}:${serviceMonths}`;
      const [existingGrant] = await db.select({ id: hrAnnualLeaveLedger.id }).from(hrAnnualLeaveLedger)
        .where(and(
          eq(hrAnnualLeaveLedger.entitlementId, entitlement.id),
          eq(hrAnnualLeaveLedger.entryKind, "grant"),
        )).limit(1);
      if (!existingGrant) {
        await db.insert(hrAnnualLeaveLedger).values({
          id: crypto.randomUUID(),
          entitlementId: entitlement.id,
          entryKind: "grant",
          deltaHalfHours: entitlement.entitledHalfHours,
          sourceKey,
          note: `週年制特休自動給予（${periodStart}～${previousDate(periodEnd)}）`,
          createdBy: options.createdBy ?? null,
        }).onConflictDoNothing({ target: hrAnnualLeaveLedger.sourceKey });
        grants += 1;
      }

      serviceMonths = nextMonths;
      periodStart = periodEnd;
    }
  }
  return { employmentCount: employments.length, eligibleEmploymentCount, created, grants, asOfDate };
}

export async function getHrAnnualLeavePolicy(db: Database, asOfDate = todayUtc()) {
  assertDateOnly(asOfDate, "查詢基準日");
  const policy = await policyAt(db, asOfDate);
  const brackets = await bracketsForPolicy(db, policy.id);
  return { policy, brackets };
}

async function balanceForEntitlement(db: Database, entitlementId: string) {
  const [row] = await db.select({
    balanceHalfHours: sql<number>`coalesce(sum(${hrAnnualLeaveLedger.deltaHalfHours}), 0)`,
  }).from(hrAnnualLeaveLedger).where(eq(hrAnnualLeaveLedger.entitlementId, entitlementId));
  return Number(row?.balanceHalfHours ?? 0);
}

/** 找到可完整涵蓋申請區間的單一期別；跨週年申請需拆成兩張申請，避免總時數無法正確分配到兩期。 */
export async function allocateHrAnnualLeave(db: Database, input: HrAnnualLeaveAllocationInput): Promise<HrAnnualLeaveAllocation> {
  assertDateOnly(input.startsOn, "請假開始日");
  assertDateOnly(input.endsOn, "請假結束日");
  if (input.endsOn <= input.startsOn) throw new HrError(400, "請假日期區間不正確。");
  if (!Number.isSafeInteger(input.durationMinutes) || input.durationMinutes < ANNUAL_LEAVE_HALF_HOUR_MINUTES || input.durationMinutes % ANNUAL_LEAVE_HALF_HOUR_MINUTES !== 0) {
    throw new HrError(400, "特休時數必須是 0.5 小時的倍數。");
  }
  await ensureHrAnnualLeaveEntitlements(db, { asOfDate: input.endsOn });
  const annualLeaveStartOn = annualLeaveStartOnExpression();
  const entitlementCandidates = await db.select({
    id: hrAnnualLeaveEntitlements.id,
    periodStart: hrAnnualLeaveEntitlements.periodStart,
    periodEnd: hrAnnualLeaveEntitlements.periodEnd,
    serviceMonths: hrAnnualLeaveEntitlements.serviceMonths,
    annualLeaveStartOn,
  }).from(hrAnnualLeaveEntitlements)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrAnnualLeaveEntitlements.employmentId))
    .where(and(
      eq(hrAnnualLeaveEntitlements.employmentId, input.employmentId),
      eq(hrAnnualLeaveEntitlements.status, "open"),
      lte(hrAnnualLeaveEntitlements.periodStart, input.startsOn),
      gte(hrAnnualLeaveEntitlements.periodEnd, input.endsOn),
    )).orderBy(desc(hrAnnualLeaveEntitlements.periodStart));
  const entitlement = entitlementCandidates.find(isAnnualLeavePeriod);
  if (!entitlement) throw new HrError(409, "特休申請必須完整落在同一個特休週期內，或目前尚未取得可用額度。");
  const durationHalfHours = input.durationMinutes / ANNUAL_LEAVE_HALF_HOUR_MINUTES;
  const balanceHalfHours = await balanceForEntitlement(db, entitlement.id);
  if (balanceHalfHours < durationHalfHours) throw new HrError(409, "特休可用額度不足。請改申請其他期別或先確認額度調整。");
  return { entitlementId: entitlement.id, periodStart: entitlement.periodStart, periodEnd: entitlement.periodEnd, durationHalfHours, balanceHalfHours };
}

export async function listHrAnnualLeaveEntitlements(db: Database, options: { employeeUserId?: string; asOfDate?: string } = {}) {
  const asOfDate = options.asOfDate ?? todayUtc();
  await ensureHrAnnualLeaveEntitlements(db, { asOfDate, employeeUserId: options.employeeUserId });
  const annualLeaveStartOn = annualLeaveStartOnExpression();
  const rows = await db.select({
    id: hrAnnualLeaveEntitlements.id,
    employmentId: hrAnnualLeaveEntitlements.employmentId,
    employeeUserId: hrEmployments.employeeUserId,
    employeeNumber: hrEmployments.employeeNumber,
    employeeName,
    annualLeaveStartOn,
    serviceMonths: hrAnnualLeaveEntitlements.serviceMonths,
    periodStart: hrAnnualLeaveEntitlements.periodStart,
    periodEnd: hrAnnualLeaveEntitlements.periodEnd,
    entitledHalfHours: hrAnnualLeaveEntitlements.entitledHalfHours,
    dailyMinutes: hrAnnualLeavePolicyVersions.dailyMinutes,
    status: hrAnnualLeaveEntitlements.status,
    settledAt: hrAnnualLeaveEntitlements.settledAt,
  }).from(hrAnnualLeaveEntitlements)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrAnnualLeaveEntitlements.employmentId))
    .innerJoin(hrAnnualLeavePolicyVersions, eq(hrAnnualLeavePolicyVersions.id, hrAnnualLeaveEntitlements.policyVersionId))
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(and(
      isNull(hrEmployments.archivedAt),
      options.employeeUserId ? eq(hrEmployments.employeeUserId, options.employeeUserId) : undefined,
    ))
    .orderBy(...hrEmployeeNumberOrder(), asc(employeeName), asc(hrAnnualLeaveEntitlements.periodStart));
  const eligibleRows = rows.filter(isAnnualLeavePeriod);
  if (!eligibleRows.length) return [];

  const balances = await db.select({
    entitlementId: hrAnnualLeaveLedger.entitlementId,
    balanceHalfHours: sql<number>`coalesce(sum(${hrAnnualLeaveLedger.deltaHalfHours}), 0)`,
    debitHalfHours: sql<number>`coalesce(sum(case when ${hrAnnualLeaveLedger.deltaHalfHours} < 0 then -${hrAnnualLeaveLedger.deltaHalfHours} else 0 end), 0)`,
    // 請假扣抵與取消返還都帶 leave_request_id；人工調整與薪資結算不帶，所以這一項才是「實際請掉的特休」。
    leaveHalfHours: sql<number>`coalesce(sum(case when ${hrAnnualLeaveLedger.leaveRequestId} is not null then -${hrAnnualLeaveLedger.deltaHalfHours} else 0 end), 0)`,
  }).from(hrAnnualLeaveLedger)
    .where(inJsonArray(hrAnnualLeaveLedger.entitlementId, eligibleRows.map((row) => row.id)))
    .groupBy(hrAnnualLeaveLedger.entitlementId);
  const balanceById = new Map(balances.map((row) => [row.entitlementId, {
    balanceHalfHours: Number(row.balanceHalfHours ?? 0),
    debitHalfHours: Number(row.debitHalfHours ?? 0),
    leaveHalfHours: Number(row.leaveHalfHours ?? 0),
  }]));
  return eligibleRows.map((row) => {
    const balance = balanceById.get(row.id) ?? { balanceHalfHours: 0, debitHalfHours: 0, leaveHalfHours: 0 };
    return {
      ...row,
      annualLeaveStartOn: row.annualLeaveStartOn!,
      balanceHalfHours: balance.balanceHalfHours,
      usedHalfHours: Math.max(0, row.entitledHalfHours - balance.balanceHalfHours),
      debitHalfHours: balance.debitHalfHours,
      leaveHalfHours: balance.leaveHalfHours,
    };
  });
}

export async function getHrAnnualLeaveEntitlementDetail(db: Database, entitlementId: string) {
  if (!entitlementId.trim()) throw new HrError(400, "特休額度識別碼不正確。");
  const [row] = await db.select({
    id: hrAnnualLeaveEntitlements.id,
    employmentId: hrAnnualLeaveEntitlements.employmentId,
    employeeUserId: hrEmployments.employeeUserId,
    employeeNumber: hrEmployments.employeeNumber,
    employeeName,
    serviceStartOn: serviceStartOnExpression(),
    annualLeaveStartOn: annualLeaveStartOnExpression(),
    serviceMonths: hrAnnualLeaveEntitlements.serviceMonths,
    periodStart: hrAnnualLeaveEntitlements.periodStart,
    periodEnd: hrAnnualLeaveEntitlements.periodEnd,
    entitledHalfHours: hrAnnualLeaveEntitlements.entitledHalfHours,
    status: hrAnnualLeaveEntitlements.status,
    settledAt: hrAnnualLeaveEntitlements.settledAt,
    policyVersionNumber: hrAnnualLeavePolicyVersions.versionNumber,
    policyValidFrom: hrAnnualLeavePolicyVersions.validFrom,
    policyValidTo: hrAnnualLeavePolicyVersions.validTo,
    policyBasis: hrAnnualLeavePolicyVersions.basis,
    policyDailyMinutes: hrAnnualLeavePolicyVersions.dailyMinutes,
    policyMinimumUnitMinutes: hrAnnualLeavePolicyVersions.minimumUnitMinutes,
    policyCarryoverAllowed: hrAnnualLeavePolicyVersions.carryoverAllowed,
    policyNote: hrAnnualLeavePolicyVersions.note,
    bracketMinServiceMonths: hrAnnualLeaveBrackets.minServiceMonths,
    bracketMaxServiceMonths: hrAnnualLeaveBrackets.maxServiceMonths,
    bracketEntitledDays: hrAnnualLeaveBrackets.entitledDays,
    bracketLabel: hrAnnualLeaveBrackets.label,
  }).from(hrAnnualLeaveEntitlements)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrAnnualLeaveEntitlements.employmentId))
    .leftJoin(hrEmploymentServicePeriods, eq(hrEmploymentServicePeriods.employmentId, hrEmployments.id))
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .innerJoin(hrAnnualLeavePolicyVersions, eq(hrAnnualLeavePolicyVersions.id, hrAnnualLeaveEntitlements.policyVersionId))
    .innerJoin(hrAnnualLeaveBrackets, eq(hrAnnualLeaveBrackets.id, hrAnnualLeaveEntitlements.bracketId))
    .where(and(
      eq(hrAnnualLeaveEntitlements.id, entitlementId),
      isNull(hrEmployments.archivedAt),
    )).limit(1);
  if (!row || !isAnnualLeavePeriod(row)) throw new HrError(404, "找不到特休額度週期。");

  const ledger = await db.select({
    id: hrAnnualLeaveLedger.id,
    entryKind: hrAnnualLeaveLedger.entryKind,
    deltaHalfHours: hrAnnualLeaveLedger.deltaHalfHours,
    sourceKey: hrAnnualLeaveLedger.sourceKey,
    leaveRequestId: hrAnnualLeaveLedger.leaveRequestId,
    note: hrAnnualLeaveLedger.note,
    createdBy: hrAnnualLeaveLedger.createdBy,
    createdAt: hrAnnualLeaveLedger.createdAt,
  }).from(hrAnnualLeaveLedger)
    .where(eq(hrAnnualLeaveLedger.entitlementId, entitlementId))
    .orderBy(asc(hrAnnualLeaveLedger.createdAt), asc(hrAnnualLeaveLedger.id));
  const balanceHalfHours = ledger.reduce((total, entry) => total + entry.deltaHalfHours, 0);
  const debitHalfHours = ledger.reduce((total, entry) => total + (entry.deltaHalfHours < 0 ? -entry.deltaHalfHours : 0), 0);
  return {
    ...row,
    balanceHalfHours,
    usedHalfHours: Math.max(0, row.entitledHalfHours - balanceHalfHours),
    debitHalfHours,
    ledger,
  };
}

/** 取得後轉為日／時薪的員工仍須結清已取得的月薪特休；折現採結算日前最後一筆未撤回月薪，避免整批薪資被空薪資基準阻斷。 */
async function monthlyCompensationAt(db: Database, employmentId: string, date: string) {
  const [compensation] = await db.select({
    id: hrCompensationVersions.id,
    baseAmountMinor: hrCompensationVersions.baseAmountMinor,
  }).from(hrCompensationVersions).where(and(
    eq(hrCompensationVersions.employmentId, employmentId),
    eq(hrCompensationVersions.payBasis, "monthly"),
    lte(hrCompensationVersions.validFrom, date),
    isNull(hrCompensationVersions.voidedAt),
  )).orderBy(desc(hrCompensationVersions.validFrom), desc(hrCompensationVersions.versionNumber)).limit(1);
  return compensation;
}

/**
 * 找出本次薪資期間需要折現的未休特休。periodStart 讓正常薪資結算不會把歷史
 * 尚未對帳的期別一次掛進當期；週期剛好落在 periodStart 時仍要納入，才能補算
 * 漏跑的前一個月份。只把折現的最終寫入留在薪資結帳交易，避免試算尚未結帳就消滅額度。
 */
export async function listHrAnnualLeaveSettlementCandidates(db: Database, options: { asOfDate: string; periodStart?: string; employmentIds?: string[] }) {
  assertDateOnly(options.asOfDate, "特休結算基準日");
  if (options.periodStart !== undefined) assertDateOnly(options.periodStart, "特休結算期間起日");
  if (options.periodStart !== undefined && options.periodStart >= options.asOfDate) throw new HrError(400, "特休結算期間不正確。");
  if (options.employmentIds?.length === 0) return [];
  const rows = await db.select({
    entitlementId: hrAnnualLeaveEntitlements.id,
    employmentId: hrAnnualLeaveEntitlements.employmentId,
    employeeName,
    annualLeaveStartOn: annualLeaveStartOnExpression(),
    serviceMonths: hrAnnualLeaveEntitlements.serviceMonths,
    periodStart: hrAnnualLeaveEntitlements.periodStart,
    periodEnd: hrAnnualLeaveEntitlements.periodEnd,
    archivedAt: hrEmployments.archivedAt,
    dailyMinutes: hrAnnualLeavePolicyVersions.dailyMinutes,
  }).from(hrAnnualLeaveEntitlements)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrAnnualLeaveEntitlements.employmentId))
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .innerJoin(hrAnnualLeavePolicyVersions, eq(hrAnnualLeavePolicyVersions.id, hrAnnualLeaveEntitlements.policyVersionId))
    .where(and(
      eq(hrAnnualLeaveEntitlements.status, "open"),
      isNull(hrAnnualLeaveEntitlements.settledAt),
      or(
        options.periodStart === undefined
          ? lte(hrAnnualLeaveEntitlements.periodEnd, options.asOfDate)
          : and(gte(hrAnnualLeaveEntitlements.periodEnd, options.periodStart), lte(hrAnnualLeaveEntitlements.periodEnd, options.asOfDate)),
        options.periodStart === undefined
          ? sql`${hrEmployments.archivedAt} IS NOT NULL AND substr(${hrEmployments.archivedAt}, 1, 10) <= ${options.asOfDate}`
          : sql`${hrEmployments.archivedAt} IS NOT NULL AND substr(${hrEmployments.archivedAt}, 1, 10) >= ${options.periodStart} AND substr(${hrEmployments.archivedAt}, 1, 10) <= ${options.asOfDate}`,
      ),
      options.employmentIds ? inJsonArray(hrAnnualLeaveEntitlements.employmentId, options.employmentIds) : undefined,
    ))
    .orderBy(...hrEmployeeNumberOrder(), asc(employeeName), asc(hrAnnualLeaveEntitlements.periodStart));
  const eligibleRows = rows.filter(isAnnualLeavePeriod);
  if (!eligibleRows.length) return [];

  const entitlementIds = eligibleRows.map((row) => row.entitlementId);
  const [balances, settlementCounts] = await Promise.all([
    db.select({
      entitlementId: hrAnnualLeaveLedger.entitlementId,
      balanceHalfHours: sql<number>`coalesce(sum(${hrAnnualLeaveLedger.deltaHalfHours}), 0)`,
    }).from(hrAnnualLeaveLedger).where(inJsonArray(hrAnnualLeaveLedger.entitlementId, entitlementIds))
      .groupBy(hrAnnualLeaveLedger.entitlementId),
    db.select({
      entitlementId: hrAnnualLeaveLedger.entitlementId,
      settlementCount: sql<number>`sum(CASE WHEN ${hrAnnualLeaveLedger.entryKind} = 'settlement' THEN 1 ELSE 0 END)`,
    }).from(hrAnnualLeaveLedger).where(inJsonArray(hrAnnualLeaveLedger.entitlementId, entitlementIds))
      .groupBy(hrAnnualLeaveLedger.entitlementId),
  ]);
  const balanceById = new Map(balances.map((row) => [row.entitlementId, Number(row.balanceHalfHours ?? 0)]));
  const settlementCountById = new Map(settlementCounts.map((row) => [row.entitlementId, Number(row.settlementCount ?? 0)]));

  return Promise.all(eligibleRows.map(async (row): Promise<HrAnnualLeaveSettlementCandidate> => {
    const unusedHalfHours = balanceById.get(row.entitlementId) ?? 0;
    if (unusedHalfHours < 0) throw new HrError(409, `${row.employeeName} 的特休台帳餘額低於 0，無法進行未休折現。`);
    const archiveDate = row.archivedAt?.slice(0, 10) ?? null;
    const settlementReason: "period_end" | "termination" = archiveDate !== null && archiveDate < row.periodEnd && archiveDate <= options.asOfDate ? "termination" : "period_end";
    const settlementDate = settlementReason === "period_end" ? previousDate(options.asOfDate) : previousDate(archiveDate!);
    const compensation = unusedHalfHours > 0 ? await monthlyCompensationAt(db, row.employmentId, settlementDate) : undefined;
    if (unusedHalfHours > 0 && !compensation) throw new HrError(409, `${row.employeeName} 的特休未休折現找不到 ${settlementDate} 適用的月薪版本，請先補齊薪資設定。`);
    const amountMinor = compensation ? Math.round(compensation.baseAmountMinor * unusedHalfHours / row.dailyMinutes) : 0;
    return {
      entitlementId: row.entitlementId,
      employmentId: row.employmentId,
      employeeName: row.employeeName,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      settlementDate,
      settlementReason,
      unusedHalfHours,
      dailyMinutes: row.dailyMinutes,
      baseAmountMinor: compensation?.baseAmountMinor ?? null,
      compensationVersionId: compensation?.id ?? null,
      amountMinor,
      sourceKey: settlementCountById.get(row.entitlementId)
        ? `annual-settlement:${row.entitlementId}:${(settlementCountById.get(row.entitlementId) ?? 0) + 1}`
        : `annual-settlement:${row.entitlementId}`,
    };
  }));
}

/** 由薪資結帳把候選額度以負數 settlement 消耗，並原子地標記為 settled。 */
export function buildHrAnnualLeaveSettlementMutations(candidates: readonly HrAnnualLeaveSettlementCandidate[], actor: HrActor): SQL[] {
  const statements: SQL[] = [];
  for (const candidate of candidates) {
    if (candidate.unusedHalfHours > 0) {
      statements.push(sql`INSERT INTO hr_annual_leave_ledger
        (id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by)
        SELECT ${crypto.randomUUID()}, ${candidate.entitlementId}, 'settlement', ${-candidate.unusedHalfHours}, ${candidate.sourceKey}, NULL,
          ${candidate.settlementReason === "termination" ? `離職未休特休折現（${candidate.settlementDate}）` : `年度終結未休特休折現（${candidate.settlementDate}）`}, ${actor.id}
        WHERE EXISTS (SELECT 1 FROM hr_annual_leave_entitlements WHERE id=${candidate.entitlementId} AND status='open' AND settled_at IS NULL)
          AND coalesce((SELECT sum(delta_half_hours) FROM hr_annual_leave_ledger WHERE entitlement_id=${candidate.entitlementId}), 0) = ${candidate.unusedHalfHours}
          AND NOT EXISTS (SELECT 1 FROM hr_annual_leave_ledger WHERE source_key=${candidate.sourceKey})
        RETURNING id`);
    }
    const balanceGuard = candidate.unusedHalfHours > 0
      ? sql`AND EXISTS (SELECT 1 FROM hr_annual_leave_ledger WHERE source_key=${candidate.sourceKey})
          AND coalesce((SELECT sum(delta_half_hours) FROM hr_annual_leave_ledger WHERE entitlement_id=${candidate.entitlementId}), 0) = 0`
      : sql`AND coalesce((SELECT sum(delta_half_hours) FROM hr_annual_leave_ledger WHERE entitlement_id=${candidate.entitlementId}), 0) = 0`;
    statements.push(sql`UPDATE hr_annual_leave_entitlements
      SET status='settled', settled_at=CURRENT_TIMESTAMP
      WHERE id=${candidate.entitlementId} AND status='open' AND settled_at IS NULL ${balanceGuard}
      RETURNING id`);
  }
  return statements;
}

/**
 * 撤回已確定發放的批次時，特休折現不能留在台帳裡，否則重新試算會看不到同一筆未休額度。
 * 原 settlement 永遠保留，另外 append 一筆正向 settlement_reversal，再把 entitlement 開回可結算狀態。
 */
export function buildHrAnnualLeaveSettlementReversalMutations(sourceKeys: readonly string[], payrollRunId: string, actor: HrActor): SQL[] {
  const statements: SQL[] = [];
  for (const sourceKey of sourceKeys) {
    const reversalSourceKey = `annual-settlement-reversal:${payrollRunId}:${sourceKey}`;
    statements.push(sql`INSERT INTO hr_annual_leave_ledger
      (id, entitlement_id, entry_kind, delta_half_hours, source_key, leave_request_id, note, created_by)
      SELECT ${crypto.randomUUID()}, settlement.entitlement_id, 'settlement_reversal', -settlement.delta_half_hours, ${reversalSourceKey}, NULL,
        ${`薪資批次撤回（${payrollRunId}）恢復未休特休折現額度`}, ${actor.id}
      FROM hr_annual_leave_ledger AS settlement
      INNER JOIN hr_annual_leave_entitlements AS entitlement ON entitlement.id=settlement.entitlement_id
      WHERE settlement.source_key=${sourceKey} AND settlement.entry_kind='settlement'
        AND entitlement.status='settled' AND entitlement.settled_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM hr_annual_leave_ledger WHERE source_key=${reversalSourceKey})
      RETURNING id`);
    statements.push(sql`UPDATE hr_annual_leave_entitlements
      SET status='open', settled_at=NULL
      WHERE id=(SELECT entitlement_id FROM hr_annual_leave_ledger WHERE source_key=${sourceKey})
        AND status='settled' AND settled_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM hr_annual_leave_ledger WHERE source_key=${reversalSourceKey})
      RETURNING id`);
  }
  return statements;
}

export async function createHrAnnualLeaveAdjustment(db: Database, input: HrAnnualLeaveAdjustmentInput, actor: HrActor) {
  if (!Number.isSafeInteger(input.deltaHalfHours) || input.deltaHalfHours === 0) throw new HrError(400, "額度調整必須是非零的 0.5 小時單位整數。");
  if (input.reason.trim().length < 1 || input.reason.length > 1000) throw new HrError(400, "人工調整原因必填且不可超過 1000 字。");
  const [entitlement] = await db.select({
    id: hrAnnualLeaveEntitlements.id,
    annualLeaveStartOn: annualLeaveStartOnExpression(),
    periodStart: hrAnnualLeaveEntitlements.periodStart,
    periodEnd: hrAnnualLeaveEntitlements.periodEnd,
    serviceMonths: hrAnnualLeaveEntitlements.serviceMonths,
  }).from(hrAnnualLeaveEntitlements)
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrAnnualLeaveEntitlements.employmentId))
    .where(and(eq(hrAnnualLeaveEntitlements.id, input.entitlementId), eq(hrAnnualLeaveEntitlements.status, "open"))).limit(1);
  if (!entitlement || !isAnnualLeavePeriod(entitlement)) throw new HrError(404, "找不到可調整的特休額度。");
  const id = crypto.randomUUID();
  const sourceKey = `annual-adjustment:${id}`;
  return writeHrMutation(db, sql`INSERT INTO hr_annual_leave_ledger
    (id, entitlement_id, entry_kind, delta_half_hours, source_key, note, created_by)
    SELECT ${id}, ${input.entitlementId}, 'manual_adjustment', ${input.deltaHalfHours}, ${sourceKey}, ${input.reason.trim()}, ${actor.id}
    WHERE EXISTS (SELECT 1 FROM hr_annual_leave_entitlements WHERE id=${input.entitlementId} AND status='open')
      AND (${input.deltaHalfHours > 0 ? 1 : 0} = 1 OR coalesce((SELECT sum(delta_half_hours) FROM hr_annual_leave_ledger WHERE entitlement_id=${input.entitlementId}), 0) >= ${-input.deltaHalfHours})
    RETURNING id`, id, actor, "annual_leave_adjusted", "特休額度已變更或可用額度不足，請重新整理後再試。 ");
}

export async function annualLeaveTypeIds(db: Database) {
  const rows = await db.select({ id: hrLeaveTypes.id }).from(hrLeaveTypes)
    .where(and(eq(hrLeaveTypes.leaveKind, "annual"), eq(hrLeaveTypes.active, 1)));
  return rows.map((row) => row.id);
}
