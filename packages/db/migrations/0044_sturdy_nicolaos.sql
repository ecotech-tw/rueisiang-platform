ALTER TABLE `assistant_line_messages` ADD `message_type` text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_line_messages` ADD `image_download_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_line_messages` ADD `image_download_error` text;