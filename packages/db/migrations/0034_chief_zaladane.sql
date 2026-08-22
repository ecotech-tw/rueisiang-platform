CREATE TABLE `assistant_line_reply_backups` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`channel_key` text NOT NULL,
	`group_id` text NOT NULL,
	`line_group_id` text NOT NULL,
	`source_type` text NOT NULL,
	`webhook_event_id` text NOT NULL,
	`question_text` text NOT NULL,
	`response_text` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`reason` text DEFAULT 'reply_token_deadline' NOT NULL,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `assistant_line_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_line_reply_backups_run` ON `assistant_line_reply_backups` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_line_reply_backups_group_created_at` ON `assistant_line_reply_backups` (`group_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_assistant_line_reply_backups_external_chat_created_at` ON `assistant_line_reply_backups` (`channel_key`,`line_group_id`,`created_at`);