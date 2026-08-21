ALTER TABLE `assistant_sandbox_messages` ADD `model` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_sandbox_sessions` ADD `context_summary` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_sandbox_sessions` ADD `context_summary_message_count` integer DEFAULT 0 NOT NULL;