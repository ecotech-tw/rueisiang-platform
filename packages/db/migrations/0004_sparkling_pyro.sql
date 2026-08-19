CREATE TABLE `payout_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`stores_json` text DEFAULT '[]' NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_payout_runs_request_id` ON `payout_runs` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_payout_runs_created_at` ON `payout_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `payout_stores` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`drive_folder_url` text DEFAULT '' NOT NULL,
	`drive_folder_name` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_payout_stores_name` ON `payout_stores` (`name`);