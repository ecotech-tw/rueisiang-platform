ALTER TABLE `hr_employments` ADD `revoked_at` text;--> statement-breakpoint
ALTER TABLE `hr_employments` ADD `revoked_by` text REFERENCES users(id);