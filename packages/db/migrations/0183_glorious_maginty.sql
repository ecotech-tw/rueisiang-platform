-- 0179 已完成 hr_shift_versions.day_type 的 schema 切換；正式庫在這支 migration
-- 尚未成功記錄前就已經有 calendar／shift 的最終形狀，因此這裡只做冪等補建。
CREATE TABLE IF NOT EXISTS `hr_calendar_days` (
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
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_hr_calendar_days_type` ON `hr_calendar_days` (`day_type`,`date`);
