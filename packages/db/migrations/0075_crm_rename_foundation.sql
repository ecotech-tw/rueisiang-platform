ALTER TABLE `customers` RENAME TO `crm_customers`;
--> statement-breakpoint
ALTER TABLE `crm_customers` RENAME COLUMN `cyberbiz_raw_json` TO `raw_json`;
--> statement-breakpoint
ALTER TABLE `crm_customers` RENAME COLUMN `last_synced_at` TO `synced_at`;
--> statement-breakpoint
CREATE VIEW `customers` AS SELECT * FROM `crm_customers`;
--> statement-breakpoint
ALTER TABLE `saved_views` RENAME TO `crm_saved_views`;
--> statement-breakpoint
ALTER TABLE `crm_saved_views` ADD `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL;
--> statement-breakpoint
ALTER TABLE `customer_tag_catalog` RENAME TO `crm_tags`;
--> statement-breakpoint
CREATE TABLE `crm_customer_tags` (
	`customer_id` text NOT NULL,
	`crm_tag_id` text NOT NULL,
	PRIMARY KEY(`customer_id`, `crm_tag_id`),
	FOREIGN KEY (`customer_id`) REFERENCES `crm_customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`crm_tag_id`) REFERENCES `crm_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_crm_customer_tags_tag` ON `crm_customer_tags` (`crm_tag_id`);
--> statement-breakpoint
ALTER TABLE `cyberbiz_customer_webhooks` RENAME TO `cyberbiz_webhook_events`;
--> statement-breakpoint
ALTER TABLE `cyberbiz_webhook_events` ADD `entity_type` text;
--> statement-breakpoint
ALTER TABLE `cyberbiz_webhook_events` ADD `external_entity_id` text;
--> statement-breakpoint
ALTER TABLE `cyberbiz_webhook_events` ADD `attempts` integer DEFAULT 0 NOT NULL;
