ALTER TABLE `hr_compensation_versions` ADD `voided_at` text;--> statement-breakpoint
ALTER TABLE `hr_compensation_versions` ADD `voided_by` text REFERENCES users(id);