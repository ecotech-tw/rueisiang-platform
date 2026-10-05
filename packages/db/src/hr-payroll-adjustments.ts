import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { HrError, hrEmployeeName, writeHrMutation, type HrActor } from "./hr-people.js";
import { activityEvents } from "./schema/activity.js";
import { hrEmployments } from "./schema/hr-people.js";
import { hrPayrollAdjustmentItems, hrPayrollAdjustments, hrPayrollClosedEmployees, hrPayrollPeriods, hrPayrollRuns, hrPayslips } from "./schema/hr-payroll-runs.js";
import { users } from "./schema/auth.js";

export interface HrPayrollAdjustmentItemInput { itemName: string; amountMinor: number }
export interface HrPayrollAdjustmentInput { employmentId: string; effectivePeriodKey: string; reason: string; items: HrPayrollAdjustmentItemInput[] }
const displayName = hrEmployeeName;

function periodKey(value: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new HrError(400, "薪資月份必須是 YYYY-MM。 ");
}
function validate(input: HrPayrollAdjustmentInput) {
  periodKey(input.effectivePeriodKey);
  if (!input.reason.trim() || input.reason.length > 1000) throw new HrError(400, "薪資加扣項原因必填且不可超過 1000 字。 ");
  if (!input.items.length || input.items.length > 50) throw new HrError(400, "薪資加扣項至少需要一個項目，最多 50 項。 ");
  for (const item of input.items) {
    if (!item.itemName.trim() || item.itemName.length > 100 || !Number.isSafeInteger(item.amountMinor) || item.amountMinor === 0) throw new HrError(400, "薪資加扣項目或金額不正確。 ");
  }
}
async function ensureEditable(db: Database, employmentId: string, effectivePeriodKey: string) {
  const [periodRow] = await db.select({ status: hrPayrollPeriods.status }).from(hrPayrollPeriods).where(eq(hrPayrollPeriods.periodKey, effectivePeriodKey)).limit(1);
  const [closed] = await db.select({ id: hrPayslips.id }).from(hrPayslips)
    .innerJoin(hrPayrollRuns, eq(hrPayrollRuns.id, hrPayslips.payrollRunId))
    .innerJoin(hrPayrollPeriods, eq(hrPayrollPeriods.id, hrPayrollRuns.payrollPeriodId))
    .where(and(eq(hrPayslips.employmentId, employmentId), eq(hrPayrollPeriods.periodKey, effectivePeriodKey), eq(hrPayrollRuns.status, "closed"))).limit(1);
  const [closedClaim] = await db.select({ employmentId: hrPayrollClosedEmployees.employmentId }).from(hrPayrollClosedEmployees)
    .where(and(eq(hrPayrollClosedEmployees.periodKey, effectivePeriodKey), eq(hrPayrollClosedEmployees.employmentId, employmentId))).limit(1);
  if (periodRow?.status === "closed" || closed || closedClaim) throw new HrError(409, "加扣項生效月份已結帳，請建立下一個月份的新加扣項。 ");
}
async function ensureEmployment(db: Database, employmentId: string) {
  const [row] = await db.select({ id: hrEmployments.id }).from(hrEmployments).where(and(eq(hrEmployments.id, employmentId), sql`${hrEmployments.archivedAt} IS NULL`)).limit(1);
  if (!row) throw new HrError(404, "找不到任職紀錄。 ");
}

const adjustmentJoinSelection = {
  adjustmentId: hrPayrollAdjustments.id, adjustmentEmploymentId: hrPayrollAdjustments.employmentId,
  adjustmentEffectivePeriodKey: hrPayrollAdjustments.effectivePeriodKey, adjustmentReason: hrPayrollAdjustments.reason, adjustmentCreatedBy: hrPayrollAdjustments.createdBy,
  adjustmentCreatedAt: hrPayrollAdjustments.createdAt, adjustmentUpdatedBy: hrPayrollAdjustments.updatedBy, adjustmentUpdatedAt: hrPayrollAdjustments.updatedAt, adjustmentRevision: hrPayrollAdjustments.revision,
  itemId: hrPayrollAdjustmentItems.id, itemAdjustmentId: hrPayrollAdjustmentItems.adjustmentId, itemName: hrPayrollAdjustmentItems.itemName, itemAmountMinor: hrPayrollAdjustmentItems.amountMinor, itemCreatedAt: hrPayrollAdjustmentItems.createdAt,
  employeeNumber: hrEmployments.employeeNumber, employeeName: displayName,
};
type JoinedAdjustmentRow = {
  adjustmentId: string; adjustmentEmploymentId: string; adjustmentEffectivePeriodKey: string; adjustmentReason: string; adjustmentCreatedBy: string; adjustmentCreatedAt: string; adjustmentUpdatedBy: string; adjustmentUpdatedAt: string; adjustmentRevision: number;
  itemId: string; itemAdjustmentId: string; itemName: string; itemAmountMinor: number; itemCreatedAt: string; employeeNumber: string; employeeName: string;
};
function joinedAdjustment(row: JoinedAdjustmentRow) {
  return {
    adjustment: { id: row.adjustmentId, employmentId: row.adjustmentEmploymentId, effectivePeriodKey: row.adjustmentEffectivePeriodKey, reason: row.adjustmentReason, createdBy: row.adjustmentCreatedBy, createdAt: row.adjustmentCreatedAt, updatedBy: row.adjustmentUpdatedBy, updatedAt: row.adjustmentUpdatedAt, revision: row.adjustmentRevision },
    item: { id: row.itemId, adjustmentId: row.itemAdjustmentId, itemName: row.itemName, amountMinor: row.itemAmountMinor, createdAt: row.itemCreatedAt }, employeeNumber: row.employeeNumber, employeeName: row.employeeName,
  };
}

export async function listHrPayrollAdjustments(db: Database, effectivePeriodKey?: string) {
  if (effectivePeriodKey) periodKey(effectivePeriodKey);
  const rawRows = await db.select(adjustmentJoinSelection).from(hrPayrollAdjustments)
    .innerJoin(hrPayrollAdjustmentItems, eq(hrPayrollAdjustmentItems.adjustmentId, hrPayrollAdjustments.id))
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrPayrollAdjustments.employmentId)).innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(effectivePeriodKey ? eq(hrPayrollAdjustments.effectivePeriodKey, effectivePeriodKey) : undefined).orderBy(desc(hrPayrollAdjustments.effectivePeriodKey), asc(hrEmployments.employeeNumber), asc(hrPayrollAdjustments.createdAt));
  const rows = rawRows.map((row) => joinedAdjustment(row));
  const byId = new Map<string, { adjustment: typeof rows[number]["adjustment"]; employeeNumber: string; employeeName: string; items: typeof rows[number]["item"][] }>();
  for (const row of rows) {
    const current = byId.get(row.adjustment.id) ?? { adjustment: row.adjustment, employeeNumber: row.employeeNumber, employeeName: row.employeeName, items: [] };
    current.items.push(row.item); byId.set(row.adjustment.id, current);
  }
  return [...byId.values()];
}

export async function createHrPayrollAdjustment(db: Database, input: HrPayrollAdjustmentInput, actor: HrActor) {
  validate(input); await ensureEmployment(db, input.employmentId); await ensureEditable(db, input.employmentId, input.effectivePeriodKey);
  const id = crypto.randomUUID();
  const statements = [
    db.insert(hrPayrollAdjustments).values({ id, employmentId: input.employmentId, effectivePeriodKey: input.effectivePeriodKey, reason: input.reason.trim(), createdBy: actor.id, updatedBy: actor.id }),
    ...input.items.map((item) => db.insert(hrPayrollAdjustmentItems).values({ id: crypto.randomUUID(), adjustmentId: id, itemName: item.itemName.trim(), amountMinor: item.amountMinor })),
    db.insert(activityEvents).values(activityRow({ entityType: "hr_personnel", entityId: id, source: "hr", eventType: "payroll_adjustment_created", summary: "薪資加扣項建立", actor, payload: { employmentId: input.employmentId, effectivePeriodKey: input.effectivePeriodKey, itemCount: input.items.length } })),
  ];
  await db.batch(statements as never);
  return { id };
}

export async function updateHrPayrollAdjustment(db: Database, id: string, input: HrPayrollAdjustmentInput & { revision: number }, actor: HrActor) {
  validate(input);
  const [current] = await db.select({ id: hrPayrollAdjustments.id, employmentId: hrPayrollAdjustments.employmentId, effectivePeriodKey: hrPayrollAdjustments.effectivePeriodKey, revision: hrPayrollAdjustments.revision }).from(hrPayrollAdjustments).where(eq(hrPayrollAdjustments.id, id)).limit(1);
  if (!current || current.revision !== input.revision) throw new HrError(409, "薪資加扣項不存在或版本已過期，請重新整理。 ");
  await ensureEditable(db, current.employmentId, current.effectivePeriodKey);
  await ensureEmployment(db, input.employmentId); await ensureEditable(db, input.employmentId, input.effectivePeriodKey);
  const update = sql`UPDATE hr_payroll_adjustments SET employment_id=${input.employmentId}, effective_period_key=${input.effectivePeriodKey}, reason=${input.reason.trim()}, updated_by=${actor.id}, updated_at=CURRENT_TIMESTAMP, revision=revision+1 WHERE id=${id} AND revision=${input.revision} RETURNING id`;
  const deleteItems = sql`DELETE FROM hr_payroll_adjustment_items WHERE adjustment_id=${id} AND EXISTS (SELECT 1 FROM hr_payroll_adjustments WHERE id=${id} AND revision=${input.revision + 1}) RETURNING id`;
  const insertItems = input.items.map((item) => sql`INSERT INTO hr_payroll_adjustment_items (id, adjustment_id, item_name, amount_minor)
    SELECT ${crypto.randomUUID()}, ${id}, ${item.itemName.trim()}, ${item.amountMinor}
    WHERE EXISTS (SELECT 1 FROM hr_payroll_adjustments WHERE id=${id} AND revision=${input.revision + 1}) RETURNING id`);
  return writeHrMutation(db, [update, deleteItems, ...insertItems], id, actor, "payroll_adjustment_updated", "薪資加扣項不存在、版本已過期或資料不合法，請重新整理。 ");
}

export async function listHrPayrollAdjustmentsForPeriod(db: Database, effectivePeriodKey: string) {
  const rawRows = await db.select(adjustmentJoinSelection).from(hrPayrollAdjustments)
    .innerJoin(hrPayrollAdjustmentItems, eq(hrPayrollAdjustmentItems.adjustmentId, hrPayrollAdjustments.id)).innerJoin(hrEmployments, eq(hrEmployments.id, hrPayrollAdjustments.employmentId))
    .innerJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(eq(hrPayrollAdjustments.effectivePeriodKey, effectivePeriodKey));
  const rows = rawRows.map((row) => joinedAdjustment(row));
  const byEmployment = new Map<string, Array<{ adjustment: typeof rows[number]["adjustment"]; item: typeof rows[number]["item"] }>>();
  for (const row of rows) byEmployment.set(row.adjustment.employmentId, [...(byEmployment.get(row.adjustment.employmentId) ?? []), row]);
  return byEmployment;
}
