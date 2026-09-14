import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { HrError, type HrActor } from "./hr-people.js";
import { activityEvents } from "./schema/activity.js";
import { hrEmployees, hrEmployments } from "./schema/hr-people.js";
import { hrScheduleWorkers, hrSpecialWorkdayAllowances, hrSpecialWorkdayAssignments, hrSpecialWorkdayRuleVersions, hrSpecialWorkdayRules } from "./schema/hr-scheduling.js";
import { users } from "./schema/auth.js";

export type SpecialWorkdayWageKind = "fixed_hourly" | "multiplier";
export type SpecialWorkdaySource = "schedule" | "hourly" | "manual";
export interface SpecialWorkdayAllowanceInput { itemName: string; unitAmountMinor: number }
export interface SpecialWorkdayRuleInput { name: string; validFrom: string; validTo: string | null; wageKind: SpecialWorkdayWageKind; fixedAmountMinor?: number | null; multiplierPpm?: number | null; overtimeRule: string; workSource: SpecialWorkdaySource; note: string; allowances: SpecialWorkdayAllowanceInput[] }
export interface SpecialWorkdayAssignmentInput { ruleVersionId: string; assignments: Array<{ employmentId?: string; workerId?: string; workDate: string; allowanceQuantity: number }> }

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HrError(400, "日期格式必須是 YYYY-MM-DD。 ");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new HrError(400, "日期不是有效日期。 ");
}
function validate(input: SpecialWorkdayRuleInput) {
  validDate(input.validFrom); if (input.validTo) { validDate(input.validTo); if (input.validTo <= input.validFrom) throw new HrError(400, "規則迄日必須晚於生效日。 "); }
  if (!input.name.trim() || input.name.length > 100 || !input.overtimeRule.trim() || input.overtimeRule.length > 100) throw new HrError(400, "特殊上班日規則名稱與加班規則必填。 ");
  if (input.wageKind === "fixed_hourly" && (!Number.isSafeInteger(input.fixedAmountMinor) || input.fixedAmountMinor! < 0)) throw new HrError(400, "固定每小時金額不正確。 ");
  if (input.wageKind === "multiplier" && (!Number.isSafeInteger(input.multiplierPpm) || input.multiplierPpm! < 0)) throw new HrError(400, "薪資倍率不正確。 ");
  if (input.wageKind !== "fixed_hourly" && input.wageKind !== "multiplier" || input.workSource !== "schedule" && input.workSource !== "hourly" && input.workSource !== "manual") throw new HrError(400, "特殊上班日計算方式不正確。 ");
  if (input.note.length > 1000 || input.allowances.length > 50 || input.allowances.some((item) => !item.itemName.trim() || item.itemName.length > 100 || !Number.isSafeInteger(item.unitAmountMinor) || item.unitAmountMinor < 0)) throw new HrError(400, "補貼項目不正確。 ");
}
function versionValues(ruleId: string, versionNumber: number, input: SpecialWorkdayRuleInput, actor: HrActor, versionId: string) {
  return { id: versionId, ruleId, versionNumber, validFrom: input.validFrom, validTo: input.validTo, wageKind: input.wageKind, fixedAmountMinor: input.wageKind === "fixed_hourly" ? input.fixedAmountMinor! : null, multiplierPpm: input.wageKind === "multiplier" ? input.multiplierPpm! : null, overtimeRule: input.overtimeRule.trim(), workSource: input.workSource, note: input.note.trim(), createdBy: actor.id } as const;
}

export async function listHrSpecialWorkdayRules(db: Database) {
  // 分開讀三張表；SQLite/D1 的 joined select 在多個表有同名欄位時容易覆蓋 id。
  const [rules, versions, allowances] = await Promise.all([
    db.select().from(hrSpecialWorkdayRules).orderBy(asc(hrSpecialWorkdayRules.name)),
    db.select().from(hrSpecialWorkdayRuleVersions).orderBy(asc(hrSpecialWorkdayRuleVersions.versionNumber)),
    db.select().from(hrSpecialWorkdayAllowances),
  ]);
  return rules.map((rule) => ({
    rule,
    versions: versions.filter((version) => version.ruleId === rule.id).map((version) => ({ ...version, allowances: allowances.filter((allowance) => allowance.ruleVersionId === version.id) })),
  }));
}

export async function listHrSpecialWorkdayAssignments(db: Database, periodStart?: string, periodEnd?: string) {
  const rows = await db.select({ assignment: hrSpecialWorkdayAssignments, employeeNumber: hrEmployees.employeeNumber, employeeName: sql<string | null>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`, workerName: hrScheduleWorkers.displayName }).from(hrSpecialWorkdayAssignments)
    .leftJoin(hrEmployments, eq(hrEmployments.id, hrSpecialWorkdayAssignments.employmentId)).leftJoin(hrEmployees, eq(hrEmployees.userId, hrEmployments.employeeUserId)).leftJoin(users, eq(users.id, hrEmployments.employeeUserId)).leftJoin(hrScheduleWorkers, eq(hrScheduleWorkers.id, hrSpecialWorkdayAssignments.workerId))
    .where(and(periodStart ? sql`${hrSpecialWorkdayAssignments.workDate} >= ${periodStart}` : undefined, periodEnd ? sql`${hrSpecialWorkdayAssignments.workDate} < ${periodEnd}` : undefined)).orderBy(asc(hrSpecialWorkdayAssignments.workDate));
  return rows;
}

export async function createHrSpecialWorkdayRule(db: Database, input: SpecialWorkdayRuleInput, actor: HrActor) {
  validate(input); const ruleId = crypto.randomUUID(); const versionId = crypto.randomUUID();
  const statements = [db.insert(hrSpecialWorkdayRules).values({ id: ruleId, name: input.name.trim(), createdBy: actor.id }), db.insert(hrSpecialWorkdayRuleVersions).values(versionValues(ruleId, 1, input, actor, versionId)), ...input.allowances.map((item) => db.insert(hrSpecialWorkdayAllowances).values({ id: crypto.randomUUID(), ruleVersionId: versionId, itemName: item.itemName.trim(), unitAmountMinor: item.unitAmountMinor })), db.insert(activityEvents).values(activityRow({ entityType: "hr_personnel", entityId: ruleId, source: "hr", eventType: "special_workday_rule_created", summary: "特殊上班日規則建立", actor }))];
  await db.batch(statements as never); return { id: ruleId, versionId };
}

export async function createHrSpecialWorkdayRuleVersion(db: Database, ruleId: string, input: SpecialWorkdayRuleInput, actor: HrActor) {
  validate(input); const [rule] = await db.select({ id: hrSpecialWorkdayRules.id, active: hrSpecialWorkdayRules.active }).from(hrSpecialWorkdayRules).where(eq(hrSpecialWorkdayRules.id, ruleId)).limit(1);
  if (!rule) throw new HrError(404, "找不到特殊上班日規則。 "); if (!rule.active) throw new HrError(409, "規則已停用，不能建立新版本。 ");
  const [latest] = await db.select({ id: hrSpecialWorkdayRuleVersions.id, versionNumber: hrSpecialWorkdayRuleVersions.versionNumber, validFrom: hrSpecialWorkdayRuleVersions.validFrom }).from(hrSpecialWorkdayRuleVersions).where(eq(hrSpecialWorkdayRuleVersions.ruleId, ruleId)).orderBy(sql`${hrSpecialWorkdayRuleVersions.versionNumber} DESC`).limit(1);
  if (latest && input.validFrom <= latest.validFrom) throw new HrError(400, "新規則版本生效日必須晚於既有版本。 ");
  const versionId = crypto.randomUUID(); const number = (latest?.versionNumber ?? 0) + 1;
  const statements = [
    ...(latest ? [db.update(hrSpecialWorkdayRuleVersions).set({ validTo: input.validFrom }).where(and(eq(hrSpecialWorkdayRuleVersions.id, latest.id), sql`(${hrSpecialWorkdayRuleVersions.validTo} IS NULL OR ${hrSpecialWorkdayRuleVersions.validTo} > ${input.validFrom})`))] : []),
    db.insert(hrSpecialWorkdayRuleVersions).values(versionValues(ruleId, number, input, actor, versionId)), ...input.allowances.map((item) => db.insert(hrSpecialWorkdayAllowances).values({ id: crypto.randomUUID(), ruleVersionId: versionId, itemName: item.itemName.trim(), unitAmountMinor: item.unitAmountMinor })), db.update(hrSpecialWorkdayRules).set({ updatedAt: sql`CURRENT_TIMESTAMP`, revision: sql`${hrSpecialWorkdayRules.revision} + 1` }).where(eq(hrSpecialWorkdayRules.id, ruleId)), db.insert(activityEvents).values(activityRow({ entityType: "hr_personnel", entityId: ruleId, source: "hr", eventType: "special_workday_rule_version_created", summary: "特殊上班日規則版本建立", actor }))];
  await db.batch(statements as never); return { id: ruleId, versionId, versionNumber: number };
}

export async function setHrSpecialWorkdayRuleActive(db: Database, ruleId: string, active: boolean, actor: HrActor) {
  const result = await db.update(hrSpecialWorkdayRules).set({ active: active ? 1 : 0, updatedAt: sql`CURRENT_TIMESTAMP`, revision: sql`${hrSpecialWorkdayRules.revision} + 1` }).where(eq(hrSpecialWorkdayRules.id, ruleId)).returning({ id: hrSpecialWorkdayRules.id });
  if (!result.length) throw new HrError(404, "找不到特殊上班日規則。 ");
  await db.insert(activityEvents).values(activityRow({ entityType: "hr_personnel", entityId: ruleId, source: "hr", eventType: active ? "special_workday_rule_activated" : "special_workday_rule_deactivated", summary: active ? "特殊上班日規則啟用" : "特殊上班日規則停用", actor }));
  return { id: ruleId, active };
}

export async function assignHrSpecialWorkdays(db: Database, input: SpecialWorkdayAssignmentInput, actor: HrActor) {
  if (!Array.isArray(input.assignments) || !input.assignments.length || input.assignments.length > 1000) throw new HrError(400, "請提供要套用的員工日期。 ");
  const inputKeys = new Set<string>();
  const [source] = await db.select({ version: hrSpecialWorkdayRuleVersions, ruleName: hrSpecialWorkdayRules.name }).from(hrSpecialWorkdayRuleVersions).innerJoin(hrSpecialWorkdayRules, eq(hrSpecialWorkdayRules.id, hrSpecialWorkdayRuleVersions.ruleId)).where(and(eq(hrSpecialWorkdayRuleVersions.id, input.ruleVersionId), eq(hrSpecialWorkdayRules.active, 1))).limit(1);
  if (!source) throw new HrError(404, "找不到啟用中的特殊上班日規則版本。 ");
  const allowanceRows = await db.select().from(hrSpecialWorkdayAllowances).where(eq(hrSpecialWorkdayAllowances.ruleVersionId, input.ruleVersionId));
  const allowanceSnapshot = allowanceRows.map(({ id: _id, ruleVersionId: _version, createdAt: _created, ...item }) => item);
  const statements = [];
  for (const item of input.assignments) {
    validDate(item.workDate);
    if (item.workDate < source.version.validFrom || (source.version.validTo !== null && item.workDate >= source.version.validTo)) throw new HrError(400, "套用日期不在規則版本有效期間內。 ");
    if ((item.employmentId ? 1 : 0) + (item.workerId ? 1 : 0) !== 1 || !Number.isSafeInteger(item.allowanceQuantity) || item.allowanceQuantity < 0) throw new HrError(400, "特殊上班日套用對象或補貼數量不正確。 ");
    const inputKey = `${item.employmentId ?? `worker:${item.workerId!}`}:${item.workDate}`;
    if (inputKeys.has(inputKey)) throw new HrError(409, "同一批次不可重複套用同一人員同一天。 ");
    inputKeys.add(inputKey);
    if (item.employmentId) {
      const [employment] = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(eq(hrEmployments.id, item.employmentId), sql`${hrEmployments.hiredOn} <= ${item.workDate}`, sql`(${hrEmployments.endedOn} IS NULL OR ${hrEmployments.endedOn} > ${item.workDate})`)).limit(1);
      if (!employment) throw new HrError(400, "員工在套用日期沒有有效任職。 ");
    } else {
      const [worker] = await db.select({ id: hrScheduleWorkers.id }).from(hrScheduleWorkers).where(and(eq(hrScheduleWorkers.id, item.workerId!), eq(hrScheduleWorkers.active, 1))).limit(1);
      if (!worker) throw new HrError(400, "支援人員在套用日期不是啟用狀態。 ");
    }
    const duplicate = await db.select({ id: hrSpecialWorkdayAssignments.id }).from(hrSpecialWorkdayAssignments).where(item.employmentId ? and(eq(hrSpecialWorkdayAssignments.employmentId, item.employmentId), eq(hrSpecialWorkdayAssignments.workDate, item.workDate)) : and(eq(hrSpecialWorkdayAssignments.workerId, item.workerId!), eq(hrSpecialWorkdayAssignments.workDate, item.workDate))).limit(1);
    if (duplicate.length) throw new HrError(409, "同一人員同一天已有特殊上班日規則。 ");
    statements.push(db.insert(hrSpecialWorkdayAssignments).values({ id: crypto.randomUUID(), ruleVersionId: input.ruleVersionId, employmentId: item.employmentId ?? null, workerId: item.workerId ?? null, workDate: item.workDate, ruleNameSnapshot: source.ruleName, wageKindSnapshot: source.version.wageKind, fixedAmountMinorSnapshot: source.version.fixedAmountMinor, multiplierPpmSnapshot: source.version.multiplierPpm, workSourceSnapshot: source.version.workSource, allowanceSnapshotJson: JSON.stringify(allowanceSnapshot), allowanceQuantity: item.allowanceQuantity, appliedBy: actor.id }));
  }
  statements.push(db.insert(activityEvents).values(activityRow({ entityType: "hr_personnel", entityId: input.ruleVersionId, source: "hr", eventType: "special_workday_assigned", summary: "特殊上班日套用", actor, payload: { count: input.assignments.length } })));
  try {
    await db.batch(statements as never);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed/.test(error.message)) throw new HrError(409, "特殊上班日套用重複或資料不合法，請重新整理。 ");
    throw error;
  }
  return { count: input.assignments.length };
}

export async function listHrSpecialWorkdaysForPayroll(db: Database, periodStart: string, periodEnd: string) {
  return db.select().from(hrSpecialWorkdayAssignments).where(and(sql`${hrSpecialWorkdayAssignments.workDate} >= ${periodStart}`, sql`${hrSpecialWorkdayAssignments.workDate} < ${periodEnd}`));
}
