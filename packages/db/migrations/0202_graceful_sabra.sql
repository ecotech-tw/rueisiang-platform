CREATE TABLE `hr_payroll_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_run_id` text,
	`request_id` text NOT NULL,
	`calculation_input_json` text DEFAULT '{}' NOT NULL,
	`actor_id` text NOT NULL,
	`actor_email` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text DEFAULT 'queued' NOT NULL,
	`expected_count` integer DEFAULT 0 NOT NULL,
	`completed_count` integer DEFAULT 0 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`queue_status` text DEFAULT 'pending' NOT NULL,
	`queue_attempts` integer DEFAULT 0 NOT NULL,
	`queue_error` text DEFAULT '' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`completed_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_jobs_input" CHECK(length("hr_payroll_jobs"."calculation_input_json") <= 10000 AND json_valid("hr_payroll_jobs"."calculation_input_json") = 1 AND json_type("hr_payroll_jobs"."calculation_input_json") = 'object'),
	CONSTRAINT "ck_hr_payroll_jobs_actor_email" CHECK(length("hr_payroll_jobs"."actor_email") <= 320),
	CONSTRAINT "ck_hr_payroll_jobs_phase" CHECK("hr_payroll_jobs"."phase" IN ('queued', 'preparing', 'calculating_workers', 'calculating_employees', 'persisting', 'completed', 'failed')),
	CONSTRAINT "ck_hr_payroll_jobs_status" CHECK("hr_payroll_jobs"."status" IN ('queued', 'calculating', 'ready', 'failed')),
	CONSTRAINT "ck_hr_payroll_jobs_queue_status" CHECK("hr_payroll_jobs"."queue_status" IN ('pending', 'enqueued')),
	CONSTRAINT "ck_hr_payroll_jobs_counts" CHECK("hr_payroll_jobs"."expected_count" >= 0 AND "hr_payroll_jobs"."completed_count" BETWEEN 0 AND "hr_payroll_jobs"."expected_count"),
	CONSTRAINT "ck_hr_payroll_jobs_attempts" CHECK("hr_payroll_jobs"."attempt_count" >= 0 AND "hr_payroll_jobs"."queue_attempts" >= 0),
	CONSTRAINT "ck_hr_payroll_jobs_errors" CHECK(length("hr_payroll_jobs"."queue_error") <= 2000 AND length("hr_payroll_jobs"."last_error") <= 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payroll_jobs_request` ON `hr_payroll_jobs` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_jobs_status_updated` ON `hr_payroll_jobs` (`status`,`updated_at`);