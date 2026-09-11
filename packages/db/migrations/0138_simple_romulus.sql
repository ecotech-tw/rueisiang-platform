CREATE TABLE `report_item_sales_period` (
	`scope_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`report_month` text NOT NULL,
	`item_id` text NOT NULL,
	`report_run_id` text,
	`gross_quantity` integer DEFAULT 0 NOT NULL,
	`return_quantity` integer DEFAULT 0 NOT NULL,
	`net_quantity` integer DEFAULT 0 NOT NULL,
	`sales_amount` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`scope_id`, `period_start`, `period_end`, `item_id`),
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`report_run_id`) REFERENCES `report_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_item_sales_period_dates" CHECK(length("report_item_sales_period"."period_start") = 10 AND length("report_item_sales_period"."period_end") = 10 AND "report_item_sales_period"."period_end" >= "report_item_sales_period"."period_start"),
	CONSTRAINT "ck_item_sales_period_month" CHECK("report_item_sales_period"."report_month" = substr("report_item_sales_period"."period_start", 1, 7) AND "report_item_sales_period"."report_month" = substr("report_item_sales_period"."period_end", 1, 7))
);
--> statement-breakpoint
CREATE INDEX `idx_item_sales_period_month` ON `report_item_sales_period` (`scope_id`,`report_month`);