ALTER TABLE `assistant_line_messages` ADD `quoted_message_id` text;--> statement-breakpoint
ALTER TABLE `assistant_line_messages` ADD `attachments` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_assistant_line_messages_group_message` ON `assistant_line_messages` (`channel_key`,`line_group_id`,`line_message_id`);