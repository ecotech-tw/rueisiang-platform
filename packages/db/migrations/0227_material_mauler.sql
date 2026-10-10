ALTER TABLE `hr_overtime_requests` ADD `batch_id` text;--> statement-breakpoint
CREATE INDEX `idx_hr_overtime_batch` ON `hr_overtime_requests` (`batch_id`);