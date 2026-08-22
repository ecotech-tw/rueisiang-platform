ALTER TABLE `assistant_line_channels` ADD `channel_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_line_channels_channel_key` ON `assistant_line_channels` (`channel_key`);--> statement-breakpoint
ALTER TABLE `assistant_line_groups` ADD `channel_key` text;--> statement-breakpoint
ALTER TABLE `assistant_line_groups` ADD `tool_mode` text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_line_messages` ADD `channel_key` text;--> statement-breakpoint
ALTER TABLE `assistant_runs` ADD `assistant_key` text;--> statement-breakpoint
ALTER TABLE `assistant_runs` ADD `channel_key` text;