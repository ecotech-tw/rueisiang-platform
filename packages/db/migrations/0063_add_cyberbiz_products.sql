CREATE TABLE `cyberbiz_products` (
	`sku` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`product_name` text NOT NULL,
	`variant_name` text DEFAULT '' NOT NULL,
	`published` integer DEFAULT 1 NOT NULL,
	`synced_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cyberbiz_products_product` ON `cyberbiz_products` (`product_id`,`variant_id`);