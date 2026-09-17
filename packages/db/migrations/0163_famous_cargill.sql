ALTER TABLE `hr_employment_attendance_settings` ADD COLUMN `monthly_rest_days` integer;
--> statement-breakpoint
ALTER TABLE `hr_shift_versions` ADD COLUMN `standard_minutes` integer NOT NULL DEFAULT 480;
--> statement-breakpoint
ALTER TABLE `hr_shift_versions` ADD COLUMN `break_minutes` integer NOT NULL DEFAULT 60;
--> statement-breakpoint
UPDATE `hr_shift_versions`
SET `standard_minutes` = CAST(MIN(480, CASE WHEN `end_day_offset` = 1 THEN (86400 - `start_second` + `end_second`) / 60 ELSE (`end_second` - `start_second`) / 60 END) AS INTEGER),
    `break_minutes` = CAST(MIN(60, MAX(0, CASE WHEN `end_day_offset` = 1 THEN (86400 - `start_second` + `end_second`) / 60 ELSE (`end_second` - `start_second`) / 60 END - MIN(480, CASE WHEN `end_day_offset` = 1 THEN (86400 - `start_second` + `end_second`) / 60 ELSE (`end_second` - `start_second`) / 60 END))) AS INTEGER);
--> statement-breakpoint
CREATE TRIGGER `trg_hr_attendance_rest_days_validation_insert`
BEFORE INSERT ON `hr_employment_attendance_settings`
WHEN (NEW.`monthly_rest_days` IS NOT NULL AND (typeof(NEW.`monthly_rest_days`) <> 'integer' OR NEW.`monthly_rest_days` NOT BETWEEN 0 AND 31))
  OR (NEW.`attendance_mode` = 'general' AND NEW.`monthly_rest_days` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'attendance_monthly_rest_days_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_attendance_rest_days_validation_update`
BEFORE UPDATE OF `attendance_mode`, `monthly_rest_days` ON `hr_employment_attendance_settings`
WHEN (NEW.`monthly_rest_days` IS NOT NULL AND (typeof(NEW.`monthly_rest_days`) <> 'integer' OR NEW.`monthly_rest_days` NOT BETWEEN 0 AND 31))
  OR (NEW.`attendance_mode` = 'general' AND NEW.`monthly_rest_days` IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'attendance_monthly_rest_days_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_shift_minutes_validation_insert`
BEFORE INSERT ON `hr_shift_versions`
WHEN typeof(NEW.`standard_minutes`) <> 'integer'
  OR typeof(NEW.`break_minutes`) <> 'integer'
  OR NEW.`standard_minutes` NOT BETWEEN 0 AND 1440
  OR NEW.`break_minutes` NOT BETWEEN 0 AND 1440
  OR (NEW.`standard_minutes` + NEW.`break_minutes`) * 60 > CASE WHEN NEW.`end_day_offset` = 1 THEN 86400 - NEW.`start_second` + NEW.`end_second` ELSE NEW.`end_second` - NEW.`start_second` END
BEGIN
  SELECT RAISE(ABORT, 'shift_minutes_exceed_duration');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_shift_minutes_validation_update`
BEFORE UPDATE OF `start_second`, `end_second`, `end_day_offset`, `standard_minutes`, `break_minutes` ON `hr_shift_versions`
WHEN typeof(NEW.`standard_minutes`) <> 'integer'
  OR typeof(NEW.`break_minutes`) <> 'integer'
  OR NEW.`standard_minutes` NOT BETWEEN 0 AND 1440
  OR NEW.`break_minutes` NOT BETWEEN 0 AND 1440
  OR (NEW.`standard_minutes` + NEW.`break_minutes`) * 60 > CASE WHEN NEW.`end_day_offset` = 1 THEN 86400 - NEW.`start_second` + NEW.`end_second` ELSE NEW.`end_second` - NEW.`start_second` END
BEGIN
  SELECT RAISE(ABORT, 'shift_minutes_exceed_duration');
END;
