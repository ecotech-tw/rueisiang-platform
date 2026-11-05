PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_hr_payslip_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`payslip_id` text NOT NULL,
	`line_key` text NOT NULL,
	`direction` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`quantity_seconds` integer,
	`explanation_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`payslip_id`) REFERENCES `hr_payslips`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payslip_lines_key" CHECK(length(trim("__new_hr_payslip_lines"."line_key")) BETWEEN 1 AND 80),
	CONSTRAINT "ck_hr_payslip_lines_direction" CHECK("__new_hr_payslip_lines"."direction" IN ('earning', 'deduction')),
	CONSTRAINT "ck_hr_payslip_lines_amount" CHECK("__new_hr_payslip_lines"."amount_minor" >= 0),
	CONSTRAINT "ck_hr_payslip_lines_quantity" CHECK("__new_hr_payslip_lines"."quantity_seconds" IS NULL OR "__new_hr_payslip_lines"."quantity_seconds" >= 0),
	CONSTRAINT "ck_hr_payslip_lines_explanation" CHECK(length("__new_hr_payslip_lines"."explanation_json") <= 20000)
);
--> statement-breakpoint
INSERT INTO `__new_hr_payslip_lines`("id", "payslip_id", "line_key", "direction", "amount_minor", "quantity_seconds", "explanation_json") SELECT "id", "payslip_id", "line_key", "direction", "amount_minor", "quantity_seconds", "explanation_json" FROM `hr_payslip_lines`;--> statement-breakpoint
DROP TABLE `hr_payslip_lines`;--> statement-breakpoint
ALTER TABLE `__new_hr_payslip_lines` RENAME TO `hr_payslip_lines`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payslip_lines_key` ON `hr_payslip_lines` (`payslip_id`,`line_key`);--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_lines_closed_insert`
BEFORE INSERT ON `hr_payslip_lines`
WHEN EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` WHERE `payslip`.`id` = NEW.`payslip_id` AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_lines_closed_update`
BEFORE UPDATE ON `hr_payslip_lines`
WHEN EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` WHERE `payslip`.`id` IN (OLD.`payslip_id`, NEW.`payslip_id`) AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_payslip_lines_closed_delete`
BEFORE DELETE ON `hr_payslip_lines`
WHEN EXISTS (SELECT 1 FROM `hr_payslips` AS `payslip` INNER JOIN `hr_payroll_runs` AS `run` ON `run`.`id` = `payslip`.`payroll_run_id` WHERE `payslip`.`id` = OLD.`payslip_id` AND `run`.`status` = 'closed')
BEGIN
  SELECT RAISE(ABORT, 'payroll_run_closed');
END;