CREATE TABLE `cyberbiz_product_links` (
	`id` text PRIMARY KEY NOT NULL,
	`inventory_item_id` text NOT NULL,
	`cyberbiz_product_id` text NOT NULL,
	`cyberbiz_variant_id` text NOT NULL,
	`sku` text NOT NULL,
	`warehouse_scope` text DEFAULT 'company' NOT NULL,
	`pos_shop_id` integer DEFAULT 0 NOT NULL,
	`sync_status` text DEFAULT 'synced' NOT NULL,
	`last_synced_quantity` integer,
	`last_synced_at` text,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`inventory_item_id`) REFERENCES `inventory_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cyberbiz_product_links_inventory_item_id_unique` ON `cyberbiz_product_links` (`inventory_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cyberbiz_product_links_cyberbiz_variant_id_unique` ON `cyberbiz_product_links` (`cyberbiz_variant_id`);--> statement-breakpoint
CREATE INDEX `idx_cyberbiz_product_links_status` ON `cyberbiz_product_links` (`sync_status`);--> statement-breakpoint
CREATE INDEX `idx_cyberbiz_product_links_sku` ON `cyberbiz_product_links` (`sku`);--> statement-breakpoint
CREATE TABLE `cyberbiz_product_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`product_id` text,
	`variant_id` text,
	`sku` text DEFAULT '' NOT NULL,
	`quantity` integer,
	`payload_hash` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`result` text DEFAULT '' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`processed_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_cyberbiz_product_webhooks_status` ON `cyberbiz_product_webhooks` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_cyberbiz_product_webhooks_variant` ON `cyberbiz_product_webhooks` (`variant_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `inventory_items` (
	`id` text PRIMARY KEY NOT NULL,
	`sku` text,
	`name` text NOT NULL,
	`category` text DEFAULT '一般備品' NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`unit` text DEFAULT '件' NOT NULL,
	`min_stock` integer DEFAULT 5 NOT NULL,
	`zone_id` text,
	`shelf_level` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_items_sku_unique` ON `inventory_items` (`sku`);--> statement-breakpoint
CREATE INDEX `idx_inventory_items_zone` ON `inventory_items` (`zone_id`);--> statement-breakpoint
CREATE INDEX `idx_inventory_items_name` ON `inventory_items` (`name`);--> statement-breakpoint
CREATE TABLE `layout_elements` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`color` text DEFAULT 'rose' NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `product_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'rose' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_categories_name_unique` ON `product_categories` (`name`);--> statement-breakpoint
CREATE TABLE `warehouse_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`canvas_width` integer DEFAULT 1600 NOT NULL,
	`canvas_height` integer DEFAULT 900 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `zone_images` (
	`id` text PRIMARY KEY NOT NULL,
	`zone_id` text NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `zone_images_object_key_unique` ON `zone_images` (`object_key`);--> statement-breakpoint
CREATE INDEX `idx_zone_images_zone` ON `zone_images` (`zone_id`);--> statement-breakpoint
CREATE TABLE `zones` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT '一般備品' NOT NULL,
	`color` text DEFAULT 'mint' NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`shelf_levels` text DEFAULT '[{"id":"top","name":"上層"},{"id":"middle","name":"中層"},{"id":"bottom","name":"底層"}]' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `zones_code_unique` ON `zones` (`code`);