ALTER TABLE `hr_leave_requests` ADD `starts_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `hr_leave_requests` ADD `ends_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_hr_leave_requests_employment_time` ON `hr_leave_requests` (`employment_id`,`starts_at`);