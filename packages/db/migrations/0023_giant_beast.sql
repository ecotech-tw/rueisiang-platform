PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assistant_line_channels` (
	`channel_key` text PRIMARY KEY NOT NULL,
	`assistant_key` text NOT NULL,
	`channel_id` text DEFAULT '' NOT NULL,
	`channel_secret_encrypted` text DEFAULT '' NOT NULL,
	`access_token_encrypted` text DEFAULT '' NOT NULL,
	`display_name` text DEFAULT 'Rueisiang 小香' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_assistant_line_channels`("channel_key", "assistant_key", "channel_id", "channel_secret_encrypted", "access_token_encrypted", "display_name", "enabled", "updated_by", "created_at", "updated_at") SELECT "channel_key", "assistant_key", "channel_id", "channel_secret_encrypted", "access_token_encrypted", "display_name", "enabled", "updated_by", "created_at", "updated_at" FROM `assistant_line_channels`;--> statement-breakpoint
DROP TABLE `assistant_line_channels`;--> statement-breakpoint
ALTER TABLE `__new_assistant_line_channels` RENAME TO `assistant_line_channels`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_line_channels_assistant` ON `assistant_line_channels` (`assistant_key`);