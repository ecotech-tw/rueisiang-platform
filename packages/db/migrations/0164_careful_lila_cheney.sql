ALTER TABLE `hr_schedule_entries` ADD COLUMN `standard_minutes` integer NOT NULL DEFAULT 480;
--> statement-breakpoint
ALTER TABLE `hr_schedule_entries` ADD COLUMN `break_minutes` integer NOT NULL DEFAULT 60;
--> statement-breakpoint
ALTER TABLE `hr_schedule_worker_entries` ADD COLUMN `standard_minutes` integer NOT NULL DEFAULT 480;
--> statement-breakpoint
ALTER TABLE `hr_schedule_worker_entries` ADD COLUMN `break_minutes` integer NOT NULL DEFAULT 60;
--> statement-breakpoint
UPDATE `hr_schedule_entries`
SET `standard_minutes` = (SELECT `standard_minutes` FROM `hr_shift_versions` WHERE `hr_shift_versions`.`id` = `hr_schedule_entries`.`shift_version_id`),
    `break_minutes` = (SELECT `break_minutes` FROM `hr_shift_versions` WHERE `hr_shift_versions`.`id` = `hr_schedule_entries`.`shift_version_id`);
--> statement-breakpoint
UPDATE `hr_schedule_worker_entries`
SET `standard_minutes` = (SELECT `standard_minutes` FROM `hr_shift_versions` WHERE `hr_shift_versions`.`id` = `hr_schedule_worker_entries`.`shift_version_id`),
    `break_minutes` = (SELECT `break_minutes` FROM `hr_shift_versions` WHERE `hr_shift_versions`.`id` = `hr_schedule_worker_entries`.`shift_version_id`);
--> statement-breakpoint
CREATE TRIGGER `trg_hr_schedule_entry_minutes_validation_insert`
BEFORE INSERT ON `hr_schedule_entries`
WHEN NOT EXISTS (
  SELECT 1 FROM `hr_shift_versions`
  WHERE `id` = NEW.`shift_version_id`
    AND typeof(NEW.`standard_minutes`) = 'integer'
    AND typeof(NEW.`break_minutes`) = 'integer'
    AND NEW.`standard_minutes` BETWEEN 0 AND 1440
    AND NEW.`break_minutes` BETWEEN 0 AND 1440
    AND (NEW.`standard_minutes` + NEW.`break_minutes`) * 60 <= CASE WHEN `end_day_offset` = 1 THEN 86400 - `start_second` + `end_second` ELSE `end_second` - `start_second` END
)
BEGIN
  SELECT RAISE(ABORT, 'schedule_entry_minutes_exceed_duration');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_schedule_entry_minutes_validation_update`
BEFORE UPDATE OF `shift_version_id`, `standard_minutes`, `break_minutes` ON `hr_schedule_entries`
WHEN NOT EXISTS (
  SELECT 1 FROM `hr_shift_versions`
  WHERE `id` = NEW.`shift_version_id`
    AND typeof(NEW.`standard_minutes`) = 'integer'
    AND typeof(NEW.`break_minutes`) = 'integer'
    AND NEW.`standard_minutes` BETWEEN 0 AND 1440
    AND NEW.`break_minutes` BETWEEN 0 AND 1440
    AND (NEW.`standard_minutes` + NEW.`break_minutes`) * 60 <= CASE WHEN `end_day_offset` = 1 THEN 86400 - `start_second` + `end_second` ELSE `end_second` - `start_second` END
)
BEGIN
  SELECT RAISE(ABORT, 'schedule_entry_minutes_exceed_duration');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_schedule_worker_entry_minutes_validation_insert`
BEFORE INSERT ON `hr_schedule_worker_entries`
WHEN NOT EXISTS (
  SELECT 1 FROM `hr_shift_versions`
  WHERE `id` = NEW.`shift_version_id`
    AND typeof(NEW.`standard_minutes`) = 'integer'
    AND typeof(NEW.`break_minutes`) = 'integer'
    AND NEW.`standard_minutes` BETWEEN 0 AND 1440
    AND NEW.`break_minutes` BETWEEN 0 AND 1440
    AND (NEW.`standard_minutes` + NEW.`break_minutes`) * 60 <= CASE WHEN `end_day_offset` = 1 THEN 86400 - `start_second` + `end_second` ELSE `end_second` - `start_second` END
)
BEGIN
  SELECT RAISE(ABORT, 'schedule_entry_minutes_exceed_duration');
END;
--> statement-breakpoint
CREATE TRIGGER `trg_hr_schedule_worker_entry_minutes_validation_update`
BEFORE UPDATE OF `shift_version_id`, `standard_minutes`, `break_minutes` ON `hr_schedule_worker_entries`
WHEN NOT EXISTS (
  SELECT 1 FROM `hr_shift_versions`
  WHERE `id` = NEW.`shift_version_id`
    AND typeof(NEW.`standard_minutes`) = 'integer'
    AND typeof(NEW.`break_minutes`) = 'integer'
    AND NEW.`standard_minutes` BETWEEN 0 AND 1440
    AND NEW.`break_minutes` BETWEEN 0 AND 1440
    AND (NEW.`standard_minutes` + NEW.`break_minutes`) * 60 <= CASE WHEN `end_day_offset` = 1 THEN 86400 - `start_second` + `end_second` ELSE `end_second` - `start_second` END
)
BEGIN
  SELECT RAISE(ABORT, 'schedule_entry_minutes_exceed_duration');
END;
