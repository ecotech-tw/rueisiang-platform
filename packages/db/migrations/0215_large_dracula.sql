ALTER TABLE `hr_schedule_entries` ADD `shift_group_id` text;--> statement-breakpoint
ALTER TABLE `hr_schedule_entries` ADD `required_headcount` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `hr_schedule_entries` ADD `attendance_status` text DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_entries_group` ON `hr_schedule_entries` (`schedule_version_id`,`shift_group_id`);--> statement-breakpoint
ALTER TABLE `hr_schedule_worker_entries` ADD `shift_group_id` text;--> statement-breakpoint
ALTER TABLE `hr_schedule_worker_entries` ADD `required_headcount` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `hr_schedule_worker_entries` ADD `attendance_status` text DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_worker_entries_group` ON `hr_schedule_worker_entries` (`schedule_version_id`,`shift_group_id`);--> statement-breakpoint
ALTER TABLE `hr_shift_templates` ADD `required_headcount` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `hr_payroll_worker_results` ADD `schedule_allocation_json` text DEFAULT '[]' NOT NULL;