ALTER TABLE `users` ADD `invitation_token_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD `invitation_expires_at` text;--> statement-breakpoint
ALTER TABLE `users` ADD `password_set_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_invitation_token_hash` ON `users` (`invitation_token_hash`);