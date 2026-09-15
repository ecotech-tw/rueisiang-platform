CREATE TABLE `auth_device_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`previous_token_hash` text,
	`user_agent` text DEFAULT '' NOT NULL,
	`rotated_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_auth_device_sessions_token_hash` ON `auth_device_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_auth_device_sessions_user_id` ON `auth_device_sessions` (`user_id`);