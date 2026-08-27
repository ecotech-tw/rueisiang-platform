-- 先建立月粒度商品銷售表，讓舊日資料與新月資料可以短暫並存。
CREATE TABLE `report_sales_monthly` (
	`scope_id` text NOT NULL,
	`report_month` text NOT NULL,
	`sku` text NOT NULL,
	`product_name` text DEFAULT '' NOT NULL,
	`category` text DEFAULT '未分類' NOT NULL,
	`gross_quantity` integer DEFAULT 0 NOT NULL,
	`return_quantity` integer DEFAULT 0 NOT NULL,
	`net_quantity` integer DEFAULT 0 NOT NULL,
	`sales_amount` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`scope_id`, `report_month`, `sku`)
);
--> statement-breakpoint
CREATE INDEX `idx_report_sales_monthly_month` ON `report_sales_monthly` (`scope_id`,`report_month`);
--> statement-breakpoint
CREATE INDEX `idx_report_sales_monthly_sku` ON `report_sales_monthly` (`scope_id`,`sku`,`report_month`);
--> statement-breakpoint
CREATE INDEX `idx_report_sales_monthly_category` ON `report_sales_monthly` (`scope_id`,`category`,`report_month`);
