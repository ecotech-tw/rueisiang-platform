CREATE TABLE `hr_payroll_withdrawals` (
	`payroll_run_id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`withdrawn_by` text NOT NULL,
	`withdrawn_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`withdrawn_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_withdrawals_reason" CHECK(length(trim("hr_payroll_withdrawals"."reason")) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_withdrawals_withdrawn_at` ON `hr_payroll_withdrawals` (`withdrawn_at`);--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_withdrawal_guard_insert`
BEFORE INSERT ON `hr_payroll_withdrawals`
WHEN NOT EXISTS (
  SELECT 1 FROM `hr_payroll_runs` AS `run`
  WHERE `run`.`id` = NEW.`payroll_run_id`
    AND (
      `run`.`status` = 'closed'
      OR (`run`.`status` = 'ready' AND (
        EXISTS (SELECT 1 FROM `hr_payroll_closed_employees` AS `claim` WHERE `claim`.`payroll_run_id` = `run`.`id`)
        OR EXISTS (SELECT 1 FROM `hr_payroll_closed_workers` AS `claim` WHERE `claim`.`payroll_run_id` = `run`.`id`)
      ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_withdrawal_invalid');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_withdrawal_immutable_update`
BEFORE UPDATE ON `hr_payroll_withdrawals`
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_withdrawal_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_withdrawal_immutable_delete`
BEFORE DELETE ON `hr_payroll_withdrawals`
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_withdrawal_immutable');
END;--> statement-breakpoint
-- 撤回不改寫原薪資快照；withdrawal marker 只讓受影響的人員重新取得可計算資格。
-- 這些 trigger 不能由 drizzle schema 表達，因此和新 marker table 一起安裝。
DROP TRIGGER IF EXISTS `trg_hr_monthly_leave_closed_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_leave_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_leave_closed_delete`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_leave_closed_insert`
BEFORE INSERT ON `hr_monthly_leave_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(NEW.`leave_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` = NEW.`employment_id` AND `period`.`period_key` = substr(NEW.`leave_date`, 1, 7) AND `run`.`status` = 'closed' AND NOT EXISTS (SELECT 1 FROM `hr_payroll_withdrawals` AS `withdrawal` WHERE `withdrawal`.`payroll_run_id` = `run`.`id`))
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_leave_closed_update`
BEFORE UPDATE ON `hr_monthly_leave_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(NEW.`leave_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(OLD.`leave_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` IN (OLD.`employment_id`, NEW.`employment_id`) AND `period`.`period_key` IN (substr(OLD.`leave_date`, 1, 7), substr(NEW.`leave_date`, 1, 7)) AND `run`.`status` = 'closed' AND NOT EXISTS (SELECT 1 FROM `hr_payroll_withdrawals` AS `withdrawal` WHERE `withdrawal`.`payroll_run_id` = `run`.`id`))
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_leave_closed_delete`
BEFORE DELETE ON `hr_monthly_leave_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(OLD.`leave_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` = OLD.`employment_id` AND `period`.`period_key` = substr(OLD.`leave_date`, 1, 7) AND `run`.`status` = 'closed' AND NOT EXISTS (SELECT 1 FROM `hr_payroll_withdrawals` AS `withdrawal` WHERE `withdrawal`.`payroll_run_id` = `run`.`id`))
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_hourly_closed_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_hourly_closed_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_monthly_hourly_closed_delete`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_hourly_closed_insert`
BEFORE INSERT ON `hr_monthly_hourly_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(NEW.`work_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` = NEW.`employment_id` AND `period`.`period_key` = substr(NEW.`work_date`, 1, 7) AND `run`.`status` = 'closed' AND NOT EXISTS (SELECT 1 FROM `hr_payroll_withdrawals` AS `withdrawal` WHERE `withdrawal`.`payroll_run_id` = `run`.`id`))
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_hourly_closed_update`
BEFORE UPDATE ON `hr_monthly_hourly_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(NEW.`work_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(OLD.`work_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` IN (OLD.`employment_id`, NEW.`employment_id`) AND `period`.`period_key` IN (substr(OLD.`work_date`, 1, 7), substr(NEW.`work_date`, 1, 7)) AND `run`.`status` = 'closed' AND NOT EXISTS (SELECT 1 FROM `hr_payroll_withdrawals` AS `withdrawal` WHERE `withdrawal`.`payroll_run_id` = `run`.`id`))
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_monthly_hourly_closed_delete`
BEFORE DELETE ON `hr_monthly_hourly_entries`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_periods` AS `period` WHERE `period`.`period_key` = substr(OLD.`work_date`, 1, 7) AND `period`.`status` = 'closed')
  OR EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` INNER JOIN `hr_payroll_periods` AS `period` ON `period`.`id` = `run`.`payroll_period_id` WHERE `payslip`.`employment_id` = OLD.`employment_id` AND `period`.`period_key` = substr(OLD.`work_date`, 1, 7) AND `run`.`status` = 'closed' AND NOT EXISTS (SELECT 1 FROM `hr_payroll_withdrawals` AS `withdrawal` WHERE `withdrawal`.`payroll_run_id` = `run`.`id`))
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_closed_employee_update`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_closed_employee_update`
BEFORE UPDATE ON `hr_payroll_closed_employees`
WHEN NOT (
  OLD.`period_key` = NEW.`period_key`
  AND OLD.`employment_id` = NEW.`employment_id`
  AND EXISTS (SELECT 1 FROM `hr_payroll_withdrawals` AS `withdrawal` WHERE `withdrawal`.`payroll_run_id` = OLD.`payroll_run_id`)
  AND EXISTS (SELECT 1 FROM `hr_payroll_runs` AS `run` WHERE `run`.`id` = NEW.`payroll_run_id` AND `run`.`status` = 'ready')
)
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_period_close_requires_claims`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_period_close_requires_claims`
BEFORE UPDATE OF `status` ON `hr_payroll_periods`
WHEN OLD.`status` = 'open' AND NEW.`status` = 'closed'
  AND EXISTS (
    SELECT 1 FROM `hr_employments` AS `employment`
    INNER JOIN `users` AS `account` ON `account`.`id` = `employment`.`employee_user_id`
    WHERE `account`.`status` IN ('active', 'invited')
      AND `employment`.`archived_at` IS NULL
      AND coalesce((SELECT `service_start_on` FROM `hr_employment_service_periods` WHERE `employment_id` = `employment`.`id`), '0001-01-01') < date(NEW.`period_key` || '-01', '+1 month')
      AND NOT EXISTS (
        SELECT 1 FROM `hr_payroll_closed_employees` AS `claim`
        WHERE `claim`.`period_key` = NEW.`period_key`
          AND `claim`.`employment_id` = `employment`.`id`
          AND NOT EXISTS (SELECT 1 FROM `hr_payroll_withdrawals` AS `withdrawal` WHERE `withdrawal`.`payroll_run_id` = `claim`.`payroll_run_id`)
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_not_ready');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_period_closed_update`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_period_closed_update`
BEFORE UPDATE ON `hr_payroll_periods`
WHEN OLD.`status` = 'closed'
  AND (
    NEW.`status` <> 'open'
    OR NOT EXISTS (
      SELECT 1
      FROM `hr_payroll_withdrawals` AS `withdrawal`
      INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `withdrawal`.`payroll_run_id`
      WHERE `run`.`payroll_period_id` = OLD.`id`
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_closed');
END;