CREATE TABLE `assistant_sandbox_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `assistant_sandbox_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_sandbox_messages_session_created_at` ON `assistant_sandbox_messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `assistant_sandbox_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`assistant_key` text NOT NULL,
	`created_by` text NOT NULL,
	`model` text NOT NULL,
	`prompt_revision_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_sandbox_sessions_owner_updated_at` ON `assistant_sandbox_sessions` (`assistant_key`,`created_by`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_assistant_sandbox_sessions_status` ON `assistant_sandbox_sessions` (`assistant_key`,`created_by`,`status`);--> statement-breakpoint
ALTER TABLE `assistant_runs` ADD `session_id` text;--> statement-breakpoint
CREATE INDEX `idx_assistant_runs_session_created_at` ON `assistant_runs` (`session_id`,`created_at`);