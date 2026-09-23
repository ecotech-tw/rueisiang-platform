-- 0179 早於 0184 執行；全新資料庫先完成班別日型欄位與特休表所需的父表。
-- 正式庫的 hr_shift_versions 已在舊部署路徑完成這個日型切換，0183 只需補 calendar table。
DROP INDEX `idx_hr_shift_versions_number`;--> statement-breakpoint
ALTER TABLE `hr_shift_versions` ADD `day_type` text DEFAULT 'weekday' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_shift_versions_number` ON `hr_shift_versions` (`shift_template_id`,`day_type`,`version_number`);--> statement-breakpoint
ALTER TABLE `hr_leave_types` ADD `leave_kind` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
-- SQLite 在移除舊 hr_employments 時解析到尚未存在的 foreign-key parent。
CREATE TABLE IF NOT EXISTS `hr_annual_leave_policy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_key` text DEFAULT 'annual_leave' NOT NULL,
	`version_number` integer NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`basis` text DEFAULT 'anniversary' NOT NULL,
	`daily_minutes` integer DEFAULT 480 NOT NULL,
	`minimum_unit_minutes` integer DEFAULT 30 NOT NULL,
	`carryover_allowed` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_annual_leave_policy_dates" CHECK(length("hr_annual_leave_policy_versions"."valid_from") = 10 AND ("hr_annual_leave_policy_versions"."valid_to" IS NULL OR (length("hr_annual_leave_policy_versions"."valid_to") = 10 AND "hr_annual_leave_policy_versions"."valid_to" > "hr_annual_leave_policy_versions"."valid_from"))),
	CONSTRAINT "ck_hr_annual_leave_policy_basis" CHECK("hr_annual_leave_policy_versions"."basis" = 'anniversary'),
	CONSTRAINT "ck_hr_annual_leave_policy_minutes" CHECK("hr_annual_leave_policy_versions"."daily_minutes" > 0 AND "hr_annual_leave_policy_versions"."daily_minutes" % "hr_annual_leave_policy_versions"."minimum_unit_minutes" = 0 AND "hr_annual_leave_policy_versions"."minimum_unit_minutes" = 30),
	CONSTRAINT "ck_hr_annual_leave_policy_carryover" CHECK("hr_annual_leave_policy_versions"."carryover_allowed" IN (0, 1)),
	CONSTRAINT "ck_hr_annual_leave_policy_note" CHECK(length("hr_annual_leave_policy_versions"."note") <= 1000)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `hr_annual_leave_brackets` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_version_id` text NOT NULL,
	`min_service_months` integer NOT NULL,
	`max_service_months` integer,
	`entitled_days` integer NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`policy_version_id`) REFERENCES `hr_annual_leave_policy_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_annual_leave_bracket_range" CHECK("hr_annual_leave_brackets"."min_service_months" >= 6 AND ("hr_annual_leave_brackets"."max_service_months" IS NULL OR "hr_annual_leave_brackets"."max_service_months" > "hr_annual_leave_brackets"."min_service_months")),
	CONSTRAINT "ck_hr_annual_leave_bracket_days" CHECK("hr_annual_leave_brackets"."entitled_days" > 0 AND "hr_annual_leave_brackets"."entitled_days" <= 30),
	CONSTRAINT "ck_hr_annual_leave_bracket_label" CHECK(length("hr_annual_leave_brackets"."label") <= 100)
);--> statement-breakpoint
-- 有些正式庫在這組扁平化 migration 之前已經建立特休表；0178 不會重建
-- 尚未出現在當時 schema 的表，所以先把它們的資料與下游 ledger 搬到 v2。
-- IF NOT EXISTS 也讓全新資料庫走同一條路徑，0184 再以 IF NOT EXISTS 略過重建。
CREATE TABLE IF NOT EXISTS `hr_annual_leave_entitlements` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`policy_version_id` text NOT NULL,
	`bracket_id` text NOT NULL,
	`service_months` integer NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`entitled_half_hours` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`settled_at` text,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`policy_version_id`) REFERENCES `hr_annual_leave_policy_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`bracket_id`) REFERENCES `hr_annual_leave_brackets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_annual_leave_entitlement_dates" CHECK(length("hr_annual_leave_entitlements"."period_start") = 10 AND length("hr_annual_leave_entitlements"."period_end") = 10 AND "hr_annual_leave_entitlements"."period_end" > "hr_annual_leave_entitlements"."period_start"),
	CONSTRAINT "ck_hr_annual_leave_entitlement_service" CHECK("hr_annual_leave_entitlements"."service_months" >= 6),
	CONSTRAINT "ck_hr_annual_leave_entitlement_amount" CHECK("hr_annual_leave_entitlements"."entitled_half_hours" > 0),
	CONSTRAINT "ck_hr_annual_leave_entitlement_status" CHECK("hr_annual_leave_entitlements"."status" IN ('open', 'settled'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `hr_annual_leave_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`entitlement_id` text NOT NULL,
	`entry_kind` text NOT NULL,
	`delta_half_hours` integer NOT NULL,
	`source_key` text NOT NULL,
	`leave_request_id` text,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`entitlement_id`) REFERENCES `hr_annual_leave_entitlements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`leave_request_id`) REFERENCES `hr_leave_requests`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_annual_leave_ledger_kind" CHECK("hr_annual_leave_ledger"."entry_kind" IN ('grant', 'leave_request', 'manual_adjustment', 'settlement', 'settlement_reversal')),
	CONSTRAINT "ck_hr_annual_leave_ledger_delta" CHECK("hr_annual_leave_ledger"."delta_half_hours" <> 0),
	CONSTRAINT "ck_hr_annual_leave_ledger_note" CHECK(length("hr_annual_leave_ledger"."note") <= 1000)
);--> statement-breakpoint
CREATE TABLE `__hr_annual_leave_entitlements_backup` AS SELECT * FROM `hr_annual_leave_entitlements`;--> statement-breakpoint
CREATE TABLE `__hr_annual_leave_ledger_backup` AS SELECT * FROM `hr_annual_leave_ledger`;--> statement-breakpoint
DROP TABLE `hr_annual_leave_ledger`;--> statement-breakpoint
DROP TABLE `hr_annual_leave_entitlements`;--> statement-breakpoint
CREATE TABLE `__new_hr_annual_leave_entitlements` (
	`id` text PRIMARY KEY NOT NULL,
	`employment_id` text NOT NULL,
	`policy_version_id` text NOT NULL,
	`bracket_id` text NOT NULL,
	`service_months` integer NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`entitled_half_hours` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`settled_at` text,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`policy_version_id`) REFERENCES `hr_annual_leave_policy_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`bracket_id`) REFERENCES `hr_annual_leave_brackets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_annual_leave_entitlement_dates" CHECK(length("__new_hr_annual_leave_entitlements"."period_start") = 10 AND length("__new_hr_annual_leave_entitlements"."period_end") = 10 AND "__new_hr_annual_leave_entitlements"."period_end" > "__new_hr_annual_leave_entitlements"."period_start"),
	CONSTRAINT "ck_hr_annual_leave_entitlement_service" CHECK("__new_hr_annual_leave_entitlements"."service_months" >= 6),
	CONSTRAINT "ck_hr_annual_leave_entitlement_amount" CHECK("__new_hr_annual_leave_entitlements"."entitled_half_hours" > 0),
	CONSTRAINT "ck_hr_annual_leave_entitlement_status" CHECK("__new_hr_annual_leave_entitlements"."status" IN ('open', 'settled'))
);--> statement-breakpoint
INSERT INTO `__new_hr_annual_leave_entitlements` SELECT * FROM `__hr_annual_leave_entitlements_backup`;--> statement-breakpoint
ALTER TABLE `__new_hr_annual_leave_entitlements` RENAME TO `hr_annual_leave_entitlements`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_annual_leave_entitlement_period` ON `hr_annual_leave_entitlements` (`employment_id`,`period_start`);--> statement-breakpoint
CREATE INDEX `idx_hr_annual_leave_entitlement_employee` ON `hr_annual_leave_entitlements` (`employment_id`,`period_end`);--> statement-breakpoint
CREATE TABLE `hr_annual_leave_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`entitlement_id` text NOT NULL,
	`entry_kind` text NOT NULL,
	`delta_half_hours` integer NOT NULL,
	`source_key` text NOT NULL,
	`leave_request_id` text,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`entitlement_id`) REFERENCES `hr_annual_leave_entitlements`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`leave_request_id`) REFERENCES `hr_leave_requests`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_annual_leave_ledger_kind" CHECK("hr_annual_leave_ledger"."entry_kind" IN ('grant', 'leave_request', 'manual_adjustment', 'settlement', 'settlement_reversal')),
	CONSTRAINT "ck_hr_annual_leave_ledger_delta" CHECK("hr_annual_leave_ledger"."delta_half_hours" <> 0),
	CONSTRAINT "ck_hr_annual_leave_ledger_note" CHECK(length("hr_annual_leave_ledger"."note") <= 1000)
);--> statement-breakpoint
INSERT INTO `hr_annual_leave_ledger` SELECT * FROM `__hr_annual_leave_ledger_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_annual_leave_ledger_source` ON `hr_annual_leave_ledger` (`source_key`);--> statement-breakpoint
CREATE INDEX `idx_hr_annual_leave_ledger_entitlement` ON `hr_annual_leave_ledger` (`entitlement_id`,`created_at`);--> statement-breakpoint
DROP TABLE `__hr_annual_leave_entitlements_backup`;--> statement-breakpoint
DROP TABLE `__hr_annual_leave_ledger_backup`;--> statement-breakpoint
-- 0178 已把所有下游 foreign key 指向 hr_employments_v2，現在才可以在 D1
-- transaction 內移除舊父表。rename 會讓 SQLite 同步更新子表 foreign key 的 target name。
DROP TABLE `hr_employments`;
ALTER TABLE `hr_employments_v2` RENAME TO `hr_employments`;
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
    INNER JOIN `users` AS `account` ON `account`.`id` = `employment`.`employee_user_id`
    WHERE `account`.`status` = 'active'
      AND `employment`.`archived_at` IS NULL
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
--> statement-breakpoint
CREATE TRIGGER `trg_hr_attendance_rest_days_validation_insert`
BEFORE INSERT ON `hr_employment_attendance_settings`
WHEN (NEW.`monthly_rest_days` IS NOT NULL AND (typeof(NEW.`monthly_rest_days`) <> 'integer' OR NEW.`monthly_rest_days` NOT BETWEEN 0 AND 31))
  OR (NEW.`attendance_mode` = 'general' AND NEW.`monthly_rest_days` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'attendance_monthly_rest_days_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_attendance_rest_days_validation_update`
BEFORE UPDATE OF `attendance_mode`, `monthly_rest_days` ON `hr_employment_attendance_settings`
WHEN (NEW.`monthly_rest_days` IS NOT NULL AND (typeof(NEW.`monthly_rest_days`) <> 'integer' OR NEW.`monthly_rest_days` NOT BETWEEN 0 AND 31))
  OR (NEW.`attendance_mode` = 'general' AND NEW.`monthly_rest_days` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'attendance_monthly_rest_days_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_shift_minutes_validation_insert`
BEFORE INSERT ON `hr_shift_versions`
WHEN typeof(NEW.`standard_minutes`) <> 'integer'
  OR typeof(NEW.`break_minutes`) <> 'integer'
  OR NEW.`standard_minutes` NOT BETWEEN 0 AND 1440
  OR NEW.`break_minutes` NOT BETWEEN 0 AND 1440
  OR (NEW.`standard_minutes` + NEW.`break_minutes`) * 60 > CASE WHEN NEW.`end_day_offset` = 1 THEN 86400 - NEW.`start_second` + NEW.`end_second` ELSE NEW.`end_second` - NEW.`start_second` END
BEGIN
  SELECT RAISE(ABORT, 'shift_minutes_exceed_duration');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_shift_minutes_validation_update`
BEFORE UPDATE OF `start_second`, `end_second`, `end_day_offset`, `standard_minutes`, `break_minutes` ON `hr_shift_versions`
WHEN typeof(NEW.`standard_minutes`) <> 'integer'
  OR typeof(NEW.`break_minutes`) <> 'integer'
  OR NEW.`standard_minutes` NOT BETWEEN 0 AND 1440
  OR NEW.`break_minutes` NOT BETWEEN 0 AND 1440
  OR (NEW.`standard_minutes` + NEW.`break_minutes`) * 60 > CASE WHEN NEW.`end_day_offset` = 1 THEN 86400 - NEW.`start_second` + NEW.`end_second` ELSE NEW.`end_second` - NEW.`start_second` END
BEGIN
  SELECT RAISE(ABORT, 'shift_minutes_exceed_duration');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_schedule_entry_minutes_validation_insert`
BEFORE INSERT ON `hr_schedule_entries`
WHEN NOT EXISTS (
  SELECT 1 FROM `hr_shift_versions`
  WHERE `id` = NEW.`shift_version_id`
    AND typeof(NEW.`standard_minutes`) = 'integer'
    AND typeof(NEW.`break_minutes`) = 'integer'
    AND NEW.`standard_minutes` BETWEEN 0 AND 1440
    AND NEW.`break_minutes` BETWEEN 0 AND 1440
    AND (NEW.`standard_minutes` + NEW.`break_minutes`) * 60 <= CASE WHEN `end_day_offset` = 1 THEN 86400 - `start_second` + `end_second` ELSE `end_second` - `start_second` END
)
BEGIN
  SELECT RAISE(ABORT, 'schedule_entry_minutes_exceed_duration');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_schedule_entry_minutes_validation_update`
BEFORE UPDATE OF `shift_version_id`, `standard_minutes`, `break_minutes` ON `hr_schedule_entries`
WHEN NOT EXISTS (
  SELECT 1 FROM `hr_shift_versions`
  WHERE `id` = NEW.`shift_version_id`
    AND typeof(NEW.`standard_minutes`) = 'integer'
    AND typeof(NEW.`break_minutes`) = 'integer'
    AND NEW.`standard_minutes` BETWEEN 0 AND 1440
    AND NEW.`break_minutes` BETWEEN 0 AND 1440
    AND (NEW.`standard_minutes` + NEW.`break_minutes`) * 60 <= CASE WHEN `end_day_offset` = 1 THEN 86400 - `start_second` + `end_second` ELSE `end_second` - `start_second` END
)
BEGIN
  SELECT RAISE(ABORT, 'schedule_entry_minutes_exceed_duration');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_schedule_worker_entry_minutes_validation_insert`
BEFORE INSERT ON `hr_schedule_worker_entries`
WHEN NOT EXISTS (
  SELECT 1 FROM `hr_shift_versions`
  WHERE `id` = NEW.`shift_version_id`
    AND typeof(NEW.`standard_minutes`) = 'integer'
    AND typeof(NEW.`break_minutes`) = 'integer'
    AND NEW.`standard_minutes` BETWEEN 0 AND 1440
    AND NEW.`break_minutes` BETWEEN 0 AND 1440
    AND (NEW.`standard_minutes` + NEW.`break_minutes`) * 60 <= CASE WHEN `end_day_offset` = 1 THEN 86400 - `start_second` + `end_second` ELSE `end_second` - `start_second` END
)
BEGIN
  SELECT RAISE(ABORT, 'schedule_entry_minutes_exceed_duration');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_schedule_worker_entry_minutes_validation_update`
BEFORE UPDATE OF `shift_version_id`, `standard_minutes`, `break_minutes` ON `hr_schedule_worker_entries`
WHEN NOT EXISTS (
  SELECT 1 FROM `hr_shift_versions`
  WHERE `id` = NEW.`shift_version_id`
    AND typeof(NEW.`standard_minutes`) = 'integer'
    AND typeof(NEW.`break_minutes`) = 'integer'
    AND NEW.`standard_minutes` BETWEEN 0 AND 1440
    AND NEW.`break_minutes` BETWEEN 0 AND 1440
    AND (NEW.`standard_minutes` + NEW.`break_minutes`) * 60 <= CASE WHEN `end_day_offset` = 1 THEN 86400 - `start_second` + `end_second` ELSE `end_second` - `start_second` END
)
BEGIN
  SELECT RAISE(ABORT, 'schedule_entry_minutes_exceed_duration');
END;
