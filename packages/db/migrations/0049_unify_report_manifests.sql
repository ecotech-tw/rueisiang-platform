-- 將報表查詢改成三張最小資料表：scope、商品銷售日資料、出金日資料。
-- 執行紀錄仍保留，但欄位改用 D1 匯入語意，不再使用已移除的 manifest 名稱。
ALTER TABLE `cyberbiz_report_runs` RENAME COLUMN `manifest_eligible` TO `d1_import_eligible`;
--> statement-breakpoint
CREATE TABLE `report_scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_kind` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_report_scopes_name` ON `report_scopes` (`scope_kind`,`normalized_name`,`active`);
--> statement-breakpoint
CREATE INDEX `idx_report_scopes_active` ON `report_scopes` (`scope_kind`,`active`);
--> statement-breakpoint
CREATE TABLE `report_sales_daily` (
	`scope_id` text NOT NULL,
	`business_date` text NOT NULL,
	`sku` text NOT NULL,
	`product_name` text DEFAULT '' NOT NULL,
	`category` text DEFAULT '未分類' NOT NULL,
	`gross_quantity` integer DEFAULT 0 NOT NULL,
	`return_quantity` integer DEFAULT 0 NOT NULL,
	`net_quantity` integer DEFAULT 0 NOT NULL,
	`sales_amount` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`scope_id`, `business_date`, `sku`)
);
--> statement-breakpoint
CREATE INDEX `idx_report_sales_daily_date` ON `report_sales_daily` (`scope_id`,`business_date`);
--> statement-breakpoint
CREATE INDEX `idx_report_sales_daily_sku` ON `report_sales_daily` (`scope_id`,`sku`,`business_date`);
--> statement-breakpoint
CREATE INDEX `idx_report_sales_daily_category` ON `report_sales_daily` (`scope_id`,`category`,`business_date`);
--> statement-breakpoint
CREATE TABLE `report_payout_daily` (
	`scope_id` text NOT NULL,
	`business_date` text NOT NULL,
	`payout_amount` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`scope_id`, `business_date`)
);
--> statement-breakpoint
CREATE INDEX `idx_report_payout_daily_date` ON `report_payout_daily` (`scope_id`,`business_date`);
--> statement-breakpoint
INSERT OR IGNORE INTO `report_scopes` (`id`, `scope_kind`, `name`, `normalized_name`, `active`)
SELECT `scope_id`, `scope_type`, COALESCE(NULLIF(`scope_name`, ''), `scope_id`),
       lower(replace(replace(replace(COALESCE(NULLIF(`scope_name`, ''), `scope_id`), ' ', ''), char(9), ''), char(10), '')),
       1
FROM `cyberbiz_report_manifests`;
--> statement-breakpoint
INSERT OR IGNORE INTO `report_scopes` (`id`, `scope_kind`, `name`, `normalized_name`, `active`)
VALUES ('company', 'company', '公司整體', '公司整體', 1);
--> statement-breakpoint
DROP TABLE `cyberbiz_report_manifests`;
