CREATE TABLE `momo_report_payout_snapshots` (
	`scope_id` text NOT NULL,
	`snapshot_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`business_date` text NOT NULL,
	`payout_amount` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`scope_id`, `snapshot_key`, `business_date`),
	FOREIGN KEY (`scope_id`) REFERENCES `scopes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_momo_payout_snapshot_date" CHECK(length("momo_report_payout_snapshots"."business_date") = 10)
);
--> statement-breakpoint
CREATE INDEX `idx_momo_payout_snapshots_scope_date` ON `momo_report_payout_snapshots` (`scope_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_momo_payout_snapshots_key` ON `momo_report_payout_snapshots` (`scope_id`,`snapshot_key`);