-- 舊版需求人力在班別主檔，先回填到每個日型版本，讓既有班別維持原本的提示值。
UPDATE `hr_shift_versions`
SET `required_headcount` = (
  SELECT `required_headcount`
  FROM `hr_shift_templates`
  WHERE `hr_shift_templates`.`id` = `hr_shift_versions`.`shift_template_id`
)
WHERE EXISTS (
  SELECT 1
  FROM `hr_shift_templates`
  WHERE `hr_shift_templates`.`id` = `hr_shift_versions`.`shift_template_id`
);--> statement-breakpoint
CREATE TRIGGER `trg_hr_shift_versions_headcount_insert`
BEFORE INSERT ON `hr_shift_versions`
WHEN NEW.`required_headcount` NOT BETWEEN 1 AND 100
BEGIN
  SELECT RAISE(ABORT, 'hr_shift_versions_headcount_invalid');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hr_shift_versions_headcount_update`
BEFORE UPDATE OF `required_headcount` ON `hr_shift_versions`
WHEN NEW.`required_headcount` NOT BETWEEN 1 AND 100
BEGIN
  SELECT RAISE(ABORT, 'hr_shift_versions_headcount_invalid');
END;
