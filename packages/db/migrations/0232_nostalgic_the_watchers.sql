CREATE TABLE `assistant_hr_request_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`assistant_key` text NOT NULL,
	`channel_key` text,
	`surface` text NOT NULL,
	`conversation_key` text NOT NULL,
	`user_id` text NOT NULL,
	`actor_user_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`submitted_request_id` text,
	`expires_at` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`channel_key`) REFERENCES `assistant_line_channels`(`channel_key`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_assistant_hr_request_drafts_surface" CHECK("assistant_hr_request_drafts"."surface" IN ('line', 'sandbox')),
	CONSTRAINT "ck_assistant_hr_request_drafts_kind" CHECK("assistant_hr_request_drafts"."kind" IN ('leave', 'overtime', 'clock_correction')),
	CONSTRAINT "ck_assistant_hr_request_drafts_status" CHECK("assistant_hr_request_drafts"."status" IN ('open', 'submitted', 'cancelled')),
	CONSTRAINT "ck_assistant_hr_request_drafts_channel" CHECK(("assistant_hr_request_drafts"."surface" = 'line') = ("assistant_hr_request_drafts"."channel_key" IS NOT NULL)),
	CONSTRAINT "ck_assistant_hr_request_drafts_revision" CHECK("assistant_hr_request_drafts"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assistant_hr_request_drafts_open` ON `assistant_hr_request_drafts` (`assistant_key`,`surface`,`conversation_key`) WHERE "assistant_hr_request_drafts"."status" = 'open';--> statement-breakpoint
CREATE INDEX `idx_assistant_hr_request_drafts_user` ON `assistant_hr_request_drafts` (`user_id`,`updated_at`);