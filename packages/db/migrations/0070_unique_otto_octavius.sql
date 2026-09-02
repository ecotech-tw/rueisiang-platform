CREATE TABLE `cyberbiz_product_categories` (
	`sku` text NOT NULL,
	`category_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`sku`, `category_id`),
	FOREIGN KEY (`sku`) REFERENCES `cyberbiz_products`(`sku`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `product_categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cyberbiz_product_categories_sku` ON `cyberbiz_product_categories` (`sku`);--> statement-breakpoint
CREATE INDEX `idx_cyberbiz_product_categories_category` ON `cyberbiz_product_categories` (`category_id`);