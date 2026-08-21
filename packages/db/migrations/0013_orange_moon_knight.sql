CREATE TABLE `assistant_line_channels` (
	`assistant_key` text PRIMARY KEY NOT NULL,
	`channel_id` text DEFAULT '' NOT NULL,
	`channel_secret_encrypted` text DEFAULT '' NOT NULL,
	`display_name` text DEFAULT 'Rueisiang 小香' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `assistant_line_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`assistant_key` text NOT NULL,
	`line_group_id` text NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`discovered_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`assistant_key`) REFERENCES `assistant_line_channels`(`assistant_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_line_groups_key_group` ON `assistant_line_groups` (`assistant_key`,`line_group_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_line_groups_enabled` ON `assistant_line_groups` (`assistant_key`,`enabled`);--> statement-breakpoint
CREATE TABLE `assistant_line_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`assistant_key` text NOT NULL,
	`line_group_id` text NOT NULL,
	`source_type` text NOT NULL,
	`webhook_event_id` text NOT NULL,
	`line_message_id` text,
	`line_user_id` text,
	`text` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_line_messages_event` ON `assistant_line_messages` (`assistant_key`,`webhook_event_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_line_messages_group_created_at` ON `assistant_line_messages` (`assistant_key`,`line_group_id`,`created_at`);