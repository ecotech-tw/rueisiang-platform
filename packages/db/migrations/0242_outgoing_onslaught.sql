CREATE TABLE `media_cdn_blobs` (
	`object_key` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media_cdn_images` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`filename` text NOT NULL,
	`object_key` text,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`purge_pending` integer DEFAULT true NOT NULL,
	`purge_error` text,
	`deleted_at` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_media_cdn_images_updated` ON `media_cdn_images` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_media_cdn_images_purge` ON `media_cdn_images` (`purge_pending`) WHERE "media_cdn_images"."purge_pending" = 1;