CREATE TABLE `scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text DEFAULT 'legacy',
	`scope_kind` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`drive_folder_url` text DEFAULT '' NOT NULL,
	`drive_folder_name` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `scopes` (`id`, `source_type`, `scope_kind`, `name`, `normalized_name`, `active`, `created_at`, `updated_at`)
SELECT `id`, 'report', `scope_kind`, `name`, `normalized_name`, `active`, `created_at`, `updated_at`
FROM `report_scopes`;
--> statement-breakpoint
INSERT OR IGNORE INTO `scopes` (`id`, `source_type`, `scope_kind`, `name`, `normalized_name`, `drive_folder_url`, `drive_folder_name`, `sort_order`, `active`, `created_at`, `updated_at`)
SELECT `id`, 'payout', 'store', `name`, lower(replace(replace(replace(`name`, ' ', ''), char(9), ''), char(10), '')), `drive_folder_url`, `drive_folder_name`, `sort_order`, 1, `created_at`, `updated_at`
FROM `payout_stores`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_scopes_source_normalized` ON `scopes` (`source_type`,`normalized_name`);
--> statement-breakpoint
CREATE INDEX `idx_scopes_pick` ON `scopes` (`scope_kind`,`active`,`sort_order`);
--> statement-breakpoint
CREATE TRIGGER `trg_report_scopes_to_scopes_insert` AFTER INSERT ON `report_scopes`
BEGIN
  INSERT OR IGNORE INTO `scopes` (`id`, `source_type`, `scope_kind`, `name`, `normalized_name`, `active`, `created_at`, `updated_at`)
  VALUES (NEW.`id`, 'report', NEW.`scope_kind`, NEW.`name`, NEW.`normalized_name`, NEW.`active`, NEW.`created_at`, NEW.`updated_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `trg_report_scopes_to_scopes_update` AFTER UPDATE ON `report_scopes`
BEGIN
  UPDATE `scopes`
  SET `name` = NEW.`name`, `normalized_name` = NEW.`normalized_name`, `active` = NEW.`active`, `updated_at` = NEW.`updated_at`
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_report_scopes_to_scopes_delete` AFTER DELETE ON `report_scopes`
BEGIN
  DELETE FROM `scopes` WHERE `id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TABLE `report_external_products` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`external_key` text NOT NULL,
	`external_variant_key` text DEFAULT '' NOT NULL,
	`external_name` text DEFAULT '' NOT NULL,
	`resolution` text NOT NULL,
	`item_id` text,
	`ignored_reason` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_report_external_products_key` ON `report_external_products` (`source_type`,`external_key`,`external_variant_key`);
--> statement-breakpoint
CREATE INDEX `idx_report_external_products_item` ON `report_external_products` (`item_id`) WHERE `item_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `report_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`source_type` text NOT NULL,
	`imports_sales` integer DEFAULT 0 NOT NULL,
	`imports_payout` integer DEFAULT 0 NOT NULL,
	`period_kind` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`workflow_run_id` text,
	`imported_sales_rows` integer DEFAULT 0 NOT NULL,
	`imported_payout_rows` integer DEFAULT 0 NOT NULL,
	`skipped_rows` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`actor_email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_report_runs_request_id` ON `report_runs` (`request_id`);
--> statement-breakpoint
CREATE INDEX `idx_report_runs_created` ON `report_runs` (`created_at`);
--> statement-breakpoint
CREATE TABLE `report_run_scopes` (
	`report_run_id` text NOT NULL,
	`scope_id` text NOT NULL,
	PRIMARY KEY(`report_run_id`, `scope_id`),
	FOREIGN KEY (`report_run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_report_run_scopes_scope` ON `report_run_scopes` (`scope_id`);
--> statement-breakpoint
CREATE TABLE `report_run_reports` (
	`report_run_id` text PRIMARY KEY NOT NULL,
	`report_md` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`report_run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `report_item_sales_monthly` (
	`scope_id` text NOT NULL,
	`report_month` text NOT NULL,
	`item_id` text NOT NULL,
	`record_origin` text NOT NULL,
	`report_run_id` text,
	`gross_quantity` integer DEFAULT 0 NOT NULL,
	`return_quantity` integer DEFAULT 0 NOT NULL,
	`net_quantity` integer DEFAULT 0 NOT NULL,
	`sales_amount` integer DEFAULT 0 NOT NULL,
	`updated_by_email` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`scope_id`, `report_month`, `item_id`, `record_origin`),
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`report_run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_item_sales_month` ON `report_item_sales_monthly` (`report_month`,`scope_id`);
--> statement-breakpoint
CREATE INDEX `idx_item_sales_item` ON `report_item_sales_monthly` (`item_id`,`report_month`);
--> statement-breakpoint
CREATE TABLE `report_ingest_issues` (
	`report_run_id` text NOT NULL,
	`external_key` text NOT NULL,
	`external_variant_key` text DEFAULT '' NOT NULL,
	`external_name` text DEFAULT '' NOT NULL,
	`issue_type` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`report_run_id`, `external_key`, `external_variant_key`, `issue_type`),
	FOREIGN KEY (`report_run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ingest_issues_key` ON `report_ingest_issues` (`external_key`,`external_variant_key`);
