CREATE TABLE `hr_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_key` text NOT NULL,
	`kind` text NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`read_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_notifications_kind" CHECK("hr_notifications"."kind" IN ('request_submitted', 'request_reviewed', 'request_cancelled')),
	CONSTRAINT "ck_hr_notifications_entity_kind" CHECK("hr_notifications"."entity_kind" IN ('leave', 'overtime', 'clock_correction')),
	CONSTRAINT "ck_hr_notifications_title" CHECK(length(trim("hr_notifications"."title")) BETWEEN 1 AND 120),
	CONSTRAINT "ck_hr_notifications_body" CHECK(length("hr_notifications"."body") BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hr_notifications_source_key_unique` ON `hr_notifications` (`source_key`);--> statement-breakpoint
CREATE INDEX `idx_hr_notifications_user_created` ON `hr_notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_hr_notifications_user_unread` ON `hr_notifications` (`user_id`,`read_at`,`created_at`);--> statement-breakpoint
ALTER TABLE `hr_leave_requests` ADD `approver_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `hr_leave_requests` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_hr_leave_requests_approver_status` ON `hr_leave_requests` (`approver_user_id`,`status`);--> statement-breakpoint
ALTER TABLE `hr_overtime_requests` ADD `approver_user_id` text REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `idx_hr_overtime_approver_status` ON `hr_overtime_requests` (`approver_user_id`,`status`);