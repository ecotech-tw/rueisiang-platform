CREATE TABLE `product_bundle_components` (
	`mapping_id` text NOT NULL,
	`inventory_item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	PRIMARY KEY(`mapping_id`, `inventory_item_id`),
	FOREIGN KEY (`mapping_id`) REFERENCES `product_sku_mappings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inventory_item_id`) REFERENCES `inventory_items`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_product_bundle_components_inventory_item` ON `product_bundle_components` (`inventory_item_id`);
