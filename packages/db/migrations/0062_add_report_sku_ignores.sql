CREATE TABLE `report_sku_ignores` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`external_sku` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_report_sku_ignores_channel_external_sku` ON `report_sku_ignores` (`channel`,`external_sku`);