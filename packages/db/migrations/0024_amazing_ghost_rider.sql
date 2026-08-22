CREATE TABLE `assistant_channel_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_key` text NOT NULL,
	`tool_key` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`channel_key`) REFERENCES `assistant_line_channels`(`channel_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_channel_tools_channel_tool` ON `assistant_channel_tools` (`channel_key`,`tool_key`);--> statement-breakpoint
CREATE TABLE `assistant_chat_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`channel_tool_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `assistant_line_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_tool_id`) REFERENCES `assistant_channel_tools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_chat_tools_group_tool` ON `assistant_chat_tools` (`group_id`,`channel_tool_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assistant_line_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_key` text NOT NULL,
	`line_group_id` text NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`tool_mode` text DEFAULT 'inherit' NOT NULL,
	`discovered_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`channel_key`) REFERENCES `assistant_line_channels`(`channel_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_assistant_line_groups`("id", "channel_key", "line_group_id", "display_name", "enabled", "tool_mode", "discovered_at", "updated_at") SELECT "id", "channel_key", "line_group_id", "display_name", "enabled", "tool_mode", "discovered_at", "updated_at" FROM `assistant_line_groups`;--> statement-breakpoint
DROP TABLE `assistant_line_groups`;--> statement-breakpoint
ALTER TABLE `__new_assistant_line_groups` RENAME TO `assistant_line_groups`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_line_groups_key_group` ON `assistant_line_groups` (`channel_key`,`line_group_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_line_groups_enabled` ON `assistant_line_groups` (`channel_key`,`enabled`);--> statement-breakpoint
CREATE TABLE `__new_assistant_line_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_key` text NOT NULL,
	`line_group_id` text NOT NULL,
	`source_type` text NOT NULL,
	`webhook_event_id` text NOT NULL,
	`line_message_id` text,
	`line_user_id` text,
	`text` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_assistant_line_messages`("id", "channel_key", "line_group_id", "source_type", "webhook_event_id", "line_message_id", "line_user_id", "text", "created_at") SELECT "id", "channel_key", "line_group_id", "source_type", "webhook_event_id", "line_message_id", "line_user_id", "text", "created_at" FROM `assistant_line_messages`;--> statement-breakpoint
DROP TABLE `assistant_line_messages`;--> statement-breakpoint
ALTER TABLE `__new_assistant_line_messages` RENAME TO `assistant_line_messages`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_line_messages_event` ON `assistant_line_messages` (`channel_key`,`webhook_event_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_line_messages_group_created_at` ON `assistant_line_messages` (`channel_key`,`line_group_id`,`created_at`);