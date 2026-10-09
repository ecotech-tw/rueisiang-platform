DROP TRIGGER `trg_hr_formal_payroll_adjustments_kind_insert`;--> statement-breakpoint
DROP TRIGGER `trg_hr_formal_payroll_adjustments_kind_update`;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustments_person_kind_insert`
BEFORE INSERT ON `hr_payroll_adjustments`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` IN ('employee', 'worker'))
BEGIN
  SELECT RAISE(ABORT, 'payroll_person_employment_required');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payroll_adjustments_person_kind_update`
BEFORE UPDATE OF `employment_id` ON `hr_payroll_adjustments`
WHEN NOT EXISTS (SELECT 1 FROM `hr_employments` WHERE `id` = NEW.`employment_id` AND `person_kind` IN ('employee', 'worker'))
BEGIN
  SELECT RAISE(ABORT, 'payroll_person_employment_required');
END;
