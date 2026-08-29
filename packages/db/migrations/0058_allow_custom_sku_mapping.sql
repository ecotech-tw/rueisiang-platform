-- 0054 建立的 inventory_item_id 仍是 NOT NULL；自訂 SKU 需要允許沒有 WMS 主商品，
-- 但仍以 product_bundle_components 保存至少一個實際用料。先搬子表再替換父表，
-- 避免 DROP 父表時被 ON DELETE CASCADE 一併刪掉既有組合用料。
CREATE TABLE `product_sku_mappings_new` (
	`id` text PRIMARY KEY NOT NULL,
	`inventory_item_id` text,
	`channel` text DEFAULT 'legacy' NOT NULL,
	`external_name` text DEFAULT '' NOT NULL,
	`external_sku` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`inventory_item_id`) REFERENCES `inventory_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `product_sku_mappings_new` (
	`id`, `inventory_item_id`, `channel`, `external_name`, `external_sku`, `created_at`, `updated_at`
)
SELECT
	`id`, `inventory_item_id`, `channel`, `external_name`, `external_sku`, `created_at`, `updated_at`
FROM `product_sku_mappings`;
--> statement-breakpoint
CREATE TABLE `product_bundle_components_new` (
	`mapping_id` text NOT NULL,
	`inventory_item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	PRIMARY KEY(`mapping_id`, `inventory_item_id`),
	FOREIGN KEY (`mapping_id`) REFERENCES `product_sku_mappings_new`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inventory_item_id`) REFERENCES `inventory_items`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `product_bundle_components_new` (`mapping_id`, `inventory_item_id`, `quantity`)
SELECT `mapping_id`, `inventory_item_id`, `quantity`
FROM `product_bundle_components`;
--> statement-breakpoint
DROP TABLE `product_bundle_components`;
--> statement-breakpoint
DROP TABLE `product_sku_mappings`;
--> statement-breakpoint
ALTER TABLE `product_sku_mappings_new` RENAME TO `product_sku_mappings`;
--> statement-breakpoint
ALTER TABLE `product_bundle_components_new` RENAME TO `product_bundle_components`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_product_sku_mappings_channel_external_sku`
	ON `product_sku_mappings` (`channel`, `external_sku`);
--> statement-breakpoint
CREATE INDEX `idx_product_sku_mappings_inventory_item`
	ON `product_sku_mappings` (`inventory_item_id`);
--> statement-breakpoint
CREATE INDEX `idx_product_bundle_components_inventory_item`
	ON `product_bundle_components` (`inventory_item_id`);
