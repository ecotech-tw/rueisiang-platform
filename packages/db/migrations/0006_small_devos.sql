CREATE TABLE `user_permissions` (
	`user_id` text NOT NULL,
	`permission` text NOT NULL,
	`granted_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`user_id`, `permission`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
