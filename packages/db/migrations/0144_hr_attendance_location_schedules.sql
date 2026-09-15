CREATE TABLE `hr_attendance_location_schedules` (
  `id` text PRIMARY KEY NOT NULL,
  `location_id` text NOT NULL,
  `day_of_week` integer NOT NULL,
  `is_rest_day` integer DEFAULT 0 NOT NULL,
  `start_minute` integer,
  `end_minute` integer,
  `standard_minutes` integer DEFAULT 480 NOT NULL,
  `tolerance_minutes` integer DEFAULT 10 NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  FOREIGN KEY (`location_id`) REFERENCES `hr_attendance_locations`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT `ck_hr_attendance_location_schedules_day` CHECK(`day_of_week` BETWEEN 0 AND 6),
  CONSTRAINT `ck_hr_attendance_location_schedules_rest` CHECK(`is_rest_day` IN (0, 1)),
  CONSTRAINT `ck_hr_attendance_location_schedules_start` CHECK(`start_minute` IS NULL OR `start_minute` BETWEEN 0 AND 1439),
  CONSTRAINT `ck_hr_attendance_location_schedules_end` CHECK(`end_minute` IS NULL OR `end_minute` BETWEEN 0 AND 1439),
  CONSTRAINT `ck_hr_attendance_location_schedules_period` CHECK(`is_rest_day` = 1 OR (`start_minute` IS NOT NULL AND `end_minute` IS NOT NULL AND `end_minute` > `start_minute`)),
  CONSTRAINT `ck_hr_attendance_location_schedules_standard` CHECK(`standard_minutes` BETWEEN 0 AND 1440),
  CONSTRAINT `ck_hr_attendance_location_schedules_tolerance` CHECK(`tolerance_minutes` BETWEEN 0 AND 1440),
  CONSTRAINT `ck_hr_attendance_location_schedules_revision` CHECK(`revision` > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hr_attendance_location_schedules_day` ON `hr_attendance_location_schedules` (`location_id`,`day_of_week`);
--> statement-breakpoint
ALTER TABLE `hr_clock_events` ADD COLUMN `time_anomaly_kind` text;
--> statement-breakpoint
ALTER TABLE `hr_clock_events` ADD COLUMN `expected_start_minute` integer;
--> statement-breakpoint
ALTER TABLE `hr_clock_events` ADD COLUMN `expected_end_minute` integer;
--> statement-breakpoint
ALTER TABLE `hr_clock_events` ADD COLUMN `tolerance_minutes` integer;
--> statement-breakpoint
CREATE INDEX `idx_hr_clock_events_anomaly` ON `hr_clock_events` (`time_anomaly_kind`,`occurred_at`);
