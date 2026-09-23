CREATE TABLE `hr_calendar_days` (
	`date` text PRIMARY KEY NOT NULL,
	`day_type` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_calendar_days_date" CHECK(length("hr_calendar_days"."date") = 10),
	CONSTRAINT "ck_hr_calendar_days_type" CHECK("hr_calendar_days"."day_type" IN ('weekday', 'weekend', 'holiday')),
	CONSTRAINT "ck_hr_calendar_days_name" CHECK(length("hr_calendar_days"."name") <= 100)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_calendar_days_type` ON `hr_calendar_days` (`day_type`,`date`);--> statement-breakpoint
DROP INDEX `idx_hr_shift_versions_number`;--> statement-breakpoint
ALTER TABLE `hr_shift_versions` ADD `day_type` text DEFAULT 'weekday' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_shift_versions_number` ON `hr_shift_versions` (`shift_template_id`,`day_type`,`version_number`);