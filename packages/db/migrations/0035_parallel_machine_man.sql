CREATE TABLE `assistant_line_push_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`channel_key` text NOT NULL,
	`group_id` text NOT NULL,
	`line_group_id` text NOT NULL,
	`source_type` text NOT NULL,
	`window_key` text NOT NULL,
	`recipient_count` integer NOT NULL,
	`remote_usage` integer NOT NULL,
	`reserved_through` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `assistant_line_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_line_push_deliveries_run` ON `assistant_line_push_deliveries` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_line_push_deliveries_window_status` ON `assistant_line_push_deliveries` (`channel_key`,`window_key`,`status`);--> statement-breakpoint
CREATE INDEX `idx_assistant_line_push_deliveries_group_created_at` ON `assistant_line_push_deliveries` (`group_id`,`created_at`);