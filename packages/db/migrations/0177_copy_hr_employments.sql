-- 把 0175 已回填的扁平資料複製到新父表。子表仍暫時指向舊表，
-- 直到下一支 generated migration 完成外鍵搬移後才交換 table 名稱。
-- 0178 會重建 HR 下游表；先移除所有掛在這些表或查詢這些表的 trigger，
-- 0179 完成交換後再以同一份歷史定義重建，避免 trigger 參考暫時不存在的表。
DROP TRIGGER IF EXISTS `trg_hr_special_workday_source_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_special_workday_source_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_special_workday_assignment_source_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_special_workday_assignment_source_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_overtime_rate_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_overtime_rate_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_leave_validation_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_leave_validation_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_leave_capacity_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_leave_capacity_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_leave_closed_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_leave_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_leave_closed_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_hourly_validation_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_hourly_validation_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_hourly_closed_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_hourly_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_hourly_closed_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_run_open_period`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_run_snapshot_validation_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_run_snapshot_validation_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_run_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_run_closed_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_closed_employee_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_closed_employee_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_closed_employee_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslips_closed_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslips_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslips_closed_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslip_lines_closed_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslip_lines_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslip_lines_closed_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_run_employees_closed_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_run_employees_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_run_employees_closed_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_worker_results_closed_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_worker_results_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_worker_results_closed_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslip_compensation_links_closed_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslip_compensation_links_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslip_compensation_links_closed_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslip_insurance_links_closed_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslip_insurance_links_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslip_insurance_links_closed_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_period_close_requires_claims`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_period_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_adjustment_closed_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_adjustment_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_adjustment_closed_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_adjustment_item_closed_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_adjustment_item_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_adjustment_item_closed_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_attendance_rest_days_validation_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_attendance_rest_days_validation_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_shift_minutes_validation_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_shift_minutes_validation_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_schedule_entry_minutes_validation_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_schedule_entry_minutes_validation_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_schedule_worker_entry_minutes_validation_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_schedule_worker_entry_minutes_validation_update`;--> statement-breakpoint
INSERT INTO `hr_employments_v2` (
  `id`, `employee_user_id`, `employee_number`, `position`, `supervisor_user_id`,
  `archived_at`, `revision`, `created_at`, `updated_at`
)
SELECT
  `id`, `employee_user_id`, `employee_number`, `position`, `supervisor_user_id`,
  `archived_at`, `revision`, `created_at`, `updated_at`
FROM `hr_employments`;
--> statement-breakpoint
-- 在舊日期欄位仍存在時保存服務年資起算日；後續交換任職主檔後沿用同一 employment id。
CREATE TABLE `hr_employment_service_periods` (
  `employment_id` text PRIMARY KEY NOT NULL,
  `service_start_on` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT "ck_hr_employment_service_periods_date" CHECK(length(`service_start_on`) = 10)
);
--> statement-breakpoint
INSERT INTO `hr_employment_service_periods` (`employment_id`, `service_start_on`, `created_at`, `updated_at`)
SELECT `id`, `seniority_start_on`, `created_at`, `updated_at`
FROM `hr_employments`;
