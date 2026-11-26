PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_hr_notifications` (
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
	CONSTRAINT "ck_hr_notifications_kind" CHECK("__new_hr_notifications"."kind" IN ('request_submitted', 'request_reviewed', 'request_cancelled')),
	CONSTRAINT "ck_hr_notifications_entity_kind" CHECK("__new_hr_notifications"."entity_kind" IN ('leave', 'overtime', 'clock_correction', 'expense')),
	CONSTRAINT "ck_hr_notifications_title" CHECK(length(trim("__new_hr_notifications"."title")) BETWEEN 1 AND 120),
	CONSTRAINT "ck_hr_notifications_body" CHECK(length("__new_hr_notifications"."body") BETWEEN 1 AND 1000)
);
--> statement-breakpoint
INSERT INTO `__new_hr_notifications`("id", "user_id", "source_key", "kind", "entity_kind", "entity_id", "title", "body", "read_at", "created_at") SELECT "id", "user_id", "source_key", "kind", "entity_kind", "entity_id", "title", "body", "read_at", "created_at" FROM `hr_notifications`;--> statement-breakpoint
DROP TABLE `hr_notifications`;--> statement-breakpoint
ALTER TABLE `__new_hr_notifications` RENAME TO `hr_notifications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `hr_notifications_source_key_unique` ON `hr_notifications` (`source_key`);--> statement-breakpoint
CREATE INDEX `idx_hr_notifications_user_created` ON `hr_notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_hr_notifications_user_unread` ON `hr_notifications` (`user_id`,`read_at`,`created_at`);