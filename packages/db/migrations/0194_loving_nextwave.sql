ALTER TABLE `hr_insurance_versions` ADD `voided_at` text;--> statement-breakpoint
ALTER TABLE `hr_insurance_versions` ADD `voided_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `hr_insurance_versions` ADD `superseded_valid_to` text;--> statement-breakpoint
ALTER TABLE `hr_insurance_versions` ADD `superseded_by_version_id` text REFERENCES hr_insurance_versions(id);