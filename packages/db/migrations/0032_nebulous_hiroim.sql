ALTER TABLE `assistant_line_groups` ADD `source_type` text DEFAULT 'group' NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_line_groups` ADD `context_reset_at` text;