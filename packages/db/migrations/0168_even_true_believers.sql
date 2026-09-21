ALTER TABLE `hr_bonus_policy_members` ADD `superseded_valid_to` text;--> statement-breakpoint
ALTER TABLE `hr_bonus_policy_members` ADD `superseded_by_version_id` text REFERENCES hr_bonus_policy_versions(id);--> statement-breakpoint
ALTER TABLE `hr_bonus_policy_versions` ADD `voided_at` text;--> statement-breakpoint
ALTER TABLE `hr_bonus_policy_versions` ADD `voided_by` text REFERENCES users(id);