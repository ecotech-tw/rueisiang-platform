ALTER TABLE `assistant_line_groups` ADD `next_message_sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_line_messages` ADD `sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_line_messages` ADD `queue_required` integer DEFAULT false NOT NULL;