ALTER TABLE `product_categories` RENAME TO `warehouse_categories`;--> statement-breakpoint
CREATE TABLE `report_product_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'rose' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_product_categories_name_unique` ON `report_product_categories` (`name`);--> statement-breakpoint
DROP INDEX `product_categories_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `warehouse_categories_name_unique` ON `warehouse_categories` (`name`);--> statement-breakpoint
CREATE TABLE `__new_cyberbiz_product_categories` (
	`sku` text NOT NULL,
	`category_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`sku`, `category_id`),
	FOREIGN KEY (`sku`) REFERENCES `cyberbiz_products`(`sku`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `report_product_categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_cyberbiz_product_categories`("sku", "category_id", "created_at", "updated_at") SELECT "sku", "category_id", "created_at", "updated_at" FROM `cyberbiz_product_categories`;--> statement-breakpoint
DROP TABLE `cyberbiz_product_categories`;--> statement-breakpoint
ALTER TABLE `__new_cyberbiz_product_categories` RENAME TO `cyberbiz_product_categories`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cyberbiz_product_categories_sku` ON `cyberbiz_product_categories` (`sku`);--> statement-breakpoint
CREATE INDEX `idx_cyberbiz_product_categories_category` ON `cyberbiz_product_categories` (`category_id`);
