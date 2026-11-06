DROP TRIGGER IF EXISTS `trg_hr_payroll_closed_employee_delete`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_closed_employee_delete`
BEFORE DELETE ON `hr_payroll_closed_employees`
WHEN NOT EXISTS (
  SELECT 1
  FROM `hr_payroll_withdrawals` AS `withdrawal`
  INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `withdrawal`.`payroll_run_id`
  WHERE `withdrawal`.`payroll_run_id` = OLD.`payroll_run_id`
    AND `run`.`status` = 'ready'
) AND NOT EXISTS (
  SELECT 1 FROM `hr_payroll_record_withdrawals` AS `withdrawal`
  WHERE `withdrawal`.`payroll_run_id` = OLD.`payroll_run_id`
    AND `withdrawal`.`person_kind` = 'employee'
    AND `withdrawal`.`person_id` = OLD.`employment_id`
)
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_closed_worker_delete`
BEFORE DELETE ON `hr_payroll_closed_workers`
WHEN NOT EXISTS (
  SELECT 1
  FROM `hr_payroll_withdrawals` AS `withdrawal`
  INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `withdrawal`.`payroll_run_id`
  WHERE `withdrawal`.`payroll_run_id` = OLD.`payroll_run_id`
    AND `run`.`status` = 'ready'
) AND NOT EXISTS (
  SELECT 1 FROM `hr_payroll_record_withdrawals` AS `withdrawal`
  WHERE `withdrawal`.`payroll_run_id` = OLD.`payroll_run_id`
    AND `withdrawal`.`person_kind` = 'worker'
    AND `withdrawal`.`person_id` = OLD.`worker_id`
)
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_record_withdrawals_update`
BEFORE UPDATE ON `hr_payroll_record_withdrawals`
BEGIN
  SELECT RAISE(ABORT, 'payroll_record_withdrawal_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_record_withdrawals_delete`
BEFORE DELETE ON `hr_payroll_record_withdrawals`
BEGIN
  SELECT RAISE(ABORT, 'payroll_record_withdrawal_immutable');
END;
