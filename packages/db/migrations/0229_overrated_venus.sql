CREATE TABLE `hr_schedule_managers` (
	`scope_id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_hr_schedule_managers_user` ON `hr_schedule_managers` (`user_id`);