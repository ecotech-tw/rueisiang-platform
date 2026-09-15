UPDATE `hr_special_workday_rule_versions` SET `work_source` = 'hourly' WHERE `work_source` <> 'hourly';
--> statement-breakpoint
UPDATE `hr_special_workday_assignments` SET `work_source_snapshot` = 'hourly' WHERE `work_source_snapshot` <> 'hourly';
--> statement-breakpoint
UPDATE `hr_overtime_requests` SET `rate_ppm` = 1333333 WHERE `rate_ppm` <> 1333333;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_special_workday_source_insert`
BEFORE INSERT ON `hr_special_workday_rule_versions`
WHEN NEW.`work_source` <> 'hourly'
BEGIN
  SELECT RAISE(ABORT, 'special_workday_source_server_determined');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_special_workday_source_update`
BEFORE UPDATE OF `work_source` ON `hr_special_workday_rule_versions`
WHEN NEW.`work_source` <> 'hourly'
BEGIN
  SELECT RAISE(ABORT, 'special_workday_source_server_determined');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_special_workday_assignment_source_insert`
BEFORE INSERT ON `hr_special_workday_assignments`
WHEN NEW.`work_source_snapshot` <> 'hourly'
BEGIN
  SELECT RAISE(ABORT, 'special_workday_source_server_determined');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_special_workday_assignment_source_update`
BEFORE UPDATE OF `work_source_snapshot` ON `hr_special_workday_assignments`
WHEN NEW.`work_source_snapshot` <> 'hourly'
BEGIN
  SELECT RAISE(ABORT, 'special_workday_source_server_determined');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_overtime_rate_insert`
BEFORE INSERT ON `hr_overtime_requests`
WHEN NEW.`rate_ppm` <> 1333333
BEGIN
  SELECT RAISE(ABORT, 'overtime_rate_server_determined');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_overtime_rate_update`
BEFORE UPDATE OF `rate_ppm` ON `hr_overtime_requests`
WHEN NEW.`rate_ppm` <> 1333333
BEGIN
  SELECT RAISE(ABORT, 'overtime_rate_server_determined');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_leave_validation_insert`
BEFORE INSERT ON `hr_monthly_leave_entries`
WHEN date(NEW.`leave_date`) IS NULL OR date(NEW.`leave_date`) <> NEW.`leave_date`
  OR typeof(NEW.`hours_half_units`) <> 'integer' OR NEW.`hours_half_units` NOT BETWEEN 1 AND 48
  OR typeof(NEW.`pay_rate_ppm`) <> 'integer' OR NEW.`pay_rate_ppm` NOT BETWEEN 0 AND 1000000
  OR typeof(NEW.`deduction_amount`) <> 'integer' OR NEW.`deduction_amount` < 0
  OR NOT EXISTS (SELECT 1 FROM `hr_leave_types` WHERE `id` = NEW.`leave_type_id` AND `active` = 1)
BEGIN
  SELECT RAISE(ABORT, 'monthly_leave_validation_failed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_leave_validation_update`
BEFORE UPDATE OF `leave_type_id`, `leave_date`, `hours_half_units`, `pay_rate_ppm`, `deduction_amount` ON `hr_monthly_leave_entries`
WHEN date(NEW.`leave_date`) IS NULL OR date(NEW.`leave_date`) <> NEW.`leave_date`
  OR typeof(NEW.`hours_half_units`) <> 'integer' OR NEW.`hours_half_units` NOT BETWEEN 1 AND 48
  OR typeof(NEW.`pay_rate_ppm`) <> 'integer' OR NEW.`pay_rate_ppm` NOT BETWEEN 0 AND 1000000
  OR typeof(NEW.`deduction_amount`) <> 'integer' OR NEW.`deduction_amount` < 0
  OR NOT EXISTS (SELECT 1 FROM `hr_leave_types` WHERE `id` = NEW.`leave_type_id` AND `active` = 1)
BEGIN
  SELECT RAISE(ABORT, 'monthly_leave_validation_failed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_leave_capacity_insert`
BEFORE INSERT ON `hr_monthly_leave_entries`
WHEN coalesce((SELECT sum(`hours_half_units`) FROM `hr_monthly_leave_entries` WHERE `employment_id` = NEW.`employment_id` AND `leave_date` = NEW.`leave_date`), 0) + NEW.`hours_half_units` > 48
BEGIN
  SELECT RAISE(ABORT, 'daily_leave_capacity_exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_leave_capacity_update`
BEFORE UPDATE OF `employment_id`, `leave_date`, `hours_half_units` ON `hr_monthly_leave_entries`
WHEN coalesce((SELECT sum(`hours_half_units`) FROM `hr_monthly_leave_entries` WHERE `id` <> OLD.`id` AND `employment_id` = NEW.`employment_id` AND `leave_date` = NEW.`leave_date`), 0) + NEW.`hours_half_units` > 48
BEGIN
  SELECT RAISE(ABORT, 'daily_leave_capacity_exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_leave_closed_insert`
BEFORE INSERT ON `hr_monthly_leave_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(NEW.`leave_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` = NEW.`employment_id` AND `period`.`period_key` = substr(NEW.`leave_date`, 1, 7) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_leave_closed_update`
BEFORE UPDATE ON `hr_monthly_leave_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(NEW.`leave_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(OLD.`leave_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` IN (OLD.`employment_id`, NEW.`employment_id`) AND `period`.`period_key` IN (substr(OLD.`leave_date`, 1, 7), substr(NEW.`leave_date`, 1, 7)) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_leave_closed_delete`
BEFORE DELETE ON `hr_monthly_leave_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(OLD.`leave_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` = OLD.`employment_id` AND `period`.`period_key` = substr(OLD.`leave_date`, 1, 7) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_hourly_validation_insert`
BEFORE INSERT ON `hr_monthly_hourly_entries`
WHEN date(NEW.`work_date`) IS NULL OR date(NEW.`work_date`) <> NEW.`work_date`
  OR typeof(NEW.`hours_half_units`) <> 'integer' OR NEW.`hours_half_units` NOT BETWEEN 0 AND 48
  OR typeof(NEW.`no_work`) <> 'integer' OR NEW.`no_work` NOT IN (0, 1)
  OR (NEW.`no_work` = 0 AND NEW.`hours_half_units` = 0)
BEGIN
  SELECT RAISE(ABORT, 'monthly_hourly_validation_failed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_hourly_validation_update`
BEFORE UPDATE OF `work_date`, `hours_half_units`, `no_work` ON `hr_monthly_hourly_entries`
WHEN date(NEW.`work_date`) IS NULL OR date(NEW.`work_date`) <> NEW.`work_date`
  OR typeof(NEW.`hours_half_units`) <> 'integer' OR NEW.`hours_half_units` NOT BETWEEN 0 AND 48
  OR typeof(NEW.`no_work`) <> 'integer' OR NEW.`no_work` NOT IN (0, 1)
  OR (NEW.`no_work` = 0 AND NEW.`hours_half_units` = 0)
BEGIN
  SELECT RAISE(ABORT, 'monthly_hourly_validation_failed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_hourly_closed_insert`
BEFORE INSERT ON `hr_monthly_hourly_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(NEW.`work_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` = NEW.`employment_id` AND `period`.`period_key` = substr(NEW.`work_date`, 1, 7) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_hourly_closed_update`
BEFORE UPDATE ON `hr_monthly_hourly_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(NEW.`work_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(OLD.`work_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` IN (OLD.`employment_id`, NEW.`employment_id`) AND `period`.`period_key` IN (substr(OLD.`work_date`, 1, 7), substr(NEW.`work_date`, 1, 7)) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_hourly_closed_delete`
BEFORE DELETE ON `hr_monthly_hourly_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(OLD.`work_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` = OLD.`employment_id` AND `period`.`period_key` = substr(OLD.`work_date`, 1, 7) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
--> statement-breakpoint
CREATE TABLE `hr_mutation_guards` (
  `id` text PRIMARY KEY NOT NULL,
  `ok` integer NOT NULL,
  CONSTRAINT `ck_hr_mutation_guards_ok` CHECK(`ok` = 1)
);
--> statement-breakpoint
ALTER TABLE `hr_bonus_performance_snapshots` ADD COLUMN `idempotency_key` text;
--> statement-breakpoint
UPDATE `hr_bonus_performance_snapshots`
SET `idempotency_key` = json_array(`scope_id`, coalesce(`employment_id`, 'team'), `period_start`, `period_end`, `source_ref`)
WHERE `idempotency_key` IS NULL;
--> statement-breakpoint
UPDATE `hr_bonus_performance_snapshots`
SET `idempotency_key` = `idempotency_key` || ':legacy:' || `id`
WHERE `id` NOT IN (SELECT min(`id`) FROM `hr_bonus_performance_snapshots` GROUP BY `idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_bonus_performance_idempotency` ON `hr_bonus_performance_snapshots` (`idempotency_key`);
--> statement-breakpoint
CREATE TRIGGER `trg_hr_bonus_performance_idempotency_required`
BEFORE INSERT ON `hr_bonus_performance_snapshots`
WHEN NEW.`idempotency_key` IS NULL OR length(NEW.`idempotency_key`) = 0
BEGIN
  SELECT RAISE(ABORT, 'bonus_performance_idempotency_required');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_bonus_performance_idempotency_update_required`
BEFORE UPDATE OF `idempotency_key` ON `hr_bonus_performance_snapshots`
WHEN NEW.`idempotency_key` IS NULL OR length(NEW.`idempotency_key`) = 0
BEGIN
  SELECT RAISE(ABORT, 'bonus_performance_idempotency_required');
END;
--> statement-breakpoint
ALTER TABLE `hr_clock_events` ADD COLUMN `correction_request_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_clock_events_correction_request` ON `hr_clock_events` (`correction_request_id`);
--> statement-breakpoint
ALTER TABLE `hr_form_requests` ADD COLUMN `corrected_clock_event_id` text;
--> statement-breakpoint
CREATE INDEX `idx_hr_form_requests_corrected_event` ON `hr_form_requests` (`corrected_clock_event_id`);
--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `hr_payroll_periods_new` (
  `id` text PRIMARY KEY NOT NULL,
  `period_key` text NOT NULL,
  `attendance_start` text NOT NULL,
  `attendance_end` text NOT NULL,
  `pay_date` text,
  `status` text DEFAULT 'open' NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_payroll_periods_key` CHECK(`period_key` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  CONSTRAINT `ck_hr_payroll_periods_dates` CHECK(length(`attendance_start`) = 10 AND length(`attendance_end`) = 10 AND `attendance_end` > `attendance_start` AND (`pay_date` IS NULL OR length(`pay_date`) = 10)),
  CONSTRAINT `ck_hr_payroll_periods_status` CHECK(`status` IN ('open', 'closed')),
  CONSTRAINT `ck_hr_payroll_periods_revision` CHECK(`revision` > 0)
);
--> statement-breakpoint
INSERT INTO `hr_payroll_periods_new` (`id`, `period_key`, `attendance_start`, `attendance_end`, `pay_date`, `status`, `created_by`, `created_at`, `updated_at`, `revision`)
  SELECT `id`, `period_key`, `attendance_start`, `attendance_end`, `pay_date`, `status`, `created_by`, `created_at`, `updated_at`, `revision` FROM `hr_payroll_periods`;
--> statement-breakpoint
DROP TABLE `hr_payroll_periods`;
--> statement-breakpoint
CREATE TABLE `hr_payroll_periods` (
  `id` text PRIMARY KEY NOT NULL,
  `period_key` text NOT NULL,
  `attendance_start` text NOT NULL,
  `attendance_end` text NOT NULL,
  `pay_date` text,
  `status` text DEFAULT 'open' NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_payroll_periods_key` CHECK(`period_key` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  CONSTRAINT `ck_hr_payroll_periods_dates` CHECK(length(`attendance_start`) = 10 AND length(`attendance_end`) = 10 AND `attendance_end` > `attendance_start` AND (`pay_date` IS NULL OR length(`pay_date`) = 10)),
  CONSTRAINT `ck_hr_payroll_periods_status` CHECK(`status` IN ('open', 'closed')),
  CONSTRAINT `ck_hr_payroll_periods_revision` CHECK(`revision` > 0)
);
--> statement-breakpoint
INSERT INTO `hr_payroll_periods` (`id`, `period_key`, `attendance_start`, `attendance_end`, `pay_date`, `status`, `created_by`, `created_at`, `updated_at`, `revision`)
  SELECT `id`, `period_key`, `attendance_start`, `attendance_end`, `pay_date`, `status`, `created_by`, `created_at`, `updated_at`, `revision` FROM `hr_payroll_periods_new`;
--> statement-breakpoint
DROP TABLE `hr_payroll_periods_new`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payroll_periods_key` ON `hr_payroll_periods` (`period_key`);
--> statement-breakpoint
ALTER TABLE `hr_payroll_runs` ADD COLUMN `pay_date` text;
--> statement-breakpoint
ALTER TABLE `hr_payroll_runs` ADD COLUMN `calculation_input_json` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE `hr_payroll_runs` ADD COLUMN `source_snapshot_json` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE `hr_payroll_runs` ADD COLUMN `warnings_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
UPDATE `hr_payroll_runs` SET `pay_date` = (SELECT `pay_date` FROM `hr_payroll_periods` WHERE `hr_payroll_periods`.`id` = `hr_payroll_runs`.`payroll_period_id`) WHERE `pay_date` IS NULL;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_run_open_period`
BEFORE INSERT ON `hr_payroll_runs`
WHEN NOT EXISTS (SELECT 1 FROM `hr_payroll_periods` WHERE `id` = NEW.`payroll_period_id` AND `status` = 'open')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_run_snapshot_validation_insert`
BEFORE INSERT ON `hr_payroll_runs`
WHEN (NEW.`pay_date` IS NOT NULL AND (date(NEW.`pay_date`) IS NULL OR date(NEW.`pay_date`) <> NEW.`pay_date`))
  OR length(NEW.`calculation_input_json`) > 10000
  OR length(NEW.`source_snapshot_json`) > 2000000
  OR length(NEW.`warnings_json`) > 100000
  OR json_valid(NEW.`calculation_input_json`) = 0 OR json_type(NEW.`calculation_input_json`) <> 'object'
  OR json_valid(NEW.`source_snapshot_json`) = 0 OR json_type(NEW.`source_snapshot_json`) <> 'object'
  OR json_valid(NEW.`warnings_json`) = 0 OR json_type(NEW.`warnings_json`) <> 'array'
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_snapshot_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_run_snapshot_validation_update`
BEFORE UPDATE OF `pay_date`, `calculation_input_json`, `source_snapshot_json`, `warnings_json` ON `hr_payroll_runs`
WHEN (NEW.`pay_date` IS NOT NULL AND (date(NEW.`pay_date`) IS NULL OR date(NEW.`pay_date`) <> NEW.`pay_date`))
  OR length(NEW.`calculation_input_json`) > 10000
  OR length(NEW.`source_snapshot_json`) > 2000000
  OR length(NEW.`warnings_json`) > 100000
  OR json_valid(NEW.`calculation_input_json`) = 0 OR json_type(NEW.`calculation_input_json`) <> 'object'
  OR json_valid(NEW.`source_snapshot_json`) = 0 OR json_type(NEW.`source_snapshot_json`) <> 'object'
  OR json_valid(NEW.`warnings_json`) = 0 OR json_type(NEW.`warnings_json`) <> 'array'
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_snapshot_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_run_closed_update`
BEFORE UPDATE ON `hr_payroll_runs`
WHEN OLD.`status` = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_run_closed_delete`
BEFORE DELETE ON `hr_payroll_runs`
WHEN OLD.`status` = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TABLE `hr_payroll_closed_employees` (
  `period_key` text NOT NULL,
  `employment_id` text NOT NULL,
  `payroll_run_id` text NOT NULL,
  `closed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY(`period_key`, `employment_id`),
  FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_payroll_closed_employees_period` CHECK(`period_key` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_closed_employees_run` ON `hr_payroll_closed_employees` (`payroll_run_id`);
--> statement-breakpoint
INSERT INTO `hr_payroll_closed_employees` (`period_key`, `employment_id`, `payroll_run_id`)
  SELECT `period`.`period_key`, `payslip`.`employment_id`, min(`run`.`id`)
  FROM `hr_payslips` AS `payslip`
  INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id`
  INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id`
  WHERE `run`.`status` = 'closed'
  GROUP BY `period`.`period_key`, `payslip`.`employment_id`;
--> statement-breakpoint
UPDATE `hr_payroll_periods` SET `status` = 'closed', `updated_at` = CURRENT_TIMESTAMP
  WHERE EXISTS (SELECT 1 FROM `hr_payroll_runs` AS `run` WHERE `run`.`payroll_period_id` = `hr_payroll_periods`.`id` AND `run`.`status` = 'closed');
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_closed_employee_insert`
BEFORE INSERT ON `hr_payroll_closed_employees`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = NEW.`period_key` AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payroll_runs` AS `run` WHERE `run`.`id` = NEW.`payroll_run_id` AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_closed_employee_update`
BEFORE UPDATE ON `hr_payroll_closed_employees`
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_closed_employee_delete`
BEFORE DELETE ON `hr_payroll_closed_employees`
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslips_closed_insert`
BEFORE INSERT ON `hr_payslips`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_runs` WHERE `id` = NEW.`payroll_run_id` AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslips_closed_update`
BEFORE UPDATE ON `hr_payslips`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_runs` WHERE `id` IN (OLD.`payroll_run_id`, NEW.`payroll_run_id`) AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslips_closed_delete`
BEFORE DELETE ON `hr_payslips`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_runs` WHERE `id` = OLD.`payroll_run_id` AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_lines_closed_insert`
BEFORE INSERT ON `hr_payslip_lines`
WHEN EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` WHERE `payslip`.`id` = NEW.`payslip_id` AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_lines_closed_update`
BEFORE UPDATE ON `hr_payslip_lines`
WHEN EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` WHERE `payslip`.`id` IN (OLD.`payslip_id`, NEW.`payslip_id`) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_lines_closed_delete`
BEFORE DELETE ON `hr_payslip_lines`
WHEN EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` WHERE `payslip`.`id` = OLD.`payslip_id` AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_run_employees_closed_insert`
BEFORE INSERT ON `hr_payroll_run_employees`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_runs` WHERE `id` = NEW.`payroll_run_id` AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_run_employees_closed_update`
BEFORE UPDATE ON `hr_payroll_run_employees`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_runs` WHERE `id` IN (OLD.`payroll_run_id`, NEW.`payroll_run_id`) AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_run_employees_closed_delete`
BEFORE DELETE ON `hr_payroll_run_employees`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_runs` WHERE `id` = OLD.`payroll_run_id` AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_worker_results_closed_insert`
BEFORE INSERT ON `hr_payroll_worker_results`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_runs` WHERE `id` = NEW.`payroll_run_id` AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_worker_results_closed_update`
BEFORE UPDATE ON `hr_payroll_worker_results`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_runs` WHERE `id` IN (OLD.`payroll_run_id`, NEW.`payroll_run_id`) AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_worker_results_closed_delete`
BEFORE DELETE ON `hr_payroll_worker_results`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_runs` WHERE `id` = OLD.`payroll_run_id` AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_compensation_links_closed_insert`
BEFORE INSERT ON `hr_payslip_compensation_links`
WHEN EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` WHERE `payslip`.`id` = NEW.`payslip_id` AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_compensation_links_closed_update`
BEFORE UPDATE ON `hr_payslip_compensation_links`
WHEN EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` WHERE `payslip`.`id` IN (OLD.`payslip_id`, NEW.`payslip_id`) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_compensation_links_closed_delete`
BEFORE DELETE ON `hr_payslip_compensation_links`
WHEN EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` WHERE `payslip`.`id` = OLD.`payslip_id` AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_insurance_links_closed_insert`
BEFORE INSERT ON `hr_payslip_insurance_links`
WHEN EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` WHERE `payslip`.`id` = NEW.`payslip_id` AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_insurance_links_closed_update`
BEFORE UPDATE ON `hr_payslip_insurance_links`
WHEN EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` WHERE `payslip`.`id` IN (OLD.`payslip_id`, NEW.`payslip_id`) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_insurance_links_closed_delete`
BEFORE DELETE ON `hr_payslip_insurance_links`
WHEN EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` WHERE `payslip`.`id` = OLD.`payslip_id` AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_period_close_requires_claims`
BEFORE UPDATE OF `status` ON `hr_payroll_periods`
WHEN OLD.`status` = 'open' AND NEW.`status` = 'closed'
  AND EXISTS (
    SELECT 1 FROM `hr_employments` AS `employment`
    INNER JOIN `hr_employees` AS `employee` ON `employee`.`user_id` = `employment`.`employee_user_id`
    INNER JOIN `users` AS `account` ON `account`.`id` = `employment`.`employee_user_id`
    WHERE `account`.`status` = 'active'
      AND `employment`.`hired_on` < NEW.`attendance_end`
      AND (`employment`.`ended_on` IS NULL OR `employment`.`ended_on` > NEW.`attendance_start`)
      AND NOT EXISTS (
        SELECT 1 FROM `hr_payroll_closed_employees` AS `claim`
        WHERE `claim`.`period_key` = NEW.`period_key` AND `claim`.`employment_id` = `employment`.`id`
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_not_ready');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_period_closed_update`
BEFORE UPDATE ON `hr_payroll_periods`
WHEN OLD.`status` = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `hr_bonus_performance_snapshots_new` (
  `id` text PRIMARY KEY NOT NULL,
  `scope_id` text NOT NULL,
  `employment_id` text,
  `period_start` text NOT NULL,
  `period_end` text NOT NULL,
  `amount_minor` integer NOT NULL,
  `source_kind` text NOT NULL,
  `source_ref` text DEFAULT '' NOT NULL,
  `idempotency_key` text NOT NULL,
  `provenance_json` text DEFAULT '{}' NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_bonus_performance_period` CHECK(`period_end` > `period_start`),
  CONSTRAINT `ck_hr_bonus_performance_amount` CHECK(`amount_minor` >= 0),
  CONSTRAINT `ck_hr_bonus_performance_kind` CHECK(`source_kind` IN ('manual', 'report')),
  CONSTRAINT `ck_hr_bonus_performance_idempotency` CHECK(length(trim(`idempotency_key`)) > 0),
  CONSTRAINT `ck_hr_bonus_performance_provenance` CHECK(length(`provenance_json`) <= 10000)
);
--> statement-breakpoint
INSERT INTO `hr_bonus_performance_snapshots_new` (`id`, `scope_id`, `employment_id`, `period_start`, `period_end`, `amount_minor`, `source_kind`, `source_ref`, `idempotency_key`, `provenance_json`, `created_by`, `created_at`)
  SELECT `id`, `scope_id`, `employment_id`, `period_start`, `period_end`, `amount_minor`, `source_kind`, `source_ref`, `idempotency_key`, `provenance_json`, `created_by`, `created_at`
  FROM `hr_bonus_performance_snapshots`;
--> statement-breakpoint
DROP TABLE `hr_bonus_performance_snapshots`;
--> statement-breakpoint
ALTER TABLE `hr_bonus_performance_snapshots_new` RENAME TO `hr_bonus_performance_snapshots`;
--> statement-breakpoint
CREATE INDEX `idx_hr_bonus_performance_scope_period` ON `hr_bonus_performance_snapshots` (`scope_id`,`period_start`,`period_end`);
--> statement-breakpoint
CREATE INDEX `idx_hr_bonus_performance_employment_period` ON `hr_bonus_performance_snapshots` (`employment_id`,`period_start`,`period_end`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_bonus_performance_source` ON `hr_bonus_performance_snapshots` (`scope_id`,`employment_id`,`period_start`,`period_end`,`source_ref`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_bonus_performance_idempotency` ON `hr_bonus_performance_snapshots` (`idempotency_key`);
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustment_closed_insert`
BEFORE INSERT ON `hr_payroll_adjustments`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` WHERE `period_key` = NEW.`effective_period_key` AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustment_closed_update`
BEFORE UPDATE ON `hr_payroll_adjustments`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` WHERE `period_key` IN (OLD.`effective_period_key`, NEW.`effective_period_key`) AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustment_closed_delete`
BEFORE DELETE ON `hr_payroll_adjustments`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` WHERE `period_key` = OLD.`effective_period_key` AND `status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustment_item_closed_insert`
BEFORE INSERT ON `hr_payroll_adjustment_items`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_adjustments` AS `adjustment` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`period_key` = `adjustment`.`effective_period_key` WHERE `adjustment`.`id` = NEW.`adjustment_id` AND `period`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustment_item_closed_update`
BEFORE UPDATE ON `hr_payroll_adjustment_items`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_adjustments` AS `adjustment` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`period_key` = `adjustment`.`effective_period_key` WHERE `adjustment`.`id` IN (OLD.`adjustment_id`, NEW.`adjustment_id`) AND `period`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustment_item_closed_delete`
BEFORE DELETE ON `hr_payroll_adjustment_items`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_adjustments` AS `adjustment` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`period_key` = `adjustment`.`effective_period_key` WHERE `adjustment`.`id` = OLD.`adjustment_id` AND `period`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;
