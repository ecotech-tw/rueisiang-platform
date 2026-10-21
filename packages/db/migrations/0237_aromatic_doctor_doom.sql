CREATE TABLE `hr_payroll_request_source_runs` (
	`payroll_run_id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hr_payroll_request_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_run_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_request_sources_source` ON `hr_payroll_request_sources` (`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_request_sources_run` ON `hr_payroll_request_sources` (`payroll_run_id`);