ALTER TABLE `hr_special_workday_rule_versions` ADD `voided_at` text;--> statement-breakpoint
ALTER TABLE `hr_special_workday_rule_versions` ADD `voided_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `hr_special_workday_rule_versions` ADD `superseded_valid_to` text;--> statement-breakpoint
ALTER TABLE `hr_special_workday_rule_versions` ADD `superseded_by_version_id` text REFERENCES hr_special_workday_rule_versions(id);