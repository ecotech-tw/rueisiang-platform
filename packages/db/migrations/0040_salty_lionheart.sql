CREATE TABLE `media_objects` (
	`object_key` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`scope_key` text DEFAULT '' NOT NULL,
	`filename` text DEFAULT '' NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`checksum` text NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_media_objects_namespace_created_at` ON `media_objects` (`namespace`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_media_objects_scope_key` ON `media_objects` (`namespace`,`scope_key`);--> statement-breakpoint
CREATE INDEX `idx_media_objects_expires_at` ON `media_objects` (`expires_at`);--> statement-breakpoint
ALTER TABLE `assistant_sandbox_messages` ADD `attachments` text DEFAULT '[]' NOT NULL;