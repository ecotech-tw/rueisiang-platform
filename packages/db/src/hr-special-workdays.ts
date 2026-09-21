import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { HrError, writeHrMutation, type HrActor } from "./hr-people.js";
import { activityEvents } from "./schema/activity.js";
import { hrEmployees, hrEmployments } from "./schema/hr-people.js";
import { hrScheduleWorkers, hrSpecialWorkdayAllowances, hrSpecialWorkdayAssignments, hrSpecialWorkdayOvertimeRules, hrSpecialWorkdayRuleVersions, hrSpecialWorkdayRules } from "./schema/hr-scheduling.js";
import { users } from "./schema/auth.js";

export type SpecialWorkdayWageKind = "fixed_hourly" | "multiplier";
export type SpecialWorkdaySource = "schedule" | "hourly" | "manual";
export type SpecialWorkdayOvertimeRateKind = "fixed_hourly" | "multiplier";
const DEFAULT_SPECIAL_WORKDAY_SOURCE: SpecialWorkdaySource = "hourly";
// 版本表的文字欄位是 0146 舊 schema；實際特殊日加班規則已改由 normalized 級距表保存。
const DEFAULT_SPECIAL_WORKDAY_OVERTIME_RULE = "依員工核准加班規則另計";
export interface SpecialWorkdayAllowanceInput { itemName: string; unitAmountMinor: number }
export interface SpecialWorkdayOvertimeRuleInput { fromHalfHours: number; toHalfHours: number | null; rateKind: SpecialWorkdayOvertimeRateKind; fixedAmountMinor?: number | null; multiplierPpm?: number | null }
export interface SpecialWorkdayRuleInput { name: string; validFrom: string; validTo: string | null; wageKind: SpecialWorkdayWageKind; fixedAmountMinor?: number | null; multiplierPpm?: number | null; workSource?: SpecialWorkdaySource; note?: string; allowances: SpecialWorkdayAllowanceInput[]; overtimeRules: SpecialWorkdayOvertimeRuleInput[] }
export interface SpecialWorkdayAssignmentInput { ruleVersionId: string; assignments: Array<{ employmentId?: string; workerId?: string; workDate: string; allowanceQuantity: number }> }

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HrError(400, "日期格式必須是 YYYY-MM-DD。 ");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new HrError(400, "日期不是有效日期。 ");
}
function normalizeOvertimeRules(rules: SpecialWorkdayOvertimeRuleInput[]) {
  if (rules.length > 50) throw new HrError(400, "特殊上班日加班規則最多 50 筆。 ");
  const sorted = rules.slice().sort((left, right) => left.fromHalfHours - right.fromHalfHours);
  for (const rule of sorted) {
    if (!Number.isSafeInteger(rule.fromHalfHours) || rule.fromHalfHours < 1 || (rule.toHalfHours !== null && (!Number.isSafeInteger(rule.toHalfHours) || rule.toHalfHours < rule.fromHalfHours))) throw new HrError(400, "特殊上班日加班時數級距不正確。 ");
    if (rule.rateKind === "fixed_hourly" && (!Number.isSafeInteger(rule.fixedAmountMinor) || rule.fixedAmountMinor! < 0 || rule.multiplierPpm !== null && rule.multiplierPpm !== undefined)) throw new HrError(400, "特殊上班日固定加班時薪不正確。 ");
    if (rule.rateKind === "multiplier" && (!Number.isSafeInteger(rule.multiplierPpm) || rule.multiplierPpm! < 0 || rule.fixedAmountMinor !== null && rule.fixedAmountMinor !== undefined)) throw new HrError(400, "特殊上班日加班倍率不正確。 ");
    if (rule.rateKind !== "fixed_hourly" && rule.rateKind !== "multiplier") throw new HrError(400, "特殊上班日加班計算方式不正確。 ");
  }
  if (sorted.length && sorted[0]!.fromHalfHours !== 1) throw new HrError(400, "特殊上班日加班級距必須從 0.0 小時起算。 ");
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (previous.toHalfHours === null || current.fromHalfHours !== previous.toHalfHours + 1) throw new HrError(400, "特殊上班日加班級距不可重疊或留空段。 ");
  }
  return sorted;
}
function validate(input: SpecialWorkdayRuleInput) {
  if (input.workSource !== undefined) throw new HrError(400, "特殊上班日工時來源由系統決定，不可由請求指定。 ");
  const workSource = DEFAULT_SPECIAL_WORKDAY_SOURCE;
  const note = input.note ?? "";
  validDate(input.validFrom); if (input.validTo) { validDate(input.validTo); if (input.validTo <= input.validFrom) throw new HrError(400, "規則迄日必須晚於生效日。 "); }
  if (!input.name.trim() || input.name.length > 100) throw new HrError(400, "特殊上班日規則名稱必填。 ");
  if (input.wageKind === "fixed_hourly" && (!Number.isSafeInteger(input.fixedAmountMinor) || input.fixedAmountMinor! < 0)) throw new HrError(400, "固定每小時金額不正確。 ");
  if (input.wageKind === "multiplier" && (!Number.isSafeInteger(input.multiplierPpm) || input.multiplierPpm! < 0)) throw new HrError(400, "薪資倍率不正確。 ");
  if (input.wageKind !== "fixed_hourly" && input.wageKind !== "multiplier" || workSource !== "schedule" && workSource !== "hourly" && workSource !== "manual") throw new HrError(400, "特殊上班日計算方式不正確。 ");
  if (note.length > 1000 || input.allowances.length > 50 || input.allowances.some((item) => !item.itemName.trim() || item.itemName.length > 100 || !Number.isSafeInteger(item.unitAmountMinor) || item.unitAmountMinor < 0)) throw new HrError(400, "補貼項目不正確。 ");
  normalizeOvertimeRules(input.overtimeRules);
}
function versionValues(ruleId: string, versionNumber: number, input: SpecialWorkdayRuleInput, actor: HrActor, versionId: string) {
  return { id: versionId, ruleId, versionNumber, validFrom: input.validFrom, validTo: input.validTo, wageKind: input.wageKind, fixedAmountMinor: input.wageKind === "fixed_hourly" ? input.fixedAmountMinor! : null, multiplierPpm: input.wageKind === "multiplier" ? input.multiplierPpm! : null, overtimeRule: DEFAULT_SPECIAL_WORKDAY_OVERTIME_RULE, workSource: input.workSource ?? DEFAULT_SPECIAL_WORKDAY_SOURCE, note: (input.note ?? "").trim(), createdBy: actor.id } as const;
}

export async function listHrSpecialWorkdayRules(db: Database) {
  // 分開讀三張表；SQLite/D1 的 joined select 在多個表有同名欄位時容易覆蓋 id。
  const [rules, versions, allowances, overtimeRules] = await Promise.all([
    db.select().from(hrSpecialWorkdayRules).orderBy(asc(hrSpecialWorkdayRules.name)),
    db.select().from(hrSpecialWorkdayRuleVersions).orderBy(asc(hrSpecialWorkdayRuleVersions.ruleId), asc(hrSpecialWorkdayRuleVersions.versionNumber)),
    db.select().from(hrSpecialWorkdayAllowances),
    db.select().from(hrSpecialWorkdayOvertimeRules).orderBy(asc(hrSpecialWorkdayOvertimeRules.fromHalfHours)),
  ]);
  return rules.map((rule) => ({
    rule,
    versions: versions.filter((version) => version.ruleId === rule.id).map((version) => ({ ...version, allowances: allowances.filter((allowance) => allowance.ruleVersionId === version.id), overtimeRules: overtimeRules.filter((overtimeRule) => overtimeRule.ruleVersionId === version.id) })),
  }));
}

export async function listHrSpecialWorkdayAssignments(db: Database, periodStart?: string, periodEnd?: string) {
  const rows = await db.select({ assignment: hrSpecialWorkdayAssignments, ruleVersionNumber: hrSpecialWorkdayRuleVersions.versionNumber, ruleVersionVoidedAt: hrSpecialWorkdayRuleVersions.voidedAt, employeeNumber: hrEmployees.employeeNumber, employeeName: sql<string | null>`coalesce(nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`, workerName: hrScheduleWorkers.displayName }).from(hrSpecialWorkdayAssignments)
    .innerJoin(hrSpecialWorkdayRuleVersions, eq(hrSpecialWorkdayRuleVersions.id, hrSpecialWorkdayAssignments.ruleVersionId)).leftJoin(hrEmployments, eq(hrEmployments.id, hrSpecialWorkdayAssignments.employmentId)).leftJoin(hrEmployees, eq(hrEmployees.userId, hrEmployments.employeeUserId)).leftJoin(users, eq(users.id, hrEmployments.employeeUserId)).leftJoin(hrScheduleWorkers, eq(hrScheduleWorkers.id, hrSpecialWorkdayAssignments.workerId))
    .where(and(periodStart ? sql`${hrSpecialWorkdayAssignments.workDate} >= ${periodStart}` : undefined, periodEnd ? sql`${hrSpecialWorkdayAssignments.workDate} < ${periodEnd}` : undefined)).orderBy(asc(hrSpecialWorkdayAssignments.workDate));
  return rows;
}

export async function createHrSpecialWorkdayRule(db: Database, input: SpecialWorkdayRuleInput, actor: HrActor) {
  validate(input); const ruleId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const overtimeRules = normalizeOvertimeRules(input.overtimeRules);
  const statements = [db.insert(hrSpecialWorkdayRules).values({ id: ruleId, name: input.name.trim(), createdBy: actor.id }), db.insert(hrSpecialWorkdayRuleVersions).values(versionValues(ruleId, 1, input, actor, versionId)), ...overtimeRules.map((rule) => db.insert(hrSpecialWorkdayOvertimeRules).values({ id: crypto.randomUUID(), ruleVersionId: versionId, fromHalfHours: rule.fromHalfHours, toHalfHours: rule.toHalfHours, rateKind: rule.rateKind, fixedAmountMinor: rule.rateKind === "fixed_hourly" ? rule.fixedAmountMinor! : null, multiplierPpm: rule.rateKind === "multiplier" ? rule.multiplierPpm! : null })), ...input.allowances.map((item) => db.insert(hrSpecialWorkdayAllowances).values({ id: crypto.randomUUID(), ruleVersionId: versionId, itemName: item.itemName.trim(), unitAmountMinor: item.unitAmountMinor })), db.insert(activityEvents).values(activityRow({ entityType: "hr_personnel", entityId: ruleId, source: "hr", eventType: "special_workday_rule_created", summary: "特殊上班日規則建立", actor }))];
  await db.batch(statements as never); return { id: ruleId, versionId };
}

export async function createHrSpecialWorkdayRuleVersion(db: Database, ruleId: string, input: SpecialWorkdayRuleInput, actor: HrActor) {
  validate(input);
  const overtimeRules = normalizeOvertimeRules(input.overtimeRules);
  const [rule] = await db.select({ id: hrSpecialWorkdayRules.id, active: hrSpecialWorkdayRules.active }).from(hrSpecialWorkdayRules).where(eq(hrSpecialWorkdayRules.id, ruleId)).limit(1);
  if (!rule) throw new HrError(404, "找不到特殊上班日規則。 ");
  if (!rule.active) throw new HrError(409, "規則已停用，不能建立新版本。 ");
  // 解除後要能在原生效日建立修正版，所以生效日只和仍有效的最新版本比較；編號則永遠取所有版本最大值。
  const [latest] = await db.select({ id: hrSpecialWorkdayRuleVersions.id, versionNumber: hrSpecialWorkdayRuleVersions.versionNumber, validFrom: hrSpecialWorkdayRuleVersions.validFrom, validTo: hrSpecialWorkdayRuleVersions.validTo }).from(hrSpecialWorkdayRuleVersions)
    .where(and(eq(hrSpecialWorkdayRuleVersions.ruleId, ruleId), sql`${hrSpecialWorkdayRuleVersions.voidedAt} IS NULL`)).orderBy(desc(hrSpecialWorkdayRuleVersions.versionNumber)).limit(1);
  if (latest && input.validFrom <= latest.validFrom) throw new HrError(400, "新規則版本生效日必須晚於既有版本。 ");
  const [maxVersion] = await db.select({ versionNumber: sql<number>`coalesce(max(${hrSpecialWorkdayRuleVersions.versionNumber}), 0)`.as("special_workday_max_version_number") }).from(hrSpecialWorkdayRuleVersions).where(eq(hrSpecialWorkdayRuleVersions.ruleId, ruleId));
  const versionId = crypto.randomUUID();
  const number = Number(maxVersion?.versionNumber ?? 0) + 1;
  const versionInsertValues = {
    ...versionValues(ruleId, number, input, actor, versionId),
    // 讀取與寫入之間若最新版本剛被解除，子查詢會變成 NULL，讓整批寫入回滾，不留下兩個有效期間。
    ruleId: latest
      ? sql<string>`(SELECT version.rule_id FROM hr_special_workday_rule_versions AS version INNER JOIN hr_special_workday_rules AS rule ON rule.id=version.rule_id WHERE version.id=${latest.id} AND version.voided_at IS NULL AND rule.active=1)`
      : sql<string>`(SELECT id FROM hr_special_workday_rules WHERE id=${ruleId} AND active=1)`,
  };
  const statements = [
    // 先插入版本再留下 supersededByVersionId，該欄位才有可追蹤的來源版本。
    db.insert(hrSpecialWorkdayRuleVersions).values(versionInsertValues),
    ...overtimeRules.map((overtimeRule) => db.insert(hrSpecialWorkdayOvertimeRules).values({ id: crypto.randomUUID(), ruleVersionId: versionId, fromHalfHours: overtimeRule.fromHalfHours, toHalfHours: overtimeRule.toHalfHours, rateKind: overtimeRule.rateKind, fixedAmountMinor: overtimeRule.rateKind === "fixed_hourly" ? overtimeRule.fixedAmountMinor! : null, multiplierPpm: overtimeRule.rateKind === "multiplier" ? overtimeRule.multiplierPpm! : null })),
    ...input.allowances.map((item) => db.insert(hrSpecialWorkdayAllowances).values({ id: crypto.randomUUID(), ruleVersionId: versionId, itemName: item.itemName.trim(), unitAmountMinor: item.unitAmountMinor })),
    ...(latest ? [db.update(hrSpecialWorkdayRuleVersions).set({
      validTo: latest.validTo === null || latest.validTo > input.validFrom ? input.validFrom : latest.validTo,
      supersededValidTo: latest.validTo,
      supersededByVersionId: versionId,
    }).where(and(eq(hrSpecialWorkdayRuleVersions.id, latest.id), sql`${hrSpecialWorkdayRuleVersions.voidedAt} IS NULL`))] : []),
    db.update(hrSpecialWorkdayRules).set({ updatedAt: sql`CURRENT_TIMESTAMP`, revision: sql`${hrSpecialWorkdayRules.revision} + 1` }).where(eq(hrSpecialWorkdayRules.id, ruleId)),
    db.insert(activityEvents).values(activityRow({ entityType: "hr_personnel", entityId: ruleId, source: "hr", eventType: "special_workday_rule_version_created", summary: "特殊上班日規則版本建立", actor })),
  ];
  try {
    await db.batch(statements as never);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed|NOT NULL constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed/.test(error.message)) throw new HrError(409, "特殊上班日規則已變更，請重新整理後再試。 ");
    throw error;
  }
  return { id: ruleId, versionId, versionNumber: number };
}

/** 解除最新版本但不刪除資料；已套用日期仍保留原本的規則與快照。 */
export async function voidHrSpecialWorkdayRuleVersion(db: Database, ruleId: string, versionId: string, actor: HrActor) {
  const [version] = await db.select({ id: hrSpecialWorkdayRuleVersions.id, ruleId: hrSpecialWorkdayRuleVersions.ruleId, versionNumber: hrSpecialWorkdayRuleVersions.versionNumber, validFrom: hrSpecialWorkdayRuleVersions.validFrom, voidedAt: hrSpecialWorkdayRuleVersions.voidedAt, active: hrSpecialWorkdayRules.active }).from(hrSpecialWorkdayRuleVersions)
    .innerJoin(hrSpecialWorkdayRules, eq(hrSpecialWorkdayRules.id, hrSpecialWorkdayRuleVersions.ruleId)).where(and(eq(hrSpecialWorkdayRuleVersions.id, versionId), eq(hrSpecialWorkdayRuleVersions.ruleId, ruleId))).limit(1);
  if (!version) throw new HrError(404, "找不到特殊上班日規則版本。 ");
  if (version.voidedAt !== null) throw new HrError(409, "這個特殊上班日規則版本已經解除。 ");
  if (!version.active) throw new HrError(409, "特殊上班日規則已停用，不能解除版本。 ");
  const activeVersions = await db.select({ id: hrSpecialWorkdayRuleVersions.id, versionNumber: hrSpecialWorkdayRuleVersions.versionNumber }).from(hrSpecialWorkdayRuleVersions)
    .where(and(eq(hrSpecialWorkdayRuleVersions.ruleId, ruleId), sql`${hrSpecialWorkdayRuleVersions.voidedAt} IS NULL`)).orderBy(desc(hrSpecialWorkdayRuleVersions.versionNumber));
  if (activeVersions[0]?.id !== versionId) throw new HrError(409, "只能解除最新的特殊上班日規則版本；請先依序解除較新的版本。 ");
  const previous = activeVersions[1];
  if (!previous) throw new HrError(409, "這是第一個版本，沒有可以回到的上一版；整個規則設錯請改用停用。 ");
  await writeHrMutation(db, [
    sql`UPDATE hr_special_workday_rule_versions SET voided_at=CURRENT_TIMESTAMP, voided_by=${actor.id}
      WHERE id=${versionId} AND rule_id=${ruleId} AND voided_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM hr_special_workday_rule_versions AS newer
          WHERE newer.rule_id=${ruleId} AND newer.voided_at IS NULL
            AND newer.version_number > ${version.versionNumber})
      RETURNING id`,
    // 新版建立時留下的原迄日優先；舊 migration 建立的版本才用 NULL 收尾的相容判斷。
    sql`UPDATE hr_special_workday_rule_versions SET valid_to=COALESCE(superseded_valid_to, CASE WHEN valid_to=${version.validFrom} THEN NULL ELSE valid_to END), superseded_valid_to=NULL, superseded_by_version_id=NULL
      WHERE id=${previous.id} AND (superseded_by_version_id=${versionId} OR (superseded_by_version_id IS NULL AND valid_to=${version.validFrom}))
      RETURNING id`,
    sql`UPDATE hr_special_workday_rules SET updated_at=CURRENT_TIMESTAMP, revision=revision + 1 WHERE id=${ruleId} RETURNING id`,
  ], ruleId, actor, "special_workday_rule_version_voided", "特殊上班日規則版本已被其他人變更，請重新整理後再試。 ", { allowEmptyMutationIndexes: new Set([1]) });
  return { ruleId, versionId, previousVersionId: previous.id, status: "voided" as const };
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
  const [source] = await db.select({ version: hrSpecialWorkdayRuleVersions, ruleName: hrSpecialWorkdayRules.name }).from(hrSpecialWorkdayRuleVersions).innerJoin(hrSpecialWorkdayRules, eq(hrSpecialWorkdayRules.id, hrSpecialWorkdayRuleVersions.ruleId)).where(and(eq(hrSpecialWorkdayRuleVersions.id, input.ruleVersionId), eq(hrSpecialWorkdayRules.active, 1), sql`${hrSpecialWorkdayRuleVersions.voidedAt} IS NULL`)).limit(1);
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
  const assignments = await db.select().from(hrSpecialWorkdayAssignments).where(and(sql`${hrSpecialWorkdayAssignments.workDate} >= ${periodStart}`, sql`${hrSpecialWorkdayAssignments.workDate} < ${periodEnd}`));
  const overtimeRules = assignments.length ? await db.select().from(hrSpecialWorkdayOvertimeRules).where(sql`${hrSpecialWorkdayOvertimeRules.ruleVersionId} IN (SELECT rule_version_id FROM hr_special_workday_assignments WHERE work_date >= ${periodStart} AND work_date < ${periodEnd})`).orderBy(asc(hrSpecialWorkdayOvertimeRules.fromHalfHours)) : [];
  return assignments.map((assignment) => ({ ...assignment, overtimeRules: overtimeRules.filter((rule) => rule.ruleVersionId === assignment.ruleVersionId) }));
}
