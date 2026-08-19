ALTER TABLE `saved_views` ADD `tag` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `saved_views` ADD `created_by_email` text DEFAULT '' NOT NULL;