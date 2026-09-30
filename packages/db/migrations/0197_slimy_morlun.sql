CREATE TABLE `hr_payroll_closed_workers` (
	`period_key` text NOT NULL,
	`worker_id` text NOT NULL,
	`payroll_run_id` text NOT NULL,
	`closed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`period_key`, `worker_id`),
	FOREIGN KEY (`worker_id`) REFERENCES `hr_schedule_workers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_closed_workers_period" CHECK("hr_payroll_closed_workers"."period_key" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_closed_workers_run` ON `hr_payroll_closed_workers` (`payroll_run_id`);--> statement-breakpoint
CREATE TABLE `hr_payroll_record_items` (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_run_id` text NOT NULL,
	`person_kind` text NOT NULL,
	`employment_id` text,
	`worker_id` text,
	`source_period_key` text NOT NULL,
	`item_name` text NOT NULL,
	`direction` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`reason` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`employment_id`) REFERENCES `hr_employments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`worker_id`) REFERENCES `hr_schedule_workers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_record_items_person" CHECK(("hr_payroll_record_items"."person_kind" = 'employee' AND "hr_payroll_record_items"."employment_id" IS NOT NULL AND "hr_payroll_record_items"."worker_id" IS NULL) OR ("hr_payroll_record_items"."person_kind" = 'worker' AND "hr_payroll_record_items"."employment_id" IS NULL AND "hr_payroll_record_items"."worker_id" IS NOT NULL)),
	CONSTRAINT "ck_hr_payroll_record_items_source_period" CHECK("hr_payroll_record_items"."source_period_key" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "ck_hr_payroll_record_items_name" CHECK(length(trim("hr_payroll_record_items"."item_name")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_payroll_record_items_direction" CHECK("hr_payroll_record_items"."direction" IN ('earning', 'deduction')),
	CONSTRAINT "ck_hr_payroll_record_items_amount" CHECK("hr_payroll_record_items"."amount_minor" > 0),
	CONSTRAINT "ck_hr_payroll_record_items_reason" CHECK(length(trim("hr_payroll_record_items"."reason")) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_record_items_record` ON `hr_payroll_record_items` (`payroll_run_id`,`person_kind`,`employment_id`,`worker_id`);--> statement-breakpoint
INSERT OR IGNORE INTO `hr_payroll_closed_workers` (`period_key`, `worker_id`, `payroll_run_id`)
SELECT payroll_period.period_key, worker_result.worker_id, worker_result.payroll_run_id
FROM hr_payroll_worker_results AS worker_result
INNER JOIN hr_payroll_runs AS payroll_run ON payroll_run.id = worker_result.payroll_run_id
INNER JOIN hr_payroll_periods AS payroll_period ON payroll_period.id = payroll_run.payroll_period_id
WHERE payroll_run.status = 'closed';