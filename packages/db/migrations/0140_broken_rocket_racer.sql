CREATE TABLE `hr_worker_compensation_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`pay_basis` text NOT NULL,
	`base_amount_minor` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `hr_schedule_workers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_worker_compensation_versions_number" CHECK("hr_worker_compensation_versions"."version_number" > 0),
	CONSTRAINT "ck_hr_worker_compensation_versions_dates" CHECK(length("hr_worker_compensation_versions"."valid_from") = 10 AND ("hr_worker_compensation_versions"."valid_to" IS NULL OR (length("hr_worker_compensation_versions"."valid_to") = 10 AND "hr_worker_compensation_versions"."valid_to" > "hr_worker_compensation_versions"."valid_from"))),
	CONSTRAINT "ck_hr_worker_compensation_versions_basis" CHECK("hr_worker_compensation_versions"."pay_basis" IN ('monthly', 'daily', 'hourly')),
	CONSTRAINT "ck_hr_worker_compensation_versions_amount" CHECK("hr_worker_compensation_versions"."base_amount_minor" >= 0),
	CONSTRAINT "ck_hr_worker_compensation_versions_note" CHECK(length("hr_worker_compensation_versions"."note") <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_worker_compensation_versions_number` ON `hr_worker_compensation_versions` (`worker_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_hr_worker_compensation_versions_period` ON `hr_worker_compensation_versions` (`worker_id`,`valid_from`);--> statement-breakpoint
CREATE TABLE `hr_schedule_worker_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_version_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`shift_version_id` text NOT NULL,
	`work_date` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`schedule_version_id`) REFERENCES `hr_schedule_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`worker_id`) REFERENCES `hr_schedule_workers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`shift_version_id`) REFERENCES `hr_shift_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_schedule_worker_entries_date" CHECK(length("hr_schedule_worker_entries"."work_date") = 10),
	CONSTRAINT "ck_hr_schedule_worker_entries_period" CHECK("hr_schedule_worker_entries"."ends_at" > "hr_schedule_worker_entries"."starts_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_schedule_worker_entries_unique` ON `hr_schedule_worker_entries` (`schedule_version_id`,`worker_id`,`work_date`,`starts_at`);--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_worker_entries_worker_date` ON `hr_schedule_worker_entries` (`worker_id`,`work_date`);--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_worker_entries_scope_date` ON `hr_schedule_worker_entries` (`scope_id`,`work_date`);--> statement-breakpoint
CREATE TABLE `hr_schedule_workers` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_schedule_workers_name" CHECK(length(trim("hr_schedule_workers"."display_name")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_schedule_workers_active" CHECK("hr_schedule_workers"."active" IN (0, 1)),
	CONSTRAINT "ck_hr_schedule_workers_revision" CHECK("hr_schedule_workers"."revision" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_workers_active_name` ON `hr_schedule_workers` (`active`,`display_name`);--> statement-breakpoint
CREATE TABLE `hr_scope_shift_assignments` (
	`scope_id` text NOT NULL,
	`shift_template_id` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`scope_id`, `shift_template_id`),
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`shift_template_id`) REFERENCES `hr_shift_templates`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_scope_shift_assignments_default" CHECK("hr_scope_shift_assignments"."is_default" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_hr_scope_shift_assignments_scope` ON `hr_scope_shift_assignments` (`scope_id`,`is_default`);--> statement-breakpoint
CREATE TABLE `hr_payroll_worker_results` (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_run_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`worker_name` text NOT NULL,
	`compensation_version_id` text,
	`pay_basis` text NOT NULL,
	`scheduled_days` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`worker_id`) REFERENCES `hr_schedule_workers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`compensation_version_id`) REFERENCES `hr_worker_compensation_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_worker_results_name" CHECK(length(trim("hr_payroll_worker_results"."worker_name")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_payroll_worker_results_days" CHECK("hr_payroll_worker_results"."scheduled_days" >= 0),
	CONSTRAINT "ck_hr_payroll_worker_results_amount" CHECK("hr_payroll_worker_results"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payroll_worker_results_run_worker` ON `hr_payroll_worker_results` (`payroll_run_id`,`worker_id`);--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_worker_results_worker` ON `hr_payroll_worker_results` (`worker_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `hr_attendance_locations` ADD `scope_id` text REFERENCES scopes(id);--> statement-breakpoint
CREATE INDEX `idx_hr_attendance_locations_scope` ON `hr_attendance_locations` (`scope_id`,`active`,`name`);--> statement-breakpoint
ALTER TABLE `hr_clock_events` ADD `scope_id` text REFERENCES scopes(id);--> statement-breakpoint
ALTER TABLE `hr_clock_events` ADD `location_name_snapshot` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `hr_clock_events` ADD `scope_name_snapshot` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `hr_clock_events` ADD `recorded_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `hr_clock_events` ADD `manual_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `hr_schedule_versions` ADD `locked_at` text;