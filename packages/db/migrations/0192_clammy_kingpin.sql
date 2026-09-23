PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_hr_calendar_days` (
	`date` text PRIMARY KEY NOT NULL,
	`day_type` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`special_kind` text DEFAULT 'none' NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_calendar_days_date" CHECK(length("__new_hr_calendar_days"."date") = 10),
	CONSTRAINT "ck_hr_calendar_days_type" CHECK("__new_hr_calendar_days"."day_type" IN ('weekday', 'weekend', 'holiday')),
	CONSTRAINT "ck_hr_calendar_days_special_kind" CHECK("__new_hr_calendar_days"."special_kind" IN ('none', 'typhoon_stop')),
	CONSTRAINT "ck_hr_calendar_days_name" CHECK(length("__new_hr_calendar_days"."name") <= 100)
);
--> statement-breakpoint
INSERT INTO `__new_hr_calendar_days`("date", "day_type", "name", "special_kind", "updated_by", "created_at", "updated_at") SELECT "date", "day_type", "name", 'none', "updated_by", "created_at", "updated_at" FROM `hr_calendar_days`; --> statement-breakpoint
DROP TABLE `hr_calendar_days`;--> statement-breakpoint
ALTER TABLE `__new_hr_calendar_days` RENAME TO `hr_calendar_days`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_hr_calendar_days_type` ON `hr_calendar_days` (`day_type`,`date`);--> statement-breakpoint
CREATE TABLE `__new_hr_payroll_worker_results` (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_run_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`worker_name` text NOT NULL,
	`compensation_version_id` text,
	`pay_basis` text NOT NULL,
	`scheduled_days` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`typhoon_stop_days` integer DEFAULT 0 NOT NULL,
	`typhoon_stop_pay_minor` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `hr_payroll_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`worker_id`) REFERENCES `hr_schedule_workers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`compensation_version_id`) REFERENCES `hr_worker_compensation_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_payroll_worker_results_name" CHECK(length(trim("__new_hr_payroll_worker_results"."worker_name")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_hr_payroll_worker_results_days" CHECK("__new_hr_payroll_worker_results"."scheduled_days" >= 0),
	CONSTRAINT "ck_hr_payroll_worker_results_amount" CHECK("__new_hr_payroll_worker_results"."amount_minor" >= 0),
	CONSTRAINT "ck_hr_payroll_worker_results_typhoon_days" CHECK("__new_hr_payroll_worker_results"."typhoon_stop_days" >= 0 AND "__new_hr_payroll_worker_results"."typhoon_stop_days" <= "__new_hr_payroll_worker_results"."scheduled_days"),
	CONSTRAINT "ck_hr_payroll_worker_results_typhoon_amount" CHECK("__new_hr_payroll_worker_results"."typhoon_stop_pay_minor" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_hr_payroll_worker_results`("id", "payroll_run_id", "worker_id", "worker_name", "compensation_version_id", "pay_basis", "scheduled_days", "amount_minor", "typhoon_stop_days", "typhoon_stop_pay_minor", "created_at") SELECT "id", "payroll_run_id", "worker_id", "worker_name", "compensation_version_id", "pay_basis", "scheduled_days", "amount_minor", 0, 0, "created_at" FROM `hr_payroll_worker_results`;--> statement-breakpoint
DROP TABLE `hr_payroll_worker_results`;--> statement-breakpoint
ALTER TABLE `__new_hr_payroll_worker_results` RENAME TO `hr_payroll_worker_results`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_payroll_worker_results_run_worker` ON `hr_payroll_worker_results` (`payroll_run_id`,`worker_id`);--> statement-breakpoint
CREATE INDEX `idx_hr_payroll_worker_results_worker` ON `hr_payroll_worker_results` (`worker_id`,`created_at`);