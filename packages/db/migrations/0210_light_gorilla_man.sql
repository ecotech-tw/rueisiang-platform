CREATE TABLE `hr_payroll_special_workday_source_runs` (
	`payroll_run_id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hr_payroll_special_workday_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_run_id` text NOT NULL,
	`assignment_id` text,
	`rule_id` text,
	`rule_version_id` text,
	`work_date` text,
	CONSTRAINT "ck_hr_payroll_special_workday_sources_target" CHECK("hr_payroll_special_workday_sources"."assignment_id" IS NOT NULL OR "hr_payroll_special_workday_sources"."rule_version_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_special_workday_sources_run` ON `hr_payroll_special_workday_sources` (`payroll_run_id`);--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_special_workday_sources_assignment` ON `hr_payroll_special_workday_sources` (`assignment_id`);--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_special_workday_sources_version` ON `hr_payroll_special_workday_sources` (`rule_version_id`);