CREATE TABLE `report_manual_payout_daily` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`business_date` text NOT NULL,
	`payout_amount` integer DEFAULT 0 NOT NULL,
	`created_by_id` text NOT NULL,
	`created_by_email` text NOT NULL,
	`updated_by_id` text NOT NULL,
	`updated_by_email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_report_manual_payout_scope_date` ON `report_manual_payout_daily` (`scope_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_report_manual_payout_date` ON `report_manual_payout_daily` (`scope_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `report_manual_sales_monthly` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`report_month` text NOT NULL,
	`sku_source` text NOT NULL,
	`sku` text NOT NULL,
	`product_name` text DEFAULT '' NOT NULL,
	`category` text DEFAULT '未分類' NOT NULL,
	`gross_quantity` integer DEFAULT 0 NOT NULL,
	`return_quantity` integer DEFAULT 0 NOT NULL,
	`net_quantity` integer DEFAULT 0 NOT NULL,
	`sales_amount` integer DEFAULT 0 NOT NULL,
	`created_by_id` text NOT NULL,
	`created_by_email` text NOT NULL,
	`updated_by_id` text NOT NULL,
	`updated_by_email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_report_manual_sales_scope_month_sku` ON `report_manual_sales_monthly` (`scope_id`,`report_month`,`sku`);--> statement-breakpoint
CREATE INDEX `idx_report_manual_sales_month` ON `report_manual_sales_monthly` (`scope_id`,`report_month`);--> statement-breakpoint
CREATE INDEX `idx_report_manual_sales_sku` ON `report_manual_sales_monthly` (`scope_id`,`sku`,`report_month`);