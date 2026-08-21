CREATE TABLE `assistant_prompt_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`assistant_key` text NOT NULL,
	`revision` integer NOT NULL,
	`system_prompt` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_prompt_key_revision` ON `assistant_prompt_revisions` (`assistant_key`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_assistant_prompt_active` ON `assistant_prompt_revisions` (`assistant_key`,`is_active`);--> statement-breakpoint
CREATE TABLE `assistant_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`group_id` text,
	`model` text NOT NULL,
	`prompt_revision_id` text NOT NULL,
	`input_chars` integer NOT NULL,
	`output_chars` integer DEFAULT 0 NOT NULL,
	`prompt_tokens` integer,
	`candidate_tokens` integer,
	`total_tokens` integer,
	`status` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`actor_id` text,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_runs_channel_created_at` ON `assistant_runs` (`channel`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_assistant_runs_group_created_at` ON `assistant_runs` (`group_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `assistant_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tool_key` text NOT NULL,
	`status` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assistant_tool_calls_run_id` ON `assistant_tool_calls` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_assistant_tool_calls_tool_created_at` ON `assistant_tool_calls` (`tool_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `assistant_tool_configs` (
	`key` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'development' NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
