CREATE TABLE `report_bundle_sales_monthly` (
	`scope_id` text NOT NULL,
	`report_month` text NOT NULL,
	`external_sku` text NOT NULL,
	`item_id` text NOT NULL,
	`report_run_id` text NOT NULL,
	`gross_quantity` integer DEFAULT 0 NOT NULL,
	`return_quantity` integer DEFAULT 0 NOT NULL,
	`net_quantity` integer DEFAULT 0 NOT NULL,
	`sales_amount` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`scope_id`, `report_month`, `external_sku`),
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`report_run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_bundle_sales_item` ON `report_bundle_sales_monthly` (`item_id`,`report_month`);--> statement-breakpoint
CREATE INDEX `idx_bundle_sales_month` ON `report_bundle_sales_monthly` (`report_month`,`scope_id`);