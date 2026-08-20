CREATE TABLE `activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`entity_label` text DEFAULT '' NOT NULL,
	`event_type` text NOT NULL,
	`summary` text NOT NULL,
	`field` text DEFAULT '' NOT NULL,
	`old_value` text,
	`new_value` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`actor_type` text DEFAULT 'system' NOT NULL,
	`actor_id` text,
	`actor_email` text,
	`source` text DEFAULT 'crm' NOT NULL,
	`status` text DEFAULT 'succeeded' NOT NULL,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activity_entity_created` ON `activity_events` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_activity_source_created` ON `activity_events` (`source`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_activity_actor_created` ON `activity_events` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_activity_created` ON `activity_events` (`created_at`);