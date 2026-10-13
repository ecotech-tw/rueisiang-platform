CREATE TABLE `hr_schedule_scope_locks` (
	`period_start` text NOT NULL,
	`scope_id` text NOT NULL,
	`locked_at` text,
	`locked_by` text,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`period_start`, `scope_id`),
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`locked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_hr_schedule_scope_locks_period" CHECK(length("hr_schedule_scope_locks"."period_start") = 10),
	CONSTRAINT "ck_hr_schedule_scope_locks_revision" CHECK("hr_schedule_scope_locks"."revision" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_scope_locks_locked` ON `hr_schedule_scope_locks` (`period_start`,`locked_at`);