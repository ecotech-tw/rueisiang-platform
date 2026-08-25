CREATE TABLE `shopee_sales_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`drive_folder_url` text DEFAULT '' NOT NULL,
	`actor_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shopee_sales_runs_request_id` ON `shopee_sales_runs` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_shopee_sales_runs_created_at` ON `shopee_sales_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `shopee_sales_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`drive_folder_url` text DEFAULT '' NOT NULL,
	`drive_folder_name` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 蝦皮營運工具需要讓既有的管理者與主管角色取得對應權限。
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT id, 'tools:shopee-sales:run' FROM roles WHERE key IN ('admin', 'manager');
--> statement-breakpoint
INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT id, 'tools:shopee-sales:config' FROM roles WHERE key = 'admin';
