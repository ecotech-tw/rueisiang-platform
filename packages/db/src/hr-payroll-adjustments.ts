import { and, asc, desc, eq, sql, type SQLWrapper } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { HrError, hrEmployeeName, hrEmployeeNumberOrder, writeHrMutation, type HrActor } from "./hr-people.js";
import { activityEvents } from "./schema/activity.js";
import { hrEmployments } from "./schema/hr-people.js";
import { hrPayrollAdjustmentItems, hrPayrollAdjustments } from "./schema/hr-payroll-runs.js";
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
function payrollAdjustmentCanEdit(employmentId: SQLWrapper | string, effectivePeriodKey: SQLWrapper | string) {
  return sql<number>`NOT (
    EXISTS (SELECT 1 FROM hr_payroll_periods p WHERE p.period_key=${effectivePeriodKey} AND p.status='closed')
    OR EXISTS (SELECT 1 FROM hr_payslips s INNER JOIN hr_payroll_runs r ON r.id=s.payroll_run_id INNER JOIN hr_payroll_periods p ON p.id=r.payroll_period_id WHERE s.employment_id=${employmentId} AND p.period_key=${effectivePeriodKey} AND r.status='closed')
    OR EXISTS (SELECT 1 FROM hr_payroll_closed_employees c WHERE c.period_key=${effectivePeriodKey} AND c.employment_id=${employmentId})
    OR EXISTS (SELECT 1 FROM hr_payroll_worker_results w INNER JOIN hr_payroll_runs r ON r.id=w.payroll_run_id INNER JOIN hr_payroll_periods p ON p.id=r.payroll_period_id WHERE w.worker_id=${employmentId} AND p.period_key=${effectivePeriodKey} AND r.status='closed')
    OR EXISTS (SELECT 1 FROM hr_payroll_closed_workers c WHERE c.period_key=${effectivePeriodKey} AND c.worker_id=${employmentId})
  )`;
}
async function ensureEditable(db: Database, employmentId: string, effectivePeriodKey: string) {
  const [row] = await db.select({ canEdit: payrollAdjustmentCanEdit(employmentId, effectivePeriodKey) }).from(hrEmployments)
    .where(eq(hrEmployments.id, employmentId)).limit(1);
  if (row && !Boolean(row.canEdit)) throw new HrError(409, "加扣項生效月份已結帳，請建立下一個月份的新加扣項。 ");
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
  const periodFilter = effectivePeriodKey ? eq(hrPayrollAdjustments.effectivePeriodKey, effectivePeriodKey) : undefined;
  const rawRows = await db.select(adjustmentJoinSelection).from(hrPayrollAdjustments)
    .innerJoin(hrPayrollAdjustmentItems, eq(hrPayrollAdjustmentItems.adjustmentId, hrPayrollAdjustments.id))
    .innerJoin(hrEmployments, eq(hrEmployments.id, hrPayrollAdjustments.employmentId)).leftJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(periodFilter).orderBy(desc(hrPayrollAdjustments.effectivePeriodKey), ...hrEmployeeNumberOrder(), asc(hrPayrollAdjustments.createdAt));
  const editabilityRows = await db.select({ id: hrPayrollAdjustments.id, canEdit: payrollAdjustmentCanEdit(hrPayrollAdjustments.employmentId, hrPayrollAdjustments.effectivePeriodKey) })
    .from(hrPayrollAdjustments).where(periodFilter);
  const rows = rawRows.map((row) => joinedAdjustment(row));
  const byId = new Map<string, { adjustment: typeof rows[number]["adjustment"]; employeeNumber: string; employeeName: string; items: typeof rows[number]["item"][] }>();
  for (const row of rows) {
    const current = byId.get(row.adjustment.id) ?? { adjustment: row.adjustment, employeeNumber: row.employeeNumber, employeeName: row.employeeName, items: [] };
    current.items.push(row.item); byId.set(row.adjustment.id, current);
  }
  const editability = new Map(editabilityRows.map((row) => [row.id, Boolean(row.canEdit)]));
  return [...byId.values()].map((row) => ({ ...row, canEdit: editability.get(row.adjustment.id) ?? false }));
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

export async function deleteHrPayrollAdjustment(db: Database, id: string, expectedRevision: number, actor: HrActor) {
  const [current] = await db.select({ id: hrPayrollAdjustments.id, employmentId: hrPayrollAdjustments.employmentId, effectivePeriodKey: hrPayrollAdjustments.effectivePeriodKey, reason: hrPayrollAdjustments.reason, revision: hrPayrollAdjustments.revision }).from(hrPayrollAdjustments).where(eq(hrPayrollAdjustments.id, id)).limit(1);
  if (!current || current.revision !== expectedRevision) throw new HrError(409, "薪資加扣項不存在或版本已過期，請重新整理。 ");
  await ensureEditable(db, current.employmentId, current.effectivePeriodKey);
  const items = await db.select({ itemName: hrPayrollAdjustmentItems.itemName, amountMinor: hrPayrollAdjustmentItems.amountMinor }).from(hrPayrollAdjustmentItems).where(eq(hrPayrollAdjustmentItems.adjustmentId, id));
  const deleteItems = sql`DELETE FROM hr_payroll_adjustment_items WHERE adjustment_id=${id} AND EXISTS (SELECT 1 FROM hr_payroll_adjustments WHERE id=${id} AND revision=${expectedRevision}) RETURNING id`;
  const deleteAdjustment = sql`DELETE FROM hr_payroll_adjustments WHERE id=${id} AND revision=${expectedRevision} RETURNING id`;
  return writeHrMutation(db, [deleteItems, deleteAdjustment], id, actor, "payroll_adjustment_deleted", "薪資加扣項不存在、版本已過期或已結帳，請重新整理。", {
    activity: { summary: "薪資加扣項已刪除", payload: { employmentId: current.employmentId, effectivePeriodKey: current.effectivePeriodKey, reason: current.reason, items } },
  });
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
    .leftJoin(users, eq(users.id, hrEmployments.employeeUserId))
    .where(eq(hrPayrollAdjustments.effectivePeriodKey, effectivePeriodKey));
  const rows = rawRows.map((row) => joinedAdjustment(row));
  const byEmployment = new Map<string, Array<{ adjustment: typeof rows[number]["adjustment"]; item: typeof rows[number]["item"] }>>();
  for (const row of rows) byEmployment.set(row.adjustment.employmentId, [...(byEmployment.get(row.adjustment.employmentId) ?? []), row]);
  return byEmployment;
}
