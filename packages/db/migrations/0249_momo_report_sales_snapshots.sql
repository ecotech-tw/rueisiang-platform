CREATE TABLE `momo_report_sales_snapshots` (
	`scope_id` text NOT NULL,
	`snapshot_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`report_month` text NOT NULL,
	`external_sku` text NOT NULL,
	`product_name` text DEFAULT '' NOT NULL,
	`gross_quantity` integer DEFAULT 0 NOT NULL,
	`return_quantity` integer DEFAULT 0 NOT NULL,
	`net_quantity` integer DEFAULT 0 NOT NULL,
	`sales_amount` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`scope_id`, `snapshot_key`, `report_month`, `external_sku`),
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_momo_sales_snapshots_scope_month` ON `momo_report_sales_snapshots` (`scope_id`,`report_month`);--> statement-breakpoint
CREATE INDEX `idx_momo_sales_snapshots_content` ON `momo_report_sales_snapshots` (`scope_id`,`content_hash`);