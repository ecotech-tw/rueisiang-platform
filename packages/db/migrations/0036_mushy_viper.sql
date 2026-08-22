CREATE TABLE `assistant_line_queue_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_key` text NOT NULL,
	`webhook_event_id` text NOT NULL,
	`payload_encrypted` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claim_token` text,
	`locked_until` text,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_line_queue_jobs_channel_event` ON `assistant_line_queue_jobs` (`channel_key`,`webhook_event_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_line_queue_jobs_status_updated_at` ON `assistant_line_queue_jobs` (`status`,`updated_at`);