CREATE TABLE `customer_events` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`event_type` text NOT NULL,
	`summary` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`actor_type` text DEFAULT 'system' NOT NULL,
	`actor_id` text,
	`actor_email` text,
	`source` text DEFAULT 'crm' NOT NULL,
	`status` text DEFAULT 'succeeded' NOT NULL,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_customer_events_customer_created` ON `customer_events` (`customer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_customer_events_source_created` ON `customer_events` (`source`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_customer_events_actor_created` ON `customer_events` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `customer_tag_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_customer_tag_catalog_name` ON `customer_tag_catalog` (`name`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`normalized_phone` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`source_channel` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`cyberbiz_customer_id` text,
	`cyberbiz_uid` text,
	`cyberbiz_tags_json` text DEFAULT '[]' NOT NULL,
	`cyberbiz_updated_at` text,
	`cyberbiz_raw_json` text DEFAULT '{}' NOT NULL,
	`sync_status` text DEFAULT 'local_only' NOT NULL,
	`sync_error` text,
	`last_synced_at` text,
	`last_webhook_at` text,
	`blocked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_customers_normalized_phone` ON `customers` (`normalized_phone`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_customers_cyberbiz_customer_id` ON `customers` (`cyberbiz_customer_id`);--> statement-breakpoint
CREATE INDEX `idx_customers_status_channel` ON `customers` (`status`,`source_channel`);--> statement-breakpoint
CREATE INDEX `idx_customers_updated_at` ON `customers` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_customers_cyberbiz_updated_at` ON `customers` (`cyberbiz_updated_at`);--> statement-breakpoint
CREATE TABLE `cyberbiz_customer_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`cyberbiz_customer_id` text,
	`customer_id` text,
	`payload_json` text NOT NULL,
	`result_json` text DEFAULT '{}' NOT NULL,
	`last_error` text,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`processed_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_cyberbiz_customer_webhooks_status` ON `cyberbiz_customer_webhooks` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_cyberbiz_customer_webhooks_customer` ON `cyberbiz_customer_webhooks` (`cyberbiz_customer_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`search` text DEFAULT '' NOT NULL,
	`channel` text DEFAULT 'all' NOT NULL,
	`status` text DEFAULT 'all' NOT NULL,
	`sort_field` text DEFAULT 'updatedAt' NOT NULL,
	`sort_direction` text DEFAULT 'desc' NOT NULL,
	`page_size` integer DEFAULT 10 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_saved_views_name` ON `saved_views` (`name`);