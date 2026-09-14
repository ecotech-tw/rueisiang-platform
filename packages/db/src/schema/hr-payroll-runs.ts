import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { hrCompensationVersions, hrInsuranceVersions, hrWorkerCompensationVersions } from "./hr-payroll.js";
import { hrEmployments } from "./hr-people.js";
import { hrScheduleWorkers } from "./hr-scheduling.js";
import { users } from "./auth.js";

export const hrPayrollPeriods = sqliteTable("hr_payroll_periods", {
  id: text("id").primaryKey(),
  periodKey: text("period_key").notNull(),
  attendanceStart: text("attendance_start").notNull(),
  attendanceEnd: text("attendance_end").notNull(),
  payDate: text("pay_date").notNull(),
  status: text("status", { enum: ["open", "closed"] as const }).notNull().default("open"),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revision: integer("revision").notNull().default(1),
}, (table) => [
  uniqueIndex("idx_hr_payroll_periods_key").on(table.periodKey),
  check("ck_hr_payroll_periods_key", sql`${table.periodKey} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'`),
  check("ck_hr_payroll_periods_dates", sql`length(${table.attendanceStart}) = 10 AND length(${table.attendanceEnd}) = 10 AND ${table.attendanceEnd} > ${table.attendanceStart} AND length(${table.payDate}) = 10`),
  check("ck_hr_payroll_periods_status", sql`${table.status} IN ('open', 'closed')`),
  check("ck_hr_payroll_periods_revision", sql`${table.revision} > 0`),
]);

/** 已結帳期間的差額補發／扣回；不改寫原薪資單，於生效月份產生獨立明細。 */
export const hrPayrollAdjustments = sqliteTable("hr_payroll_adjustments", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  sourcePeriodKey: text("source_period_key").notNull(),
  effectivePeriodKey: text("effective_period_key").notNull(),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: text("updated_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revision: integer("revision").notNull().default(1),
}, (table) => [
  index("idx_hr_payroll_adjustments_effective").on(table.effectivePeriodKey, table.employmentId),
  check("ck_hr_payroll_adjustments_source_period", sql`${table.sourcePeriodKey} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'`),
  check("ck_hr_payroll_adjustments_effective_period", sql`${table.effectivePeriodKey} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'`),
  check("ck_hr_payroll_adjustments_reason", sql`length(trim(${table.reason})) BETWEEN 1 AND 1000`),
  check("ck_hr_payroll_adjustments_revision", sql`${table.revision} > 0`),
]);

export const hrPayrollAdjustmentItems = sqliteTable("hr_payroll_adjustment_items", {
  id: text("id").primaryKey(),
  adjustmentId: text("adjustment_id").notNull().references(() => hrPayrollAdjustments.id, { onDelete: "restrict" }),
  itemName: text("item_name").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_hr_payroll_adjustment_items_adjustment").on(table.adjustmentId),
  check("ck_hr_payroll_adjustment_items_name", sql`length(trim(${table.itemName})) BETWEEN 1 AND 100`),
]);

export const hrPayrollRuns = sqliteTable("hr_payroll_runs", {
  id: text("id").primaryKey(),
  payrollPeriodId: text("payroll_period_id").notNull().references(() => hrPayrollPeriods.id, { onDelete: "restrict" }),
  versionNumber: integer("version_number").notNull(),
  requestId: text("request_id").notNull(),
  inputRevision: integer("input_revision").notNull(),
  engineVersion: text("engine_version").notNull(),
  status: text("status", { enum: ["calculating", "ready", "approved", "closed", "failed"] as const }).notNull().default("calculating"),
  expectedCount: integer("expected_count").notNull().default(0),
  completedCount: integer("completed_count").notNull().default(0),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "restrict" }),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_payroll_runs_request").on(table.requestId),
  uniqueIndex("idx_hr_payroll_runs_period_version").on(table.payrollPeriodId, table.versionNumber),
  index("idx_hr_payroll_runs_period_status").on(table.payrollPeriodId, table.status),
  check("ck_hr_payroll_runs_version", sql`${table.versionNumber} > 0`),
  check("ck_hr_payroll_runs_input_revision", sql`${table.inputRevision} > 0`),
  check("ck_hr_payroll_runs_status", sql`${table.status} IN ('calculating', 'ready', 'approved', 'closed', 'failed')`),
  check("ck_hr_payroll_runs_counts", sql`${table.expectedCount} >= 0 AND ${table.completedCount} BETWEEN 0 AND ${table.expectedCount}`),
]);

export const hrPayrollRunEmployees = sqliteTable("hr_payroll_run_employees", {
  payrollRunId: text("payroll_run_id").notNull().references(() => hrPayrollRuns.id, { onDelete: "restrict" }),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  inputRevision: integer("input_revision").notNull(),
  status: text("status", { enum: ["calculating", "succeeded", "failed"] as const }).notNull().default("calculating"),
  lastError: text("last_error").notNull().default(""),
}, (table) => [
  primaryKey({ columns: [table.payrollRunId, table.employmentId] }),
  index("idx_hr_payroll_run_employees_employment").on(table.employmentId, table.payrollRunId),
  check("ck_hr_payroll_run_employees_revision", sql`${table.inputRevision} > 0`),
  check("ck_hr_payroll_run_employees_status", sql`${table.status} IN ('calculating', 'succeeded', 'failed')`),
  check("ck_hr_payroll_run_employees_error", sql`length(${table.lastError}) <= 1000`),
]);

/** 薪資單保存姓名與員工編號快照；更名不應改變已結帳的歷史文件。 */
export const hrPayslips = sqliteTable("hr_payslips", {
  id: text("id").primaryKey(),
  payrollRunId: text("payroll_run_id").notNull().references(() => hrPayrollRuns.id, { onDelete: "restrict" }),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  employeeNumber: text("employee_number").notNull(),
  employeeName: text("employee_name").notNull(),
  earningMinor: integer("earning_minor").notNull(),
  deductionMinor: integer("deduction_minor").notNull(),
  netMinor: integer("net_minor").notNull(),
  publishedAt: text("published_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_payslips_run_employment").on(table.payrollRunId, table.employmentId),
  index("idx_hr_payslips_employment").on(table.employmentId, table.createdAt),
  check("ck_hr_payslips_amounts", sql`${table.earningMinor} >= 0 AND ${table.deductionMinor} >= 0 AND ${table.netMinor} = ${table.earningMinor} - ${table.deductionMinor}`),
  check("ck_hr_payslips_employee_number", sql`length(trim(${table.employeeNumber})) BETWEEN 1 AND 40`),
]);

/** 約聘／臨時支援人員沒有 employee payslip，仍保留同一批薪資試算的歷史結果。 */
export const hrPayrollWorkerResults = sqliteTable("hr_payroll_worker_results", {
  id: text("id").primaryKey(),
  payrollRunId: text("payroll_run_id").notNull().references(() => hrPayrollRuns.id, { onDelete: "restrict" }),
  workerId: text("worker_id").notNull().references(() => hrScheduleWorkers.id, { onDelete: "restrict" }),
  workerName: text("worker_name").notNull(),
  compensationVersionId: text("compensation_version_id").references(() => hrWorkerCompensationVersions.id, { onDelete: "restrict" }),
  payBasis: text("pay_basis", { enum: ["monthly", "daily", "hourly", "mixed"] as const }).notNull(),
  scheduledDays: integer("scheduled_days").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_payroll_worker_results_run_worker").on(table.payrollRunId, table.workerId),
  index("idx_hr_payroll_worker_results_worker").on(table.workerId, table.createdAt),
  check("ck_hr_payroll_worker_results_name", sql`length(trim(${table.workerName})) BETWEEN 1 AND 100`),
  check("ck_hr_payroll_worker_results_days", sql`${table.scheduledDays} >= 0`),
  check("ck_hr_payroll_worker_results_amount", sql`${table.amountMinor} >= 0`),
]);

export const hrPayslipLines = sqliteTable("hr_payslip_lines", {
  id: text("id").primaryKey(),
  payslipId: text("payslip_id").notNull().references(() => hrPayslips.id, { onDelete: "restrict" }),
  lineKey: text("line_key").notNull(),
  direction: text("direction", { enum: ["earning", "deduction"] as const }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  quantitySeconds: integer("quantity_seconds"),
  explanationJson: text("explanation_json").notNull().default("{}"),
}, (table) => [
  uniqueIndex("idx_hr_payslip_lines_key").on(table.payslipId, table.lineKey),
  check("ck_hr_payslip_lines_key", sql`length(trim(${table.lineKey})) BETWEEN 1 AND 80`),
  check("ck_hr_payslip_lines_direction", sql`${table.direction} IN ('earning', 'deduction')`),
  check("ck_hr_payslip_lines_amount", sql`${table.amountMinor} >= 0`),
  check("ck_hr_payslip_lines_quantity", sql`${table.quantitySeconds} IS NULL OR ${table.quantitySeconds} >= 0`),
  check("ck_hr_payslip_lines_explanation", sql`length(${table.explanationJson}) <= 10000`),
]);

export const hrPayslipCompensationLinks = sqliteTable("hr_payslip_compensation_links", {
  payslipId: text("payslip_id").notNull().references(() => hrPayslips.id, { onDelete: "restrict" }),
  compensationVersionId: text("compensation_version_id").notNull().references(() => hrCompensationVersions.id, { onDelete: "restrict" }),
}, (table) => [primaryKey({ columns: [table.payslipId, table.compensationVersionId] })]);

export const hrPayslipInsuranceLinks = sqliteTable("hr_payslip_insurance_links", {
  payslipId: text("payslip_id").notNull().references(() => hrPayslips.id, { onDelete: "restrict" }),
  insuranceVersionId: text("insurance_version_id").notNull().references(() => hrInsuranceVersions.id, { onDelete: "restrict" }),
}, (table) => [primaryKey({ columns: [table.payslipId, table.insuranceVersionId] })]);

export type HrPayrollPeriod = typeof hrPayrollPeriods.$inferSelect;
export type HrPayrollAdjustment = typeof hrPayrollAdjustments.$inferSelect;
export type HrPayrollAdjustmentItem = typeof hrPayrollAdjustmentItems.$inferSelect;
export type HrPayrollRun = typeof hrPayrollRuns.$inferSelect;
export type HrPayrollWorkerResult = typeof hrPayrollWorkerResults.$inferSelect;
export type HrPayslip = typeof hrPayslips.$inferSelect;
export type HrPayslipLine = typeof hrPayslipLines.$inferSelect;
