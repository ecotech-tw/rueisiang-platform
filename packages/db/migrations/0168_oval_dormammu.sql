ALTER TABLE `hr_bonus_policy_versions` ADD `voided_at` text;--> statement-breakpoint
ALTER TABLE `hr_bonus_policy_versions` ADD `voided_by` text REFERENCES users(id);