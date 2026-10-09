CREATE TABLE `auth_line_account_links` (
	`user_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`line_user_id` text NOT NULL,
	`linked_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_auth_line_account_links_channel_id" CHECK(length(trim("auth_line_account_links"."channel_id")) BETWEEN 1 AND 100),
	CONSTRAINT "ck_auth_line_account_links_line_user_id" CHECK(length(trim("auth_line_account_links"."line_user_id")) BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_auth_line_account_links_identity` ON `auth_line_account_links` (`channel_id`,`line_user_id`);--> statement-breakpoint
ALTER TABLE `auth_device_sessions` ADD `auth_method` text DEFAULT 'device' NOT NULL;