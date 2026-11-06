CREATE TABLE `hr_payroll_record_withdrawals` (
	`payroll_run_id` text NOT NULL,
	`person_kind` text NOT NULL,
	`person_id` text NOT NULL,
	`reason` text NOT NULL,
	`withdrawn_by` text NOT NULL,
	`withdrawn_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`payroll_run_id`, `person_kind`, `person_id`),
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`withdrawn_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_record_withdrawals_reason" CHECK(length(trim("hr_payroll_record_withdrawals"."reason")) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_record_withdrawals_person` ON `hr_payroll_record_withdrawals` (`person_kind`,`person_id`);--> statement-breakpoint
ALTER TABLE `hr_payroll_request_sources` ADD `person_kind` text;--> statement-breakpoint
ALTER TABLE `hr_payroll_request_sources` ADD `person_id` text;--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_request_sources_person` ON `hr_payroll_request_sources` (`person_kind`,`person_id`);--> statement-breakpoint
ALTER TABLE `hr_payroll_special_workday_sources` ADD `person_kind` text;--> statement-breakpoint
ALTER TABLE `hr_payroll_special_workday_sources` ADD `person_id` text;--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_special_workday_sources_person` ON `hr_payroll_special_workday_sources` (`person_kind`,`person_id`);