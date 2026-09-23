ALTER TABLE `hr_employment_actions` ADD `ended_scope_assignments` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `hr_employment_actions` ADD `ended_attendance_assignments` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `hr_employment_actions` ADD `before_primary_assignment_id` text;