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
        WHERE `claim`.`period_key` = NEW.`period_key` AND `claim`.`employment_id` = `employment`.`id`
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'payroll_period_not_ready');
END;
