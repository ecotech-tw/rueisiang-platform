import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { hrCompensationVersions, hrInsuranceVersions, hrWorkerCompensationVersions } from "./hr-payroll.js";
import { hrEmployments } from "./hr-people.js";
import { hrScheduleWorkers } from "./hr-scheduling.js";
import { users } from "./auth.js";

/** writeHrMutation 用的交易內 guard；CHECK 失敗會讓整個 D1 batch rollback。 */
export const hrMutationGuards = sqliteTable("hr_mutation_guards", {
  id: text("id").primaryKey(),
  ok: integer("ok").notNull(),
}, (table) => [check("ck_hr_mutation_guards_ok", sql`${table.ok} = 1`)]);

export const hrPayrollPeriods = sqliteTable("hr_payroll_periods", {
  id: text("id").primaryKey(),
  periodKey: text("period_key").notNull(),
  attendanceStart: text("attendance_start").notNull(),
  attendanceEnd: text("attendance_end").notNull(),
  payDate: text("pay_date"),
  status: text("status", { enum: ["open", "closed"] as const }).notNull().default("open"),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revision: integer("revision").notNull().default(1),
}, (table) => [
  uniqueIndex("idx_hr_payroll_periods_key").on(table.periodKey),
  check("ck_hr_payroll_periods_key", sql`${table.periodKey} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'`),
  check("ck_hr_payroll_periods_dates", sql`length(${table.attendanceStart}) = 10 AND length(${table.attendanceEnd}) = 10 AND ${table.attendanceEnd} > ${table.attendanceStart} AND (${table.payDate} IS NULL OR length(${table.payDate}) = 10)`),
  check("ck_hr_payroll_periods_status", sql`${table.status} IN ('open', 'closed')`),
  check("ck_hr_payroll_periods_revision", sql`${table.revision} > 0`),
]);

/** 指定生效月份的人工薪資加扣項；不改寫原薪資單，於該月份產生獨立明細。 */
export const hrPayrollAdjustments = sqliteTable("hr_payroll_adjustments", {
  id: text("id").primaryKey(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  effectivePeriodKey: text("effective_period_key").notNull(),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: text("updated_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revision: integer("revision").notNull().default(1),
}, (table) => [
  index("idx_hr_payroll_adjustments_effective").on(table.effectivePeriodKey, table.employmentId),
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
  payDate: text("pay_date"),
  calculationInputJson: text("calculation_input_json").notNull().default("{}"),
  sourceSnapshotJson: text("source_snapshot_json").notNull().default("{}"),
  warningsJson: text("warnings_json").notNull().default("[]"),
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
  check("ck_hr_payroll_runs_pay_date", sql`${table.payDate} IS NULL OR length(${table.payDate}) = 10`),
  check("ck_hr_payroll_runs_calculation_input", sql`length(${table.calculationInputJson}) <= 10000`),
  check("ck_hr_payroll_runs_source_snapshot", sql`length(${table.sourceSnapshotJson}) <= 2000000`),
  check("ck_hr_payroll_runs_warnings", sql`length(${table.warningsJson}) <= 100000`),
  check("ck_hr_payroll_runs_status", sql`${table.status} IN ('calculating', 'ready', 'approved', 'closed', 'failed')`),
  check("ck_hr_payroll_runs_counts", sql`${table.expectedCount} >= 0 AND ${table.completedCount} BETWEEN 0 AND ${table.expectedCount}`),
]);

/**
 * 薪資批次用過哪些特殊上班日套用與規則版本，一列一筆。
 *
 * 存在的理由只有一個——「這筆套用／這一版還能不能刪」每次開頁面、每次刪除都要問，從批次的
 * source_snapshot_json 找就得把所有批次的快照重新解析一遍，批次越多越慢。批次建立時照快照寫入，
 * 批次刪除時一起刪。
 *
 * **不能當成「隨時可以從快照重建」的快取**：0211 回填的早期批次，有些列來自薪資明細
 * （assignmentIds、specialWorkdayRuleSnapshots），那些批次的快照裡根本沒有 specialWorkdays。
 * 清空重建會漏掉那一半，早期批次用過的套用與版本就變成可以刪。
 *
 * 四個 ID 欄位都不設外鍵：
 * - payroll_run_id：設 RESTRICT 的話，不知道這張表的舊版 Worker（部署空窗、回滾）刪批次會直接失敗；
 *   設 CASCADE 則是 CLAUDE.md 明說不要的那種（父表哪天被重建，整張表會被連坐刪光）。
 *   所以批次不在了的列一律當作不存在：讀的時候過濾，刪批次時順手掃掉。
 * - assignment_id／rule_id／rule_version_id：回填進來的歷史 ID 可能指向早就不在的列。
 *   能不能刪由 hr-special-workdays.ts 判斷。
 *
 * rule_version_id 是 NULL 的列來自沒記版本的舊紀錄，只知道當時的規則與日期（連這兩個都沒有時是 NULL）。
 */
export const hrPayrollSpecialWorkdaySources = sqliteTable("hr_payroll_special_workday_sources", {
  id: text("id").primaryKey(),
  payrollRunId: text("payroll_run_id").notNull(),
  assignmentId: text("assignment_id"),
  ruleId: text("rule_id"),
  ruleVersionId: text("rule_version_id"),
  workDate: text("work_date"),
}, (table) => [
  index("idx_hr_payroll_special_workday_sources_run").on(table.payrollRunId),
  index("idx_hr_payroll_special_workday_sources_assignment").on(table.assignmentId),
  index("idx_hr_payroll_special_workday_sources_version").on(table.ruleVersionId),
  check("ck_hr_payroll_special_workday_sources_target", sql`${table.assignmentId} IS NOT NULL OR ${table.ruleVersionId} IS NOT NULL`),
]);

/**
 * 已經寫過 hr_payroll_special_workday_sources 的批次，一個批次一列。
 *
 * 「這個批次沒有特殊上班日」與「這個批次還沒寫索引」在索引表裡長得一樣（都是零列），要靠這張表分辨。
 * 會沒寫的情況：migration 已套用、但還在跑的舊版 Worker 建立的批次（每次部署都有這段空窗，回滾期間也是）。
 * 讀索引之前先找出不在這張表裡的批次，從它的來源快照補寫——見 indexMissingPayrollSpecialWorkdaySources。
 * 不設外鍵，理由同上一張表。
 */
export const hrPayrollSpecialWorkdaySourceRuns = sqliteTable("hr_payroll_special_workday_source_runs", {
  payrollRunId: text("payroll_run_id").primaryKey(),
});

/** 撤回原因是稽核紀錄；批次退回 ready 並釋放當期 claim，供重新覆核、試算或刪除。一般不可改寫 marker，刪除整批時由受控交易一併清除。 */
export const hrPayrollWithdrawals = sqliteTable("hr_payroll_withdrawals", {
  payrollRunId: text("payroll_run_id").primaryKey().references(() => hrPayrollRuns.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  withdrawnBy: text("withdrawn_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  withdrawnAt: text("withdrawn_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_hr_payroll_withdrawals_withdrawn_at").on(table.withdrawnAt),
  check("ck_hr_payroll_withdrawals_reason", sql`length(trim(${table.reason})) BETWEEN 1 AND 1000`),
]);

/** 背景薪資試算的投遞與進度；真正的薪資結果仍以 hr_payroll_runs 為準。 */
export const hrPayrollJobs = sqliteTable("hr_payroll_jobs", {
  id: text("id").primaryKey(),
  payrollRunId: text("payroll_run_id").references(() => hrPayrollRuns.id, { onDelete: "set null" }),
  requestId: text("request_id").notNull(),
  calculationInputJson: text("calculation_input_json").notNull().default("{}"),
  actorId: text("actor_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  actorEmail: text("actor_email").notNull().default(""),
  status: text("status", { enum: ["queued", "calculating", "ready", "failed"] as const }).notNull().default("queued"),
  phase: text("phase", { enum: ["queued", "preparing", "calculating_workers", "calculating_employees", "persisting", "completed", "failed"] as const }).notNull().default("queued"),
  expectedCount: integer("expected_count").notNull().default(0),
  completedCount: integer("completed_count").notNull().default(0),
  attemptCount: integer("attempt_count").notNull().default(0),
  queueStatus: text("queue_status", { enum: ["pending", "enqueued"] as const }).notNull().default("pending"),
  queueAttempts: integer("queue_attempts").notNull().default(0),
  queueError: text("queue_error").notNull().default(""),
  lastError: text("last_error").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_payroll_jobs_request").on(table.requestId),
  index("idx_hr_payroll_jobs_status_updated").on(table.status, table.updatedAt),
  check("ck_hr_payroll_jobs_input", sql`length(${table.calculationInputJson}) <= 10000 AND json_valid(${table.calculationInputJson}) = 1 AND json_type(${table.calculationInputJson}) = 'object'`),
  check("ck_hr_payroll_jobs_actor_email", sql`length(${table.actorEmail}) <= 320`),
  check("ck_hr_payroll_jobs_phase", sql`${table.phase} IN ('queued', 'preparing', 'calculating_workers', 'calculating_employees', 'persisting', 'completed', 'failed')`),
  check("ck_hr_payroll_jobs_status", sql`${table.status} IN ('queued', 'calculating', 'ready', 'failed')`),
  check("ck_hr_payroll_jobs_queue_status", sql`${table.queueStatus} IN ('pending', 'enqueued')`),
  check("ck_hr_payroll_jobs_counts", sql`${table.expectedCount} >= 0 AND ${table.completedCount} BETWEEN 0 AND ${table.expectedCount}`),
  check("ck_hr_payroll_jobs_attempts", sql`${table.attemptCount} >= 0 AND ${table.queueAttempts} >= 0`),
  check("ck_hr_payroll_jobs_errors", sql`length(${table.queueError}) <= 2000 AND length(${table.lastError}) <= 2000`),
]);

export type HrPayrollJob = typeof hrPayrollJobs.$inferSelect;

/** 只保存 migration 後的新結帳 claim；既有歷史結果不重寫，但未來並行結帳由資料庫唯一鍵仲裁。 */
export const hrPayrollClosedEmployees = sqliteTable("hr_payroll_closed_employees", {
  periodKey: text("period_key").notNull(),
  employmentId: text("employment_id").notNull().references(() => hrEmployments.id, { onDelete: "restrict" }),
  payrollRunId: text("payroll_run_id").notNull().references(() => hrPayrollRuns.id, { onDelete: "restrict" }),
  closedAt: text("closed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.periodKey, table.employmentId] }),
  index("idx_hr_payroll_closed_employees_run").on(table.payrollRunId),
  check("ck_hr_payroll_closed_employees_period", sql`${table.periodKey} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'`),
]);

/** 支援人員沒有正式 payslip；另存同一組 period/person claim，讓發放紀錄可以逐筆核准。 */
export const hrPayrollClosedWorkers = sqliteTable("hr_payroll_closed_workers", {
  periodKey: text("period_key").notNull(),
  workerId: text("worker_id").notNull().references(() => hrScheduleWorkers.id, { onDelete: "restrict" }),
  payrollRunId: text("payroll_run_id").notNull().references(() => hrPayrollRuns.id, { onDelete: "restrict" }),
  closedAt: text("closed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  primaryKey({ columns: [table.periodKey, table.workerId] }),
  index("idx_hr_payroll_closed_workers_run").on(table.payrollRunId),
  check("ck_hr_payroll_closed_workers_period", sql`${table.periodKey} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'`),
]);

/** 舊版單筆發放加扣項的相容資料表；新的薪資加扣項一律使用 hrPayrollAdjustments 並在試算時寫入薪資單快照。 */
export const hrPayrollRecordItems = sqliteTable("hr_payroll_record_items", {
  id: text("id").primaryKey(),
  payrollRunId: text("payroll_run_id").notNull().references(() => hrPayrollRuns.id, { onDelete: "restrict" }),
  personKind: text("person_kind", { enum: ["employee", "worker"] as const }).notNull(),
  employmentId: text("employment_id").references(() => hrEmployments.id, { onDelete: "restrict" }),
  workerId: text("worker_id").references(() => hrScheduleWorkers.id, { onDelete: "restrict" }),
  itemName: text("item_name").notNull(),
  direction: text("direction", { enum: ["earning", "deduction"] as const }).notNull(),
  amountMinor: integer("amount_minor").notNull(),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_hr_payroll_record_items_record").on(table.payrollRunId, table.personKind, table.employmentId, table.workerId),
  check("ck_hr_payroll_record_items_person", sql`(${table.personKind} = 'employee' AND ${table.employmentId} IS NOT NULL AND ${table.workerId} IS NULL) OR (${table.personKind} = 'worker' AND ${table.employmentId} IS NULL AND ${table.workerId} IS NOT NULL)`),
  check("ck_hr_payroll_record_items_name", sql`length(trim(${table.itemName})) BETWEEN 1 AND 100`),
  check("ck_hr_payroll_record_items_direction", sql`${table.direction} IN ('earning', 'deduction')`),
  check("ck_hr_payroll_record_items_amount", sql`${table.amountMinor} > 0`),
  check("ck_hr_payroll_record_items_reason", sql`length(trim(${table.reason})) BETWEEN 1 AND 1000`),
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
  /** 支援人員付薪加班的歷史快照；舊結果預設為 0／空物件。 */
  overtimeMinor: integer("overtime_minor").notNull().default(0),
  overtimeSeconds: integer("overtime_seconds").notNull().default(0),
  overtimeExplanationJson: text("overtime_explanation_json").notNull().default("{}"),
  /** 支援人員的班別薪資分配快照，供結帳後稽核；舊結果為空陣列。 */
  scheduleAllocationJson: text("schedule_allocation_json").notNull().default("[]"),
  typhoonStopDays: integer("typhoon_stop_days").notNull().default(0),
  typhoonStopPayMinor: integer("typhoon_stop_pay_minor").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_hr_payroll_worker_results_run_worker").on(table.payrollRunId, table.workerId),
  index("idx_hr_payroll_worker_results_worker").on(table.workerId, table.createdAt),
  check("ck_hr_payroll_worker_results_name", sql`length(trim(${table.workerName})) BETWEEN 1 AND 100`),
  check("ck_hr_payroll_worker_results_days", sql`${table.scheduledDays} >= 0`),
  check("ck_hr_payroll_worker_results_amount", sql`${table.amountMinor} >= 0`),
  check("ck_hr_payroll_worker_results_overtime", sql`${table.overtimeMinor} >= 0 AND ${table.overtimeSeconds} >= 0 AND length(${table.overtimeExplanationJson}) <= 50000`),
  check("ck_hr_payroll_worker_results_typhoon_days", sql`${table.typhoonStopDays} >= 0 AND ${table.typhoonStopDays} <= ${table.scheduledDays}`),
  check("ck_hr_payroll_worker_results_typhoon_amount", sql`${table.typhoonStopPayMinor} >= 0`),
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
export type HrPayrollClosedWorker = typeof hrPayrollClosedWorkers.$inferSelect;
export type HrPayrollRecordItem = typeof hrPayrollRecordItems.$inferSelect;
export type HrPayrollWorkerResult = typeof hrPayrollWorkerResults.$inferSelect;
export type HrPayslip = typeof hrPayslips.$inferSelect;
export type HrPayslipLine = typeof hrPayslipLines.$inferSelect;
