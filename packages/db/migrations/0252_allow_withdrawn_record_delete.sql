DROP TRIGGER IF EXISTS `trg_hr_payslips_closed_delete`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslips_closed_delete`
BEFORE DELETE ON `hr_payslips`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_runs` WHERE `id` = OLD.`payroll_run_id` AND `status` = 'closed')
  AND NOT EXISTS (
    SELECT 1 FROM `hr_payroll_record_withdrawals`
    WHERE `payroll_run_id` = OLD.`payroll_run_id` AND `person_kind` = 'employee' AND `person_id` = OLD.`employment_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslip_lines_closed_delete`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_lines_closed_delete`
BEFORE DELETE ON `hr_payslip_lines`
WHEN EXISTS (
  SELECT 1 FROM `hr_payslips` AS `payslip`
  INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id`
  WHERE `payslip`.`id` = OLD.`payslip_id` AND `run`.`status` = 'closed'
)
  AND NOT EXISTS (
    SELECT 1 FROM `hr_payslips` AS `payslip`
    INNER JOIN `hr_payroll_record_withdrawals` AS `withdrawal`
      ON `withdrawal`.`payroll_run_id` = `payslip`.`payroll_run_id`
      AND `withdrawal`.`person_kind` = 'employee'
      AND `withdrawal`.`person_id` = `payslip`.`employment_id`
    WHERE `payslip`.`id` = OLD.`payslip_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_run_employees_closed_delete`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_run_employees_closed_delete`
BEFORE DELETE ON `hr_payroll_run_employees`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_runs` WHERE `id` = OLD.`payroll_run_id` AND `status` = 'closed')
  AND NOT EXISTS (
    SELECT 1 FROM `hr_payroll_record_withdrawals`
    WHERE `payroll_run_id` = OLD.`payroll_run_id` AND `person_kind` = 'employee' AND `person_id` = OLD.`employment_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payroll_worker_results_closed_delete`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_worker_results_closed_delete`
BEFORE DELETE ON `hr_payroll_worker_results`
WHEN EXISTS (SELECT 1 FROM `hr_payroll_runs` WHERE `id` = OLD.`payroll_run_id` AND `status` = 'closed')
  AND NOT EXISTS (
    SELECT 1 FROM `hr_payroll_record_withdrawals`
    WHERE `payroll_run_id` = OLD.`payroll_run_id` AND `person_kind` = 'worker' AND `person_id` = OLD.`worker_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslip_compensation_links_closed_delete`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_compensation_links_closed_delete`
BEFORE DELETE ON `hr_payslip_compensation_links`
WHEN EXISTS (
  SELECT 1 FROM `hr_payslips` AS `payslip`
  INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id`
  WHERE `payslip`.`id` = OLD.`payslip_id` AND `run`.`status` = 'closed'
)
  AND NOT EXISTS (
    SELECT 1 FROM `hr_payslips` AS `payslip`
    INNER JOIN `hr_payroll_record_withdrawals` AS `withdrawal`
      ON `withdrawal`.`payroll_run_id` = `payslip`.`payroll_run_id`
      AND `withdrawal`.`person_kind` = 'employee'
      AND `withdrawal`.`person_id` = `payslip`.`employment_id`
    WHERE `payslip`.`id` = OLD.`payslip_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_hr_payslip_insurance_links_closed_delete`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_insurance_links_closed_delete`
BEFORE DELETE ON `hr_payslip_insurance_links`
WHEN EXISTS (
  SELECT 1 FROM `hr_payslips` AS `payslip`
  INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id`
  WHERE `payslip`.`id` = OLD.`payslip_id` AND `run`.`status` = 'closed'
)
  AND NOT EXISTS (
    SELECT 1 FROM `hr_payslips` AS `payslip`
    INNER JOIN `hr_payroll_record_withdrawals` AS `withdrawal`
      ON `withdrawal`.`payroll_run_id` = `payslip`.`payroll_run_id`
      AND `withdrawal`.`person_kind` = 'employee'
      AND `withdrawal`.`person_id` = `payslip`.`employment_id`
    WHERE `payslip`.`id` = OLD.`payslip_id`
  )
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;
