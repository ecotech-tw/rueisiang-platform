import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { chunks, inJsonArray } from "./sql-lists.js";
import { activityRow } from "./activity.js";
import { HrError, writeHrMutation, type HrActor } from "./hr-people.js";
import { activityEvents } from "./schema/activity.js";
import { hrEmployments } from "./schema/hr-people.js";
import { hrScheduleWorkers, hrSpecialWorkdayAllowances, hrSpecialWorkdayAssignments, hrSpecialWorkdayOvertimeRules, hrSpecialWorkdayRuleVersions, hrSpecialWorkdayRules } from "./schema/hr-scheduling.js";
import { users } from "./schema/auth.js";

export type SpecialWorkdayWageKind = "fixed_hourly" | "multiplier";
export type SpecialWorkdaySource = "schedule" | "hourly" | "manual";
export type SpecialWorkdayOvertimeRateKind = "fixed_hourly" | "multiplier";
const DEFAULT_SPECIAL_WORKDAY_SOURCE: SpecialWorkdaySource = "hourly";
// 版本表的文字欄位是 0146 舊 schema；實際特殊日加班規則已改由 normalized 級距表保存。
const DEFAULT_SPECIAL_WORKDAY_OVERTIME_RULE = "依員工核准加班規則另計";
export interface SpecialWorkdayAllowanceInput { itemName: string; unitAmountMinor: number }
export interface SpecialWorkdayAllowanceQuantityInput { allowanceId: string; quantity: number }
export interface SpecialWorkdayAllowanceSnapshot { itemName: string; unitAmountMinor: number; quantity: number }
export interface SpecialWorkdayOvertimeRuleInput { fromHalfHours: number; toHalfHours: number | null; rateKind: SpecialWorkdayOvertimeRateKind; fixedAmountMinor?: number | null; multiplierPpm?: number | null }
export interface SpecialWorkdayRuleInput { name: string; validFrom: string; validTo: string | null; wageKind: SpecialWorkdayWageKind; fixedAmountMinor?: number | null; multiplierPpm?: number | null; workSource?: SpecialWorkdaySource; note?: string; allowances: SpecialWorkdayAllowanceInput[]; overtimeRules: SpecialWorkdayOvertimeRuleInput[] }
export interface SpecialWorkdayAssignmentItem { employmentId?: string; workerId?: string; workDate: string; allowanceQuantities?: SpecialWorkdayAllowanceQuantityInput[]; allowanceQuantity?: number }
export interface SpecialWorkdayAssignmentInput { ruleId: string; assignments: SpecialWorkdayAssignmentItem[] }
export interface SpecialWorkdayAssignmentUpdateInput extends SpecialWorkdayAssignmentItem { ruleId: string }

/** 套用資料保存每個補貼自己的數量；歷史資料沒有 quantity 時沿用舊欄位的共用數量。 */
export function parseSpecialWorkdayAllowanceSnapshot(snapshotJson: string, legacyQuantity = 0): SpecialWorkdayAllowanceSnapshot[] {
  let raw: unknown;
  try {
    raw = JSON.parse(snapshotJson);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const fallbackQuantity = Number.isSafeInteger(legacyQuantity) && legacyQuantity >= 0 ? legacyQuantity : 0;
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const itemName = typeof item.itemName === "string" ? item.itemName : "";
    const unitAmountMinor = typeof item.unitAmountMinor === "number" && Number.isSafeInteger(item.unitAmountMinor) && item.unitAmountMinor >= 0 ? item.unitAmountMinor : 0;
    if (!itemName) return [];
    const quantity = typeof item.quantity === "number" && Number.isSafeInteger(item.quantity) && item.quantity >= 0 ? item.quantity : fallbackQuantity;
    return [{ itemName, unitAmountMinor, quantity }];
  });
}

export function specialWorkdayAllowanceTotal(snapshotJson: string, legacyQuantity = 0) {
  return parseSpecialWorkdayAllowanceSnapshot(snapshotJson, legacyQuantity).reduce((sum, item) => sum + item.unitAmountMinor * item.quantity, 0);
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HrError(400, "日期格式必須是 YYYY-MM-DD。 ");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new HrError(400, "日期不是有效日期。 ");
}
function specialWorkdayAssignmentKey(employmentId: string | null | undefined, workerId: string | null | undefined, workDate: string) {
  return `${employmentId ? `employment:${employmentId}` : `worker:${workerId!}`}:${workDate}`;
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

async function currentSpecialWorkdayVersions(db: Database, ruleIds: string[]) {
  if (!ruleIds.length) return new Map<string, typeof hrSpecialWorkdayRuleVersions.$inferSelect>();
  const versions = await db.select().from(hrSpecialWorkdayRuleVersions)
    .where(inJsonArray(hrSpecialWorkdayRuleVersions.ruleId, ruleIds))
    .orderBy(desc(hrSpecialWorkdayRuleVersions.versionNumber));
  const current = new Map<string, typeof versions[number]>();
  for (const version of versions) {
    if (version.voidedAt === null && !current.has(version.ruleId)) current.set(version.ruleId, version);
  }
  return current;
}

function resolvedAllowanceSnapshot(assignment: { allowanceSnapshotJson: string; allowanceQuantity: number }, allowances: Array<{ itemName: string; unitAmountMinor: number }>) {
  const quantitiesByName = new Map(parseSpecialWorkdayAllowanceSnapshot(assignment.allowanceSnapshotJson, assignment.allowanceQuantity).map((item) => [item.itemName, item.quantity]));
  return JSON.stringify(allowances.map((allowance) => ({ itemName: allowance.itemName, unitAmountMinor: allowance.unitAmountMinor, quantity: quantitiesByName.get(allowance.itemName) ?? assignment.allowanceQuantity })));
}

export async function listHrSpecialWorkdayAssignments(db: Database, periodStart?: string, periodEnd?: string) {
  const rows = await db.select({ assignment: hrSpecialWorkdayAssignments, ruleName: hrSpecialWorkdayRules.name, employeeNumber: hrEmployments.employeeNumber, employeeName: sql<string | null>`coalesce(nullif(trim(${hrEmployments.legalName}), ''), nullif(${users.displayName}, ''), nullif(${users.googleName}, ''), ${users.email})`, workerName: hrScheduleWorkers.displayName }).from(hrSpecialWorkdayAssignments)
    .innerJoin(hrSpecialWorkdayRules, eq(hrSpecialWorkdayRules.id, hrSpecialWorkdayAssignments.ruleId)).leftJoin(hrEmployments, eq(hrEmployments.id, hrSpecialWorkdayAssignments.employmentId)).leftJoin(users, eq(users.id, hrEmployments.employeeUserId)).leftJoin(hrScheduleWorkers, eq(hrScheduleWorkers.id, hrSpecialWorkdayAssignments.workerId))
    .where(and(periodStart ? sql`${hrSpecialWorkdayAssignments.workDate} >= ${periodStart}` : undefined, periodEnd ? sql`${hrSpecialWorkdayAssignments.workDate} < ${periodEnd}` : undefined)).orderBy(asc(hrSpecialWorkdayAssignments.workDate));
  const currentVersions = await currentSpecialWorkdayVersions(db, [...new Set(rows.map((row) => row.assignment.ruleId))]);
  const currentVersionIds = [...currentVersions.values()].map((version) => version.id);
  const allowances = currentVersionIds.length ? await db.select({ ruleVersionId: hrSpecialWorkdayAllowances.ruleVersionId, itemName: hrSpecialWorkdayAllowances.itemName, unitAmountMinor: hrSpecialWorkdayAllowances.unitAmountMinor }).from(hrSpecialWorkdayAllowances).where(inJsonArray(hrSpecialWorkdayAllowances.ruleVersionId, currentVersionIds)) : [];
  return rows.map((row) => {
    const version = currentVersions.get(row.assignment.ruleId);
    const currentAllowances = allowances.filter((allowance) => allowance.ruleVersionId === version?.id);
    return {
      ...row,
      assignment: {
        ...row.assignment,
        allowanceSnapshotJson: version ? resolvedAllowanceSnapshot(row.assignment, currentAllowances) : row.assignment.allowanceSnapshotJson,
      },
      currentVersionNumber: version?.versionNumber ?? null,
      currentVersionVoidedAt: version?.voidedAt ?? null,
      currentWageKind: version?.wageKind ?? null,
    };
  });
}

export async function createHrSpecialWorkdayRule(db: Database, input: SpecialWorkdayRuleInput, actor: HrActor) {
  validate(input); const ruleId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const overtimeRules = normalizeOvertimeRules(input.overtimeRules);
  const statements = [db.insert(hrSpecialWorkdayRules).values({ id: ruleId, name: input.name.trim(), createdBy: actor.id }), db.insert(hrSpecialWorkdayRuleVersions).values(versionValues(ruleId, 1, input, actor, versionId)), ...overtimeRules.map((rule) => db.insert(hrSpecialWorkdayOvertimeRules).values({ id: crypto.randomUUID(), ruleVersionId: versionId, fromHalfHours: rule.fromHalfHours, toHalfHours: rule.toHalfHours, rateKind: rule.rateKind, fixedAmountMinor: rule.rateKind === "fixed_hourly" ? rule.fixedAmountMinor! : null, multiplierPpm: rule.rateKind === "multiplier" ? rule.multiplierPpm! : null })), ...input.allowances.map((item) => db.insert(hrSpecialWorkdayAllowances).values({ id: crypto.randomUUID(), ruleVersionId: versionId, itemName: item.itemName.trim(), unitAmountMinor: item.unitAmountMinor })), db.insert(activityEvents).values(activityRow({ entityType: "hr_personnel", entityId: ruleId, source: "hr", eventType: "special_workday_rule_created", summary: "特殊上班日規則建立", actor, entityLabel: input.name.trim() }))];
  await db.batch(statements as never); return { id: ruleId, versionId };
}

/**
 * 刪除整條規則。只有從沒被任何日期套用過的規則能刪——已有套用紀錄時必須保留來源與快照，
 * 那些是薪資算過的依據。
 *
 * revision 是必填的：刪除是「連同底下所有版本一起消失」，沒有樂觀鎖的話
 * A 開著頁面看到 v1、B 剛加了 v2 修正費率、A 按下刪除——v1 與 B 那版一起沒了，
 * 而且回 200，沒有任何地方提示衝突。其他破壞性的 HR 端點都帶（班別帶 revision、
 * 勞健保費率帶 contentHash），這裡不該是例外。
 */
export async function deleteHrSpecialWorkdayRule(db: Database, ruleId: string, revision: number, actor: HrActor) {
  const [rule] = await db.select({ id: hrSpecialWorkdayRules.id, name: hrSpecialWorkdayRules.name }).from(hrSpecialWorkdayRules).where(eq(hrSpecialWorkdayRules.id, ruleId)).limit(1);
  if (!rule) throw new HrError(404, "找不到特殊上班日規則。 ");
  const [assignment] = await db.select({ id: hrSpecialWorkdayAssignments.id }).from(hrSpecialWorkdayAssignments)
    .where(eq(hrSpecialWorkdayAssignments.ruleId, ruleId)).limit(1);
  if (assignment) throw new HrError(409, "特殊上班日規則已有日期套用紀錄，不能刪除；請改用停用。 ");
  await writeHrMutation(db, [
    // 版本彼此有自我外鍵；刪除前先清掉 superseded_by_version_id，才不會被 ON DELETE RESTRICT 擋住。
    sql`UPDATE hr_special_workday_rule_versions SET superseded_by_version_id=NULL WHERE rule_id=${ruleId} RETURNING id`,
    sql`DELETE FROM hr_special_workday_overtime_rules WHERE rule_version_id IN (SELECT id FROM hr_special_workday_rule_versions WHERE rule_id=${ruleId}) RETURNING id`,
    sql`DELETE FROM hr_special_workday_allowances WHERE rule_version_id IN (SELECT id FROM hr_special_workday_rule_versions WHERE rule_id=${ruleId}) RETURNING id`,
    sql`DELETE FROM hr_special_workday_rule_versions WHERE rule_id=${ruleId} RETURNING id`,
    sql`DELETE FROM hr_special_workday_rules WHERE id=${ruleId} AND revision=${revision} RETURNING id`,
  ], ruleId, actor, "special_workday_rule_deleted", "特殊上班日規則已被套用或已變更，不能刪除；請重新整理後再試。 ", {
    allowEmptyMutationIndexes: new Set([0, 1, 2]),
    activity: { entityLabel: rule.name, summary: "特殊上班日規則刪除", payload: { ruleName: rule.name } },
  });
  return { id: ruleId, deleted: true };
}

export async function createHrSpecialWorkdayRuleVersion(db: Database, ruleId: string, input: SpecialWorkdayRuleInput, actor: HrActor) {
  validate(input);
  const overtimeRules = normalizeOvertimeRules(input.overtimeRules);
  const [rule] = await db.select({ id: hrSpecialWorkdayRules.id, name: hrSpecialWorkdayRules.name, active: hrSpecialWorkdayRules.active }).from(hrSpecialWorkdayRules).where(eq(hrSpecialWorkdayRules.id, ruleId)).limit(1);
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
    db.insert(activityEvents).values(activityRow({ entityType: "hr_personnel", entityId: ruleId, source: "hr", eventType: "special_workday_rule_version_created", summary: "特殊上班日規則版本建立", actor, entityLabel: rule.name })),
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
  /*
   * 稽核要帶名稱。規則整條刪掉之後 entity_id 就是個查不到東西的 UUID，沒有名稱的話
   * 搜「中秋加班」只會找到刪除那一筆，前面的建立、改版、停用全變成孤兒——那正是
   * entity_label 這個欄位存在的理由。
   */
  const result = await db.update(hrSpecialWorkdayRules).set({ active: active ? 1 : 0, updatedAt: sql`CURRENT_TIMESTAMP`, revision: sql`${hrSpecialWorkdayRules.revision} + 1` }).where(eq(hrSpecialWorkdayRules.id, ruleId)).returning({ id: hrSpecialWorkdayRules.id, name: hrSpecialWorkdayRules.name });
  const updated = result[0];
  if (!updated) throw new HrError(404, "找不到特殊上班日規則。 ");
  await db.insert(activityEvents).values(activityRow({ entityType: "hr_personnel", entityId: ruleId, source: "hr", eventType: active ? "special_workday_rule_activated" : "special_workday_rule_deactivated", summary: active ? "特殊上班日規則啟用" : "特殊上班日規則停用", actor, entityLabel: updated.name }));
  return { id: ruleId, active };
}

/** 舊版 API 送來版本 ID 時只解析父規則，避免把歷史版本重新寫回套用資料。 */
export async function resolveHrSpecialWorkdayRuleId(db: Database, ruleVersionId: string) {
  const [version] = await db.select({ ruleId: hrSpecialWorkdayRuleVersions.ruleId })
    .from(hrSpecialWorkdayRuleVersions)
    .where(eq(hrSpecialWorkdayRuleVersions.id, ruleVersionId)).limit(1);
  return version?.ruleId ?? ruleVersionId;
}

const SPECIAL_WORKDAY_ASSIGNMENT_BATCH_SIZE = 12;

export async function assignHrSpecialWorkdays(db: Database, input: SpecialWorkdayAssignmentInput, actor: HrActor) {
  if (!Array.isArray(input.assignments) || !input.assignments.length || input.assignments.length > 1000) throw new HrError(400, "請提供要套用的員工日期。 ");
  const ruleId = input.ruleId;
  const [rule] = await db.select().from(hrSpecialWorkdayRules).where(eq(hrSpecialWorkdayRules.id, ruleId)).limit(1);
  if (!rule) throw new HrError(404, "找不到特殊上班日規則。 ");
  if (!rule.active) throw new HrError(409, "特殊上班日規則已停用，不能新增日期套用。 ");
  const [source] = await db.select().from(hrSpecialWorkdayRuleVersions)
    .where(and(eq(hrSpecialWorkdayRuleVersions.ruleId, ruleId), sql`${hrSpecialWorkdayRuleVersions.voidedAt} IS NULL`))
    .orderBy(desc(hrSpecialWorkdayRuleVersions.versionNumber)).limit(1);
  if (!source) throw new HrError(409, "特殊上班日規則目前沒有可用設定。 ");
  const allowanceRows = await db.select().from(hrSpecialWorkdayAllowances).where(eq(hrSpecialWorkdayAllowances.ruleVersionId, source.id));
  const allowanceById = new Map(allowanceRows.map((allowance) => [allowance.id, allowance]));
  const inputKeys = new Set<string>();
  const preparedAssignments = input.assignments.map((item) => {
    validDate(item.workDate);
    const hasAllowanceQuantities = item.allowanceQuantities !== undefined;
    const legacyAllowanceQuantity = item.allowanceQuantity;
    if ((item.employmentId ? 1 : 0) + (item.workerId ? 1 : 0) !== 1 || hasAllowanceQuantities && legacyAllowanceQuantity !== undefined || !hasAllowanceQuantities && (!Number.isSafeInteger(legacyAllowanceQuantity) || legacyAllowanceQuantity! < 0)) throw new HrError(400, "特殊上班日套用對象或補貼數量不正確。 ");
    const quantityByAllowanceId = new Map<string, number>();
    for (const allowanceQuantity of item.allowanceQuantities ?? []) {
      if (!allowanceById.has(allowanceQuantity.allowanceId) || quantityByAllowanceId.has(allowanceQuantity.allowanceId) || !Number.isSafeInteger(allowanceQuantity.quantity) || allowanceQuantity.quantity < 0) throw new HrError(400, "特殊上班日補貼項目或數量不正確。 ");
      quantityByAllowanceId.set(allowanceQuantity.allowanceId, allowanceQuantity.quantity);
    }
    const allowanceSnapshot = allowanceRows.map(({ id: allowanceId, itemName }) => ({ itemName, quantity: quantityByAllowanceId.get(allowanceId) ?? legacyAllowanceQuantity ?? 0 }));
    const inputKey = specialWorkdayAssignmentKey(item.employmentId, item.workerId, item.workDate);
    if (inputKeys.has(inputKey)) throw new HrError(409, "同一批次不可重複套用同一人員同一天。 ");
    inputKeys.add(inputKey);
    return { item, inputKey, allowanceSnapshot };
  });
  const employmentIds = [...new Set(preparedAssignments.map(({ item }) => item.employmentId).filter((id): id is string => Boolean(id)))];
  const workerIds = [...new Set(preparedAssignments.map(({ item }) => item.workerId).filter((id): id is string => Boolean(id)))];
  const [employmentRows, workerRows] = await Promise.all([
    employmentIds.length ? db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(inJsonArray(hrEmployments.id, employmentIds), sql`${hrEmployments.archivedAt} IS NULL`)) : Promise.resolve([]),
    workerIds.length ? db.select({ id: hrScheduleWorkers.id }).from(hrScheduleWorkers).where(and(inJsonArray(hrScheduleWorkers.id, workerIds), eq(hrScheduleWorkers.active, 1))) : Promise.resolve([]),
  ]);
  const activeEmploymentIds = new Set(employmentRows.map((row) => row.id));
  const activeWorkerIds = new Set(workerRows.map((row) => row.id));
  const minWorkDate = preparedAssignments.reduce((min, { item }) => item.workDate < min ? item.workDate : min, preparedAssignments[0]!.item.workDate);
  const maxWorkDate = preparedAssignments.reduce((max, { item }) => item.workDate > max ? item.workDate : max, preparedAssignments[0]!.item.workDate);
  const [existingEmploymentAssignments, existingWorkerAssignments] = await Promise.all([
    employmentIds.length ? db.select({ employmentId: hrSpecialWorkdayAssignments.employmentId, workDate: hrSpecialWorkdayAssignments.workDate }).from(hrSpecialWorkdayAssignments).where(and(inJsonArray(hrSpecialWorkdayAssignments.employmentId, employmentIds), sql`${hrSpecialWorkdayAssignments.workDate} >= ${minWorkDate}`, sql`${hrSpecialWorkdayAssignments.workDate} <= ${maxWorkDate}`)) : Promise.resolve([]),
    workerIds.length ? db.select({ workerId: hrSpecialWorkdayAssignments.workerId, workDate: hrSpecialWorkdayAssignments.workDate }).from(hrSpecialWorkdayAssignments).where(and(inJsonArray(hrSpecialWorkdayAssignments.workerId, workerIds), sql`${hrSpecialWorkdayAssignments.workDate} >= ${minWorkDate}`, sql`${hrSpecialWorkdayAssignments.workDate} <= ${maxWorkDate}`)) : Promise.resolve([]),
  ]);
  const existingKeys = new Set([
    ...existingEmploymentAssignments.map((row) => specialWorkdayAssignmentKey(row.employmentId, null, row.workDate)),
    ...existingWorkerAssignments.map((row) => specialWorkdayAssignmentKey(null, row.workerId, row.workDate)),
  ]);
  const assignmentRows = [];
  for (const { item, inputKey, allowanceSnapshot } of preparedAssignments) {
    if (item.employmentId ? !activeEmploymentIds.has(item.employmentId) : !activeWorkerIds.has(item.workerId!)) throw new HrError(400, item.employmentId ? "員工目前不是有效員工。 " : "支援人員在套用日期不是啟用狀態。 ");
    if (existingKeys.has(inputKey)) throw new HrError(409, "同一人員同一天已有特殊上班日規則。 ");
    assignmentRows.push({ id: crypto.randomUUID(), ruleId, employmentId: item.employmentId ?? null, workerId: item.workerId ?? null, workDate: item.workDate, allowanceSnapshotJson: JSON.stringify(allowanceSnapshot), allowanceQuantity: item.allowanceQuantity ?? 0, appliedBy: actor.id });
  }
  /*
   * 一列一句的話，一千筆套用就是一千句，貼著 D1 每次請求的查詢數上限。改成多列寫入：
   * 每列 8 個綁定參數，一句最多 100 個，所以一批 12 列。
   */
  const statements: unknown[] = chunks(assignmentRows, SPECIAL_WORKDAY_ASSIGNMENT_BATCH_SIZE).map((batch) => db.insert(hrSpecialWorkdayAssignments).values(batch));
  statements.push(db.insert(activityEvents).values(activityRow({ entityType: "hr_personnel", entityId: ruleId, source: "hr", eventType: "special_workday_assigned", summary: "特殊上班日套用", actor, payload: { count: input.assignments.length } })));
  try {
    await db.batch(statements as never);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed/.test(error.message)) throw new HrError(409, "特殊上班日套用重複或資料不合法，請重新整理。 ");
    throw error;
  }
  return { count: input.assignments.length, ruleId };
}

export async function updateHrSpecialWorkdayAssignment(db: Database, assignmentId: string, input: SpecialWorkdayAssignmentUpdateInput, actor: HrActor) {
  const [existing] = await db.select().from(hrSpecialWorkdayAssignments).where(eq(hrSpecialWorkdayAssignments.id, assignmentId)).limit(1);
  if (!existing) throw new HrError(404, "找不到特殊上班日套用紀錄。 ");
  const [rule] = await db.select().from(hrSpecialWorkdayRules).where(eq(hrSpecialWorkdayRules.id, input.ruleId)).limit(1);
  if (!rule) throw new HrError(404, "找不到特殊上班日規則。 ");
  if (!rule.active && rule.id !== existing.ruleId) throw new HrError(409, "特殊上班日規則已停用，不能改套用到這個規則。 ");
  const [source] = await db.select().from(hrSpecialWorkdayRuleVersions)
    .where(and(eq(hrSpecialWorkdayRuleVersions.ruleId, input.ruleId), sql`${hrSpecialWorkdayRuleVersions.voidedAt} IS NULL`))
    .orderBy(desc(hrSpecialWorkdayRuleVersions.versionNumber)).limit(1);
  if (!source) throw new HrError(409, "特殊上班日規則目前沒有可用設定。 ");

  validDate(input.workDate);
  const hasAllowanceQuantities = input.allowanceQuantities !== undefined;
  const legacyAllowanceQuantity = input.allowanceQuantity;
  if ((input.employmentId ? 1 : 0) + (input.workerId ? 1 : 0) !== 1 || hasAllowanceQuantities && legacyAllowanceQuantity !== undefined || !hasAllowanceQuantities && (!Number.isSafeInteger(legacyAllowanceQuantity) || legacyAllowanceQuantity! < 0)) throw new HrError(400, "特殊上班日套用對象或補貼數量不正確。 ");
  const allowanceRows = await db.select().from(hrSpecialWorkdayAllowances).where(eq(hrSpecialWorkdayAllowances.ruleVersionId, source.id));
  const allowanceById = new Map(allowanceRows.map((allowance) => [allowance.id, allowance]));
  const quantityByAllowanceId = new Map<string, number>();
  for (const allowanceQuantity of input.allowanceQuantities ?? []) {
    if (!allowanceById.has(allowanceQuantity.allowanceId) || quantityByAllowanceId.has(allowanceQuantity.allowanceId) || !Number.isSafeInteger(allowanceQuantity.quantity) || allowanceQuantity.quantity < 0) throw new HrError(400, "特殊上班日補貼項目或數量不正確。 ");
    quantityByAllowanceId.set(allowanceQuantity.allowanceId, allowanceQuantity.quantity);
  }
  const allowanceSnapshot = allowanceRows.map(({ id: allowanceId, itemName }) => ({ itemName, quantity: quantityByAllowanceId.get(allowanceId) ?? legacyAllowanceQuantity ?? 0 }));
  const targetChanged = existing.employmentId !== (input.employmentId ?? null) || existing.workerId !== (input.workerId ?? null);
  if (targetChanged) {
    if (input.employmentId) {
      const [employment] = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(eq(hrEmployments.id, input.employmentId), sql`${hrEmployments.archivedAt} IS NULL`)).limit(1);
      if (!employment) throw new HrError(400, "員工目前不是有效員工。 ");
    } else {
      const [worker] = await db.select({ id: hrScheduleWorkers.id }).from(hrScheduleWorkers).where(and(eq(hrScheduleWorkers.id, input.workerId!), eq(hrScheduleWorkers.active, 1))).limit(1);
      if (!worker) throw new HrError(400, "支援人員目前不是啟用狀態。 ");
    }
  }
  const duplicate = await db.select({ id: hrSpecialWorkdayAssignments.id }).from(hrSpecialWorkdayAssignments).where(and(
    ne(hrSpecialWorkdayAssignments.id, assignmentId),
    eq(hrSpecialWorkdayAssignments.workDate, input.workDate),
    input.employmentId ? eq(hrSpecialWorkdayAssignments.employmentId, input.employmentId) : eq(hrSpecialWorkdayAssignments.workerId, input.workerId!),
  )).limit(1);
  if (duplicate.length) throw new HrError(409, "同一人員同一天已有特殊上班日規則。 ");

  await writeHrMutation(db, sql`UPDATE hr_special_workday_assignments SET
    rule_id=${input.ruleId}, employment_id=${input.employmentId ?? null}, worker_id=${input.workerId ?? null}, work_date=${input.workDate},
    allowance_snapshot_json=${JSON.stringify(allowanceSnapshot)}, allowance_quantity=${input.allowanceQuantity ?? 0}
    WHERE id=${assignmentId} RETURNING id`,
  assignmentId, actor, "special_workday_assignment_updated", "特殊上班日套用已變更或重複，請重新整理後再試。 ", {
    activity: { summary: "特殊上班日套用調整", payload: { ruleId: input.ruleId, employmentId: input.employmentId ?? null, workerId: input.workerId ?? null, workDate: input.workDate } },
  });
  return { id: assignmentId, ruleId: input.ruleId };
}

export async function listHrSpecialWorkdaysForPayroll(
  db: Database,
  periodStart: string,
  periodEnd: string,
  target?: { employmentIds?: string[]; workerIds?: string[] },
) {
  const targetConditions = [
    target?.employmentIds?.length ? inJsonArray(hrSpecialWorkdayAssignments.employmentId, target.employmentIds) : undefined,
    target?.workerIds?.length ? inJsonArray(hrSpecialWorkdayAssignments.workerId, target.workerIds) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
  const targetCondition = target ? targetConditions.length ? or(...targetConditions) : sql`0` : undefined;
  const assignmentRows = await db.select({ assignment: hrSpecialWorkdayAssignments, ruleId: hrSpecialWorkdayAssignments.ruleId })
    .from(hrSpecialWorkdayAssignments)
    .where(and(
      sql`${hrSpecialWorkdayAssignments.workDate} >= ${periodStart}`,
      sql`${hrSpecialWorkdayAssignments.workDate} < ${periodEnd}`,
      targetCondition,
    ));
  if (!assignmentRows.length) return [];

  const ruleIds = [...new Set(assignmentRows.map((row) => row.ruleId))];
  const [currentVersions, rules] = await Promise.all([
    currentSpecialWorkdayVersions(db, ruleIds),
    db.select({ id: hrSpecialWorkdayRules.id, name: hrSpecialWorkdayRules.name }).from(hrSpecialWorkdayRules).where(inJsonArray(hrSpecialWorkdayRules.id, ruleIds)),
  ]);
  const currentVersionIds = [...currentVersions.values()].map((version) => version.id);
  const [allowances, overtimeRules] = currentVersionIds.length ? await Promise.all([
    db.select().from(hrSpecialWorkdayAllowances).where(inJsonArray(hrSpecialWorkdayAllowances.ruleVersionId, currentVersionIds)),
    db.select().from(hrSpecialWorkdayOvertimeRules).where(inJsonArray(hrSpecialWorkdayOvertimeRules.ruleVersionId, currentVersionIds)).orderBy(asc(hrSpecialWorkdayOvertimeRules.fromHalfHours)),
  ]) : [[], []];
  const allowancesByVersion = new Map<string, typeof allowances>();
  for (const allowance of allowances) allowancesByVersion.set(allowance.ruleVersionId, [...(allowancesByVersion.get(allowance.ruleVersionId) ?? []), allowance]);
  const overtimeRulesByVersion = new Map<string, typeof overtimeRules>();
  for (const rule of overtimeRules) overtimeRulesByVersion.set(rule.ruleVersionId, [...(overtimeRulesByVersion.get(rule.ruleVersionId) ?? []), rule]);
  const ruleNames = new Map(rules.map((rule) => [rule.id, rule.name]));

  return assignmentRows.map(({ assignment, ruleId }) => {
    const version = currentVersions.get(ruleId);
    if (!version) return {
      ...assignment,
      ruleVersionId: null,
      ruleNameSnapshot: ruleNames.get(ruleId) ?? "特殊上班日規則",
      wageKindSnapshot: null,
      fixedAmountMinorSnapshot: null,
      multiplierPpmSnapshot: null,
      workSourceSnapshot: null,
      overtimeRules: [],
    };
    return {
      ...assignment,
      ruleVersionId: version.id,
      ruleNameSnapshot: ruleNames.get(ruleId) ?? "特殊上班日規則",
      wageKindSnapshot: version.wageKind,
      fixedAmountMinorSnapshot: version.fixedAmountMinor,
      multiplierPpmSnapshot: version.multiplierPpm,
      workSourceSnapshot: version.workSource,
      allowanceSnapshotJson: resolvedAllowanceSnapshot(assignment, allowancesByVersion.get(version.id) ?? []),
      overtimeRules: overtimeRulesByVersion.get(version.id) ?? [],
    };
  });
}
