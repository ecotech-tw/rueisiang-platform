UPDATE `hr_special_workday_assignments`
SET `rule_id` = (
  SELECT `rule_id`
  FROM `hr_special_workday_rule_versions`
  WHERE `hr_special_workday_rule_versions`.`id` = `hr_special_workday_assignments`.`rule_version_id`
)
WHERE `rule_id` IS NULL;
