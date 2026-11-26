CREATE TABLE `cyberbiz_order_restocks` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`order_id` text NOT NULL,
	`order_name` text NOT NULL,
	`phase` text NOT NULL,
	`source` text NOT NULL,
	`product_id` text DEFAULT '' NOT NULL,
	`variant_id` text DEFAULT '' NOT NULL,
	`sku` text DEFAULT '' NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`item_id` text,
	`mode` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`order_created_at` text DEFAULT '' NOT NULL,
	`target_quantity` integer,
	`remote_before` integer,
	`remote_after` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`started_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_order_restocks_phase" CHECK("cyberbiz_order_restocks"."phase" IN ('create', 'cancel')),
	CONSTRAINT "ck_order_restocks_mode" CHECK("cyberbiz_order_restocks"."mode" IN ('observe', 'apply')),
	CONSTRAINT "ck_order_restocks_state" CHECK("cyberbiz_order_restocks"."state" IN ('pending', 'checking', 'applying', 'applied', 'unchanged', 'observed', 'skipped', 'review')),
	CONSTRAINT "ck_order_restocks_quantity" CHECK("cyberbiz_order_restocks"."quantity" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_order_restocks_business_key` ON `cyberbiz_order_restocks` (`order_id`,`phase`,`variant_id`);--> statement-breakpoint
CREATE INDEX `idx_order_restocks_pending` ON `cyberbiz_order_restocks` (`mode`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_order_restocks_item` ON `cyberbiz_order_restocks` (`item_id`,`state`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cyberbiz_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`cyberbiz_customer_id` text,
	`customer_id` text,
	`payload_json` text NOT NULL,
	`result_json` text DEFAULT '{}' NOT NULL,
	`last_error` text,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`processed_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`entity_type` text DEFAULT 'customer' NOT NULL,
	`external_entity_id` text,
	`attempts` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `crm_customers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_webhook_events_entity" CHECK("__new_cyberbiz_webhook_events"."entity_type" IN ('customer', 'product', 'order', 'stock')),
	CONSTRAINT "ck_webhook_events_status" CHECK("__new_cyberbiz_webhook_events"."status" IN ('processing', 'processed', 'ignored', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_cyberbiz_webhook_events`("id", "topic", "status", "cyberbiz_customer_id", "customer_id", "payload_json", "result_json", "last_error", "received_at", "processed_at", "updated_at", "entity_type", "external_entity_id", "attempts") SELECT "id", "topic", "status", "cyberbiz_customer_id", "customer_id", "payload_json", "result_json", "last_error", "received_at", "processed_at", "updated_at", "entity_type", "external_entity_id", "attempts" FROM `cyberbiz_webhook_events`;--> statement-breakpoint
DROP TABLE `cyberbiz_webhook_events`;--> statement-breakpoint
ALTER TABLE `__new_cyberbiz_webhook_events` RENAME TO `cyberbiz_webhook_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_webhook_events_status` ON `cyberbiz_webhook_events` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_events_customer` ON `cyberbiz_webhook_events` (`cyberbiz_customer_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_webhook_events_entity` ON `cyberbiz_webhook_events` (`entity_type`,`external_entity_id`,`received_at`);