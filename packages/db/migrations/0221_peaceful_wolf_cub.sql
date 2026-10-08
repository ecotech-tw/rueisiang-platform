DROP INDEX `idx_hr_schedule_workers_employment`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_schedule_workers_employment` ON `hr_schedule_workers` (`employment_id`);--> statement-breakpoint
CREATE TRIGGER `trg_hr_employment_person_kind_immutable`
BEFORE UPDATE OF `person_kind` ON `hr_employments`
WHEN NEW.`person_kind` <> OLD.`person_kind`
BEGIN
  SELECT RAISE(ABORT, 'hr_employment_person_kind_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_schedule_workers_identity_insert`
BEFORE INSERT ON `hr_schedule_workers`
WHEN NEW.`id` <> NEW.`employment_id`
BEGIN
  SELECT RAISE(ABORT, 'hr_schedule_worker_identity_mismatch');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_schedule_workers_identity_update`
BEFORE UPDATE OF `id`, `employment_id` ON `hr_schedule_workers`
WHEN NEW.`id` <> NEW.`employment_id`
BEGIN
  SELECT RAISE(ABORT, 'hr_schedule_worker_identity_mismatch');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_schedule_workers_employment_kind_insert`
BEFORE INSERT ON `hr_schedule_workers`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'worker')
BEGIN
  SELECT RAISE(ABORT, 'worker_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_schedule_workers_employment_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_schedule_workers`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'worker')
BEGIN
  SELECT RAISE(ABORT, 'worker_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_worker_compensation_employment_kind_insert`
BEFORE INSERT ON `hr_worker_compensation_versions`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`worker_id` AND `person_kind` = 'worker')
BEGIN
  SELECT RAISE(ABORT, 'worker_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_worker_compensation_employment_kind_update`
BEFORE UPDATE OF `worker_id` ON `hr_worker_compensation_versions`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`worker_id` AND `person_kind` = 'worker')
BEGIN
  SELECT RAISE(ABORT, 'worker_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_schedule_worker_entries_employment_kind_insert`
BEFORE INSERT ON `hr_schedule_worker_entries`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`worker_id` AND `person_kind` = 'worker')
BEGIN
  SELECT RAISE(ABORT, 'worker_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_schedule_worker_entries_employment_kind_update`
BEFORE UPDATE OF `worker_id` ON `hr_schedule_worker_entries`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`worker_id` AND `person_kind` = 'worker')
BEGIN
  SELECT RAISE(ABORT, 'worker_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_worker_overtime_employment_kind_insert`
BEFORE INSERT ON `hr_worker_overtime_requests`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`worker_id` AND `person_kind` = 'worker')
BEGIN
  SELECT RAISE(ABORT, 'worker_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_worker_overtime_employment_kind_update`
BEFORE UPDATE OF `worker_id` ON `hr_worker_overtime_requests`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`worker_id` AND `person_kind` = 'worker')
BEGIN
  SELECT RAISE(ABORT, 'worker_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_worker_results_employment_kind_insert`
BEFORE INSERT ON `hr_payroll_worker_results`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`worker_id` AND `person_kind` = 'worker')
BEGIN
  SELECT RAISE(ABORT, 'worker_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_worker_results_employment_kind_update`
BEFORE UPDATE OF `worker_id` ON `hr_payroll_worker_results`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`worker_id` AND `person_kind` = 'worker')
BEGIN
  SELECT RAISE(ABORT, 'worker_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_closed_workers_employment_kind_insert`
BEFORE INSERT ON `hr_payroll_closed_workers`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`worker_id` AND `person_kind` = 'worker')
BEGIN
  SELECT RAISE(ABORT, 'worker_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_closed_workers_employment_kind_update`
BEFORE UPDATE OF `worker_id` ON `hr_payroll_closed_workers`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`worker_id` AND `person_kind` = 'worker')
BEGIN
  SELECT RAISE(ABORT, 'worker_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_special_workday_assignment_employment_kind_insert`
BEFORE INSERT ON `hr_special_workday_assignments`
WHEN (NEW.`employment_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee'))
  OR (NEW.`worker_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`worker_id` AND `person_kind` = 'worker'))
BEGIN
  SELECT RAISE(ABORT, 'special_workday_person_kind_mismatch');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_special_workday_assignment_employment_kind_update`
BEFORE UPDATE OF `employment_id`, `worker_id` ON `hr_special_workday_assignments`
WHEN (NEW.`employment_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee'))
  OR (NEW.`worker_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`worker_id` AND `person_kind` = 'worker'))
BEGIN
  SELECT RAISE(ABORT, 'special_workday_person_kind_mismatch');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_record_item_employment_kind_insert`
BEFORE INSERT ON `hr_payroll_record_items`
WHEN (NEW.`person_kind` = 'employee' AND NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee'))
  OR (NEW.`person_kind` = 'worker' AND NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`worker_id` AND `person_kind` = 'worker'))
BEGIN
  SELECT RAISE(ABORT, 'payroll_record_person_kind_mismatch');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_record_item_employment_kind_update`
BEFORE UPDATE OF `person_kind`, `employment_id`, `worker_id` ON `hr_payroll_record_items`
WHEN (NEW.`person_kind` = 'employee' AND NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee'))
  OR (NEW.`person_kind` = 'worker' AND NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`worker_id` AND `person_kind` = 'worker'))
BEGIN
  SELECT RAISE(ABORT, 'payroll_record_person_kind_mismatch');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_service_period_kind_insert`
BEFORE INSERT ON `hr_employment_service_periods`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_service_period_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_employment_service_periods`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_employee_scopes_kind_insert`
BEFORE INSERT ON `hr_employee_scopes`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_employee_scopes_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_employee_scopes`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_attendance_locations_kind_insert`
BEFORE INSERT ON `hr_employee_attendance_locations`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_attendance_locations_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_employee_attendance_locations`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_attendance_settings_kind_insert`
BEFORE INSERT ON `hr_employment_attendance_settings`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_attendance_settings_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_employment_attendance_settings`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_clock_events_identity_insert`
BEFORE INSERT ON `hr_clock_events`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `employee_user_id` = NEW.`employee_user_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_identity_mismatch');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_clock_events_identity_update`
BEFORE UPDATE OF `employment_id`, `employee_user_id` ON `hr_clock_events`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `employee_user_id` = NEW.`employee_user_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_identity_mismatch');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_compensation_kind_insert`
BEFORE INSERT ON `hr_compensation_versions`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_compensation_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_compensation_versions`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_insurance_kind_insert`
BEFORE INSERT ON `hr_insurance_versions`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_insurance_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_insurance_versions`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_monthly_leave_kind_insert`
BEFORE INSERT ON `hr_monthly_leave_entries`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_monthly_leave_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_monthly_leave_entries`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_monthly_hourly_kind_insert`
BEFORE INSERT ON `hr_monthly_hourly_entries`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_monthly_hourly_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_monthly_hourly_entries`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_leave_requests_kind_insert`
BEFORE INSERT ON `hr_leave_requests`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_leave_requests_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_leave_requests`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_overtime_kind_insert`
BEFORE INSERT ON `hr_overtime_requests`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_overtime_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_overtime_requests`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_schedule_entries_kind_insert`
BEFORE INSERT ON `hr_schedule_entries`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_schedule_entries_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_schedule_entries`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_bonus_members_kind_insert`
BEFORE INSERT ON `hr_bonus_policy_members`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_bonus_members_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_bonus_policy_members`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_payroll_adjustments_kind_insert`
BEFORE INSERT ON `hr_payroll_adjustments`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_payroll_adjustments_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_payroll_adjustments`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_payroll_closed_kind_insert`
BEFORE INSERT ON `hr_payroll_closed_employees`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_payroll_closed_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_payroll_closed_employees`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_payroll_run_employees_kind_insert`
BEFORE INSERT ON `hr_payroll_run_employees`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_payroll_run_employees_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_payroll_run_employees`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_payslips_kind_insert`
BEFORE INSERT ON `hr_payslips`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_payslips_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_payslips`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_annual_entitlements_kind_insert`
BEFORE INSERT ON `hr_annual_leave_entitlements`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_annual_entitlements_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_annual_leave_entitlements`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_form_requests_identity_insert`
BEFORE INSERT ON `hr_form_requests`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `employee_user_id` = NEW.`employee_user_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_identity_mismatch');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_formal_form_requests_identity_update`
BEFORE UPDATE OF `employment_id`, `employee_user_id` ON `hr_form_requests`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `employee_user_id` = NEW.`employee_user_id` AND `person_kind` = 'employee')
BEGIN
  SELECT RAISE(ABORT, 'formal_employee_identity_mismatch');
END;